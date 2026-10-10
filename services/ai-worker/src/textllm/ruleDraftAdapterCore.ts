import { AdapterError } from '../adapter/adapterCore';
import { InferenceResultV1, ModelCardV1, AI_ADAPTER_CONTRACT } from '../adapter/contract';
import { PipelineAdapterCore, PipelineAdapterOptions, PipelineCardBase } from '../adapter/pipelineAdapterCore';
import { InferContext } from '../sdk/core';
import { LoadedRuleDraftPipeline, RuleDraftError } from './ruleDraftPipeline';

export class RuleDraftAdapterCore extends PipelineAdapterCore<LoadedRuleDraftPipeline> {
  constructor(loaded: LoadedRuleDraftPipeline | null, opts: PipelineAdapterOptions) {
    super(loaded, opts, ['rule_draft'], 'rule draft pipeline');
  }

  protected liveness(l: LoadedRuleDraftPipeline): string | null {
    return l.alive() ? null : 'llama-server is not running';
  }

  protected card(l: LoadedRuleDraftPipeline, base: PipelineCardBase): ModelCardV1 {
    return {
      ...base,
      classes: ['text'],
      codeLicense: 'MIT AND Apache-2.0',
      weightsSource: `${base.weightsSource}; runtime: llama.cpp ${l.definition.llamaCpp.tag} (${l.definition.llamaCpp.commit}, MIT)`,
      runtime: 'llama.cpp',
      input: { width: 1, height: 1, colorSpace: 'RGB', letterbox: false, resizeMode: 'fixed' },
      evaluation: null,
    };
  }

  protected runtime(l: LoadedRuleDraftPipeline) {
    return {
      runtime: `llama.cpp@${l.definition.llamaCpp.tag}`,
      extraComponents: [{ role: 'runtime', modelName: 'llama-server', modelVersion: l.runtime.buildInfo, modelSha256: l.runtime.binarySha256 }],
    };
  }

  protected async infer(): Promise<never> {
    throw new AdapterError('UNSUPPORTED_TASK', 'the rule draft model takes text on POST /v1/extract-rule-intent, not frames');
  }

  /** POST /v1/extract-rule-intent. Never throws. */
  async handleRuleIntentRequest(body: unknown): Promise<InferenceResultV1> {
    const t0 = Date.now();
    try {
      if (!this.loaded) {
        throw new AdapterError('MODEL_NOT_LOADED', 'rule draft pipeline is not loaded');
      }
      if (!this.loaded.alive()) {
        throw new AdapterError('MODEL_NOT_LOADED', 'llama-server is not running');
      }
      const b = body as any;
      if (!b || typeof b.instruction !== 'string' || !b.instruction.trim()) {
        throw new AdapterError('INVALID_FRAME', 'instruction must be a non-empty string');
      }
      const locations = Array.isArray(b.locations) ? b.locations : [];
      const deadlineMs = typeof b.deadlineMs === 'number' ? b.deadlineMs : 15000;

      const res = await this.loaded.extractIntent(b.instruction.trim(), locations, deadlineMs);
      this.metrics.inc('vigilone_rule_drafts_total', 'Natural language rule drafts processed');

      return {
        contract: AI_ADAPTER_CONTRACT,
        status: 'ok',
        requestId: b.requestId || `req_${Date.now()}`,
        detections: [],
        ruleIntent: {
          ir: res.ir,
          promptSha256: res.promptSha256,
        },
        provenance: {
          adapterId: this.opts.adapterId,
          adapterVersion: this.opts.adapterVersion,
          modelId: this.modelId,
          modelName: this.loaded.definition.name,
          modelVersion: this.loaded.definition.version,
          modelSha256: this.loaded.definitionSha256,
          runtime: `llama.cpp@${this.loaded.definition.llamaCpp.tag}`,
          inferenceId: `inf_${Date.now()}`,
          frameTimestampUtc: new Date().toISOString(),
          components: this.loaded.components.map((c) => ({
            role: c.role,
            modelName: c.entry.name,
            modelVersion: c.entry.version,
            modelSha256: c.entry.sha256,
          })),
        },
        latencyMs: Date.now() - t0,
      };
    } catch (err: any) {
      const code = err instanceof AdapterError ? err.code : 'RUNTIME_ERROR';
      return {
        contract: AI_ADAPTER_CONTRACT,
        status: 'error',
        requestId: (body as any)?.requestId || 'unknown',
        errorCode: code as any,
        message: err.message || 'rule intent extraction failed',
        retryable: (err instanceof RuleDraftError && err.code === 'RULE_DRAFT_BUSY') || code === 'MODEL_NOT_LOADED',
      };
    }
  }
}
