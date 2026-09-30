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
  InferenceResultV1,
  ModelCardV1,
  RETRYABLE,
  TextEmbeddingRequestV1,
} from '../adapter/contract';
import { ortRuntimeLabel } from '../runtimeInfo';
import { EMBEDDING_DIM, LoadedEmbeddingPipeline } from './embeddingPipeline';

const MAX_TEXT_CHARS = 512;

/**
 * ai-adapter.v1.1 for embeddings: task `embedding` (a JPEG or raw crop in, a 768-dim vector out) and
 * the optional `POST /v1/embed-text` (text in, a vector in the same space out). Same backpressure and
 * deadline rules as the other adapters. The vector is what the model produced; consumers normalise.
 * No image or text is kept: nothing is written to disk and no request content is logged.
 */
export class EmbeddingAdapterCore {
  public readonly metrics = new MetricsRegistry();
  private inFlight = 0;
  private modelId: string;

  constructor(
    private readonly loaded: LoadedEmbeddingPipeline | null,
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
      task: 'embedding',
      classes: ['embedding'],
      codeLicense: [...new Set(l.components.map((c) => c.entry.codeLicense))].join(' AND '),
      weightsLicense: [...new Set(l.components.map((c) => c.entry.weightLicense))].join(' AND '),
      weightsSource: l.components.map((c) => `${c.role}: ${c.entry.weightsSource}`).join('; '),
      runtime: 'onnxruntime',
      input: { width: 224, height: 224, colorSpace: 'RGB', letterbox: false, resizeMode: 'fixed' },
      components: l.components.map((c) => ({ role: c.role, name: c.entry.name, version: c.entry.version, sha256: c.entry.sha256, weightsLicense: c.entry.weightLicense })),
      // Retrieval quality on site data has not been measured (needs labelled site queries).
      evaluation: null,
    };
  }

  describe(): AdapterDescriptorV1 {
    const card = this.modelCard();
    return { contract: AI_ADAPTER_CONTRACT, adapterId: this.opts.adapterId, adapterVersion: this.opts.adapterVersion, tasks: ['embedding'], models: card ? [card] : [], requiresNetworkEgress: false };
  }

  health(): AdapterHealthV1 {
    const max = this.opts.maxInFlight ?? 1;
    return {
      contract: AI_ADAPTER_CONTRACT,
      adapterId: this.opts.adapterId,
      status: !this.loaded ? 'FAILED' : this.inFlight >= max ? 'DEGRADED' : 'READY',
      loadedModelIds: this.loaded ? [this.modelId] : [],
      lastError: this.loaded ? null : this.opts.failure || 'embedding pipeline not loaded',
      observedAtUtc: new Date().toISOString(),
    };
  }

  private provenance(frameTimestampUtc: string): AiProvenanceV1 {
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

  private error(requestId: string, err: any): InferenceResultV1 {
    const code: AdapterErrorCode = err instanceof AdapterError ? err.code : 'RUNTIME_ERROR';
    this.metrics.inc('vigilone_ai_inferences_total', 'Inferences by outcome', { outcome: code });
    return { contract: AI_ADAPTER_CONTRACT, status: 'error', requestId, errorCode: code, message: (err?.message || 'inference failed').slice(0, 2000), retryable: RETRYABLE[code] };
  }

  private static requestId(body: unknown): string {
    return body && typeof (body as any).requestId === 'string' && (body as any).requestId ? (body as any).requestId.slice(0, 200) : 'unidentified-request';
  }

  /** Runs `work` under the in-flight limit and the deadline, and wraps the vector as an ok result. */
  private async run(requestId: string, modelId: string, deadlineMs: number, timestampUtc: string, kind: 'image' | 'text', work: () => Promise<Float32Array>): Promise<InferenceResultV1> {
    if (!this.loaded) throw new AdapterError('MODEL_NOT_LOADED', this.opts.failure || 'embedding pipeline not loaded');
    if (modelId !== this.modelId) throw new AdapterError('MODEL_NOT_LOADED', `model '${modelId}' is not loaded (loaded: ${this.modelId})`);
    const max = this.opts.maxInFlight ?? 1;
    if (this.inFlight >= max) {
      this.metrics.inc('vigilone_ai_requests_rejected_total', 'Requests rejected by backpressure', { reason: 'overloaded' });
      throw new AdapterError('OVERLOADED', `embedding adapter busy: ${this.inFlight} running`);
    }
    // Count the request before any await so a burst cannot slip past the limit.
    this.inFlight++;
    const started = Date.now();
    let vector: Float32Array;
    try {
      vector = await work();
    } finally {
      this.inFlight--;
    }
    const latencyMs = Date.now() - started;
    if (latencyMs > deadlineMs) throw new AdapterError('DEADLINE_EXCEEDED', `result ready after ${latencyMs}ms, deadline was ${deadlineMs}ms`);
    if (vector.length !== EMBEDDING_DIM) throw new AdapterError('RUNTIME_ERROR', `model produced ${vector.length} components, expected ${EMBEDDING_DIM}`);
    this.metrics.inc('vigilone_ai_inferences_total', 'Inferences by outcome', { outcome: 'ok' });
    this.metrics.inc('vigilone_embeddings_total', 'Embeddings produced', { kind });
    this.metrics.observe('vigilone_ai_inference_latency_ms', 'End-to-end embedding latency', LATENCY_BUCKETS_MS, latencyMs);
    const bytes = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength); // little-endian on every supported platform
    return {
      contract: AI_ADAPTER_CONTRACT,
      status: 'ok',
      requestId,
      detections: [],
      embedding: { dim: EMBEDDING_DIM, encoding: 'float32_base64', vector: bytes.toString('base64'), normalized: false },
      provenance: this.provenance(timestampUtc),
      latencyMs,
    };
  }

  async handleInferRequest(body: unknown): Promise<InferenceResultV1> {
    const requestId = EmbeddingAdapterCore.requestId(body);
    try {
      const req = validateRequest(body);
      if (req.task !== 'embedding') throw new AdapterError('UNSUPPORTED_TASK', `task '${req.task}' is not served by this adapter (embedding)`);
      const f = req.frame;
      return await this.run(req.requestId, req.modelId, req.deadlineMs, f.timestampUtc, 'image', async () => {
        const img = await decodeRequestFrame(f as any);
        return this.loaded!.embedImage(img);
      });
    } catch (err: any) {
      return this.error(requestId, err);
    }
  }

  /** `POST /v1/embed-text` (ai-adapter.v1.1). */
  async handleTextEmbedRequest(body: unknown): Promise<InferenceResultV1> {
    const requestId = EmbeddingAdapterCore.requestId(body);
    try {
      const b = body as Partial<TextEmbeddingRequestV1> | null;
      const bad = (m: string) => new AdapterError('INVALID_FRAME', `invalid TextEmbeddingRequestV1: ${m}`);
      if (!b || typeof b !== 'object') throw bad('body must be a JSON object');
      if (b.contract !== AI_ADAPTER_CONTRACT) throw bad(`contract must be '${AI_ADAPTER_CONTRACT}'`);
      for (const k of ['requestId', 'tenantId', 'modelId'] as const) if (typeof b[k] !== 'string' || !b[k]) throw bad(`${k} is required`);
      if (typeof b.text !== 'string' || b.text.trim().length === 0 || b.text.length > MAX_TEXT_CHARS) throw bad(`text must be 1 to ${MAX_TEXT_CHARS} characters and not blank`);
      if (!Number.isInteger(b.deadlineMs) || (b.deadlineMs as number) <= 0 || (b.deadlineMs as number) > 60000) throw bad('deadlineMs must be an integer in (0, 60000]');
      const text = b.text;
      return await this.run(b.requestId as string, b.modelId as string, b.deadlineMs as number, new Date().toISOString(), 'text', () => this.loaded!.embedText(text));
    } catch (err: any) {
      return this.error(requestId, err);
    }
  }
}
