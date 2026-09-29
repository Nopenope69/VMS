/**
 * Object-crop capture on the detection path (Phase 5, P5.1), behind VIGILONE_FEATURE_OBJECT_CROPS
 * (default OFF).
 *
 * A crop is cut from the detection's own snapshot image (the file named by `snapshotPath`) with
 * ffmpeg's crop filter and stored by the CropStore. Nothing is captured when there is no snapshot,
 * no bounding box or no object class: the class decides whether the crop is a person crop, so it is
 * never guessed. Person crops go through the per-site policy gate (SiteCropPolicy: off unless the
 * site recorded a purpose); the CropStore enforces it again on write.
 *
 * Capture is best-effort by design and loud by rule: a failure never stops detection ingestion or
 * touches recording, and every failure is logged (rate-limited per code) and counted. The expected
 * "person crops are off for this site" answer is counted as `policy_denied`, not logged as an error.
 * Note: the ai-worker does not write snapshot files today, so in a live deployment nothing is
 * captured until a snapshot source exists.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { MetricsService } from '../observability/metrics.service';
import { snapshotRoots } from '../privacy/dataProtection.service';
import { CropClass, CropPolicy, CropStore, CropStoreError, DEFAULT_CROP_POLICY, StoredCrop } from './cropStore';

const METRIC = 'vigilone_crops_total';
const METRIC_HELP = 'Object crops by capture outcome';
const PERSON_CLASSES = new Set(['person']);

export interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CropCaptureInput {
  tenantId: string;
  cameraId: string;
  detectionId: string;
  objectClass?: string | null;
  boundingBox?: CropBox | null;
  snapshotPath?: string | null;
  capturedAt: Date;
}

export type CropCaptureOutcome = 'stored' | 'exists' | 'policy_denied' | 'skipped' | 'failed';

/** Where crops live: CROPS_DIR, else <RECORDINGS_DIR>/crops. Must be absolute. */
export function cropsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.CROPS_DIR || path.join(env.RECORDINGS_DIR || '/recordings', 'crops');
  if (!path.isAbsolute(root)) throw new CropStoreError('BAD_ID', `CROPS_DIR must be an absolute path, got "${root}"`);
  return path.resolve(root);
}

function envBytes(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new CropStoreError('BAD_ID', `${name} must be a non-negative number, got "${raw}"`);
  return n;
}

/** The effective policy for a site: person crops off unless the site row says otherwise. */
export async function loadCropPolicy(prisma: PrismaClient, siteId: string, env: NodeJS.ProcessEnv = process.env): Promise<CropPolicy> {
  const row = await prisma.siteCropPolicy.findUnique({ where: { siteId } });
  return {
    personCropsEnabled: row?.personCropsEnabled === true && Boolean(row.acknowledgedPurpose),
    nonPersonRetentionDays: row?.nonPersonRetentionDays ?? DEFAULT_CROP_POLICY.nonPersonRetentionDays,
    personRetentionDays: row?.personRetentionDays ?? DEFAULT_CROP_POLICY.personRetentionDays,
    minFreeBytes: envBytes(env, 'CROP_MIN_FREE_BYTES', DEFAULT_CROP_POLICY.minFreeBytes),
    maxCropBytes: envBytes(env, 'CROP_MAX_BYTES', DEFAULT_CROP_POLICY.maxCropBytes),
  };
}

/** The snapshot must be a real file under an allowed snapshot root (symlinks resolved), never an arbitrary path. */
function resolveSnapshot(snapshotPath: string): string {
  let real: string;
  try {
    real = fs.realpathSync(path.resolve(snapshotPath));
  } catch (e) {
    throw new CropStoreError('SOURCE_UNREADABLE', `snapshot cannot be read: ${(e as Error).message}`);
  }
  const inside = snapshotRoots().some((root) => {
    let r: string;
    try {
      r = fs.realpathSync(root);
    } catch {
      return false;
    }
    return real.startsWith(r + path.sep);
  });
  if (!inside) throw new CropStoreError('BAD_ID', 'snapshot is outside the allowed snapshot roots');
  return real;
}

export type CropCutter = (snapshotFile: string, box: CropBox) => Promise<Buffer>;

