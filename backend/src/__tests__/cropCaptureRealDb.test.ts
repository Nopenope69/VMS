/**
 * P5.1 crop capture on the real detection path: DetectionIngestionService.ingest with the real
 * database, real ffmpeg and a real image file. Covers the feature flag (default OFF), the cut itself
 * (decoded dimensions), the per-site person gate, retention overrides, the free-space floor failing
 * loudly without stopping the detection, snapshot path safety and "no file without a row".
 * Paths use os.tmpdir() only, so the suite runs the same on macOS and Linux.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera } from './helpers/realDb';
import { DetectionIngestionService } from '../services/ai/detectionIngestion.service';
import { CropCaptureService, resetCropLogThrottle } from '../services/crops/cropCapture.service';
import { CropStore, CropStoreError } from '../services/crops/cropStore';
import { MetricsService } from '../services/observability/metrics.service';

jest.setTimeout(120000);

const prisma = new PrismaClient();
const FLAG = 'VIGILONE_FEATURE_OBJECT_CROPS';
const DAY = 86_400_000;
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crops-')));
const recordings = path.join(tmp, 'recordings');
const snapshots = path.join(recordings, 'snapshots');
const outside = path.join(tmp, 'outside');
const cropsDir = path.join(tmp, 'crops');
const saved = { ...process.env };
let tenantId = '';
let cameraId = '';
let siteId = '';
let manifest: { id: string; sha256: string; name: string; version: string };
let snap = '';
const t0 = new Date('2026-09-29T10:00:00.000Z');

const noEvents = { ingestEvent: async () => undefined } as any;
const submit = (svc: DetectionIngestionService, over: Record<string, unknown> = {}) => {
  const inferenceId = (over.inferenceId as string | undefined) ?? `inf-${crypto.randomUUID()}`;
  return svc.ingest({
    tenantId,
    cameraId,
    modelManifestId: manifest.id,
    inferenceId,
    type: 'VEHICLE_DETECTED',
    confidence: 0.9,
    objectClass: 'car',
    boundingBox: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    snapshotPath: snap,
    timestamp: t0.toISOString(),
    provenance: { adapterId: 'ai-worker', adapterVersion: 't', modelId: manifest.id, modelName: manifest.name, modelVersion: manifest.version, modelSha256: manifest.sha256, runtime: 'onnxruntime@1.30.0', executionProvider: 'cpu', inferenceId, frameTimestampUtc: t0.toISOString() },
    ...over,
  });
};
const cropRow = (detectionId: string) => prisma.objectCrop.findUnique({ where: { detectionEventId: detectionId } });
const dims = (file: string) =>
  execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' })
    .trim()
    .split(',')
    .map(Number);
const filesUnder = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)])) : []);
const counter = (outcome: string, code?: string) => MetricsService.getValue('vigilone_crops_total', code ? { outcome, code } : { outcome }) ?? 0;

/** Ingestion service whose crop capture reads free space from the given function. */
const withFreeSpace = (free: () => number) =>
  new DetectionIngestionService(prisma, () => ({} as any), noEvents, new CropCaptureService(prisma, undefined, undefined, (root, policy) => new CropStore(root, policy, free)));

