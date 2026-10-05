import { AdapterError } from '../adapter/adapterCore';
import { InferenceResultV1, ModelCardV1 } from '../adapter/contract';
import { PipelineAdapterCore, PipelineAdapterOptions, PipelineCardBase } from '../adapter/pipelineAdapterCore';
import { InferContext } from '../sdk/core';
import { LoadedQueryRewritePipeline } from './queryRewritePipeline';

/**
 * ai-adapter.v1.2 for plain-language search (contract rules: PipelineAdapterCore): task `query_rewrite`, served
 * only on `POST /v1/rewrite-text` (text and place names in, plain English out, with the prompt hash). There is no
 * image task: `/v1/infer` answers UNSUPPORTED_TASK. Nothing is stored or logged here; the request only passes
 * through. FAILED when the llama.cpp sidecar is not running.
 */
export class QueryRewriteAdapterCore extends PipelineAdapterCore<LoadedQueryRewritePipeline> {
  constructor(loaded: LoadedQueryRewritePipeline | null, opts: PipelineAdapterOptions) {
    super(loaded, opts, ['query_rewrite'], 'query rewrite pipeline');
  }

  protected liveness(l: LoadedQueryRewritePipeline): string | null {
    return l.alive() ? null : 'llama-server is not running';
  }

  protected card(l: LoadedQueryRewritePipeline, base: PipelineCardBase): ModelCardV1 {
    return {
      ...base,
      classes: ['text'],
      codeLicense: 'MIT AND Apache-2.0',
      weightsSource: `${base.weightsSource}; runtime: llama.cpp ${l.definition.llamaCpp.tag} (${l.definition.llamaCpp.commit}, MIT)`,
      runtime: 'llama.cpp',
      // Text in, text out: the image input fields are not used.
      input: { width: 1, height: 1, colorSpace: 'RGB', letterbox: false, resizeMode: 'fixed' },
      // Measured on the labelled search requests (docs/ai/nl-search-evaluation.md); no site requests yet.
      evaluation: null,
    };
  }

  protected runtime(l: LoadedQueryRewritePipeline) {
    return {
      runtime: `llama.cpp@${l.definition.llamaCpp.tag}`,
      extraComponents: [{ role: 'runtime', modelName: 'llama-server', modelVersion: l.runtime.buildInfo, modelSha256: l.runtime.binarySha256 }],
    };
  }

  protected async infer(): Promise<never> {
    throw new AdapterError('UNSUPPORTED_TASK', 'the query rewrite model takes text on POST /v1/rewrite-text, not frames');
  }

  protected async rewriteText(l: LoadedQueryRewritePipeline, text: string, vocabulary: string[], ctx: InferContext) {
    const r = await l.rewrite(text, vocabulary, ctx.deadlineMs);
    this.metrics.inc('vigilone_query_rewrites_total', 'Search requests rewritten into English');
    return r;
  }

  /** `POST /v1/rewrite-text` (ai-adapter.v1.2). Never throws. */
  handleTextRewriteRequest(body: unknown): Promise<InferenceResultV1> {
    return this.core.rewriteText(body) as Promise<InferenceResultV1>;
  }
}
