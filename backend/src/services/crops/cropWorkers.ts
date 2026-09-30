/**
 * Startup of the crop background workers, called by server.ts. Kept apart from server.ts so the
 * decision (flag off: nothing starts; flag on: the purger starts on a validated interval) is tested.
 */
import { FeatureFlag, isFeatureEnabled } from '../../config/featureFlags';

export const DEFAULT_CROP_PURGE_INTERVAL_MS = 3_600_000;
const MIN_INTERVAL_MS = 1000;

/** CROP_PURGE_INTERVAL_MS, or the default. A value that is not a whole number of at least 1000 ms is a configuration error. */
export function cropPurgeIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CROP_PURGE_INTERVAL_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_CROP_PURGE_INTERVAL_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_INTERVAL_MS) {
    throw new Error(`CROP_PURGE_INTERVAL_MS must be a whole number of at least ${MIN_INTERVAL_MS} milliseconds, got "${raw}"`);
  }
  return n;
}

export interface Startable {
  start(intervalMs: number): void;
  stop(): void;
}

/** Starts the crop purger when VIGILONE_FEATURE_OBJECT_CROPS is on; returns a handle to stop it, or null when it is off. */
export function startCropWorkers(purger: Startable, env: NodeJS.ProcessEnv = process.env): { stop(): void } | null {
  if (!isFeatureEnabled(FeatureFlag.OBJECT_CROPS, env)) return null;
  const interval = cropPurgeIntervalMs(env); // throws before anything starts
  purger.start(interval);
  return { stop: () => purger.stop() };
}
