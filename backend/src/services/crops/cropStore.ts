/**
 * P5.1 object-crop store (filesystem part).
 *
 * Rules, all enforced here and covered by tests:
 *  - paths are derived only from validated ids, never from caller strings, and never leave the root;
 *  - every crop is written atomically (temp file, fsync, rename) and its SHA-256 is returned;
 *  - a write is refused, loudly, when free space cannot be read or is below the floor
 *    (there is deliberately no "assume plenty of space" fallback);
 *  - person crops are refused unless the site policy allows them (DPDP: off until enabled with a purpose);
 *  - purge is hold-aware through an injected predicate and never deletes what it cannot prove is unheld.
 * Nothing here touches recording. Callers must treat CropStoreError as "crop not stored", never as a stream fault.
 */
import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type CropCode = 'BAD_ID' | 'POLICY_DENIED' | 'LOW_SPACE' | 'SPACE_UNKNOWN' | 'EMPTY' | 'TOO_LARGE' | 'WRITE_FAILED';

export class CropStoreError extends Error {
  constructor(public readonly code: CropCode, message: string) {
    super(message);
    this.name = 'CropStoreError';
  }
}

export interface CropPolicy {
  /** Person crops are stored only when true (site switch plus recorded purpose acknowledgement). */
  personCropsEnabled: boolean;
  /** Days to keep non-person crops. */
  nonPersonRetentionDays: number;
  /** Days to keep person crops. */
  personRetentionDays: number;
  /** Refuse writes when free bytes on the volume are at or below this. */
  minFreeBytes: number;
  /** Refuse a single crop larger than this. */
  maxCropBytes: number;
}

export const DEFAULT_CROP_POLICY: CropPolicy = {
  personCropsEnabled: false,
  nonPersonRetentionDays: 14,
  personRetentionDays: 7,
  minFreeBytes: 5 * 1024 ** 3,
  maxCropBytes: 2 * 1024 ** 2,
};

export type CropClass = 'PERSON' | 'NON_PERSON';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const EXT = 'jpg';

export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id);
}

export interface FreeSpaceReader {
  (dir: string): number;
}

/** Free bytes for the volume holding dir. Throws (never guesses) if the platform cannot say. */
export const statfsFreeBytes: FreeSpaceReader = (dir) => {
  if (typeof fs.statfsSync !== 'function') throw new Error('fs.statfsSync is not available');
  const s = fs.statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
};

export interface StoredCrop {
  relativePath: string;
  sha256: string;
  byteLength: number;
  cropClass: CropClass;
  expiresAt: Date;
}

export interface PurgeCandidate {
  cropId: string;
  tenantId: string;
  relativePath: string;
  expiresAt: Date;
}

export interface PurgeResult {
  deleted: string[];
  heldSkipped: string[];
  missing: string[];
  failed: Array<{ cropId: string; error: string }>;
}

export class CropStore {
  private readonly root: string;

