/**
 * F12 (docs/audits/RECORDING_CATALOG_AUDIT_2026-10-05.md): a frame step lands on the NEXT REAL FRAME of the file, read
 * from its own timestamps, on constant and variable frame rate alike, across segment boundaries, and says so when it can
 * only estimate. Real database, real files, real ffmpeg; the truth is ffprobe's own list of frame times.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vigilone-framestep-'));
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

import { PrismaClient } from '@prisma/client';
import { RecordingCatalog, FrameStepUnavailableError } from '../services/recording/catalog/recordingCatalog.service';
import { FfprobeMediaAdapter } from '../services/recording/catalog/mediaProbeAdapter';
import { PlaybackSyncService } from '../services/playback/playbackSync.service';
import { createTenantWithCamera, createUserWithToken } from './helpers/realDb';

jest.setTimeout(90000);

const prisma = new PrismaClient();
let tenantId = '';
let cameraId = '';
let userId = '';
let seq = 0;

const T0 = Date.parse('2026-10-05T10:00:00Z');
const file = () => path.join(root, `seg${++seq}.mp4`);

function encode(out: string, seconds: number, extra: string[] = []) {
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=25:duration=${seconds}`, ...extra,
    '-c:v', 'libx264', '-g', '25', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', out,
  ]);
}
/** Variable frame rate: some frames dropped, so the gaps between frames differ. */
const vfr = (out: string, seconds: number) => encode(out, seconds, ['-vf', "select='not(mod(n,3))+not(mod(n,7))'", '-vsync', 'vfr']);

/** Every frame time in the file, in the 90 kHz clock from the first presented frame: ffprobe's own answer. */
function truthFrames(f: string): number[] {
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=time_base:packet=pts', '-of', 'json', f]).toString());
  const [num, den] = j.streams[0].time_base.split('/').map(Number);
  const pts: number[] = j.packets.map((p: any) => Number(p.pts)).sort((a: number, b: number) => a - b);
  return pts.map((p) => Math.round(((p - pts[0]) * 90000 * num) / den));
}

async function register(f: string, startMs: number, cam: string = cameraId) {
  const name = new Date(startMs).toISOString().replace(/T/, '_').replace(/:/g, '-').replace(/\.(\d+)Z$/, '-$1000');
  const target = path.join(path.dirname(f), `${name.slice(0, 19)}-${String(startMs % 1000).padStart(3, '0')}000.mp4`);
  fs.renameSync(f, target);
  const old = new Date(Date.now() - 600_000);
  fs.utimesSync(target, old, old);
  return new RecordingCatalog(prisma, undefined, new FfprobeMediaAdapter()).registerSegment({ tenantId, cameraId: cam, filePath: target });
}

const catalog = () => new RecordingCatalog(prisma, undefined, new FfprobeMediaAdapter());

beforeAll(async () => {
  ({ tenantId, cameraId } = await createTenantWithCamera(prisma, 'framestep'));
  ({ userId } = await createUserWithToken(prisma, tenantId, 'OPERATOR'));
});
afterAll(async () => {
  await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await prisma.$disconnect();
  fs.rmSync(root, { recursive: true, force: true });
});
afterEach(async () => {
  await prisma.playbackSession.deleteMany({ where: { tenantId } });
  await prisma.recordingSegment.deleteMany({ where: { tenantId } });
});

