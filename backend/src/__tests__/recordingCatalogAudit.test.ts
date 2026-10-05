/**
 * Audit of RecordingCatalog against the crash-safety and time ideas read in Moonfire NVR (design only) and
 * MediaMTX: docs/audits/RECORDING_CATALOG_AUDIT_2026-10-05.md. Real database, real files, real ffmpeg.
 *
 * F1 to F4, F9 and F10 are fixed and are plain `it` now ("Fix 1" and "Fix 2" in the audit). A finding that is still
 * open is written as `it.failing`: it states the CORRECT behaviour and currently FAILS, so the suite stays green while
 * the defect exists and breaks the moment someone fixes it; the fix then changes `it.failing` to `it`.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';

const previousRecordingsDir = process.env.RECORDINGS_DIR;
// The shared test setup turns the active-write grace off (0); these tests need the production value.
const previousGrace = process.env.CRASH_RECOVERY_ACTIVE_WRITE_GRACE_SECONDS;
process.env.CRASH_RECOVERY_ACTIVE_WRITE_GRACE_SECONDS = '120';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vigilone-catalog-audit-'));
process.env.RECORDINGS_DIR = path.join(root, 'recordings');
fs.mkdirSync(process.env.RECORDINGS_DIR, { recursive: true });
// app.ts installs this in the running server; a bare catalog needs it to store BigInt PTS values in JSON.
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

import { PrismaClient, SegmentStatus } from '@prisma/client';
import { LocalStorageAdapter } from '../services/recording/catalog/storageAdapter';
import { RecordingCatalog } from '../services/recording/catalog/recordingCatalog.service';
import { FfprobeMediaAdapter, MediaProbeAdapter, MediaProbeResult } from '../services/recording/catalog/mediaProbeAdapter';
import { createTenantWithCamera } from './helpers/realDb';
import SegmentJobWorkerService from '../services/storage/segmentJobWorker.service';

jest.setTimeout(60000);

const prisma = new PrismaClient();
let tenantId = '';
let cameraId = '';
let camDir = '';
let seq = 0;

/** The next free, valid MediaMTX-style file name for the camera. */
const nextName = () => {
  seq += 1;
  return path.join(camDir, `2026-10-05_10-${String(seq).padStart(2, '0')}-00-000000.mp4`);
};
const ageFile = (file: string, secondsAgo: number) => {
  const t = new Date(Date.now() - secondsAgo * 1000);
  fs.utimesSync(file, t, t);
};
/** `seconds` of video with a keyframe every `gop` frames (25 fps), fragmented like MediaMTX's fMP4. */
function clip(file: string, seconds: number, gop: number) {
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=25:duration=${seconds}`,
    '-c:v', 'libx264', '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
    '-movflags', 'frag_keyframe+empty_moov', file,
  ]);
}
function actualKeyframeSeconds(file: string): number[] {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file]).toString();
  return out.split('\n').map((s) => s.trim().split(',')[0]).filter(Boolean).map(Number).sort((a, b) => a - b);
}

class CountingProbe implements MediaProbeAdapter {
  calls = 0;
  constructor(private result: MediaProbeResult | null) {}
  async probeMedia(): Promise<MediaProbeResult | null> {
    this.calls += 1;
    return this.result;
  }
}
const GOOD_PROBE: MediaProbeResult = { durationMs: 6000, width: 320, height: 240, codec: 'h264', fps: 25, timebaseNumerator: 1, timebaseDenominator: 90000 };

beforeAll(async () => {
  ({ tenantId, cameraId } = await createTenantWithCamera(prisma, 'catalogaudit'));
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
  await prisma.segmentJob.deleteMany({ where: { cameraId } });
  await prisma.recordingSegment.deleteMany({ where: { cameraId } });
  for (const f of fs.readdirSync(camDir)) fs.rmSync(path.join(camDir, f), { force: true, recursive: true });
});

describe('RecordingCatalog audit (2026-10-05)', () => {
  // F1. The stored keyframe index is invented, not read from the file.
  it('F1: the keyframe index lists the keyframes that are really in the file', async () => {
    const file = nextName();
    clip(file, 6, 25); // a keyframe every second
    ageFile(file, 600);
    const catalog = new RecordingCatalog(prisma, undefined, new FfprobeMediaAdapter());
    const seg = await catalog.registerSegment({ tenantId, cameraId, filePath: file });
    const stored = ((seg.keyframeIndexJson as any[]) || []).map((k) => Number(k.pts) / 90000).sort((a, b) => a - b);
    const real = actualKeyframeSeconds(file).map((t, _i, all) => t - all[0]); // counted from the first frame, as stored
    expect(real.length).toBeGreaterThanOrEqual(5);
    expect(stored.length).toBe(real.length);
    stored.forEach((s, i) => expect(Math.abs(s - real[i])).toBeLessThan(0.001));
  });

  // F2. The 5-minute crawl re-reads every known file.
  it('F2: a second crawl does not probe files the catalog already finalized', async () => {
    for (let i = 0; i < 3; i++) {
      const f = nextName();
      fs.writeFileSync(f, crypto.randomBytes(2048));
      ageFile(f, 3600);
    }
    const probe = new CountingProbe(GOOD_PROBE);
    const catalog = new RecordingCatalog(prisma, undefined, probe);
    await catalog.reconcileFilesystem();
    const afterFirst = probe.calls;
    expect(afterFirst).toBe(3);
    await catalog.reconcileFilesystem();
    expect(probe.calls).toBe(afterFirst);
  });

  // F3. A file MediaMTX is still writing is indexed as finished.
  it('F3: a file still being written is not indexed as FINALIZED', async () => {
    const f = nextName();
    fs.writeFileSync(f, crypto.randomBytes(4096)); // modified just now: the recorder may still be writing it
    const catalog = new RecordingCatalog(prisma, undefined, new CountingProbe(GOOD_PROBE));
    await catalog.reconcileFilesystem();
    const seg = await prisma.recordingSegment.findFirst({ where: { cameraId, filePath: f } });
    expect(seg?.status ?? null).not.toBe(SegmentStatus.FINALIZED);
  });

  // F4. A file that cannot be read gets invented metadata and counts as footage.
  it('F4: a file that cannot be probed is not indexed as a valid FINALIZED segment', async () => {
    const f = nextName();
    fs.writeFileSync(f, crypto.randomBytes(4096));
    ageFile(f, 3600);
    const catalog = new RecordingCatalog(prisma, undefined, new CountingProbe(null));
    await catalog.reconcileFilesystem();
    const seg = await prisma.recordingSegment.findFirst({ where: { cameraId, filePath: f } });
    expect(seg?.status ?? null).not.toBe(SegmentStatus.FINALIZED);
  });

  // What is already right, so a later fix cannot lose it.
  it('indexes a finished, readable file once and keeps one row per file', async () => {
    const f = nextName();
    fs.writeFileSync(f, crypto.randomBytes(4096));
    ageFile(f, 3600);
    const catalog = new RecordingCatalog(prisma, undefined, new CountingProbe(GOOD_PROBE));
    await catalog.reconcileFilesystem();
    await catalog.reconcileFilesystem();
    const rows = await prisma.recordingSegment.findMany({ where: { cameraId, filePath: f } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(SegmentStatus.FINALIZED);
    expect(rows[0].sha256Hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('parses the file name as UTC wall-clock time, whatever the host time zone', async () => {
    const f = path.join(camDir, '2026-10-05_10-01-00-250000.mp4');
    fs.writeFileSync(f, crypto.randomBytes(1024));
    ageFile(f, 3600);
    const catalog = new RecordingCatalog(prisma, undefined, new CountingProbe(GOOD_PROBE));
    const seg = await catalog.registerSegment({ tenantId, cameraId, filePath: f });
    expect(seg.startTime.toISOString()).toBe('2026-10-05T10:01:00.250Z');
    expect(seg.endTime.getTime() - seg.startTime.getTime()).toBe(6000);
  });
});

describe('The crawler follows the boot-recovery rules (audit fix 1)', () => {
  const day = (ms: number) => new Date(Date.parse('2026-10-05T00:00:00Z') + ms);
  const rowFor = (f: string) => prisma.recordingSegment.findFirstOrThrow({ where: { cameraId, filePath: f } });

  it('skips a file inside the active-write grace, then indexes it as FINALIZED once the grace has passed', async () => {
    const f = nextName();
    fs.writeFileSync(f, crypto.randomBytes(4096));
    const probe = new CountingProbe(GOOD_PROBE);
    const catalog = new RecordingCatalog(prisma, undefined, probe);
    expect(await catalog.reconcileFilesystem()).toBe(0);
    expect(probe.calls).toBe(0);
    expect(await prisma.recordingSegment.count({ where: { cameraId, filePath: f } })).toBe(0);
    ageFile(f, 3600);
    expect(await catalog.reconcileFilesystem()).toBe(1);
    expect((await rowFor(f)).status).toBe(SegmentStatus.FINALIZED);
  });

  it('records an unreadable file as CORRUPTED with nothing invented, and keeps it out of coverage', async () => {
    const f = nextName();
    fs.writeFileSync(f, crypto.randomBytes(4096));
    ageFile(f, 3600);
    const catalog = new RecordingCatalog(prisma, undefined, new CountingProbe(null));
    await catalog.reconcileFilesystem();
    const row = await rowFor(f);
    expect(row.status).toBe(SegmentStatus.CORRUPTED);
    expect(row.quarantineReason).toBe('UNREADABLE_MEDIA');
    expect(row.durationMs).toBe(0);
    expect([row.width, row.height, row.fps, row.codec]).toEqual([null, null, null, null]);
    expect(row.sizeBytes).toBe(4096n);
    expect(row.sha256Hash).toMatch(/^[a-f0-9]{64}$/);
    const cov = await catalog.getCoverage(cameraId, day(0), day(86_400_000));
    expect(cov.coverageBlocks).toHaveLength(0);
    expect(await catalog.findSegments(cameraId, day(0), day(86_400_000))).toHaveLength(0);
  });

  it('an empty file is CORRUPTED too, not a valid one-second segment', async () => {
    const f = nextName();
    fs.writeFileSync(f, '');
    ageFile(f, 3600);
    await new RecordingCatalog(prisma, undefined, new CountingProbe(null)).reconcileFilesystem();
    expect((await rowFor(f)).status).toBe(SegmentStatus.CORRUPTED);
  });

  it('the same row returns to FINALIZED with real metadata once the file can be read', async () => {
    const f = nextName();
    fs.writeFileSync(f, crypto.randomBytes(4096));
    ageFile(f, 3600);
    await new RecordingCatalog(prisma, undefined, new CountingProbe(null)).reconcileFilesystem();
    const before = await rowFor(f);
    await new RecordingCatalog(prisma, undefined, new CountingProbe(GOOD_PROBE)).reconcileFilesystem();
    const after = await rowFor(f);
    expect(after.id).toBe(before.id);
    expect(after.status).toBe(SegmentStatus.FINALIZED);
    expect(after.quarantineReason).toBeNull();
    expect([after.width, after.height, after.fps, after.codec]).toEqual([320, 240, 25, 'h264']);
    expect(after.durationMs).toBe(6000);
  });

  it('keeps a caller-supplied duration when the probe fails, and still invents no picture details', async () => {
    const f = nextName();
    fs.writeFileSync(f, crypto.randomBytes(4096));
    ageFile(f, 3600);
    const seg = await new RecordingCatalog(prisma, undefined, new CountingProbe(null)).registerSegment({ tenantId, cameraId, filePath: f, durationMs: 600000 });
    expect(seg.status).toBe(SegmentStatus.FINALIZED);
    expect(seg.durationMs).toBe(600000);
    expect([seg.width, seg.height, seg.fps]).toEqual([null, null, null]);
  });

  it('coverage, seek and listing ignore segments that are not FINALIZED (quarantined, missing, corrupt)', async () => {
    const mk = async (status: SegmentStatus, minute: number) =>
      prisma.recordingSegment.create({
        data: { tenantId, cameraId, filePath: path.join(camDir, `s-${status}-${minute}.mp4`), startTime: day(minute * 60_000), endTime: day(minute * 60_000 + 55_000), durationMs: 55_000, sizeBytes: 1n, status },
      });
    await mk(SegmentStatus.FINALIZED, 0);
    for (const [i, st] of [SegmentStatus.QUARANTINED, SegmentStatus.FILE_MISSING, SegmentStatus.CORRUPTED, SegmentStatus.RECOVERY_FAILED].entries()) await mk(st, i + 1);
    const catalog = new RecordingCatalog(prisma);
    const segs = await catalog.findSegments(cameraId, day(0), day(10 * 60_000));
    expect(segs.map((x) => x.status)).toEqual([SegmentStatus.FINALIZED]);
    const cov = await catalog.getCoverage(cameraId, day(0), day(10 * 60_000));
    expect(cov.coverageBlocks).toHaveLength(1);
    // A moment inside a corrupt segment is a gap, never the bad file.
    const seek = await catalog.findSeekTarget(cameraId, day(2 * 60_000 + 10_000));
    expect(seek.segmentUri ?? '').not.toMatch(/QUARANTINED|FILE_MISSING|CORRUPTED|RECOVERY_FAILED/);
  });

  it('does not walk into .quarantine: a quarantined file stays where it is and nothing nests deeper', async () => {
    const q = path.join(camDir, '.quarantine');
    fs.mkdirSync(q, { recursive: true });
    const f = path.join(q, '2026-10-05_09-00-00-000000.mp4');
    fs.writeFileSync(f, crypto.randomBytes(2048));
    ageFile(f, 3600);
    const probe = new CountingProbe(GOOD_PROBE);
    await new RecordingCatalog(prisma, undefined, probe).reconcileFilesystem();
    expect(fs.existsSync(f)).toBe(true);
    expect(fs.existsSync(path.join(q, '.quarantine'))).toBe(false);
    expect(probe.calls).toBe(0);
    expect(await prisma.recordingSegment.count({ where: { cameraId } })).toBe(0);
    expect(new LocalStorageAdapter()).toBeTruthy();
  });
});

describe('Fix 2: real keyframes, a cheap crawl, and no assumed frame rate', () => {
  const rowFor = (f: string) => prisma.recordingSegment.findFirstOrThrow({ where: { cameraId, filePath: f } });
  const real = new FfprobeMediaAdapter();

  it('keyframe index follows a different GOP too (a keyframe every 2.4 s, not the old 2 s guess)', async () => {
    const f = nextName();
    clip(f, 10, 60); // 25 fps, keyframe every 60 frames = 2.4 s
    ageFile(f, 600);
    const seg = await new RecordingCatalog(prisma, undefined, real).registerSegment({ tenantId, cameraId, filePath: f });
    const stored = (seg.keyframeIndexJson as any[]).map((k) => Number(k.pts) / 90000);
    const truth = actualKeyframeSeconds(f).map((t, _i, all) => t - all[0]);
    expect(stored.length).toBe(truth.length);
    expect(stored[1]).toBeCloseTo(2.4, 2);
    stored.forEach((x, i) => expect(Math.abs(x - truth[i])).toBeLessThan(0.001));
  });

  it('stores no index at all when the keyframes cannot be read, never a guessed one', async () => {
    const f = nextName();
    fs.writeFileSync(f, crypto.randomBytes(4096)); // not a video
    const seg = await new RecordingCatalog(prisma, undefined, new CountingProbe({ ...GOOD_PROBE })).registerSegment({ tenantId, cameraId, filePath: f });
    expect(seg.keyframeIndexJson).toBeNull();
  });

  it('a second crawl reads nothing that is already FINALIZED with the same size, and a changed file is read again', async () => {
    const a = nextName();
    const b = nextName();
    for (const f of [a, b]) {
      fs.writeFileSync(f, crypto.randomBytes(2048));
      ageFile(f, 3600);
    }
    const probe = new CountingProbe(GOOD_PROBE);
    const catalog = new RecordingCatalog(prisma, undefined, probe);
    expect(await catalog.reconcileFilesystem()).toBe(2);
    expect(await catalog.reconcileFilesystem()).toBe(0);
    expect(probe.calls).toBe(2);
    fs.appendFileSync(b, crypto.randomBytes(512)); // the file grew
    ageFile(b, 3600);
    expect(await catalog.reconcileFilesystem()).toBe(1);
    expect(probe.calls).toBe(3);
    expect((await rowFor(b)).sizeBytes).toBe(2560n);
  });

  it('a file that was unreadable is tried again on every crawl, so it can recover', async () => {
    const f = nextName();
    fs.writeFileSync(f, crypto.randomBytes(2048));
    ageFile(f, 3600);
    const probe = new CountingProbe(null);
    const catalog = new RecordingCatalog(prisma, undefined, probe);
    await catalog.reconcileFilesystem();
    await catalog.reconcileFilesystem();
    expect(probe.calls).toBe(2);
  });

  it('seek reports unknown codec and frame rate as null, not h264 and 25 fps', async () => {
    const mk = (cod: string | null, fps: number | null, minute: number) =>
      prisma.recordingSegment.create({
        data: { tenantId, cameraId, filePath: path.join(camDir, `k-${minute}.mp4`), startTime: new Date(Date.parse('2026-10-05T00:00:00Z') + minute * 60_000), endTime: new Date(Date.parse('2026-10-05T00:00:00Z') + minute * 60_000 + 55_000), durationMs: 55_000, sizeBytes: 1n, codec: cod, fps },
      });
    await mk(null, null, 0);
    await mk('hevc', 30, 1);
    const catalog = new RecordingCatalog(prisma);
    const unknown = await catalog.findSeekTarget(cameraId, new Date('2026-10-05T00:00:10Z'));
    expect([unknown.status, unknown.codec, unknown.fps]).toEqual(['READY', null, null]);
    const known = await catalog.findSeekTarget(cameraId, new Date('2026-10-05T00:01:10Z'));
    expect([known.codec, known.fps]).toEqual(['hevc', 30]);
  });

  it('a frame step is refused (FRAME_RATE_UNKNOWN, 409) when the frame rate and the keyframes are unknown, and uses the real rate otherwise', async () => {
    const seg = (fps: number | null, name: string, kf: any) =>
      prisma.recordingSegment.create({
        data: { tenantId, cameraId, filePath: path.join(camDir, name), startTime: new Date('2026-10-05T00:00:00Z'), endTime: new Date('2026-10-05T00:00:55Z'), durationMs: 55_000, sizeBytes: 1n, fps, endPts: 4_950_000n, keyframeIndexJson: kf },
      });
    const unknown = await seg(null, 'u.mp4', null);
    const catalog = new RecordingCatalog(prisma);
    await expect(catalog.stepToAdjacentFrame(cameraId, unknown.id, 90000n, 'FORWARD')).rejects.toMatchObject({ code: 'FRAME_RATE_UNKNOWN', statusCode: 409 });
    await prisma.recordingSegment.update({ where: { id: unknown.id }, data: { fps: 30 } });
    const step = await catalog.stepToAdjacentFrame(cameraId, unknown.id, 90000n, 'FORWARD');
    expect(step.frameDeltaPts).toBe(3000n); // 90000 / 30
  });
});

describe('The segment-complete worker registers through the catalog (the production path)', () => {
  it('stores the real keyframe index and a real end PTS, which it used to leave empty and zero', async () => {
    const f = nextName();
    clip(f, 8, 50); // keyframe every 2 s
    ageFile(f, 600);
    SegmentJobWorkerService.setPrismaForTesting(prisma);
    const job = await prisma.segmentJob.create({ data: { tenantId, cameraId, streamPath: 'x', segmentPath: f, status: 'PENDING' } });
    await SegmentJobWorkerService.processSingleJob(job.id);
    expect((await prisma.segmentJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('COMPLETED');
    const row = await prisma.recordingSegment.findFirstOrThrow({ where: { cameraId, filePath: f } });
    expect(row.status).toBe(SegmentStatus.FINALIZED);
    expect(Number(row.endPts)).toBeGreaterThan(7 * 90000);
    const stored = (row.keyframeIndexJson as any[]).map((k) => Number(k.pts) / 90000);
    const truth = actualKeyframeSeconds(f).map((t, _i, all) => t - all[0]);
    expect(stored.length).toBe(truth.length);
    stored.forEach((x, i) => expect(Math.abs(x - truth[i])).toBeLessThan(0.001));
    expect([row.width, row.height, row.fps, row.codec]).toEqual([320, 240, 25, 'h264']);
  });

  it('still fails the job for a file it cannot read, so the queue retries instead of indexing it', async () => {
    const f = nextName();
    fs.writeFileSync(f, crypto.randomBytes(4096));
    ageFile(f, 600);
    SegmentJobWorkerService.setPrismaForTesting(prisma);
    const job = await prisma.segmentJob.create({ data: { tenantId, cameraId, streamPath: 'x', segmentPath: f, status: 'PENDING' } });
    await SegmentJobWorkerService.processSingleJob(job.id);
    const after = await prisma.segmentJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).not.toBe('COMPLETED');
    expect(await prisma.recordingSegment.count({ where: { cameraId, filePath: f } })).toBe(0);
  });
});
