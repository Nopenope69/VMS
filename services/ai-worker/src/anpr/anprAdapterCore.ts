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
  DetectionV1,
  InferenceResultV1,
  ModelCardV1,
  RETRYABLE,
} from '../adapter/contract';
import { LoadedAnprPipeline } from './anprService';
import { PlateRead, AnprOptions } from './anprPipeline';
import { Image3 } from './imageOps';
import { ortRuntimeLabel } from '../runtimeInfo';

/**
 * ai-adapter.v1 for task plate_recognition. Same HTTP surface, backpressure (OVERLOADED) and
 * deadline rules (DEADLINE_EXCEEDED; late results discarded) as the object-detection core.
 * Each detection carries attributes { plateText, displayText, format, stateCode, lines,
 * reading, rawText }; provenance names the pipeline definition and lists both models.
 */
export class AnprAdapterCore {
  public readonly metrics = new MetricsRegistry();
  private inFlight = 0;
  private modelId: string;

  constructor(
    private readonly loaded: LoadedAnprPipeline | null,
    private readonly opts: { adapterId: string; adapterVersion: string; modelId?: string; maxInFlight?: number; failure?: string }
  ) {
    this.modelId = opts.modelId ?? (loaded ? `${loaded.definition.name}@${loaded.definition.version}` : 'none');
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
    const lic = [...new Set(l.components.map((c) => c.entry.weightLicense))].join(' AND ');
    const code = [...new Set(l.components.map((c) => c.entry.codeLicense))].join(' AND ');
    return {
      modelId: this.modelId,
      name: l.definition.name,
      version: l.definition.version,
      sha256: l.definitionSha256,
      task: 'plate_recognition',
      classes: ['license_plate'],
      codeLicense: code,
      weightsLicense: lic,
      weightsSource: l.components.map((c) => `${c.role}: ${c.entry.weightsSource}`).join('; '),
      runtime: 'onnxruntime',
      input: { width: l.definition.textDetection.limitSideLen, height: l.definition.textDetection.limitSideLen, colorSpace: 'BGR', letterbox: false, resizeMode: 'min_side' },
      components: l.components.map((c) => ({ role: c.role, name: c.entry.name, version: c.entry.version, sha256: c.entry.sha256, weightsLicense: c.entry.weightLicense })),
      // No accuracy on Indian site data exists yet (P4.3 is HUMAN-REQUIRED).
      evaluation: null,
    };
  }

  describe(): AdapterDescriptorV1 {
    const card = this.modelCard();
    return { contract: AI_ADAPTER_CONTRACT, adapterId: this.opts.adapterId, adapterVersion: this.opts.adapterVersion, tasks: ['plate_recognition'], models: card ? [card] : [], requiresNetworkEgress: false };
  }

  health(): AdapterHealthV1 {
    const max = this.opts.maxInFlight ?? 1;
    return {
      contract: AI_ADAPTER_CONTRACT,
      adapterId: this.opts.adapterId,
      status: !this.loaded ? 'FAILED' : this.inFlight >= max ? 'DEGRADED' : 'READY',
      loadedModelIds: this.loaded ? [this.modelId] : [],
      lastError: this.loaded ? null : this.opts.failure || 'ANPR pipeline not loaded',
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

  /** Runs the pipeline on one RGB frame under the concurrency limit and deadline. */
  async recognize(img: Image3, frameTimestampUtc: string, deadlineMs: number, opts?: Partial<AnprOptions>): Promise<{ plates: PlateRead[]; provenance: AiProvenanceV1; latencyMs: number }> {
    if (!this.loaded) throw new AdapterError('MODEL_NOT_LOADED', this.opts.failure || 'ANPR pipeline not loaded');
    const max = this.opts.maxInFlight ?? 1;
    if (this.inFlight >= max) {
      this.metrics.inc('vigilone_ai_requests_rejected_total', 'Requests rejected by backpressure', { reason: 'overloaded' });
      throw new AdapterError('OVERLOADED', `ANPR busy: ${this.inFlight} running`);
    }
    this.inFlight++;
    const started = Date.now();
    try {
      const r = await this.loaded.pipeline.read(img, { ...this.loaded.definition.recognition, ...(opts || {}) });
      const latencyMs = Date.now() - started;
      if (latencyMs > deadlineMs) {
        this.metrics.inc('vigilone_ai_inferences_total', 'Inferences by outcome', { outcome: 'DEADLINE_EXCEEDED' });
        throw new AdapterError('DEADLINE_EXCEEDED', `result ready after ${latencyMs}ms, deadline was ${deadlineMs}ms`);
      }
      this.metrics.inc('vigilone_ai_inferences_total', 'Inferences by outcome', { outcome: 'ok' });
      this.metrics.observe('vigilone_ai_inference_latency_ms', 'End-to-end ANPR latency', LATENCY_BUCKETS_MS, latencyMs);
      this.metrics.inc('vigilone_anpr_plates_read_total', 'Plates read (valid Indian format, above threshold)', undefined, r.plates.length);
      return { plates: r.plates, provenance: this.provenance(frameTimestampUtc), latencyMs };
    } finally {
      this.inFlight--;
    }
  }

  async handleInferRequest(body: unknown): Promise<InferenceResultV1> {
    const requestId = body && typeof (body as any).requestId === 'string' && (body as any).requestId ? (body as any).requestId.slice(0, 200) : 'unidentified-request';
    try {
      const req = validateRequest(body);
      if (!this.loaded) throw new AdapterError('MODEL_NOT_LOADED', this.opts.failure || 'ANPR pipeline not loaded');
      if (req.task !== 'plate_recognition') throw new AdapterError('UNSUPPORTED_TASK', `task '${req.task}' is not served by this adapter (plate_recognition only)`);
      if (req.modelId !== this.modelId) throw new AdapterError('MODEL_NOT_LOADED', `model '${req.modelId}' is not loaded (loaded: ${this.modelId})`);
      const f = req.frame;
      const img = await decodeRequestFrame(f as any);
      const r = await this.recognize(img, f.timestampUtc, req.deadlineMs);
      const detections: DetectionV1[] = r.plates.map((p) => ({
        objectClass: 'license_plate',
        classId: 0,
        confidence: Math.max(0, Math.min(1, p.confidence)),
        bbox: {
          x: p.box[0] / f.width,
          y: p.box[1] / f.height,
          width: (p.box[2] - p.box[0]) / f.width,
          height: (p.box[3] - p.box[1]) / f.height,
        },
        attributes: {
          plateText: p.plate.normalized,
          displayText: p.plate.display,
          format: p.plate.format,
          stateCode: p.plate.stateCode,
          lines: p.lines,
          reading: p.reading,
          rawText: p.rawText,
          corrections: p.plate.corrections,
        },
      }));
      return { contract: AI_ADAPTER_CONTRACT, status: 'ok', requestId: req.requestId, detections, provenance: r.provenance, latencyMs: r.latencyMs };
    } catch (err: any) {
      const code: AdapterErrorCode = err instanceof AdapterError ? err.code : 'RUNTIME_ERROR';
      return { contract: AI_ADAPTER_CONTRACT, status: 'error', requestId, errorCode: code, message: (err?.message || 'inference failed').slice(0, 2000), retryable: RETRYABLE[code] };
    }
  }
}
