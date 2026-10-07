/**
 * An integrity finding is not undone by re-registration (docs/audits/RECORDING_CATALOG_AUDIT_2026-10-05.md, F11).
 *
 * The periodic integrity check marks a segment CORRUPTED (HASH_MISMATCH or SIZE_CHANGED) when the file no longer
 * matches what was recorded. The crawler re-registers every file whose row is not FINALIZED; before this fix that
 * re-hashed the changed file, stored the new hash and set the row back to FINALIZED a few minutes later, silently.
 * Such a row now keeps its status, reason, original hash and size: returning it to service is a human decision (or
 * boot recovery's documented repair, which sets repairedSha256). Real database, real files.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';

const previousRecordingsDir = process.env.RECORDINGS_DIR;
const previousGrace = process.env.CRASH_RECOVERY_ACTIVE_WRITE_GRACE_SECONDS;
process.env.CRASH_RECOVERY_ACTIVE_WRITE_GRACE_SECONDS = '120';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vigilone-integrity-sticky-'));
process.env.RECORDINGS_DIR = path.join(root, 'recordings');
fs.mkdirSync(process.env.RECORDINGS_DIR, { recursive: true });
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

import { PrismaClient, SegmentStatus } from '@prisma/client';
import { RecordingCatalog } from '../services/recording/catalog/recordingCatalog.service';
import { SegmentIntegrityVerifier } from '../services/recording/catalog/segmentIntegrity';
import { MediaProbeAdapter, MediaProbeResult } from '../services/recording/catalog/mediaProbeAdapter';
import { CrashRecoveryService } from '../services/reconciliation/crashRecovery.service';
import { createTenantWithCamera } from './helpers/realDb';

jest.setTimeout(60000);

const prisma = new PrismaClient();
let tenantId = '';
let cameraId = '';
let camDir = '';
let seq = 0;

class CountingProbe implements MediaProbeAdapter {
  calls = 0;
  constructor(private result: MediaProbeResult | null) {}
  async probeMedia(): Promise<MediaProbeResult | null> {
    this.calls += 1;
    return this.result;
  }
}
const GOOD_PROBE: MediaProbeResult = { durationMs: 6000, width: 320, height: 240, codec: 'h264', fps: 25, timebaseNumerator: 1, timebaseDenominator: 90000 };

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const age = (file: string) => {
  const t = new Date(Date.now() - 3600_000);
  fs.utimesSync(file, t, t);
};
/** A finished file (aged past the active-write grace) under the camera's folder, with a valid MediaMTX-style name. */
const writeSegmentFile = (bytes: Buffer) => {
  seq += 1;
  const file = path.join(camDir, `2026-10-05_11-${String(seq).padStart(2, '0')}-00-000000.mp4`);
  fs.writeFileSync(file, bytes);
  age(file);
  return file;
};
const rowFor = (filePath: string) => prisma.recordingSegment.findUniqueOrThrow({ where: { filePath } });
const integrityCycle = () => new SegmentIntegrityVerifier(prisma).runCycle({ presenceBatch: 1000, hashBudgetBytes: 1_000_000_000 });

beforeAll(async () => {
  ({ tenantId, cameraId } = await createTenantWithCamera(prisma, 'integritysticky'));
  const cam = await prisma.camera.findUniqueOrThrow({ where: { id: cameraId } });
  camDir = path.join(process.env.RECORDINGS_DIR!, cam.streamPath);
  fs.mkdirSync(camDir, { recursive: true });
});
afterAll(async () => {
  await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await prisma.$disconnect();
  fs.rmSync(root, { recursive: true, force: true });
  if (previousGrace === undefined) delete process.env.CRASH_RECOVERY_ACTIVE_WRITE_GRACE_SECONDS;
  else process.env.CRASH_RECOVERY_ACTIVE_WRITE_GRACE_SECONDS = previousGrace;
  if (previousRecordingsDir === undefined) delete process.env.RECORDINGS_DIR;
  else process.env.RECORDINGS_DIR = previousRecordingsDir;
});
afterEach(async () => {
  await prisma.alarm.deleteMany({ where: { tenantId } });
  await prisma.event.deleteMany({ where: { cameraId } });
  await prisma.recordingSegment.deleteMany({ where: { cameraId } });
  for (const f of fs.readdirSync(camDir)) fs.rmSync(path.join(camDir, f), { force: true, recursive: true });
});

