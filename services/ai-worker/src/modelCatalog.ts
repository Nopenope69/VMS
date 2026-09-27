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
  /** candidateModels only: file inside a downloaded archive (e.g. a wheel). */
  archive?: { format: 'zip'; sha256: string; member: string; fileName: string };
  extraFiles?: Array<{ url: string; sha256: string; fileName: string }>;
  role?: string;
  governance?: { status: string; question: string };
}

export interface ModelLockFile {
  models: ModelLockEntry[];
  /** Weights under an allowed licence whose training data needs a human decision. */
  candidateModels?: ModelLockEntry[];
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
  return path.join(modelsDir, entry.archive ? entry.archive.fileName : (entry.url.split('/').pop() as string));
}

/** A candidate model (candidateModels) by key; never returned by findLockEntry. */
export function findCandidateEntry(key: string, lock: ModelLockFile = readModelLock()): ModelLockEntry {
  const e = (lock.candidateModels || []).find((m) => m.key === key || m.name === key);
  if (!e) throw new Error(`Unknown candidate model '${key}'`);
  return e;
}

export interface ModelLicenseApproval {
  key: string;
  sha256: string;
  approvedBy: string;
  approvedAt: string;
  reason: string;
}

/** Human approvals for candidate models (scripts/models/model-license-exceptions.json). */
export function readLicenseApprovals(file = process.env.VIGILONE_MODEL_EXCEPTIONS || path.join(path.dirname(resolveModelLockPath()), 'model-license-exceptions.json')): ModelLicenseApproval[] {
  if (!fs.existsSync(file)) return [];
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  return (Array.isArray(j.approvals) ? j.approvals : []).filter(
    (a: any) => a && typeof a.key === 'string' && /^[a-f0-9]{64}$/.test(a.sha256) && a.approvedBy && a.approvedAt && a.reason
  );
}

export class CandidateModelNotApproved extends Error {
  readonly code = 'LICENSE_REJECTED';
}

/**
 * The product may run a candidate model only with a human approval for that exact SHA-256.
 * Tests and evaluation tools load candidates directly and never go through this check.
 */
export function assertCandidateApproved(entry: ModelLockEntry, approvals: ModelLicenseApproval[] = readLicenseApprovals()): ModelLicenseApproval {
  const a = approvals.find((x) => x.key === entry.key && x.sha256 === entry.sha256);
  if (!a) {
    throw new CandidateModelNotApproved(
      `LICENSE_REJECTED: ${entry.key} is a candidate model pending human review (${entry.governance?.question ?? 'training-data licence'}); ` +
        `add an approval to model-license-exceptions.json to run it`
    );
  }
  return a;
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
