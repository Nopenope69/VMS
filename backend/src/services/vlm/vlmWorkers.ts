/**
 * Startup of the VLM second-opinion worker, called by server.ts: flag VLM_VERIFICATION off starts nothing;
 * on, it needs VLM_ADAPTER_URL (an http(s) URL) and valid intervals, and refuses to start, loudly, otherwise.
 */
import { PrismaClient } from '@prisma/client';
import { FeatureFlag, isFeatureEnabled } from '../../config/featureFlags';
import { VlmAdapterClient } from './vlmAdapterClient';
import { VlmVerifier } from './vlmVerifier.service';

export const DEFAULT_VLM_INTERVAL_MS = 15_000;
export const DEFAULT_VLM_MAX_ALARM_AGE_MS = 3_600_000;

function wholeMs(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be a whole number of at least ${min} milliseconds, got "${raw}"`);
  return n;
}

export function vlmAdapterUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.VLM_ADAPTER_URL?.trim();
  if (!raw) throw new Error('VIGILONE_FEATURE_VLM_VERIFICATION is on but VLM_ADAPTER_URL is not set; there is no VLM to ask');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`VLM_ADAPTER_URL is not a URL: "${raw}"`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`VLM_ADAPTER_URL must be http or https, got "${u.protocol}"`);
  return raw.replace(/\/+$/, '');
}

export function vlmSettings(env: NodeJS.ProcessEnv = process.env) {
  return {
    url: vlmAdapterUrl(env),
    intervalMs: wholeMs(env, 'VLM_VERIFY_INTERVAL_MS', DEFAULT_VLM_INTERVAL_MS, 1000),
    maxAlarmAgeMs: wholeMs(env, 'VLM_MAX_ALARM_AGE_MS', DEFAULT_VLM_MAX_ALARM_AGE_MS, 60_000),
  };
}

export interface Startable {
  start(intervalMs: number): void;
  stop(): void;
}

export function startVlmWorkers(
  prisma: PrismaClient,
  env: NodeJS.ProcessEnv = process.env,
  make: (url: string, maxAlarmAgeMs: number) => Startable = (url, age) => new VlmVerifier(prisma, new VlmAdapterClient(prisma, url), age)
): { stop(): void } | null {
  if (!isFeatureEnabled(FeatureFlag.VLM_VERIFICATION, env)) return null;
  const s = vlmSettings(env); // throws before anything starts
  const worker = make(s.url, s.maxAlarmAgeMs);
  worker.start(s.intervalMs);
  return { stop: () => worker.stop() };
}
