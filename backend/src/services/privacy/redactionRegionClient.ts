/**
 * Client for the redaction regions adapter (ai-adapter.v1, P4.4). The contract checks are AiAdapterClient's;
 * this module checks provenance against the model registry: a region is used only if it came from a
 * registered, active redaction pipeline with the same SHA-256, and the detector does not change mid-job.
 * Any failure is thrown as RedactionError; the job then fails instead of exporting unmasked video.
 */
import { PrismaClient } from '@prisma/client';
import { AiAdapterClient } from '../ai/aiAdapterClient';
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

const CODES = { unavailable: 'REDACTION_DETECTOR_UNAVAILABLE', invalid: 'REDACTION_DETECTOR_INVALID', unregistered: 'REDACTION_PROVENANCE_INVALID' } as const;

export class RedactionRegionClient {
  private modelId: string | null = null;
  private provenance: DetectorProvenance | null = null;
  private readonly adapter: AiAdapterClient;
  private current: { task: RegionTask; seq: number } | null = null;

  constructor(private prisma: PrismaClient, baseUrl: string, private timeoutMs = 20000) {
    this.adapter = new AiAdapterClient(baseUrl, {
      name: 'redaction adapter',
      timeoutMs,
      fail: (kind, m) => new RedactionError(CODES[kind], m),
      onErrorResult: (res) => new RedactionError('REDACTION_DETECTOR_FAILED', `${this.current?.task} failed on frame ${this.current?.seq}: ${res.errorCode}: ${res.message}`),
    });
  }

  /** Health READY and a model serving both redaction tasks; remembers its model id. */
  async connect(tasks: RegionTask[]): Promise<void> {
    const desc = await this.adapter.probe(tasks);
    const model = desc.models[0];
    if (!model) throw new RedactionError('REDACTION_DETECTOR_UNAVAILABLE', 'redaction adapter has no model loaded');
    this.modelId = model.modelId;
  }

  /** Runs one task on one JPEG frame; returns pixel boxes. */
  async detect(task: RegionTask, jpeg: Buffer, width: number, height: number, frameTimestampUtc: string, seq: number): Promise<RegionDetection[]> {
    if (!this.modelId) throw new Error('connect() first');
    this.current = { task, seq };
    const res = await this.adapter.call('/v1/infer', {
      tenantId: 'redaction',
      task,
      modelId: this.modelId,
      deadlineMs: this.timeoutMs,
      frame: AiAdapterClient.jpegFrame(jpeg, { width, height }, { cameraId: 'redaction', timestampUtc: frameTimestampUtc, sequenceNumber: seq }),
    });
    await this.checkProvenance(res.provenance as any);
    const want = task === 'face_detection_for_redaction' ? 'face' : 'license_plate';
    return res.detections
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