/** Registers a file through the crawler, changes it on disk, and lets the integrity check catch the change. */
async function caughtByIntegrityCheck(change: (file: string, original: Buffer) => void) {
  const original = crypto.randomBytes(4096);
  const file = writeSegmentFile(original);
  await new RecordingCatalog(prisma, undefined, new CountingProbe(GOOD_PROBE)).reconcileFilesystem();
  const registered = await rowFor(file);
  expect([registered.status, registered.sha256Hash]).toEqual([SegmentStatus.FINALIZED, sha(original)]);

  change(file, original);
  age(file);
  await integrityCycle();
  const caught = await rowFor(file);
  expect(caught.status).toBe(SegmentStatus.CORRUPTED);
  return { file, original, caught };
}

const sameSizeChange = (file: string, original: Buffer) => {
  const flipped = Buffer.from(original);
  flipped[100] ^= 0xff;
  fs.writeFileSync(file, flipped);
};
const sizeChange = (file: string) => fs.appendFileSync(file, 'tampered');

describe.each([
  ['same size, different bytes', 'HASH_MISMATCH', sameSizeChange],
  ['different size', 'SIZE_CHANGED', sizeChange],
])('a file whose content changed (%s)', (_label, reason, change) => {
  it(`stays CORRUPTED (${reason}) with its original hash and size after the crawler runs again`, async () => {
    const { file, original, caught } = await caughtByIntegrityCheck(change);
    expect(caught.quarantineReason).toBe(reason);

    const probe = new CountingProbe(GOOD_PROBE);
    await new RecordingCatalog(prisma, undefined, probe).reconcileFilesystem();
    await new RecordingCatalog(prisma, undefined, probe).reconcileFilesystem();

    const after = await rowFor(file);
    expect([after.status, after.quarantineReason]).toEqual([SegmentStatus.CORRUPTED, reason]);
    expect(after.sha256Hash).toBe(sha(original));
    expect(after.sizeBytes).toBe(BigInt(original.length));
    expect(after.id).toBe(caught.id);
    expect(probe.calls).toBe(0); // the crawler does not even read a file held by an integrity finding
  });

  it(`stays CORRUPTED (${reason}) when registerSegment is called for it directly, even with a caller-supplied hash`, async () => {
    const { file, original } = await caughtByIntegrityCheck(change);
    const catalog = new RecordingCatalog(prisma, undefined, new CountingProbe(GOOD_PROBE));

    const returned = await catalog.registerSegment({ tenantId, cameraId, filePath: file });
    expect([returned.status, returned.quarantineReason, returned.sha256Hash]).toEqual([SegmentStatus.CORRUPTED, reason, sha(original)]);

    await catalog.registerSegment({ tenantId, cameraId, filePath: file, sha256Hash: sha(fs.readFileSync(file)), durationMs: 6000 });
    const after = await rowFor(file);
    expect([after.status, after.quarantineReason]).toEqual([SegmentStatus.CORRUPTED, reason]);
    expect(after.sha256Hash).toBe(sha(original));
    expect(after.sizeBytes).toBe(BigInt(original.length));

    // Still out of footage: coverage does not count it.
    const cov = await catalog.getCoverage(cameraId, new Date('2026-10-05T00:00:00Z'), new Date('2026-10-06T00:00:00Z'));
    expect(cov.coverageBlocks).toHaveLength(0);
  });
});

