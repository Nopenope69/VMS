import { AdapterError } from '../adapter/adapterCore';
import { decodeFrame } from '../adapter/frameDecode';
import { InferenceResultV1, ModelCardV1 } from '../adapter/contract';
import { PipelineAdapterCore, PipelineAdapterOptions, PipelineCardBase } from '../adapter/pipelineAdapterCore';
import { ortRuntimeLabel } from '../runtimeInfo';
import { Frame } from '../sdk/core';
import { EMBEDDING_DIM, LoadedEmbeddingPipeline } from './embeddingPipeline';

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

  /** Checks the dimension and counts the embedding. */
  private checked(vector: Float32Array, kind: 'image' | 'text'): Float32Array {
    if (vector.length !== EMBEDDING_DIM) throw new AdapterError('RUNTIME_ERROR', `model produced ${vector.length} components, expected ${EMBEDDING_DIM}`);
    this.metrics.inc('vigilone_embeddings_total', 'Embeddings produced', { kind });
    return vector;
  }

  protected async infer(l: LoadedEmbeddingPipeline, f: Frame) {
    return { embedding: this.checked(await l.embedImage(await decodeFrame(f)), 'image') };
  }

  protected async embedText(l: LoadedEmbeddingPipeline, text: string) {
    return this.checked(await l.embedText(text), 'text');
  }

  /** `POST /v1/embed-text` (ai-adapter.v1.1). Never throws. */
  handleTextEmbedRequest(body: unknown): Promise<InferenceResultV1> {
    return this.core.embedText(body) as Promise<InferenceResultV1>;
  }
}
