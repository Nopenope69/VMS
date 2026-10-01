import { AdapterError, decodeJpeg } from '../adapter/adapterCore';
import { InferenceRequestV1, ModelCardV1 } from '../adapter/contract';
import { PipelineAdapterCore, PipelineAdapterOptions, PipelineCardBase } from '../adapter/pipelineAdapterCore';
import { LoadedVlmPipeline } from './vlmPipeline';

/**
 * ai-adapter.v1.1 for the alarm second opinion (contract rules: PipelineAdapterCore): task `vlm_verification`,
 * a JPEG frame and a target class in, `verification` { answer: yes | no | unclear, reason, promptSha256 } out.
 * One request at a time (a VLM call takes seconds on CPU). Nothing is stored or logged here: the image and the
 * answer only pass through. The model runs in a llama.cpp sidecar (ADR 0005); FAILED when it is not running.
 */
export class VlmAdapterCore extends PipelineAdapterCore<LoadedVlmPipeline> {
  constructor(loaded: LoadedVlmPipeline | null, opts: PipelineAdapterOptions) {
    super(loaded, opts, ['vlm_verification'], 'VLM pipeline');
  }

  protected failure(): string | null {
    if (!this.loaded) return this.opts.failure || 'VLM pipeline not loaded';
    if (!this.loaded.alive()) return 'llama-server is not running';
    return null;
  }

  protected card(l: LoadedVlmPipeline, base: PipelineCardBase): ModelCardV1 {
    return {
      ...base,
      classes: l.definition.targetClasses,
      codeLicense: 'MIT AND Apache-2.0',
      weightsSource: `${base.weightsSource}; runtime: llama.cpp ${l.definition.llamaCpp.tag} (${l.definition.llamaCpp.commit}, MIT)`,
      runtime: 'llama.cpp',
      input: { width: 384, height: 384, colorSpace: 'RGB', letterbox: false, resizeMode: 'fixed' },
      // Agreement with operator verdicts has not been measured (needs a pilot's alarm feedback).
      evaluation: null,
    };
  }

  protected runtime(l: LoadedVlmPipeline) {
    return {
      runtime: `llama.cpp@${l.definition.llamaCpp.tag}`,
      extraComponents: [{ role: 'runtime', modelName: 'llama-server', modelVersion: l.runtime.buildInfo, modelSha256: l.runtime.binarySha256 }],
    };
  }

  protected async run(req: InferenceRequestV1) {
    const loaded = this.loaded!;
    const targetClass = req.vlmQuery!.targetClass;
    if (!loaded.definition.targetClasses.includes(targetClass)) throw new AdapterError('UNSUPPORTED_TASK', `target class '${targetClass}' is not one this adapter checks`);
    const f = req.frame;
    if (f.format !== 'jpeg' || f.data.kind !== 'inline_base64') throw new AdapterError('INVALID_FRAME', 'vlm_verification needs an inline_base64 jpeg frame');
    const data = f.data.value;
    const { value: a, latencyMs } = await this.inSlot(req.deadlineMs, async () => {
      const jpeg = Buffer.from(data, 'base64');
      await decodeJpeg(jpeg, f.width, f.height); // a real JPEG of the declared size, or INVALID_FRAME
      return loaded.ask(jpeg, targetClass, req.deadlineMs);
    });
    this.metrics.inc('vigilone_vlm_answers_total', 'Second-opinion answers', { answer: a.answer });
    return this.ok(req.requestId, f.timestampUtc, latencyMs, {
      verification: { targetClass, answer: a.answer, reason: a.reason, promptSha256: a.promptSha256 },
    });
  }
}