describe('legitimate recovery is unchanged', () => {
  it('a file that was unreadable at first registration and is readable now still becomes FINALIZED', async () => {
    const bytes = crypto.randomBytes(4096);
    const file = writeSegmentFile(bytes);
    await new RecordingCatalog(prisma, undefined, new CountingProbe(null)).reconcileFilesystem();
    expect([(await rowFor(file)).status, (await rowFor(file)).quarantineReason]).toEqual([SegmentStatus.CORRUPTED, 'UNREADABLE_MEDIA']);

    await new RecordingCatalog(prisma, undefined, new CountingProbe(GOOD_PROBE)).reconcileFilesystem();
    const after = await rowFor(file);
    expect([after.status, after.quarantineReason, after.sha256Hash]).toEqual([SegmentStatus.FINALIZED, null, sha(bytes)]);
  });

  it('a file that was zero bytes at first registration and has content now still becomes FINALIZED', async () => {
    const file = writeSegmentFile(Buffer.alloc(0));
    await new RecordingCatalog(prisma, undefined, new CountingProbe(GOOD_PROBE)).reconcileFilesystem();
    expect((await rowFor(file)).quarantineReason).toBe('ZERO_BYTE');

    const bytes = crypto.randomBytes(2048);
    fs.writeFileSync(file, bytes);
    age(file);
    await new RecordingCatalog(prisma, undefined, new CountingProbe(GOOD_PROBE)).reconcileFilesystem();
    const after = await rowFor(file);
    expect([after.status, after.sha256Hash, after.sizeBytes]).toEqual([SegmentStatus.FINALIZED, sha(bytes), BigInt(bytes.length)]);
  });

  it('the crawler still skips a held file while it is inside the active-write grace (no read, no change)', async () => {
    const { file, original } = await caughtByIntegrityCheck(sameSizeChange);
    fs.utimesSync(file, new Date(), new Date());
    const probe = new CountingProbe(GOOD_PROBE);
    expect(await new RecordingCatalog(prisma, undefined, probe).reconcileFilesystem()).toBe(0);
    expect(probe.calls).toBe(0);
    expect((await rowFor(file)).sha256Hash).toBe(sha(original));
  });
});

describe('boot recovery', () => {
  /** A real, playable fMP4 clip (boot recovery probes files with ffprobe). */
  const clip = (file: string, seconds = 2) =>
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=160x120:rate=10:duration=${seconds}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', file]);

  it('does not refresh the recorded size of a held file from the changed file at restart', async () => {
    seq += 1;
    const file = path.join(camDir, `2026-10-05_12-${String(seq).padStart(2, '0')}-00-000000.mp4`);
    clip(file);
    age(file);
    await new RecordingCatalog(prisma, undefined, new CountingProbe(GOOD_PROBE)).reconcileFilesystem();
    const original = await rowFor(file);
    fs.appendFileSync(file, crypto.randomBytes(512)); // still plays, but it is not what was recorded
    age(file);
    await integrityCycle();
    expect((await rowFor(file)).quarantineReason).toBe('SIZE_CHANGED');

    await new CrashRecoveryService(prisma).recoverStorage([camDir]);
    const after = await rowFor(file);
    expect([after.status, after.quarantineReason]).toEqual([SegmentStatus.CORRUPTED, 'SIZE_CHANGED']);
    expect([after.sizeBytes, after.sha256Hash]).toEqual([original.sizeBytes, original.sha256Hash]);
  });

  it('the documented repair path still applies: boot recovery can repair a held file, keeping the original hash and recording the repaired one', async () => {
    seq += 1;
    const file = path.join(camDir, `2026-10-05_13-${String(seq).padStart(2, '0')}-00-000000.mp4`);
    clip(file, 3);
    age(file);
    await new RecordingCatalog(prisma, undefined, new CountingProbe(GOOD_PROBE)).reconcileFilesystem();
    const original = await rowFor(file);
    fs.writeFileSync(file, crypto.randomBytes(3000)); // no longer readable as video: boot recovery tries a repair
    age(file);
    await integrityCycle();
    expect((await rowFor(file)).quarantineReason).toBe('SIZE_CHANGED');

    // The remux itself is stubbed (as in crashRecovery.test.ts): random bytes cannot be remuxed. It writes a real clip,
    // which boot recovery then probes and hashes for real.
    const remux = jest.spyOn(CrashRecoveryService as any, 'remuxRepair').mockImplementation(async (_src: any, dst: any) => {
      clip(dst as string);
      return true;
    });
    try {
      await new CrashRecoveryService(prisma).recoverStorage([camDir]);
    } finally {
      remux.mockRestore();
    }
    const repaired = await rowFor(file);
    expect(repaired.status).toBe(SegmentStatus.FINALIZED);
    expect(repaired.sha256Hash).toBe(original.sha256Hash);
    expect(repaired.repairedSha256).toBe(sha(fs.readFileSync(file)));
    expect(repaired.repairedAt).not.toBeNull();
  });
});