  constructor(
    root: string,
    private readonly policy: CropPolicy = DEFAULT_CROP_POLICY,
    private readonly freeBytes: FreeSpaceReader = statfsFreeBytes,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!root || !path.isAbsolute(root)) throw new CropStoreError('BAD_ID', 'crop root must be an absolute path');
    this.root = path.resolve(root);
  }

  retentionDays(c: CropClass): number {
    return c === 'PERSON' ? this.policy.personRetentionDays : this.policy.nonPersonRetentionDays;
  }

  /** Relative path is tenant/camera/yyyy-mm-dd/cropId.jpg from validated parts only. */
  relativePathFor(tenantId: string, cameraId: string, cropId: string, capturedAt: Date): string {
    for (const [k, v] of [['tenantId', tenantId], ['cameraId', cameraId], ['cropId', cropId]] as const) {
      if (!isSafeId(v)) throw new CropStoreError('BAD_ID', `${k} is not a safe identifier`);
    }
    if (!Number.isFinite(capturedAt.getTime())) throw new CropStoreError('BAD_ID', 'capturedAt is not a valid date');
    const day = capturedAt.toISOString().slice(0, 10);
    return `${tenantId}/${cameraId}/${day}/${cropId}.${EXT}`;
  }

  /** Resolve a stored relative path and prove it is inside the root. */
  resolveInside(relativePath: string): string {
    const abs = path.resolve(this.root, relativePath);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) throw new CropStoreError('BAD_ID', 'path escapes the crop root');
    return abs;
  }

  write(input: { tenantId: string; cameraId: string; cropId: string; capturedAt: Date; cropClass: CropClass; bytes: Buffer }): StoredCrop {
    const { cropClass, bytes } = input;
    if (cropClass === 'PERSON' && !this.policy.personCropsEnabled) {
      throw new CropStoreError('POLICY_DENIED', 'person crops are disabled for this site');
    }
    if (!bytes || bytes.length === 0) throw new CropStoreError('EMPTY', 'crop has no bytes');
    if (bytes.length > this.policy.maxCropBytes) throw new CropStoreError('TOO_LARGE', `crop is ${bytes.length} bytes, limit ${this.policy.maxCropBytes}`);
    const rel = this.relativePathFor(input.tenantId, input.cameraId, input.cropId, input.capturedAt);
    const abs = this.resolveInside(rel);
    const dir = path.dirname(abs);

    fs.mkdirSync(dir, { recursive: true });
    let free: number;
    try {
      free = this.freeBytes(dir);
    } catch (e) {
      throw new CropStoreError('SPACE_UNKNOWN', `cannot read free space: ${(e as Error).message}`);
    }
    if (!Number.isFinite(free)) throw new CropStoreError('SPACE_UNKNOWN', 'free space is not a number');
    if (free - bytes.length <= this.policy.minFreeBytes) {
      throw new CropStoreError('LOW_SPACE', `free space ${free} would fall to or below the floor ${this.policy.minFreeBytes}`);
    }

    const tmp = path.join(dir, `.${input.cropId}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      const fd = fs.openSync(tmp, 'wx', 0o640);
      try {
        fs.writeSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, abs);
    } catch (e) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* nothing more to do */
      }
      throw new CropStoreError('WRITE_FAILED', (e as Error).message);
    }
    const expiresAt = new Date(input.capturedAt.getTime() + this.retentionDays(cropClass) * 86_400_000);
    return { relativePath: rel, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, cropClass, expiresAt };
  }

  /** Read a crop and check it still matches the recorded hash. Returns null if the file is gone. */
  readVerified(relativePath: string, expectedSha256: string): Buffer | null {
    const abs = this.resolveInside(relativePath);
    let b: Buffer;
    try {
      b = fs.readFileSync(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    if (createHash('sha256').update(b).digest('hex') !== expectedSha256) {
      throw new CropStoreError('WRITE_FAILED', 'stored crop does not match its recorded hash');
    }
    return b;
  }

  /**
   * Delete expired crops that are not held. isHeld must answer true or false; if it throws, that crop is
   * kept and reported as failed (fail closed: an unanswerable hold check never deletes).
   */
  purge(candidates: PurgeCandidate[], isHeld: (c: PurgeCandidate) => boolean): PurgeResult {
    const r: PurgeResult = { deleted: [], heldSkipped: [], missing: [], failed: [] };
    const t = this.now().getTime();
    for (const c of candidates) {
      if (c.expiresAt.getTime() > t) continue;
      try {
        if (isHeld(c)) {
          r.heldSkipped.push(c.cropId);
          continue;
        }
        const abs = this.resolveInside(c.relativePath);
        if (!fs.existsSync(abs)) {
          r.missing.push(c.cropId);
          continue;
        }
        fs.unlinkSync(abs);
        r.deleted.push(c.cropId);
      } catch (e) {
        r.failed.push({ cropId: c.cropId, error: (e as Error).message });
      }
    }
    return r;
  }
}
