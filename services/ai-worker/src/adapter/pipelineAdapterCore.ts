import crypto from 'crypto';
import { MetricsRegistry, LATENCY_BUCKETS_MS } from '../metrics';
import { AdapterError, validateRequest } from './adapterCore';
import {
  AI_ADAPTER_CONTRACT,
  AdapterDescriptorV1,
  AdapterErrorCode,
  AdapterHealthV1,
  AiProvenanceV1,
  AiTaskV1,
  InferenceRequestV1,
  InferenceResultV1,
  ModelCardV1,
  RETRYABLE,
} from './contract';

/** What every loaded model pipeline (ANPR, redaction, embedding, VLM) exposes about itself. */
export interface LoadedPipelineLike {
  definition: { name: string; version: string };
  definitionSha256: string;
  components: Array<{
    role: string;
    entry: { name: string; version: string; sha256: string; codeLicense: string; weightLicense: string; weightsSource: string };
  }>;
}

export interface PipelineAdapterOptions {
  adapterId: string;
  adapterVersion: string;
  /** Pipeline id the backend registered; default `<name>@<version>`. */
  modelId?: string;
  /** Requests running at once (default 1); one more is OVERLOADED. */
  maxInFlight?: number;
  /** Why the pipeline did not load (licence, SHA-256, missing file). */
  failure?: string;
}

type OkResult = Extract<InferenceResultV1, { status: 'ok' }>;

/** Errors already counted in `vigilone_ai_inferences_total`. */
const COUNTED = new WeakSet<object>();

/**
 * The ai-adapter.v1 rules every model pipeline in the worker follows, in one place:
 *
 *   - descriptor and health from the pipeline's model card (FAILED with the load error; DEGRADED when busy);
 *   - each request is validated, its task must be served and its modelId must be the loaded pipeline;
 *   - bounded concurrency: beyond maxInFlight running, OVERLOADED (counted before any await, so a burst
 *     cannot slip past the limit);
 *   - deadlines: a result ready after the deadline is discarded as DEADLINE_EXCEEDED, never a success;
 *   - provenance names the pipeline definition and every component model, with a fresh inference id;
 *   - every outcome is counted once in `vigilone_ai_inferences_total`; every failure becomes an error result.
 *
 * A pipeline adapter supplies its model card and the model call. The object-detection core (adapterCore.ts)
 * keeps its own queue because the camera stream pipeline shares its slots.
 */
export abstract class PipelineAdapterCore<L extends LoadedPipelineLike> {
  public readonly metrics = new MetricsRegistry();
  protected inFlight = 0;
  protected modelId: string;

  protected constructor(
    protected readonly loaded: L | null,
    protected readonly opts: PipelineAdapterOptions,
    /** The tasks served; the first is the model card's task. */
    protected readonly tasks: AiTaskV1[],
    /** Short name used in messages, e.g. 'ANPR pipeline'. */
    protected readonly label: string
  ) {
    this.modelId = opts.modelId ?? (loaded ? `${loaded.definition.name}@${loaded.definition.version}` : 'none');
    this.metrics.set('vigilone_ai_adapter_ready', 'Adapter READY (1) or not (0)', undefined, loaded ? 1 : 0);
  }

  get pipelineModelId(): string {
    return this.modelId;
  }

  setModelId(id: string): void {
    this.modelId = id;
  }

  /** The model card for the loaded pipeline (never called without one). */
  protected abstract card(l: L, base: PipelineCardBase): ModelCardV1;

  /** Why the pipeline cannot serve now, or null. Overridden where a pipeline can die after loading. */
  protected failure(): string | null {
    return this.loaded ? null : this.opts.failure || `${this.label} not loaded`;
  }

  /** The provenance runtime label and any extra components (e.g. the llama-server binary). */
  protected abstract runtime(l: L): { runtime: string; extraComponents?: NonNullable<AiProvenanceV1['components']> };

  modelCard(): ModelCardV1 | null {
    const l = this.loaded;
    if (!l) return null;
    return this.card(l, {
      modelId: this.modelId,
      name: l.definition.name,
      version: l.definition.version,
      sha256: l.definitionSha256,
      task: this.tasks[0],
      codeLicense: [...new Set(l.components.map((c) => c.entry.codeLicense))].join(' AND '),
      weightsLicense: [...new Set(l.components.map((c) => c.entry.weightLicense))].join(' AND '),
      weightsSource: l.components.map((c) => `${c.role}: ${c.entry.weightsSource}`).join('; '),
      components: l.components.map((c) => ({ role: c.role, name: c.entry.name, version: c.entry.version, sha256: c.entry.sha256, weightsLicense: c.entry.weightLicense })),
    });
  }

  describe(): AdapterDescriptorV1 {
    const card = this.modelCard();
    return { contract: AI_ADAPTER_CONTRACT, adapterId: this.opts.adapterId, adapterVersion: this.opts.adapterVersion, tasks: this.tasks, models: card ? [card] : [], requiresNetworkEgress: false };
  }

  health(): AdapterHealthV1 {
    const failure = this.failure();
    return {
      contract: AI_ADAPTER_CONTRACT,
      adapterId: this.opts.adapterId,
      status: failure ? 'FAILED' : this.inFlight >= this.maxInFlight ? 'DEGRADED' : 'READY',
      loadedModelIds: failure ? [] : [this.modelId],
      lastError: failure,
      observedAtUtc: new Date().toISOString(),
    };
  }

