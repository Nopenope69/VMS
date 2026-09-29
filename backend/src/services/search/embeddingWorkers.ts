/**
 * Startup of the embedding worker, called by server.ts (kept apart so the decision is tested): flag
 * SEMANTIC_SEARCH off starts nothing; on, it needs EMBEDDING_ADAPTER_URL (an http(s) URL) and a valid
 * CROP_EMBED_INTERVAL_MS, and refuses to start, loudly, otherwise.
 */
import { PrismaClient } from '@prisma/client';
import { FeatureFlag, isFeatureEnabled } from '../../config/featureFlags';
import { CropEmbedder } from './cropEmbedder.service';
import { EmbeddingAdapterClient } from './embeddingAdapterClient';

export const DEFAULT_EMBED_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 1000;

export function embedIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CROP_EMBED_INTERVAL_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_EMBED_INTERVAL_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_INTERVAL_MS) throw new Error(`CROP_EMBED_INTERVAL_MS must be a whole number of at least ${MIN_INTERVAL_MS} milliseconds, got "${raw}"`);
  return n;
}

export function embeddingAdapterUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.EMBEDDING_ADAPTER_URL?.trim();
  if (!raw) throw new Error('VIGILONE_FEATURE_SEMANTIC_SEARCH is on but EMBEDDING_ADAPTER_URL is not set; there is no embedding model to call');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`EMBEDDING_ADAPTER_URL is not a URL: "${raw}"`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`EMBEDDING_ADAPTER_URL must be http or https, got "${u.protocol}"`);
  return raw.replace(/\/+$/, '');
}

export interface Startable {
  start(intervalMs: number): void;
  stop(): void;
}

export function startEmbeddingWorkers(
  prisma: PrismaClient,
  env: NodeJS.ProcessEnv = process.env,
  make: (url: string) => Startable = (url) => new CropEmbedder(prisma, new EmbeddingAdapterClient(prisma, url))
): { stop(): void } | null {
  if (!isFeatureEnabled(FeatureFlag.SEMANTIC_SEARCH, env)) return null;
  const url = embeddingAdapterUrl(env); // both throw before anything starts
  const interval = embedIntervalMs(env);
  const worker = make(url);
  worker.start(interval);
  return { stop: () => worker.stop() };
}