beforeAll(async () => {
  fs.mkdirSync(snapshots, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  process.env.RECORDINGS_DIR = recordings;
  process.env.SNAPSHOTS_DIR = snapshots;
  process.env.CROPS_DIR = cropsDir;
  process.env.CROP_MIN_FREE_BYTES = '1024';
  snap = path.join(snapshots, 'snap.jpg');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=1', '-frames:v', '1', snap]);
  fs.copyFileSync(snap, path.join(outside, 'elsewhere.jpg'));
  ({ tenantId, cameraId, siteId } = await createTenantWithCamera(prisma, 'crops'));
  const name = `crops-model-${tenantId.slice(0, 8)}`;
  const sha256 = crypto.createHash('sha256').update(`crops-${tenantId}`).digest('hex');
  const m = await prisma.modelManifest.create({ data: { name, version: '1.0.0', sha256, task: 'object_detection', codeLicense: 'Apache-2.0', weightLicense: 'Apache-2.0', trainingDataJson: {}, runtimeConfigJson: {}, isActive: true } });
  manifest = { id: m.id, sha256, name, version: '1.0.0' };
});
afterAll(async () => {
  process.env = saved;
  await prisma.modelManifest.deleteMany({ where: { id: manifest.id } });
  await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await prisma.$disconnect();
  fs.rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => {
  delete process.env[FLAG];
  resetCropLogThrottle();
  jest.restoreAllMocks();
});

describe('P5.1 crop capture on the detection path', () => {
  it('flag OFF (the default): the detection is stored and no crop is written', async () => {
    const svc = new DetectionIngestionService(prisma, () => ({} as any), noEvents);
    const out = await submit(svc);
    expect(await prisma.detectionEvent.findUnique({ where: { id: out.detectionId } })).not.toBeNull();
    expect(await cropRow(out.detectionId)).toBeNull();
    expect(filesUnder(cropsDir)).toEqual([]);
  });

  it('flag ON: a non-person crop is cut from the snapshot, stored with its hash, and expires after 14 days', async () => {
    process.env[FLAG] = 'true';
    const svc = new DetectionIngestionService(prisma, () => ({} as any), noEvents);
    const out = await submit(svc);
    const row = await cropRow(out.detectionId);
    expect(row).toMatchObject({ tenantId, cameraId, cropClass: 'NON_PERSON', objectClass: 'car', capturedAt: t0 });
    expect(row!.expiresAt.getTime() - t0.getTime()).toBe(14 * DAY);
    const file = path.join(cropsDir, row!.relativePath);
    const bytes = fs.readFileSync(file);
    expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(row!.sha256);
    expect(row!.byteLength).toBe(bytes.length);
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]); // JPEG
    expect(dims(file)).toEqual([320, 240]); // the middle half of a 640x480 snapshot
    expect(row!.relativePath).toBe(`${tenantId}/${cameraId}/2026-09-29/${out.detectionId}.jpg`);

    // The same detection again is a duplicate: no second crop, no error.
    const before = counter('stored');
    const again = await submit(svc, { inferenceId: out.inferenceId });
    expect(again).toMatchObject({ duplicate: true, detectionId: out.detectionId });
    expect(counter('stored')).toBe(before);
    expect(await prisma.objectCrop.count({ where: { detectionEventId: out.detectionId } })).toBe(1);
  });

  it('nothing is captured without a snapshot, a box or an object class (the class decides person or not, so it is never guessed)', async () => {
    process.env[FLAG] = 'true';
    const svc = new DetectionIngestionService(prisma, () => ({} as any), noEvents);
    const skipped = counter('skipped');
    for (const over of [{ snapshotPath: undefined }, { boundingBox: undefined }, { objectClass: undefined }]) {
      const out = await submit(svc, over);
      expect(await cropRow(out.detectionId)).toBeNull();
    }
    expect(counter('skipped')).toBe(skipped + 3);
  });

  it('person crops are refused by default (per-site gate), counted as policy_denied, and the detection is still stored', async () => {
    process.env[FLAG] = 'true';
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const before = counter('policy_denied');
    const svc = new DetectionIngestionService(prisma, () => ({} as any), noEvents);
    const out = await submit(svc, { type: 'PERSON_DETECTED', objectClass: 'person' });
    expect(await prisma.detectionEvent.findUnique({ where: { id: out.detectionId } })).not.toBeNull();
    expect(await cropRow(out.detectionId)).toBeNull();
    expect(filesUnder(cropsDir).filter((f) => f.includes(out.detectionId))).toEqual([]);
    expect(counter('policy_denied')).toBe(before + 1);
    expect(errors).not.toHaveBeenCalled(); // an expected refusal is not an error
  });

  it('a site that enabled person crops with a recorded purpose gets them, with the 7-day default and per-site overrides', async () => {
    process.env[FLAG] = 'true';
    await prisma.siteCropPolicy.upsert({
      where: { siteId },
      create: { siteId, personCropsEnabled: true, acknowledgedPurpose: 'SECURITY_INCIDENT_INVESTIGATION', acknowledgedByUserId: 'admin-1', acknowledgedAt: new Date() },
      update: { personCropsEnabled: true, acknowledgedPurpose: 'SECURITY_INCIDENT_INVESTIGATION', acknowledgedByUserId: 'admin-1', acknowledgedAt: new Date(), personRetentionDays: null, nonPersonRetentionDays: null },
    });
    try {
      const svc = new DetectionIngestionService(prisma, () => ({} as any), noEvents);
      const a = await submit(svc, { type: 'PERSON_DETECTED', objectClass: 'person' });
      const rowA = await cropRow(a.detectionId);
      expect(rowA).toMatchObject({ cropClass: 'PERSON' });
      expect(rowA!.expiresAt.getTime() - t0.getTime()).toBe(7 * DAY);

      await prisma.siteCropPolicy.update({ where: { siteId }, data: { personRetentionDays: 2, nonPersonRetentionDays: 30 } });
      const b = await submit(svc, { type: 'PERSON_DETECTED', objectClass: 'person' });
      const c = await submit(svc);
      expect((await cropRow(b.detectionId))!.expiresAt.getTime() - t0.getTime()).toBe(2 * DAY);
      expect((await cropRow(c.detectionId))!.expiresAt.getTime() - t0.getTime()).toBe(30 * DAY);
    } finally {
      await prisma.siteCropPolicy.deleteMany({ where: { siteId } });
    }
  });

  it('a switch without an acknowledged purpose cannot exist (database CHECK), so the gate cannot be half-open', async () => {
    await expect(prisma.siteCropPolicy.create({ data: { siteId, personCropsEnabled: true } })).rejects.toThrow();
  });

  it('low or unknown free space fails loudly (log, counter), writes nothing, and never stops the detection', async () => {
    process.env[FLAG] = 'true';
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const lowBefore = counter('failed', 'LOW_SPACE');
    const out = await submit(withFreeSpace(() => 10));
    expect(await prisma.detectionEvent.findUnique({ where: { id: out.detectionId } })).not.toBeNull();
    expect(await cropRow(out.detectionId)).toBeNull();
    expect(filesUnder(cropsDir).filter((f) => f.includes(out.detectionId))).toEqual([]);
    expect(counter('failed', 'LOW_SPACE')).toBe(lowBefore + 1);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('LOW_SPACE'));

    const unknownBefore = counter('failed', 'SPACE_UNKNOWN');
    const out2 = await submit(
      withFreeSpace(() => {
        throw new Error('statfs unavailable');
      })
    );
    expect(await cropRow(out2.detectionId)).toBeNull();
    expect(counter('failed', 'SPACE_UNKNOWN')).toBe(unknownBefore + 1);
  });

  it('a snapshot outside the allowed roots, behind a symlink, or missing is refused and counted; nothing is stored', async () => {
    process.env[FLAG] = 'true';
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const svc = new DetectionIngestionService(prisma, () => ({} as any), noEvents);
    const link = path.join(snapshots, 'link.jpg');
    fs.symlinkSync(path.join(outside, 'elsewhere.jpg'), link);
    try {
      const badId = counter('failed', 'BAD_ID');
      const unreadable = counter('failed', 'SOURCE_UNREADABLE');
      for (const p of [path.join(outside, 'elsewhere.jpg'), link]) {
        const out = await submit(svc, { snapshotPath: p });
        expect(await cropRow(out.detectionId)).toBeNull();
      }
      expect(counter('failed', 'BAD_ID')).toBe(badId + 2);
      const gone = await submit(svc, { snapshotPath: path.join(snapshots, 'does-not-exist.jpg') });
      expect(await cropRow(gone.detectionId)).toBeNull();
      expect(counter('failed', 'SOURCE_UNREADABLE')).toBe(unreadable + 1);
    } finally {
      fs.rmSync(link, { force: true });
    }
  });

  it('a database failure after the file was written removes the file (no crop without a row)', async () => {
    const det = await prisma.detectionEvent.create({ data: { tenantId, cameraId, type: 'VEHICLE_DETECTED', confidence: 0.9, objectClass: 'car', timestamp: t0 } });
    const failing: any = new Proxy(prisma, {
      get: (t: any, k) => (k === 'objectCrop' ? { findUnique: (a: any) => t.objectCrop.findUnique(a), create: () => Promise.reject(new Error('db down')) } : t[k]),
    });
    const svc = new CropCaptureService(failing);
    await expect(svc.capture({ tenantId, cameraId, detectionId: det.id, objectClass: 'car', boundingBox: { x: 0, y: 0, width: 0.5, height: 0.5 }, snapshotPath: snap, capturedAt: t0 })).rejects.toThrow('db down');
    expect(filesUnder(cropsDir).filter((f) => f.includes(det.id))).toEqual([]);
  });

  it('CropStoreError codes stay typed for callers', async () => {
    const svc = new CropCaptureService(prisma);
    const det = await prisma.detectionEvent.create({ data: { tenantId, cameraId, type: 'VEHICLE_DETECTED', confidence: 0.9, objectClass: 'car', timestamp: t0 } });
    await expect(svc.capture({ tenantId, cameraId, detectionId: det.id, objectClass: 'car', boundingBox: { x: 1, y: 1, width: 0.2, height: 0.2 }, snapshotPath: snap, capturedAt: t0 })).rejects.toBeInstanceOf(CropStoreError);
  });
});

