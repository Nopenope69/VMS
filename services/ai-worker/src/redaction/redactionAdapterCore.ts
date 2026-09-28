import crypto from 'crypto';
import { MetricsRegistry, LATENCY_BUCKETS_MS } from '../metrics';
import { AdapterError, validateRequest } from '../adapter/adapterCore';
import { decodeRequestFrame } from '../adapter/frameDecode';
import {
  AI_ADAPTER_CONTRACT,
  AdapterDescriptorV1,
  AdapterErrorCode,
  AdapterHealthV1,
  AiProvenanceV1,
  AiTaskV1,
  DetectionV1,
  InferenceResultV1,
  ModelCardV1,
  RETRYABLE,
} from '../adapter/contract';
import { ortRuntimeLabel } from '../runtimeInfo';
import { LoadedRedactionPipeline, Region } from './redactionPipeline';

const TASKS: AiTaskV1[] = ['face_detection_for_redaction', 'plate_detection_for_redaction'];

/**
 * ai-adapter.v1 for redaction regions (P4.4): task face_detection_for_redaction returns class
 * 'face', task plate_detection_for_redaction returns class 'license_plate' (text regions, no OCR:
 * the adapter never reads plate text). Same backpressure and deadline rules as the other adapters.
 * Only boxes leave the adapter; no crops or embeddings are produced or stored.
 */
export class RedactionAdapterCore {
  public readonly metrics = new MetricsRegistry();
  private inFlight = 0;
  private modelId: string;

  constructor(
    private readonly loaded: LoadedRedactionPipeline | null,
    private readonly opts: { adapterId: string; adapterVersion: string; maxInFlight?: number; failure?: string }
  ) {
    this.modelId = loaded ? `${loaded.definition.name}@${loaded.definition.version}` : 'none';
    this.metrics.set('vigilone_ai_adapter_ready', 'Adapter READY (1) or not (0)', undefined, loaded ? 1 : 0);
  }

  get pipelineModelId(): string {
    return this.modelId;
  }

  setModelId(id: string) {
    this.modelId = id;
  }

  modelCard(): ModelCardV1 | null {
    const l = this.loaded;
    if (!l) return null;
    return {
      modelId: this.modelId,
      name: l.definition.name,
      version: l.definition.version,
      sha256: l.definitionSha256,
      task: 'face_detection_for_redaction',
      classes: ['face', 'license_plate'],
      codeLicense: [...new Set(l.components.map((c) => c.entry.codeLicense))].join(' AND '),
      weightsLicense: [...new Set(l.components.map((c) => c.entry.weightLicense))].join(' AND '),
      weightsSource: l.components.map((c) => `${c.role}: ${c.entry.weightsSource}`).join('; '),
      runtime: 'onnxruntime',
      input: { width: 640, height: 640, colorSpace: 'BGR', letterbox: true },
      components: l.components.map((c) => ({ role: c.role, name: c.entry.name, version: c.entry.version, sha256: c.entry.sha256, weightsLicense: c.entry.weightLicense })),
      // Recall on site footage has not been measured (needs labelled site data).
      evaluation: null,
    };
  }

  describe(): AdapterDescriptorV1 {
    const card = this.modelCard();
    return { contract: AI_ADAPTER_CONTRACT, adapterId: this.opts.adapterId, adapterVersion: this.opts.adapterVersion, tasks: TASKS, models: card ? [card] : [], requiresNetworkEgress: false };
  }

  health(): AdapterHealthV1 {
    const max = this.opts.maxInFlight ?? 1;
    return {
      contract: AI_ADAPTER_CONTRACT,
      adapterId: this.opts.adapterId,
      status: !this.loaded ? 'FAILED' : this.inFlight >= max ? 'DEGRADED' : 'READY',
      loadedModelIds: this.loaded ? [this.modelId] : [],
      lastError: this.loaded ? null : this.opts.failure || 'redaction pipeline not loaded',
      observedAtUtc: new Date().toISOString(),
    };
  }

