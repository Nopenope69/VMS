/**
 * Prompt-template ensembling for text queries (the zero-shot technique used with CLIP-family models): embed
 * the query in several natural phrasings and average the normalised vectors, instead of trusting one phrasing.
 *
 * Off by default (`QUERY_TEMPLATE_ENSEMBLE`). Whether it improves recall on this appliance's real queries is NOT
 * measured: it must be compared with the plain query on labelled site queries before the default changes.
 * It costs one text-encoder call per template for every text term of a query.
 */
import type { EmbeddingResult } from './embeddingAdapterClient';
import { DEFAULT_TEMPLATES, applyTemplate } from './templateList';
import { EmbeddingError } from './cropEmbeddingStore';

export { DEFAULT_TEMPLATES, MAX_TEMPLATES, parseTemplates, applyTemplate } from './templateList';

function unit(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s);
  if (!(n > 1e-6)) throw new EmbeddingError('EMBEDDING_INVALID', 'embedding has zero length; cosine similarity is undefined');
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/**
 * Embeds `query` once per template and returns the normalised mean. Every call must be served by the same model
 * and adapter; otherwise the vectors are not comparable and the query fails instead of mixing them.
 */
export async function ensembleTextEmbedding(
  embedText: (text: string) => Promise<EmbeddingResult>,
  query: string,
  templates: readonly string[] = DEFAULT_TEMPLATES
): Promise<EmbeddingResult> {
  if (templates.length === 0) throw new Error('no templates');
  const results: EmbeddingResult[] = [];
  for (const t of templates) results.push(await embedText(applyTemplate(t, query)));
  const first = results[0];
  for (const r of results) {
    if (r.model.sha256 !== first.model.sha256 || r.adapterId !== first.adapterId) {
      throw new EmbeddingError('EMBEDDING_INVALID', 'the embedding model changed during the query; try again');
    }
    if (r.vector.length !== first.vector.length) throw new EmbeddingError('EMBEDDING_INVALID', 'embedding sizes differ between templates');
  }
  const mean = new Float32Array(first.vector.length);
  for (const r of results) {
    const u = unit(r.vector);
    for (let i = 0; i < mean.length; i++) mean[i] += u[i];
  }
  for (let i = 0; i < mean.length; i++) mean[i] /= results.length;
  return {
    vector: unit(mean),
    model: first.model,
    adapterId: first.adapterId,
    inferenceId: results.map((r) => r.inferenceId).join('+'),
  };
}
