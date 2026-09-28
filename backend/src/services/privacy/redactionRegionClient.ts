/**
 * Client for the redaction regions adapter (ai-adapter.v1, P4.4). Every response is validated
 * against the contract and its provenance is checked against the model registry: a region is used
 * only if it came from a registered, active redaction pipeline with the same SHA-256.
 * Any failure is thrown as RedactionError; the job then fails instead of exporting unmasked video.
 */
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { AdapterDescriptorV1, AdapterHealthV1, InferenceResultV1 } from '../../contracts/aiAdapter.v1';
import { RedactionError } from './redactionErrors';

export type RegionTask = 'face_detection_for_redaction' | 'plate_detection_for_redaction';

export interface RegionDetection {
  kind: 'FACE' | 'LICENSE_PLATE';
  box: [number, number, number, number];
  score: number;
}

export interface DetectorProvenance {
  adapterId: string;
  adapterVersion: string;
  modelName: string;
  modelVersion: string;
  modelSha256: string;
  runtime: string;
  components: Array<{ role: string; modelName: string; modelVersion: string; modelSha256: string }>;
}

export class RedactionRegionClient {
  private modelId: string | null = null;
  private provenance: DetectorProvenance | null = null;

  constructor(private prisma: PrismaClient, private baseUrl: string, private timeoutMs = 20000) {}

  private async getJson(path: string): Promise<unknown> {
    let r: Response;
    try {
      r = await fetch(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e: any) {
      throw new RedactionError('REDACTION_DETECTOR_UNAVAILABLE', `redaction adapter at ${this.baseUrl} is unreachable: ${e.message}`);
    }
    if (!r.ok) throw new RedactionError('REDACTION_DETECTOR_UNAVAILABLE', `GET ${path} returned HTTP ${r.status}`);
    return r.json();
  }

  /** Health READY and a model serving both redaction tasks; remembers its model id. */
  async connect(tasks: RegionTask[]): Promise<void> {
    const health = AdapterHealthV1.safeParse(await this.getJson('/v1/health'));
    if (!health.success) throw new RedactionError('REDACTION_DETECTOR_INVALID', `health does not match ai-adapter.v1: ${health.error.issues[0].message}`);
    if (health.data.status !== 'READY') {
      throw new RedactionError('REDACTION_DETECTOR_UNAVAILABLE', `redaction adapter is ${health.data.status}: ${health.data.lastError ?? 'no detail'}`);
    }
    const desc = AdapterDescriptorV1.safeParse(await this.getJson('/v1/descriptor'));
    if (!desc.success) throw new RedactionError('REDACTION_DETECTOR_INVALID', `describe does not match ai-adapter.v1: ${desc.error.issues[0].message}`);
    for (const t of tasks) {
      if (!desc.data.tasks.includes(t)) throw new RedactionError('REDACTION_DETECTOR_UNAVAILABLE', `adapter ${desc.data.adapterId} does not serve ${t}`);
    }
    const model = desc.data.models[0];
    if (!model) throw new RedactionError('REDACTION_DETECTOR_UNAVAILABLE', 'redaction adapter has no model loaded');
    this.modelId = model.modelId;
  }

  /** Runs one task on one JPEG frame; returns pixel boxes. */
  async detect(task: RegionTask, jpeg: Buffer, width: number, height: number, frameTimestampUtc: string, seq: number): Promise<RegionDetection[]> {
    if (!this.modelId) throw new Error('connect() first');
    const body = {
      contract: 'ai-adapter.v1',
      requestId: crypto.randomUUID(),
      tenantId: 'redaction',
      task,
      modelId: this.modelId,
      deadlineMs: this.timeoutMs,
      frame: { cameraId: 'redaction', streamSessionId: 'redaction', sequenceNumber: seq, timestampUtc: frameTimestampUtc, width, height, format: 'jpeg', data: { kind: 'inline_base64', value: jpeg.toString('base64') } },
    };
    let json: unknown;
    try {
      const r = await fetch(`${this.baseUrl}/v1/infer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs + 5000) });
      json = await r.json();
    } catch (e: any) {
      throw new RedactionError('REDACTION_DETECTOR_UNAVAILABLE', `inference request failed: ${e.message}`);
    }
    const res = InferenceResultV1.safeParse(json);
    if (!res.success) throw new RedactionError('REDACTION_DETECTOR_INVALID', `inference result does not match ai-adapter.v1: ${res.error.issues[0].path.join('.')}: ${res.error.issues[0].message}`);
    if (res.data.status !== 'ok') throw new RedactionError('REDACTION_DETECTOR_FAILED', `${task} failed on frame ${seq}: ${res.data.errorCode}: ${res.data.message}`);
    await this.checkProvenance(res.data.provenance as any);
    const want = task === 'face_detection_for_redaction' ? 'face' : 'license_plate';
    return res.data.detections
      .filter((d) => d.objectClass === want)
      .map((d) => ({
        kind: want === 'face' ? ('FACE' as const) : ('LICENSE_PLATE' as const),
        box: [d.bbox.x * width, d.bbox.y * height, (d.bbox.x + d.bbox.width) * width, (d.bbox.y + d.bbox.height) * height] as [number, number, number, number],
        score: d.confidence,
      }));
  }

  get detectorProvenance(): DetectorProvenance | null {
    return this.provenance;
  }

  private async checkProvenance(p: any): Promise<void> {
    if (!p || !Array.isArray(p.components) || p.components.length === 0) {
      throw new RedactionError('REDACTION_PROVENANCE_INVALID', 'region results must carry provenance with the component models');
    }
    if (this.provenance) {
      if (p.modelSha256 !== this.provenance.modelSha256) throw new RedactionError('REDACTION_PROVENANCE_INVALID', 'the detector changed during the job');
      return;
    }
    const manifest = await this.prisma.modelManifest.findFirst({
      where: { sha256: p.modelSha256, task: 'face_detection_for_redaction', isActive: true },
      select: { name: true, version: true },
    });
    if (!manifest || manifest.name !== p.modelName || manifest.version !== p.modelVersion) {
      throw new RedactionError('REDACTION_PROVENANCE_INVALID', `detector ${p.modelName}@${p.modelVersion} (${p.modelSha256}) is not a registered, active redaction pipeline`);
    }
    this.provenance = {
      adapterId: p.adapterId,
      adapterVersion: p.adapterVersion,
      modelName: p.modelName,
      modelVersion: p.modelVersion,
      modelSha256: p.modelSha256,
      runtime: p.runtime,
      components: p.components,
    };
  }
}