/** Cuts the normalised box out of an image as a JPEG with ffmpeg. Throws CropStoreError('CUT_FAILED'|'EMPTY'). */
export const ffmpegCropCutter: CropCutter = (file, box) => {
  const x = Math.min(Math.max(box.x, 0), 1);
  const y = Math.min(Math.max(box.y, 0), 1);
  const w = Math.min(box.width, 1 - x);
  const h = Math.min(box.height, 1 - y);
  if (!(w > 0 && h > 0)) return Promise.reject(new CropStoreError('EMPTY', 'the bounding box has no area inside the image'));
  const f = (n: number) => n.toFixed(6);
  // Even dimensions keep the JPEG encoder happy for any input.
  const vf = `crop=trunc(iw*${f(w)}/2)*2:trunc(ih*${f(h)}/2)*2:trunc(iw*${f(x)}):trunc(ih*${f(y)})`;
  return new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      ['-v', 'error', '-nostdin', '-i', file, '-vf', vf, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '3', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, timeout: 15_000 },
      (err, stdout, stderr) => {
        if (err) return reject(new CropStoreError('CUT_FAILED', `ffmpeg could not cut the crop: ${(stderr?.toString() || err.message).trim().slice(0, 300)}`));
        if (!stdout || stdout.length === 0) return reject(new CropStoreError('EMPTY', 'ffmpeg produced no crop bytes'));
        resolve(stdout);
      }
    );
  });
};

const lastLogged = new Map<string, number>();
const LOG_EVERY_MS = 60_000;
/** Lets a test observe the first failure of a code again; production never calls this. */
export const resetCropLogThrottle = (): void => lastLogged.clear();

export class CropCaptureService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cut: CropCutter = ffmpegCropCutter,
    private readonly rootFn: () => string = cropsRoot,
    private readonly makeStore: (root: string, policy: CropPolicy) => CropStore = (root, policy) => new CropStore(root, policy)
  ) {}

  /**
   * Cuts and stores one crop. Returns the stored crop, or null when nothing was captured for a
   * non-error reason (`exists`, `skipped`); throws CropStoreError for a policy refusal or a failure.
   */
  async capture(input: CropCaptureInput): Promise<{ outcome: 'stored'; crop: StoredCrop } | { outcome: 'exists' | 'skipped' }> {
    if (!input.snapshotPath || !input.boundingBox || !input.objectClass) return { outcome: 'skipped' };
    if (await this.prisma.objectCrop.findUnique({ where: { detectionEventId: input.detectionId }, select: { id: true } })) return { outcome: 'exists' };

    const camera = await this.prisma.camera.findUnique({ where: { id: input.cameraId }, select: { siteId: true, tenantId: true } });
    if (!camera || camera.tenantId !== input.tenantId) throw new CropStoreError('BAD_ID', `camera ${input.cameraId} does not belong to tenant ${input.tenantId}`);
    const policy = await loadCropPolicy(this.prisma, camera.siteId);
    const cropClass: CropClass = PERSON_CLASSES.has(input.objectClass.toLowerCase()) ? 'PERSON' : 'NON_PERSON';
    // Refuse before reading or cutting anything: a denied person crop must not even be decoded.
    if (cropClass === 'PERSON' && !policy.personCropsEnabled) throw new CropStoreError('POLICY_DENIED', 'person crops are disabled for this site');

    const bytes = await this.cut(resolveSnapshot(input.snapshotPath), input.boundingBox);
    const store = this.makeStore(this.rootFn(), policy);
    const stored = store.write({ tenantId: input.tenantId, cameraId: input.cameraId, cropId: input.detectionId, capturedAt: input.capturedAt, cropClass, bytes });
    try {
      await this.prisma.objectCrop.create({
        data: {
          tenantId: input.tenantId,
          cameraId: input.cameraId,
          detectionEventId: input.detectionId,
          cropClass,
          objectClass: input.objectClass,
          relativePath: stored.relativePath,
          sha256: stored.sha256,
          byteLength: stored.byteLength,
          capturedAt: input.capturedAt,
          expiresAt: stored.expiresAt,
        },
      });
    } catch (e) {
      // No file without a row: an unlisted crop would never be purged.
      try {
        fs.rmSync(store.resolveInside(stored.relativePath), { force: true });
      } catch {
        /* the original error below is the one to report */
      }
      throw e;
    }
    return { outcome: 'stored', crop: stored };
  }

  /** Never throws. Counts every outcome and logs failures (once a minute per code). Used by detection ingestion. */
  async captureSafely(input: CropCaptureInput): Promise<CropCaptureOutcome> {
    try {
      const r = await this.capture(input);
      MetricsService.incCounter(METRIC, METRIC_HELP, { outcome: r.outcome });
      return r.outcome;
    } catch (err: any) {
      if (err instanceof CropStoreError && err.code === 'POLICY_DENIED') {
        MetricsService.incCounter(METRIC, METRIC_HELP, { outcome: 'policy_denied' });
        return 'policy_denied';
      }
      const code = err instanceof CropStoreError ? err.code : 'ERROR';
      MetricsService.incCounter(METRIC, METRIC_HELP, { outcome: 'failed', code });
      const now = Date.now();
      if (now - (lastLogged.get(code) ?? 0) >= LOG_EVERY_MS) {
        lastLogged.set(code, now);
        console.error(`[Crops] capture failed (${code}) for detection ${input.detectionId}; detection and recording are unaffected: ${err?.message || err}`);
      }
      return 'failed';
    }
  }
}
