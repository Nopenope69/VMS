import { AdapterError } from '../adapter/adapterCore';
import { decodeRequestFrame } from '../adapter/frameDecode';
import { AI_ADAPTER_CONTRACT, InferenceRequestV1, InferenceResultV1, ModelCardV1, TextEmbeddingRequestV1 } from '../adapter/contract';
import { PipelineAdapterCore, PipelineAdapterOptions, PipelineCardBase } from '../adapter/pipelineAdapterCore';
import { ortRuntimeLabel } from '../runtimeInfo';
import { EMBEDDING_DIM, LoadedEmbeddingPipeline } from './embeddingPipeline';

const MAX_TEXT_CHARS = 512;

/**
 * ai-adapter.v1.1 for embeddings (contract rules: PipelineAdapterCore): task `embedding` (a JPEG or raw crop
 * in, a 768-dim vector out) and the optional `POST /v1/embed-text` (text in, a vector in the same space out).
 * The vector is what the model produced; consumers normalise. No image or text is kept: nothing is written to
 * disk and no request content is logged.
 */
export class EmbeddingAdapterCore extends PipelineAdapterCore<LoadedEmbeddingPipeline> {
  constructor(loaded: LoadedEmbeddingPipeline | null, opts: PipelineAdapterOptions) {
    super(loaded, opts, ['embedding'], 'embedding pipeline');
  }

  protected card(_l: LoadedEmbeddingPipeline, base: PipelineCardBase): ModelCardV1 {
    return {
      ...base,
      classes: ['embedding'],
      runtime: 'onnxruntime',
      input: { width: 224, height: 224, colorSpace: 'RGB', letterbox: false, resizeMode: 'fixed' },
      // Retrieval quality on site data has not been measured (needs labelled site queries).
      evaluation: null,
    };
  }

  protected runtime() {
    return { runtime: ortRuntimeLabel() };
  }

  /** Embeds under the slot and deadline, checks the dimension and wraps the vector as an ok result. */
  private async embedResult(requestId: string, deadlineMs: number, timestampUtc: string, kind: 'image' | 'text', work: () => Promise<Float32Array>) {
    const { value: vector, latencyMs } = await this.inSlot(deadlineMs, work);
    if (vector.length !== EMBEDDING_DIM) throw new AdapterError('RUNTIME_ERROR', `model produced ${vector.length} components, expected ${EMBEDDING_DIM}`);
    this.metrics.inc('vigilone_embeddings_total', 'Embeddings produced', { kind });
    const bytes = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength); // little-endian on every supported platform
    return this.ok(requestId, timestampUtc, latencyMs, {
      embedding: { dim: EMBEDDING_DIM, encoding: 'float32_base64', vector: bytes.toString('base64'), normalized: false },
    });
  }

  protected async run(req: InferenceRequestV1) {
    const f = req.frame;
    const loaded = this.loaded!;
    return this.embedResult(req.requestId, req.deadlineMs, f.timestampUtc, 'image', async () => loaded.embedImage(await decodeRequestFrame(f as any)));
  }

  /** `POST /v1/embed-text` (ai-adapter.v1.1). */
  async handleTextEmbedRequest(body: unknown): Promise<InferenceResultV1> {
    return this.answer(body, async () => {
      const b = body as Partial<TextEmbeddingRequestV1> | null;
      const bad = (m: string) => new AdapterError('INVALID_FRAME', `invalid TextEmbeddingRequestV1: ${m}`);
      if (!b || typeof b !== 'object') throw bad('body must be a JSON object');
      if (b.contract !== AI_ADAPTER_CONTRACT) throw bad(`contract must be '${AI_ADAPTER_CONTRACT}'`);
      for (const k of ['requestId', 'tenantId', 'modelId'] as const) if (typeof b[k] !== 'string' || !b[k]) throw bad(`${k} is required`);
      if (typeof b.text !== 'string' || b.text.trim().length === 0 || b.text.length > MAX_TEXT_CHARS) throw bad(`text must be 1 to ${MAX_TEXT_CHARS} characters and not blank`);
      if (!Number.isInteger(b.deadlineMs) || (b.deadlineMs as number) <= 0 || (b.deadlineMs as number) > 60000) throw bad('deadlineMs must be an integer in (0, 60000]');
      this.requireModel(b.modelId as string);
      const text = b.text;
      const loaded = this.loaded!;
      return this.embedResult(b.requestId as string, b.deadlineMs as number, new Date().toISOString(), 'text', () => loaded.embedText(text));
    });
  }
}