describe('P5.1 crop supplied by the ai-worker (AI_ATTACH_CROPS)', () => {
  const jpegB64 = () => fs.readFileSync(snap).toString('base64'); // a complete JPEG made by ffmpeg
  const noSnapshot = { snapshotPath: undefined, boundingBox: undefined };

  it('flag ON: the attached JPEG is stored as-is (no snapshot file or box needed); the detection keeps no image', async () => {
    process.env[FLAG] = 'true';
    const svc = new DetectionIngestionService(prisma, () => ({} as any), noEvents);
    const out = await submit(svc, { ...noSnapshot, cropJpegBase64: jpegB64() });
    const row = await cropRow(out.detectionId);
    expect(row).toMatchObject({ cropClass: 'NON_PERSON', objectClass: 'car' });
    const stored = fs.readFileSync(path.join(cropsDir, row!.relativePath));
    expect(stored.equals(Buffer.from(jpegB64(), 'base64'))).toBe(true);
    expect(row!.sha256).toBe(crypto.createHash('sha256').update(stored).digest('hex'));
    expect(await prisma.detectionEvent.findUniqueOrThrow({ where: { id: out.detectionId } })).toMatchObject({ snapshotPath: null });
  });

  it('flag OFF: an attached crop is ignored', async () => {
    const svc = new DetectionIngestionService(prisma, () => ({} as any), noEvents);
    const out = await submit(svc, { ...noSnapshot, cropJpegBase64: jpegB64() });
    expect(await cropRow(out.detectionId)).toBeNull();
  });

  it('a person crop is refused unless the site enabled it, before anything is written', async () => {
    process.env[FLAG] = 'true';
    const svc = new DetectionIngestionService(prisma, () => ({} as any), noEvents);
    const denied = await submit(svc, { ...noSnapshot, type: 'PERSON_DETECTED', objectClass: 'person', cropJpegBase64: jpegB64() });
    expect(await cropRow(denied.detectionId)).toBeNull();
    expect(filesUnder(cropsDir).filter((f) => f.includes(denied.detectionId))).toEqual([]);

    await prisma.siteCropPolicy.create({ data: { siteId, personCropsEnabled: true, acknowledgedPurpose: 'SECURITY_INCIDENT_INVESTIGATION', acknowledgedByUserId: 'admin-1', acknowledgedAt: new Date() } });
    try {
      const allowed = await submit(svc, { ...noSnapshot, type: 'PERSON_DETECTED', objectClass: 'person', cropJpegBase64: jpegB64() });
      expect(await cropRow(allowed.detectionId)).toMatchObject({ cropClass: 'PERSON' });
    } finally {
      await prisma.siteCropPolicy.deleteMany({ where: { siteId } });
    }
  });

  it('bytes that are not a complete JPEG are refused and counted; the detection is still stored', async () => {
    process.env[FLAG] = 'true';
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const svc = new DetectionIngestionService(prisma, () => ({} as any), noEvents);
    const before = counter('failed', 'CUT_FAILED');
    const truncated = Buffer.from(jpegB64(), 'base64').subarray(0, 500).toString('base64');
    for (const bad of [truncated, Buffer.from('not an image at all').toString('base64')]) {
      const out = await submit(svc, { ...noSnapshot, cropJpegBase64: bad });
      expect(await prisma.detectionEvent.findUnique({ where: { id: out.detectionId } })).not.toBeNull();
      expect(await cropRow(out.detectionId)).toBeNull();
    }
    expect(counter('failed', 'CUT_FAILED')).toBe(before + 2);
  });
});
