import crypto from 'crypto';
import { MetricsRegistry, LATENCY_BUCKETS_MS } from '../metrics';
import { AdapterError, decodeJpeg, validateRequest } from '../adapter/adapterCore';
import {
  AI_ADAPTER_CONTRACT,
  AdapterDescriptorV1,
  AdapterErrorCode,
  AdapterHealthV1,
  AiProvenanceV1,
  InferenceResultV1,
  ModelCardV1,
  RETRYABLE,
} from '../adapter/contract';
import { LoadedVlmPipeline, VlmAnswer } from './vlmPipeline';

/**
 * ai-adapter.v1.1 for the alarm second opinion: task `vlm_verification`, a JPEG frame and a target class in,
 * `verification` { answer: yes | no | unclear, reason, promptSha256 } out. One request at a time (a VLM call
 * takes seconds on CPU); a second concurrent request is OVERLOADED. Nothing is stored or logged here: the
 * image and the answer only pass through.
 */
export class VlmAdapterCore {
  public readonly metrics = new MetricsRegistry();
  private inFlight = 0;
  private modelId: string;

  constructor(
    private readonly loaded: LoadedVlmPipeline | null,
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

  private failure(): string | null {
    if (!this.loaded) return this.opts.failure || 'VLM pipeline not loaded';
    if (!this.loaded.alive()) return 'llama-server is not running';
    return null;
  }

  modelCard(): ModelCardV1 | null {
    const l = this.loaded;
    if (!l) return null;
    return {
      modelId: this.modelId,
      name: l.definition.name,
      version: l.definition.version,
      sha256: l.definitionSha256,
      task: 'vlm_verification',
      classes: l.definition.targetClasses,
      codeLicense: 'MIT AND Apache-2.0',
      weightsLicense: [...new Set(l.components.map((c) => c.entry.weightLicense))].join(' AND '),
      weightsSource: l.components.map((c) => `${c.role}: ${c.entry.weightsSource}`).join('; ') + `; runtime: llama.cpp ${l.definition.llamaCpp.tag} (${l.definition.llamaCpp.commit}, MIT)`,
      runtime: 'llama.cpp',
      input: { width: 384, height: 384, colorSpace: 'RGB', letterbox: false, resizeMode: 'fixed' },
      components: l.components.map((c) => ({ role: c.role, name: c.entry.name, version: c.entry.version, sha256: c.entry.sha256, weightsLicense: c.entry.weightLicense })),
      // Agreement with operator verdicts has not been measured (needs a pilot's alarm feedback).
      evaluation: null,
    };
  }

  describe(): AdapterDescriptorV1 {
    const card = this.modelCard();
    return { contract: AI_ADAPTER_CONTRACT, adapterId: this.opts.adapterId, adapterVersion: this.opts.adapterVersion, tasks: ['vlm_verification'], models: card ? [card] : [], requiresNetworkEgress: false };
  }

  health(): AdapterHealthV1 {
    const max = this.opts.maxInFlight ?? 1;
    const failure = this.failure();
    return {
      contract: AI_ADAPTER_CONTRACT,
      adapterId: this.opts.adapterId,
      status: failure ? 'FAILED' : this.inFlight >= max ? 'DEGRADED' : 'READY',
      loadedModelIds: failure ? [] : [this.modelId],
      lastError: failure,
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
      runtime: `llama.cpp@${l.definition.llamaCpp.tag}`,
      executionProvider: 'cpu',
      inferenceId: crypto.randomUUID(),
      frameTimestampUtc,
      components: [
        ...l.components.map((c) => ({ role: c.role, modelName: c.entry.name, modelVersion: c.entry.version, modelSha256: c.entry.sha256 })),
        { role: 'runtime', modelName: 'llama-server', modelVersion: l.runtime.buildInfo, modelSha256: l.runtime.binarySha256 },
      ],
    };
  }

  async handleInferRequest(body: unknown): Promise<InferenceResultV1> {
    const requestId = body && typeof (body as any).requestId === 'string' && (body as any).requestId ? (body as any).requestId.slice(0, 200) : 'unidentified-request';
    try {
      const req = validateRequest(body);
      const failure = this.failure();
      if (failure) throw new AdapterError('MODEL_NOT_LOADED', failure);
      if (req.task !== 'vlm_verification') throw new AdapterError('UNSUPPORTED_TASK', `task '${req.task}' is not served by this adapter (vlm_verification)`);
      if (req.modelId !== this.modelId) throw new AdapterError('MODEL_NOT_LOADED', `model '${req.modelId}' is not loaded (loaded: ${this.modelId})`);
      const targetClass = req.vlmQuery!.targetClass;
      if (!this.loaded!.definition.targetClasses.includes(targetClass)) throw new AdapterError('UNSUPPORTED_TASK', `target class '${targetClass}' is not one this adapter checks`);
      const f = req.frame;
      if (f.format !== 'jpeg' || f.data.kind !== 'inline_base64') throw new AdapterError('INVALID_FRAME', 'vlm_verification needs an inline_base64 jpeg frame');
      const max = this.opts.maxInFlight ?? 1;
      if (this.inFlight >= max) {
        this.metrics.inc('vigilone_ai_requests_rejected_total', 'Requests rejected by backpressure', { reason: 'overloaded' });
        throw new AdapterError('OVERLOADED', `VLM adapter busy: ${this.inFlight} running`);
      }
      // Count the request before any await so a burst cannot slip past the limit.
      this.inFlight++;
      const started = Date.now();
      let a: VlmAnswer;
      try {
        const jpeg = Buffer.from(f.data.value, 'base64');
        await decodeJpeg(jpeg, f.width, f.height); // a real JPEG of the declared size, or INVALID_FRAME
        a = await this.loaded!.ask(jpeg, targetClass, req.deadlineMs);
      } finally {
        this.inFlight--;
      }
      const latencyMs = Date.now() - started;
      if (latencyMs > req.deadlineMs) throw new AdapterError('DEADLINE_EXCEEDED', `answer ready after ${latencyMs}ms, deadline was ${req.deadlineMs}ms`);
      this.metrics.inc('vigilone_ai_inferences_total', 'Inferences by outcome', { outcome: 'ok' });
      this.metrics.inc('vigilone_vlm_answers_total', 'Second-opinion answers', { answer: a.answer });
      this.metrics.observe('vigilone_ai_inference_latency_ms', 'End-to-end VLM latency', LATENCY_BUCKETS_MS, latencyMs);
      return {
        contract: AI_ADAPTER_CONTRACT,
        status: 'ok',
        requestId: req.requestId,
        detections: [],
        verification: { targetClass, answer: a.answer, reason: a.reason, promptSha256: a.promptSha256 },
        provenance: this.provenance(f.timestampUtc),
        latencyMs,
      };
    } catch (err: any) {
      const code: AdapterErrorCode = err instanceof AdapterError ? err.code : 'RUNTIME_ERROR';
      this.metrics.inc('vigilone_ai_inferences_total', 'Inferences by outcome', { outcome: code });
      return { contract: AI_ADAPTER_CONTRACT, status: 'error', requestId, errorCode: code, message: (err?.message || 'inference failed').slice(0, 2000), retryable: RETRYABLE[code] };
    }
  }
}