  protected get maxInFlight(): number {
    return this.opts.maxInFlight ?? 1;
  }

  protected provenance(frameTimestampUtc: string): AiProvenanceV1 {
    const l = this.loaded!;
    const { runtime, extraComponents = [] } = this.runtime(l);
    return {
      adapterId: this.opts.adapterId,
      adapterVersion: this.opts.adapterVersion,
      modelId: this.modelId,
      modelName: l.definition.name,
      modelVersion: l.definition.version,
      modelSha256: l.definitionSha256,
      runtime,
      executionProvider: 'cpu',
      inferenceId: crypto.randomUUID(),
      frameTimestampUtc,
      components: [...l.components.map((c) => ({ role: c.role, modelName: c.entry.name, modelVersion: c.entry.version, modelSha256: c.entry.sha256 })), ...extraComponents],
    };
  }

  /** Fails unless the pipeline is loaded and `modelId` names it. */
  protected requireModel(modelId: string): void {
    const failure = this.failure();
    if (failure) throw new AdapterError('MODEL_NOT_LOADED', failure);
    if (modelId !== this.modelId) throw new AdapterError('MODEL_NOT_LOADED', `model '${modelId}' is not loaded (loaded: ${this.modelId})`);
  }

  /** Runs `work` in a slot under the deadline; counts the ok outcome and its latency. */
  protected async inSlot<T>(deadlineMs: number, work: () => Promise<T>): Promise<{ value: T; latencyMs: number }> {
    if (this.inFlight >= this.maxInFlight) {
      this.metrics.inc('vigilone_ai_requests_rejected_total', 'Requests rejected by backpressure', { reason: 'overloaded' });
      throw this.counted(new AdapterError('OVERLOADED', `${this.label} busy: ${this.inFlight} running`));
    }
    this.inFlight++;
    const started = Date.now();
    let value: T;
    try {
      value = await work();
    } catch (err) {
      throw this.counted(err);
    } finally {
      this.inFlight--;
    }
    const latencyMs = Date.now() - started;
    if (latencyMs > deadlineMs) throw this.counted(new AdapterError('DEADLINE_EXCEEDED', `result ready after ${latencyMs}ms, deadline was ${deadlineMs}ms`));
    this.metrics.inc('vigilone_ai_inferences_total', 'Inferences by outcome', { outcome: 'ok' });
    this.metrics.observe('vigilone_ai_inference_latency_ms', `End-to-end ${this.label} latency`, LATENCY_BUCKETS_MS, latencyMs);
    return { value, latencyMs };
  }

  /** POST /v1/infer: validation, task and model checks, then `run`. Never throws. */
  async handleInferRequest(body: unknown): Promise<InferenceResultV1> {
    return this.answer(body, async () => {
      const req = validateRequest(body);
      this.requireModel(req.modelId);
      if (!this.tasks.includes(req.task)) throw new AdapterError('UNSUPPORTED_TASK', `task '${req.task}' is not served by this adapter (${this.tasks.join(', ')})`);
      return this.run(req);
    });
  }

  /** The model call for one validated request of a served task. */
  protected abstract run(req: InferenceRequestV1): Promise<OkResult>;

  /** Wraps a handler: any thrown error becomes a counted error result for the request. */
  protected async answer(body: unknown, handler: () => Promise<OkResult>): Promise<InferenceResultV1> {
    try {
      return await handler();
    } catch (err: any) {
      const code: AdapterErrorCode = err instanceof AdapterError ? err.code : 'RUNTIME_ERROR';
      if (!COUNTED.has(err)) this.metrics.inc('vigilone_ai_inferences_total', 'Inferences by outcome', { outcome: code });
      return { contract: AI_ADAPTER_CONTRACT, status: 'error', requestId: requestIdOf(body), errorCode: code, message: (err?.message || 'inference failed').slice(0, 2000), retryable: RETRYABLE[code] };
    }
  }

  /** Counts a failure inside a slot once, so the stream path (no `answer`) is counted too. */
  private counted(err: unknown): unknown {
    if (err && typeof err === 'object' && !COUNTED.has(err)) {
      COUNTED.add(err);
      const code: AdapterErrorCode = err instanceof AdapterError ? err.code : 'RUNTIME_ERROR';
      this.metrics.inc('vigilone_ai_inferences_total', 'Inferences by outcome', { outcome: code });
    }
    return err;
  }

  /** An ok result; provenance is fresh for this frame unless `fields` carries one. */
  protected ok(requestId: string, frameTimestampUtc: string, latencyMs: number, fields: Partial<OkResult>): OkResult {
    return { contract: AI_ADAPTER_CONTRACT, status: 'ok', requestId, detections: [], ...fields, provenance: fields.provenance ?? this.provenance(frameTimestampUtc), latencyMs } as OkResult;
  }
}

export interface PipelineCardBase {
  modelId: string;
  name: string;
  version: string;
  sha256: string;
  task: AiTaskV1;
  codeLicense: string;
  weightsLicense: string;
  weightsSource: string;
  components: NonNullable<ModelCardV1['components']>;
}

/** The request id to echo in an error result: the body's own, or 'unidentified-request'. */
export function requestIdOf(body: unknown): string {
  const id = body && typeof (body as any).requestId === 'string' ? (body as any).requestId : '';
  return id ? id.slice(0, 200) : 'unidentified-request';
}
