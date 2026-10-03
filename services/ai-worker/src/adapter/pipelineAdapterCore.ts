import { MetricsRegistry, LATENCY_BUCKETS_MS } from '../metrics';
import { AdapterDescriptorV1, AdapterHealthV1, AiProvenanceV1, AiTaskV1, InferenceResultV1, ModelCardV1 } from './contract';
import { AdapterCore, AdapterModel, Frame, InferContext, ModelCard, ModelOutput, Outcome, createAdapterCore } from '../sdk/core';

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

/**
 * A model pipeline of the worker (ANPR, redaction, embedding, VLM) as an ai-adapter.v1 adapter. The contract
 * rules are the adapter SDK's (`createAdapterCore`, in src/sdk, a checked copy of sdk/ai-adapter; ADR 0007):
 * validation, served tasks and model ids, bounded concurrency (no queue: one more than maxInFlight is
 * OVERLOADED), deadlines, result checks, provenance with every component model, and health (FAILED with the
 * load error or when the pipeline's runtime died, DEGRADED when busy).
 *
 * A pipeline adapter supplies its model card, its runtime label and its model call. This class adds the
 * worker's metrics: every outcome is counted once in `vigilone_ai_inferences_total`, including work from the
 * camera LPR path (`inSlot`). The object-detection core (adapterCore.ts) keeps its own queue, which the camera
 * stream pipeline shares.
 */
export abstract class PipelineAdapterCore<L extends LoadedPipelineLike> {
  public readonly metrics = new MetricsRegistry();
  protected modelId: string;
  private sdk: AdapterCore | null = null;

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

  /**
   * Uses the id the backend registered for this pipeline (called once at start-up, right after registration).
   * The SDK core is rebuilt with it; no request can carry the new id before the backend has it.
   */
  setModelId(id: string): void {
    this.modelId = id;
    this.sdk = null;
  }

  /** The model card for the loaded pipeline (never called without one). */
  protected abstract card(l: L, base: PipelineCardBase): ModelCardV1;

  /** The provenance runtime label and any extra components (e.g. the llama-server binary). */
  protected abstract runtime(l: L): { runtime: string; extraComponents?: NonNullable<AiProvenanceV1['components']> };

  /** The model call for one request of a served task (the SDK core has checked the request and frame). */
  protected abstract infer(l: L, frame: Frame, ctx: InferContext): Promise<ModelOutput>;

  /** Why a loaded pipeline cannot serve now, or null. Overridden where a pipeline can die after loading. */
  protected liveness(_l: L): string | null {
    return null;
  }

  /** Optional text tower (POST /v1/embed-text). */
  protected embedText?(l: L, text: string, ctx: InferContext): Promise<Float32Array>;

  /** The SDK core, built on first use (the model card comes from the subclass). */
  protected get core(): AdapterCore {
    if (this.sdk) return this.sdk;
    const l = this.loaded;
    const models: AdapterModel[] = [];
    if (l) {
      const { runtime, extraComponents } = this.runtime(l);
      models.push({
        card: this.modelCard() as ModelCard,
        tasks: this.tasks.slice(1),
        runtime,
        executionProvider: 'cpu',
        ...(extraComponents?.length ? { provenanceComponents: extraComponents } : {}),
        failure: () => this.liveness(l),
        infer: (frame, ctx) => this.infer(l, frame, ctx),
        ...(this.embedText ? { embedText: (text: string, ctx: InferContext) => this.embedText!(l, text, ctx) } : {}),
      });
    }
    this.sdk = createAdapterCore({
      adapterId: this.opts.adapterId,
      adapterVersion: this.opts.adapterVersion,
      models,
      tasks: this.tasks,
      ...(l ? {} : { loadFailure: this.opts.failure || `${this.label} not loaded` }),
      maxInFlight: this.opts.maxInFlight ?? 1,
      maxQueued: 0,
      onOutcome: (o) => this.count(o),
    });
    return this.sdk;
  }

  private count(o: Outcome): void {
    this.metrics.inc('vigilone_ai_inferences_total', 'Inferences by outcome', { outcome: o.outcome });
    if (o.outcome === 'OVERLOADED') this.metrics.inc('vigilone_ai_requests_rejected_total', 'Requests rejected by backpressure', { reason: 'overloaded' });
    if (o.outcome === 'ok' && o.latencyMs !== undefined) this.metrics.observe('vigilone_ai_inference_latency_ms', `End-to-end ${this.label} latency`, LATENCY_BUCKETS_MS, o.latencyMs);
  }

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
    return this.core.descriptor as AdapterDescriptorV1;
  }

  health(): AdapterHealthV1 {
    return this.core.health();
  }

  /** POST /v1/infer. Never throws. */
  handleInferRequest(body: unknown): Promise<InferenceResultV1> {
    return this.core.infer(body) as Promise<InferenceResultV1>;
  }

  /** Runs work outside a request (the camera LPR path) in a slot under the deadline; counted like a request. */
  protected inSlot<T>(deadlineMs: number, work: () => Promise<T>): Promise<{ value: T; latencyMs: number }> {
    return this.core.run(this.modelId, deadlineMs, () => work());
  }

  protected provenance(frameTimestampUtc: string): AiProvenanceV1 {
    return this.core.provenance(this.modelId, frameTimestampUtc);
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