  provenance(frameTimestampUtc: string): AiProvenanceV1 {
    const l = this.loaded!;
    return {
      adapterId: this.opts.adapterId,
      adapterVersion: this.opts.adapterVersion,
      modelId: this.modelId,
      modelName: l.definition.name,
      modelVersion: l.definition.version,
      modelSha256: l.definitionSha256,
      runtime: ortRuntimeLabel(),
      executionProvider: 'cpu',
      inferenceId: crypto.randomUUID(),
      frameTimestampUtc,
      components: l.components.map((c) => ({ role: c.role, modelName: c.entry.name, modelVersion: c.entry.version, modelSha256: c.entry.sha256 })),
    };
  }

  async handleInferRequest(body: unknown): Promise<InferenceResultV1> {
    const requestId = body && typeof (body as any).requestId === 'string' && (body as any).requestId ? (body as any).requestId.slice(0, 200) : 'unidentified-request';
    try {
      const req = validateRequest(body);
      if (!this.loaded) throw new AdapterError('MODEL_NOT_LOADED', this.opts.failure || 'redaction pipeline not loaded');
      if (!TASKS.includes(req.task)) throw new AdapterError('UNSUPPORTED_TASK', `task '${req.task}' is not served by this adapter (${TASKS.join(', ')})`);
      if (req.modelId !== this.modelId) throw new AdapterError('MODEL_NOT_LOADED', `model '${req.modelId}' is not loaded (loaded: ${this.modelId})`);
      const max = this.opts.maxInFlight ?? 1;
      if (this.inFlight >= max) {
        this.metrics.inc('vigilone_ai_requests_rejected_total', 'Requests rejected by backpressure', { reason: 'overloaded' });
        throw new AdapterError('OVERLOADED', `redaction adapter busy: ${this.inFlight} running`);
      }
      const f = req.frame;
      // Count the request before any await so a burst cannot slip past the limit.
      this.inFlight++;
      const started = Date.now();
      let regions: Region[];
      try {
        const img = await decodeRequestFrame(f as any);
        regions = req.task === 'face_detection_for_redaction' ? await this.loaded.faces(img) : await this.loaded.plates(img);
      } finally {
        this.inFlight--;
      }
      const latencyMs = Date.now() - started;
      if (latencyMs > req.deadlineMs) {
        this.metrics.inc('vigilone_ai_inferences_total', 'Inferences by outcome', { outcome: 'DEADLINE_EXCEEDED' });
        throw new AdapterError('DEADLINE_EXCEEDED', `result ready after ${latencyMs}ms, deadline was ${req.deadlineMs}ms`);
      }
      this.metrics.inc('vigilone_ai_inferences_total', 'Inferences by outcome', { outcome: 'ok' });
      this.metrics.observe('vigilone_ai_inference_latency_ms', 'End-to-end redaction-region latency', LATENCY_BUCKETS_MS, latencyMs);
      this.metrics.inc('vigilone_redaction_regions_total', 'Regions returned for redaction', { kind: req.task === 'face_detection_for_redaction' ? 'face' : 'license_plate' }, regions.length);
      const detections: DetectionV1[] = regions.map((r) => ({
        objectClass: r.kind,
        classId: r.kind === 'face' ? 0 : 1,
        confidence: Math.max(0, Math.min(1, r.score)),
        bbox: { x: r.box[0] / f.width, y: r.box[1] / f.height, width: (r.box[2] - r.box[0]) / f.width, height: (r.box[3] - r.box[1]) / f.height },
      }));
      return { contract: AI_ADAPTER_CONTRACT, status: 'ok', requestId: req.requestId, detections, provenance: this.provenance(f.timestampUtc), latencyMs };
    } catch (err: any) {
      const code: AdapterErrorCode = err instanceof AdapterError ? err.code : 'RUNTIME_ERROR';
      return { contract: AI_ADAPTER_CONTRACT, status: 'error', requestId, errorCode: code, message: (err?.message || 'inference failed').slice(0, 2000), retryable: RETRYABLE[code] };
    }
  }
}
