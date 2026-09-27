import fs from 'fs';
import path from 'path';
import {
  ModelClassMapping,
  ModelManifestRecord,
  ModelNmsConfig,
  ModelSignature,
  ModelThresholds,
  RuntimeConfig,
} from './types';

/** One pinned model in scripts/models/models.lock.json. */
export interface ModelLockEntry {
  key: string;
  name: string;
  version: string;
  sha256: string;
  sizeBytes: number;
  url: string;
  task: string;
  codeLicense: string;
  weightLicense: string;
  weightsSource: string;
  trainingData: { source: string; license: string; provenance: string; commercialUse: boolean };
  thresholds: ModelThresholds;
  runtimeConfig: RuntimeConfig;
  modelSignature: ModelSignature;
  classes: ModelClassMapping;
  nmsConfig: ModelNmsConfig;
  attributionRequired: boolean;
  noticeRequired: boolean;
  licenseNotes: string;
}

export interface ModelLockFile {
  models: ModelLockEntry[];
  default: string;
}

/** Locates the lock file: $VIGILONE_MODEL_LOCK, else the repository copy. */
export function resolveModelLockPath(): string {
  if (process.env.VIGILONE_MODEL_LOCK) return process.env.VIGILONE_MODEL_LOCK;
  const candidates = [
    path.resolve(__dirname, '../../../scripts/models/models.lock.json'), // src/ or dist/ in the repo
    path.resolve(process.cwd(), 'scripts/models/models.lock.json'),
    '/app/models.lock.json', // container image
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(`MODEL_LOCK_NOT_FOUND: none of ${candidates.join(', ')} exists; set VIGILONE_MODEL_LOCK`);
  }
  return found;
}

export function readModelLock(lockPath: string = resolveModelLockPath()): ModelLockFile {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as ModelLockFile;
  if (!Array.isArray(lock.models) || lock.models.length === 0) {
    throw new Error(`Model lock file ${lockPath} lists no models`);
  }
  return lock;
}

export function findLockEntry(key: string, lock: ModelLockFile = readModelLock()): ModelLockEntry {
  const e = lock.models.find((m) => m.key === key || m.name === key);
  if (!e) throw new Error(`Unknown model '${key}' (lock file has: ${lock.models.map((m) => m.key).join(', ')})`);
  return e;
}

/** Models directory: $VIGILONE_MODELS_DIR, else <repo>/.cache/models (what fetch-model.sh uses). */
export function resolveModelsDir(): string {
  return process.env.VIGILONE_MODELS_DIR || path.resolve(__dirname, '../../../.cache/models');
}

export function artifactPathFor(entry: ModelLockEntry, modelsDir: string = resolveModelsDir()): string {
  return path.join(modelsDir, entry.url.split('/').pop() as string);
}

/** Builds the worker-side manifest record for a lock entry (id is the backend registry id). */
export function manifestFromLockEntry(entry: ModelLockEntry, id: string): ModelManifestRecord {
  return {
    id,
    name: entry.name,
    version: entry.version,
    sha256: entry.sha256,
    codeLicense: entry.codeLicense,
    weightLicense: entry.weightLicense,
    runtimeConfigJson: entry.runtimeConfig,
    thresholdsJson: entry.thresholds,
    classesJson: entry.classes,
    modelSignatureJson: entry.modelSignature,
    nmsConfigJson: entry.nmsConfig,
    isActive: true,
    weightsSource: entry.weightsSource,
  };
}
