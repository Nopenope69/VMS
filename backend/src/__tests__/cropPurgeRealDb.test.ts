/**
 * P5.1 scheduled crop purge on the real database and real files: expired crops are removed, held
 * ones (incident hold, legal-hold manifest) are kept, and if the hold lookup cannot be read the run
 * deletes nothing, reports the failure and audits it (fail closed). Portable: os.tmpdir() only.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera } from './helpers/realDb';
import { CropPurger, purgeTenantCrops } from '../services/crops/cropPurge.service';
import { CropStore } from '../services/crops/cropStore';
import { MetricsService } from '../services/observability/metrics.service';

jest.setTimeout(120000);

const prisma = new PrismaClient();
const DAY = 86_400_000;
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'croppurge-')));
const root = path.join(tmp, 'crops');
const now = new Date('2026-10-01T12:00:00.000Z');
const store = () => new CropStore(root, undefined, undefined, () => now);
let tenantId = '';
let cameraId = '';
let otherCameraId = '';
let siteId = '';
let userId = '';
let seq = 0;

/** A stored crop with a real file. capturedDaysAgo/ttlDays decide whether it is expired at `now`. */
async function makeCrop(opts: { camera?: string; capturedDaysAgo: number; ttlDays: number; withFile?: boolean; asDirectory?: boolean; rowId?: string }) {
  const id = `c${Date.now().toString(36)}${(seq++).toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  const capturedAt = new Date(now.getTime() - opts.capturedDaysAgo * DAY);
  const camera = opts.camera ?? cameraId;
  const rel = `${tenantId}/${camera}/${capturedAt.toISOString().slice(0, 10)}/${id}.jpg`;
  const abs = path.join(root, rel);
  if (opts.asDirectory) fs.mkdirSync(abs, { recursive: true });
  else if (opts.withFile !== false) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(`jpeg-${id}`));
  }
  const row = await prisma.objectCrop.create({
    data: { ...(opts.rowId ? { id: opts.rowId } : {}), tenantId, cameraId: camera, cropClass: 'NON_PERSON', objectClass: 'car', relativePath: rel, sha256: crypto.createHash('sha256').update(id).digest('hex'), byteLength: 10, capturedAt, expiresAt: new Date(capturedAt.getTime() + opts.ttlDays * DAY) },
  });
  return { row, abs };
}
const exists = (p: string) => fs.existsSync(p);
const rowExists = async (id: string) => (await prisma.objectCrop.count({ where: { id } })) === 1;

beforeAll(async () => {
  ({ tenantId, cameraId, siteId } = await createTenantWithCamera(prisma, 'croppurge'));
  const other = await prisma.camera.create({ data: { tenantId, siteId, name: 'other', streamPath: `other_${tenantId.slice(0, 6)}`, ipAddress: '127.0.0.2', mainRtspUri: 'rtsp://127.0.0.2/x' } });
  otherCameraId = other.id;
  userId = (await prisma.user.create({ data: { tenantId, email: `purge-${crypto.randomBytes(4).toString('hex')}@test.invalid`, passwordHash: 'x', name: 'purge', role: 'TENANT_ADMIN' } })).id;
});
afterAll(async () => {
  await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await prisma.$disconnect();
  fs.rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => jest.restoreAllMocks());

describe('P5.1 crop retention purge', () => {
  it('removes expired unheld crops (file and row), keeps unexpired ones, and audits the run', async () => {
    const expired = await makeCrop({ capturedDaysAgo: 20, ttlDays: 14 });
    const fresh = await makeCrop({ capturedDaysAgo: 3, ttlDays: 14 });
    const r = await purgeTenantCrops(prisma, tenantId, store(), now);
    expect(r).toMatchObject({ deleted: 1, heldSkipped: 0, failed: 0 });
    expect(exists(expired.abs)).toBe(false);
    expect(await rowExists(expired.row.id)).toBe(false);
    expect(exists(fresh.abs)).toBe(true);
    expect(await rowExists(fresh.row.id)).toBe(true);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId, action: 'CROP_RETENTION_PURGE' }, orderBy: { sequenceNumber: 'desc' } });
    expect(audit.metadataJson).toMatchObject({ deleted: 1, heldSkipped: 0, failed: 0 });
    await prisma.objectCrop.delete({ where: { id: fresh.row.id } });
  });

  it('keeps expired crops covered by an unexpired incident hold or a legal-hold manifest; other cameras and lapsed holds do not protect', async () => {
    const alarm = await prisma.alarm.create({ data: { tenantId, cameraId, title: 'held' } });
    const heldByIncident = await makeCrop({ capturedDaysAgo: 30, ttlDays: 14 });
    await prisma.incidentEvidenceHold.create({ data: { tenantId, alarmId: alarm.id, cameraId, windowStart: new Date(now.getTime() - 31 * DAY), windowEnd: new Date(now.getTime() - 29 * DAY), expiresAt: new Date(now.getTime() + 10 * DAY) } });

    const heldByLegal = await makeCrop({ capturedDaysAgo: 60, ttlDays: 14 });
    await prisma.evidenceManifest.create({ data: { tenantId, createdByUserId: userId, startUtc: new Date(now.getTime() - 61 * DAY), endUtc: new Date(now.getTime() - 59 * DAY), cameraIdsJson: [cameraId], masterEvidenceHash: 'a'.repeat(64), sourceMetadataJson: {}, segmentManifestJson: [], legalHold: true } });

    const otherCamera = await makeCrop({ camera: otherCameraId, capturedDaysAgo: 30, ttlDays: 14 }); // same time as the incident hold, different camera
    const lapsed = await makeCrop({ capturedDaysAgo: 90, ttlDays: 14 });
    const lapsedAlarm = await prisma.alarm.create({ data: { tenantId, cameraId, title: 'lapsed' } });
    await prisma.incidentEvidenceHold.create({ data: { tenantId, alarmId: lapsedAlarm.id, cameraId, windowStart: new Date(now.getTime() - 91 * DAY), windowEnd: new Date(now.getTime() - 89 * DAY), expiresAt: new Date(now.getTime() - 1000) } });

    const r = await purgeTenantCrops(prisma, tenantId, store(), now);
    expect(r).toMatchObject({ deleted: 2, heldSkipped: 2, failed: 0 });
    for (const kept of [heldByIncident, heldByLegal]) {
      expect(exists(kept.abs)).toBe(true);
      expect(await rowExists(kept.row.id)).toBe(true);
    }
    for (const gone of [otherCamera, lapsed]) {
      expect(exists(gone.abs)).toBe(false);
      expect(await rowExists(gone.row.id)).toBe(false);
    }
    await prisma.objectCrop.deleteMany({ where: { id: { in: [heldByIncident.row.id, heldByLegal.row.id] } } });
    await prisma.evidenceManifest.deleteMany({ where: { tenantId } });
    await prisma.incidentEvidenceHold.deleteMany({ where: { tenantId } });
  });

  it.each(['incidentEvidenceHold', 'evidenceManifest'])('fails closed when the %s lookup fails: nothing is deleted, the failure is logged, counted and audited', async (model) => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const a = await makeCrop({ capturedDaysAgo: 40, ttlDays: 14 });
    const b = await makeCrop({ capturedDaysAgo: 41, ttlDays: 14 });
    const broken: any = new Proxy(prisma, {
      get: (t: any, k) => (k === model ? { findMany: () => Promise.reject(new Error(`${model} unavailable`)) } : t[k]),
    });

    await expect(purgeTenantCrops(broken, tenantId, store(), now)).rejects.toThrow(`${model} unavailable`);
    for (const c of [a, b]) {
      expect(exists(c.abs)).toBe(true);
      expect(await rowExists(c.row.id)).toBe(true);
    }

    const failuresBefore = MetricsService.getValue('vigilone_crop_purge_failures_total') ?? 0;
    const auditBefore = await prisma.auditEvent.count({ where: { tenantId, action: 'CROP_PURGE_FAILED' } });
    const results = await new CropPurger(broken, (n) => new CropStore(root, undefined, undefined, () => n)).runOnce(now);
    expect(results).toEqual([]);
    expect(exists(a.abs) && exists(b.abs)).toBe(true);
    expect(MetricsService.getValue('vigilone_crop_purge_failures_total')).toBe(failuresBefore + 1);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(`${model} unavailable`));
    expect(await prisma.auditEvent.count({ where: { tenantId, action: 'CROP_PURGE_FAILED' } })).toBe(auditBefore + 1);

    // Once the lookup works again the next run purges them.
    const ok = await new CropPurger(prisma, (n) => new CropStore(root, undefined, undefined, () => n)).runOnce(now);
    expect(ok.find((x) => x.tenantId === tenantId)).toMatchObject({ deleted: 2 });
    expect(exists(a.abs) || exists(b.abs)).toBe(false);
  });

  it('a row whose file is already gone is removed; a file that cannot be removed keeps its row and is reported', async () => {
    const missing = await makeCrop({ capturedDaysAgo: 30, ttlDays: 14, withFile: false });
    const stuck = await makeCrop({ capturedDaysAgo: 30, ttlDays: 14, asDirectory: true }); // unlink on a directory fails on every platform, even as root
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await purgeTenantCrops(prisma, tenantId, store(), now);
    expect(r).toMatchObject({ deleted: 0, missingRowsRemoved: 1, failed: 1 });
    expect(await rowExists(missing.row.id)).toBe(false);
    expect(await rowExists(stuck.row.id)).toBe(true);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(stuck.row.id));
    fs.rmSync(stuck.abs, { recursive: true, force: true });
    await prisma.objectCrop.delete({ where: { id: stuck.row.id } });
  });

  it('pages past held rows: more held rows than one batch do not stop later expired crops from being purged', async () => {
    const alarm = await prisma.alarm.create({ data: { tenantId, cameraId: otherCameraId, title: 'big hold' } });
    await prisma.incidentEvidenceHold.create({ data: { tenantId, alarmId: alarm.id, cameraId: otherCameraId, windowStart: new Date(now.getTime() - 100 * DAY), windowEnd: new Date(now.getTime() - 40 * DAY), expiresAt: new Date(now.getTime() + DAY) } });
    const capturedAt = new Date(now.getTime() - 50 * DAY);
    const N = 505; // BATCH is 500
    await prisma.objectCrop.createMany({
      // Ids sort before the targets' ids below, so the targets can only be reached on the second page.
      data: Array.from({ length: N }, (_, i) => ({ id: `held-${String(i).padStart(4, '0')}`, tenantId, cameraId: otherCameraId, cropClass: 'NON_PERSON', objectClass: 'car', relativePath: `${tenantId}/${otherCameraId}/held/${i}-${crypto.randomBytes(4).toString('hex')}.jpg`, sha256: 'b'.repeat(64), byteLength: 1, capturedAt, expiresAt: new Date(capturedAt.getTime() + DAY) })),
    });
    const targets = [];
    for (let i = 0; i < 3; i++) targets.push(await makeCrop({ capturedDaysAgo: 45, ttlDays: 14, rowId: `zz-target-${i}` }));
    const r = await purgeTenantCrops(prisma, tenantId, store(), now);
    expect(r.heldSkipped).toBe(N);
    expect(r.deleted).toBe(3);
    for (const t of targets) expect(exists(t.abs)).toBe(false);
    expect(await prisma.objectCrop.count({ where: { tenantId, cameraId: otherCameraId } })).toBe(N);
  });
});
