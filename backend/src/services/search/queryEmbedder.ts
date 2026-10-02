/**
 * Embeds a search query (text, or an uploaded JPEG) with the verified embedding adapter, so it can be compared
 * with stored crop embeddings. Health, descriptor and model registry are checked on every query: it is cheap
 * next to an inference, and a model swapped under us is caught instead of compared against the wrong vectors.
 */
import prisma from '../../config/database';
import { EmbeddingAdapterClient, EmbeddingResult } from './embeddingAdapterClient';
import { embeddingAdapterUrl } from './embeddingWorkers';

export interface QueryEmbedder {
  text(text: string): Promise<EmbeddingResult>;
  image(jpeg: Buffer): Promise<EmbeddingResult>;
}

/** The adapter-backed embedder, or null when no embedding adapter is configured. */
export function defaultQueryEmbedder(): QueryEmbedder | null {
  let url: string;
  try {
    url = embeddingAdapterUrl();
  } catch {
    return null;
  }
  const connected = async () => {
    const client = new EmbeddingAdapterClient(prisma, url, 10000);
    await client.connect();
    return client;
  };
  return {
    text: async (text) => (await connected()).embedText(text),
    image: async (jpeg) => (await connected()).embed(jpeg, new Date().toISOString()),
  };
}

let override: QueryEmbedder | null | undefined;
/** Test hook: replace (or with null, remove) the query embedder. undefined restores the default. */
export function setQueryEmbedderForTests(e: QueryEmbedder | null | undefined) {
  override = e;
}
export const queryEmbedder = (): QueryEmbedder | null => (override !== undefined ? override : defaultQueryEmbedder());
