/**
 * Embedding pipeline (Phase 5): SigLIP 2 base (patch 16, 224 px). The image tower turns a crop into a
 * 768-dim vector, the text tower turns search text into a vector in the same space. Both are candidate
 * models (unpublished training data), so like the other pipelines the worker verifies every file's
 * SHA-256 and refuses to run without a human approval for each (LICENSE_REJECTED).
 *
 * The vector returned is the towers' `pooler_output`, exactly what the official transformers
 * `get_image_features` / `get_text_features` produce (tools/reference/siglip2_reference.py); it is
 * L2-normalised by the backend before it is stored.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { OrtSession } from '../anpr/ortSession';
import { Image3 } from '../anpr/imageOps';
import { AnprLoadError, VerifiedComponent, verifyPipelineComponents } from '../anpr/anprService';
import { resolveModelLockPath } from '../modelCatalog';
import { SIGLIP2_INPUT, siglip2Preprocess } from './preprocess';

export const EMBEDDING_DIM = 768;

export interface EmbeddingPipelineDefinition {
  name: string;
  version: string;
  tasks: string[];
  components: Array<{ role: string; key: string; sha256: string }>;
  dim: number;
  text: { maxTokens: number; lowercase: boolean; padTokenId: number };
}

export interface LoadedEmbeddingPipeline {
  definition: EmbeddingPipelineDefinition;
  definitionSha256: string;
  components: VerifiedComponent[];
  /** Image embedding (768 floats, not normalised). */
  embedImage(img: Image3): Promise<Float32Array>;
  /** Text embedding (768 floats, not normalised). */
  embedText(text: string): Promise<Float32Array>;
  /** Token ids exactly as sent to the text tower (padded to maxTokens); exposed for tests. */
  tokenize(text: string): number[];
}

export function resolveEmbeddingPipelinePath(): string {
  return path.join(path.dirname(resolveModelLockPath()), 'pipelines', 'embedding-siglip2-v1.json');
}

interface TokenizerLike {
  encode(text: string): { ids: number[] };
}

/** Lower-cases, encodes, truncates to maxTokens (keeping the closing EOS) and pads, as SigLIP 2 was trained. */
export function buildTokenIds(tok: TokenizerLike, text: string, def: EmbeddingPipelineDefinition['text']): number[] {
  const src = def.lowercase ? text.toLowerCase() : text;
  let ids = Array.from(tok.encode(src).ids);
  if (ids.length > def.maxTokens) {
    const eos = ids[ids.length - 1];
    ids = ids.slice(0, def.maxTokens - 1);
    ids.push(eos);
  }
  while (ids.length < def.maxTokens) ids.push(def.padTokenId);
  return ids;
}

export async function loadEmbeddingPipeline(opts: { definitionPath?: string; evaluationOnly?: boolean; modelsDir?: string } = {}): Promise<LoadedEmbeddingPipeline> {
  const defPath = opts.definitionPath ?? resolveEmbeddingPipelinePath();
  if (!fs.existsSync(defPath)) throw new AnprLoadError('ARTIFACT_MISSING', `pipeline definition ${defPath} not found`);
  const raw = fs.readFileSync(defPath);
  const def = JSON.parse(raw.toString('utf8')) as EmbeddingPipelineDefinition;
  if (!Array.isArray(def.components) || !Array.isArray(def.tasks) || !def.tasks.includes('embedding') || def.dim !== EMBEDDING_DIM) {
    throw new AnprLoadError('INVALID_PIPELINE', `${defPath} is not a ${EMBEDDING_DIM}-dimension embedding pipeline`);
  }
  const { loaded, buffers } = verifyPipelineComponents(def.components, opts);
  const tokEntry = loaded.find((c) => c.role === 'text_encoder')?.entry.extraFiles?.[0];
  if (!buffers.image_encoder || !buffers.text_encoder || !tokEntry) throw new AnprLoadError('INVALID_PIPELINE', 'an image_encoder, a text_encoder and its tokenizer file are required');

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Tokenizer } = require('@huggingface/tokenizers');
  const tokenizer: TokenizerLike = new Tokenizer(JSON.parse(buffers[`text_encoder:${tokEntry.fileName}`].toString('utf8')), {});
  const image = await OrtSession.create(buffers.image_encoder);
  const text = await OrtSession.create(buffers.text_encoder);
  if (!image.inputNames.includes('pixel_values') || !image.outputNames.includes('pooler_output')) throw new AnprLoadError('INVALID_PIPELINE', `image tower has inputs ${image.inputNames} and outputs ${image.outputNames}`);
  if (!text.inputNames.includes('input_ids') || !text.outputNames.includes('pooler_output')) throw new AnprLoadError('INVALID_PIPELINE', `text tower has inputs ${text.inputNames} and outputs ${text.outputNames}`);

  const checkDim = (r: { data: Float32Array; dims: number[] }, what: string) => {
    if (r.dims.length !== 2 || r.dims[0] !== 1 || r.dims[1] !== EMBEDDING_DIM || r.data.length !== EMBEDDING_DIM) throw new Error(`${what} tower returned shape [${r.dims}], expected [1,${EMBEDDING_DIM}]`);
    for (let i = 0; i < r.data.length; i++) if (!Number.isFinite(r.data[i])) throw new Error(`${what} tower returned a non-finite value`);
    return Float32Array.from(r.data);
  };

  return {
    definition: def,
    definitionSha256: crypto.createHash('sha256').update(raw).digest('hex'),
    components: loaded,
    tokenize: (t) => buildTokenIds(tokenizer, t, def.text),
    async embedImage(img) {
      const out = await image.run({ pixel_values: { type: 'float32', data: siglip2Preprocess(img), dims: [1, 3, SIGLIP2_INPUT, SIGLIP2_INPUT] } });
      return checkDim(out.pooler_output, 'image');
    },
    async embedText(t) {
      const ids = BigInt64Array.from(buildTokenIds(tokenizer, t, def.text), (x) => BigInt(x));
      const out = await text.run({ input_ids: { type: 'int64', data: ids, dims: [1, def.text.maxTokens] } });
      return checkDim(out.pooler_output, 'text');
    },
  };
}