describe('exact frame stepping (F12)', () => {
  it('constant frame rate: forward and backward land on the neighbouring real frames, from a frame or from between frames', async () => {
    const f = file();
    encode(f, 4);
    const frames = truthFrames(f);
    const seg = await register(f, T0);
    for (const k of [5, 20, 60]) {
      const fwd = await catalog().stepToAdjacentFrame(cameraId, seg.id, BigInt(frames[k]), 'FORWARD');
      expect([Number(fwd.newPts), fwd.precision, fwd.clamped]).toEqual([frames[k + 1], 'EXACT', false]);
      expect(Number(fwd.frameDeltaPts)).toBe(frames[k + 1] - frames[k]);
      const back = await catalog().stepToAdjacentFrame(cameraId, seg.id, BigInt(frames[k]), 'BACKWARD');
      expect(Number(back.newPts)).toBe(frames[k - 1]);
      // Between two frames the picture on screen is the earlier one: forward goes to the next frame, backward to the one before it.
      const mid = BigInt(frames[k] + 1500);
      expect(Number((await catalog().stepToAdjacentFrame(cameraId, seg.id, mid, 'FORWARD')).newPts)).toBe(frames[k + 1]);
      expect(Number((await catalog().stepToAdjacentFrame(cameraId, seg.id, mid, 'BACKWARD')).newPts)).toBe(frames[k - 1]);
    }
  });

  it('variable frame rate: every step equals the next frame in the file, and the steps are not all the same length', async () => {
    const f = file();
    vfr(f, 12);
    const frames = truthFrames(f);
    expect(new Set(frames.slice(1).map((v, i) => v - frames[i])).size).toBeGreaterThan(2);
    const seg = await register(f, T0);
    const deltas = new Set<number>();
    for (let k = 1; k < frames.length - 1; k += 5) {
      const fwd = await catalog().stepToAdjacentFrame(cameraId, seg.id, BigInt(frames[k]), 'FORWARD');
      expect(Number(fwd.newPts)).toBe(frames[k + 1]);
      deltas.add(Number(fwd.frameDeltaPts));
      expect(Number((await catalog().stepToAdjacentFrame(cameraId, seg.id, BigInt(frames[k]), 'BACKWARD')).newPts)).toBe(frames[k - 1]);
    }
    expect(deltas.size).toBeGreaterThan(1);
  });

  it('the time of the new frame is the segment start plus the frame time, never earlier than the frame', async () => {
    const f = file();
    vfr(f, 6);
    const frames = truthFrames(f);
    const seg = await register(f, T0 + 250);
    const step = await catalog().stepToAdjacentFrame(cameraId, seg.id, BigInt(frames[3]), 'FORWARD');
    const exactMs = T0 + 250 + frames[4] / 90;
    expect(step.utc.getTime()).toBeGreaterThanOrEqual(exactMs);
    expect(step.utc.getTime() - exactMs).toBeLessThan(1);
  });

  it('at the first or last frame of the only segment the step stays put and says it was clamped', async () => {
    const f = file();
    encode(f, 3);
    const frames = truthFrames(f);
    const seg = await register(f, T0);
    const first = await catalog().stepToAdjacentFrame(cameraId, seg.id, 0n, 'BACKWARD');
    expect([Number(first.newPts), first.clamped, first.precision]).toEqual([0, true, 'EXACT']);
    const last = await catalog().stepToAdjacentFrame(cameraId, seg.id, BigInt(frames[frames.length - 1]), 'FORWARD');
    expect([Number(last.newPts), last.clamped]).toEqual([frames[frames.length - 1], true]);
  });

  it('crosses into the next segment on its first frame, and back onto the previous one on its last frame', async () => {
    const a = file();
    const b = file();
    encode(a, 3);
    encode(b, 3);
    const fa = truthFrames(a);
    const segA = await register(a, T0);
    // The next file starts where this one's frames end (one frame after the last), as MediaMTX rolls over.
    const durationMs = segA.durationMs;
    const segB = await register(b, T0 + durationMs);
    const fwd = await catalog().stepToAdjacentFrame(cameraId, segA.id, BigInt(fa[fa.length - 1]), 'FORWARD');
    expect([fwd.segmentId, Number(fwd.newPts), fwd.clamped]).toEqual([segB.id, 0, false]);
    expect(fwd.utc.getTime()).toBe(T0 + durationMs);
    const back = await catalog().stepToAdjacentFrame(cameraId, segB.id, 0n, 'BACKWARD');
    expect([back.segmentId, Number(back.newPts), back.clamped]).toEqual([segA.id, fa[fa.length - 1], false]);
  });

  it('does not cross a real gap: the step is clamped', async () => {
    const a = file();
    const b = file();
    encode(a, 3);
    encode(b, 3);
    const fa = truthFrames(a);
    const segA = await register(a, T0);
    await register(b, T0 + segA.durationMs + 60_000);
    const step = await catalog().stepToAdjacentFrame(cameraId, segA.id, BigInt(fa[fa.length - 1]), 'FORWARD');
    expect([step.segmentId, step.clamped]).toEqual([segA.id, true]);
  });

  it('when the file is not there it estimates from the frame rate and says APPROXIMATE; with no frame rate it refuses', async () => {
    const f = file();
    encode(f, 3);
    const seg = await register(f, T0);
    fs.rmSync(seg.filePath);
    const est = await catalog().stepToAdjacentFrame(cameraId, seg.id, 90000n, 'FORWARD');
    expect([est.precision, Number(est.newPts)]).toEqual(['APPROXIMATE', 90000 + 3600]);
    await prisma.recordingSegment.update({ where: { id: seg.id }, data: { fps: null } });
    await expect(catalog().stepToAdjacentFrame(cameraId, seg.id, 90000n, 'FORWARD')).rejects.toBeInstanceOf(FrameStepUnavailableError);
  });

  it('a playback session steps to the real next frame of the reference camera and reports the precision', async () => {
    const f = file();
    vfr(f, 8);
    const frames = truthFrames(f);
    const seg = await register(f, T0);
    const sync = new PlaybackSyncService(prisma, catalog());
    const session = await sync.createPlaybackSession(tenantId, userId, [cameraId], new Date(T0 + Math.ceil(frames[6] / 90)));
    const r1: any = await sync.stepSessionFrame(session.id, 'FORWARD');
    expect(r1.precision).toBe('EXACT');
    expect(r1.masterTimeUtc.getTime()).toBe(T0 + Math.ceil(frames[7] / 90));
    expect(r1.cameras[0].segmentId).toBe(seg.id);
    const r2: any = await sync.stepSessionFrame(session.id, 'BACKWARD');
    expect(r2.masterTimeUtc.getTime()).toBe(T0 + Math.ceil(frames[6] / 90));
  });

  it('every camera of a synchronised view lands on a real frame of its own, not between two of its frames', async () => {
    // Camera A films at 25 fps; camera B at a variable rate and starts 137 ms later, so its frames never line up with A's.
    const camB = await prisma.camera.create({
      data: { tenantId, siteId: (await prisma.camera.findUniqueOrThrow({ where: { id: cameraId } })).siteId, name: 'framestep B', streamPath: `framestep_b_${seq}`, ipAddress: '127.0.0.1', mainRtspUri: `rtsp://127.0.0.1:8554/framestep_b_${seq}` },
    });
    const fa = file();
    encode(fa, 6);
    const fb = file();
    vfr(fb, 6);
    const framesB = truthFrames(fb);
    await register(fa, T0);
    const T0B = T0 + 137;
    const segB = await register(fb, T0B, camB.id);
    const sync = new PlaybackSyncService(prisma, catalog());
    const session = await sync.createPlaybackSession(tenantId, userId, [cameraId, camB.id], new Date(T0 + 2000));

    for (const direction of ['FORWARD', 'FORWARD', 'BACKWARD', 'FORWARD'] as const) {
      const r: any = await sync.stepSessionFrame(session.id, direction);
      expect(r.referenceCameraId).toBe(cameraId);
      const a = r.cameras.find((c: any) => c.cameraId === cameraId);
      const b = r.cameras.find((c: any) => c.cameraId === camB.id);
      expect(a.framePrecision).toBe('EXACT');
      expect(b.framePrecision).toBe('EXACT');
      expect(b.segmentId).toBe(segB.id);
      // B shows its last real frame at or before the master time.
      const masterInB = (r.masterTimeUtc.getTime() - T0B) * 90;
      const expected = framesB.filter((f) => f <= masterInB).pop()!;
      expect(Number(BigInt(b.currentPts) - segB.startPts)).toBe(expected);
      expect(b.offsetMs).toBe(Math.ceil(expected / 90));
      expect(framesB).toContain(Number(BigInt(b.currentPts) - segB.startPts));
    }
    await prisma.camera.delete({ where: { id: camB.id } });
  });

  it('a camera whose file cannot be read keeps the computed position and says APPROXIMATE; the step still happens', async () => {
    const camB = await prisma.camera.create({
      data: { tenantId, siteId: (await prisma.camera.findUniqueOrThrow({ where: { id: cameraId } })).siteId, name: 'framestep gone', streamPath: `framestep_g_${seq}`, ipAddress: '127.0.0.1', mainRtspUri: `rtsp://127.0.0.1:8554/framestep_g_${seq}` },
    });
    const fa = file();
    encode(fa, 4);
    const fb = file();
    encode(fb, 4);
    await register(fa, T0);
    const segB = await register(fb, T0 + 50, camB.id);
    fs.rmSync(segB.filePath);
    const sync = new PlaybackSyncService(prisma, catalog());
    const session = await sync.createPlaybackSession(tenantId, userId, [cameraId, camB.id], new Date(T0 + 1000));
    const r: any = await sync.stepSessionFrame(session.id, 'FORWARD');
    expect(r.precision).toBe('EXACT');
    const b = r.cameras.find((c: any) => c.cameraId === camB.id);
    expect(b.framePrecision).toBe('APPROXIMATE');
    expect(b.offsetMs).toBe(r.masterTimeUtc.getTime() - (T0 + 50));
    await prisma.camera.delete({ where: { id: camB.id } });
  });
});
