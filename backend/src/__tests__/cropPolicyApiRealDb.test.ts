/**
 * P5.1 per-site crop policy API on the real Express app and database: flag gating, RBAC, tenant
 * isolation, the purpose requirement for person crops, audit, and the effect on real capture.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera, createUserWithToken, startApp } from './helpers/realDb';
import { CropCaptureService } from '../services/crops/cropCapture.service';

jest.setTimeout(60000);

const prisma = new PrismaClient();
const FLAG = 'VIGILONE_FEATURE_OBJECT_CROPS';
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'croppolicy-')));
const saved = { ...process.env };
let app: { url: string; close: () => Promise<void> };
let a = { tenantId: '', siteId: '', cameraId: '', adminId: '', admin: '', operator: '', viewer: '' };
let b = { tenantId: '', siteId: '', admin: '' };
let jpeg = Buffer.alloc(0);

const call = async (token: string, method: string, siteId: string, body?: unknown) => {
  const r = await fetch(`${app.url}/api/v1/crop-policy/${siteId}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
};

beforeAll(async () => {
  process.env.CROPS_DIR = path.join(tmp, 'crops');
  process.env.CROP_MIN_FREE_BYTES = '1024';
  const t1 = await createTenantWithCamera(prisma, 'cpol-a');
  const t2 = await createTenantWithCamera(prisma, 'cpol-b');
  const admin = await createUserWithToken(prisma, t1.tenantId, 'TENANT_ADMIN');
  a = { tenantId: t1.tenantId, siteId: t1.siteId, cameraId: t1.cameraId, adminId: admin.userId, admin: admin.token, operator: (await createUserWithToken(prisma, t1.tenantId, 'OPERATOR')).token, viewer: (await createUserWithToken(prisma, t1.tenantId, 'VIEWER')).token };
  b = { tenantId: t2.tenantId, siteId: t2.siteId, admin: (await createUserWithToken(prisma, t2.tenantId, 'TENANT_ADMIN')).token };
  const f = path.join(tmp, 'crop.jpg');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=1', '-frames:v', '1', f]);
  jpeg = fs.readFileSync(f);
  app = await startApp();
});
afterAll(async () => {
  await app.close();
  await prisma.tenant.deleteMany({ where: { id: { in: [a.tenantId, b.tenantId] } } });
  await prisma.$disconnect();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.env = saved;
});
afterEach(() => {
  delete process.env[FLAG];
});

describe('P5.1 crop policy API', () => {
  it('flag OFF: 501 FEATURE_DISABLED and nothing is written', async () => {
    const r = await call(a.admin, 'PUT', a.siteId, { personCropsEnabled: true, purpose: 'SECURITY_INCIDENT_INVESTIGATION' });
    expect(r.status).toBe(501);
    expect(r.json.code).toBe('FEATURE_DISABLED');
    expect(await prisma.siteCropPolicy.count({ where: { siteId: a.siteId } })).toBe(0);
  });

  it('defaults: person crops off, ADR retention, no row created by reading', async () => {
    process.env[FLAG] = 'true';
    const r = await call(a.admin, 'GET', a.siteId);
    expect(r.status).toBe(200);
    expect(r.json.policy).toMatchObject({ personCropsEnabled: false, acknowledgedPurpose: null, nonPersonRetentionDays: 14, personRetentionDays: 7, usingDefaultRetention: { nonPerson: true, person: true }, storedPersonCrops: 0 });
    expect(r.json.purposes).toContain('SECURITY_INCIDENT_INVESTIGATION');
    expect(await prisma.siteCropPolicy.count({ where: { siteId: a.siteId } })).toBe(0);
  });

  it('operators and viewers cannot read or change it; another tenant cannot see the site', async () => {
    process.env[FLAG] = 'true';
    for (const t of [a.operator, a.viewer]) {
      expect((await call(t, 'GET', a.siteId)).status).toBe(403);
      expect((await call(t, 'PUT', a.siteId, { personCropsEnabled: true, purpose: 'AUDIT_REVIEW' })).status).toBe(403);
    }
    const other = await call(b.admin, 'GET', a.siteId);
    expect(other.status).toBe(404);
    expect((await call(b.admin, 'PUT', a.siteId, { personCropsEnabled: true, purpose: 'AUDIT_REVIEW' })).status).toBe(404);
    expect((await call(a.admin, 'GET', 'no-such-site')).status).toBe(404);
    expect(await prisma.siteCropPolicy.count({ where: { siteId: a.siteId } })).toBe(0);
  });

  it('enabling person crops needs a valid purpose (and a reference where required); bad input changes nothing', async () => {
    process.env[FLAG] = 'true';
    const bad: Array<[unknown, string]> = [
      [{ personCropsEnabled: true }, 'PURPOSE_REQUIRED'],
      [{ personCropsEnabled: true, purpose: 'MARKETING' }, 'INVALID_POLICY'],
      [{ personCropsEnabled: true, purpose: 'LAW_ENFORCEMENT_REQUEST' }, 'PURPOSE_REFERENCE_REQUIRED'],
      [{ purpose: 'AUDIT_REVIEW' }, 'PURPOSE_WITHOUT_SWITCH'],
      [{ personRetentionDays: 0 }, 'INVALID_POLICY'],
      [{ nonPersonRetentionDays: 4000 }, 'INVALID_POLICY'],
      [{ unknownField: 1 }, 'INVALID_POLICY'],
      [{}, 'EMPTY_PATCH'],
    ];
    for (const [body, code] of bad) {
      const r = await call(a.admin, 'PUT', a.siteId, body);
      expect([r.status, r.json.code]).toEqual([400, code]);
    }
    expect(await prisma.siteCropPolicy.count({ where: { siteId: a.siteId } })).toBe(0);
  });

  it('enable → audited with who and why → real person capture works → disable clears the acknowledgement and capture is refused again', async () => {
    process.env[FLAG] = 'true';
    const on = await call(a.admin, 'PUT', a.siteId, { personCropsEnabled: true, purpose: 'LAW_ENFORCEMENT_REQUEST', purposeReference: 'FIR 123/2026', personRetentionDays: 3 });
    expect(on.status).toBe(200);
    expect(on.json.policy).toMatchObject({ personCropsEnabled: true, acknowledgedPurpose: 'LAW_ENFORCEMENT_REQUEST: FIR 123/2026', acknowledgedByUserId: a.adminId, personRetentionDays: 3, usingDefaultRetention: { nonPerson: true, person: false } });
    expect(on.json.policy.acknowledgedAt).toBeTruthy();
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: 'CROP_POLICY_UPDATE' }, orderBy: { sequenceNumber: 'desc' } });
    expect(audit).toMatchObject({ userId: a.adminId, resourceType: 'Site', resourceId: a.siteId });
    expect(audit.metadataJson).toMatchObject({ before: { personCropsEnabled: false }, requested: { personCropsEnabled: true, purpose: 'LAW_ENFORCEMENT_REQUEST' } });

    const svc = new CropCaptureService(prisma);
    const det = (n: string) => prisma.detectionEvent.create({ data: { tenantId: a.tenantId, cameraId: a.cameraId, type: 'PERSON_DETECTED', confidence: 0.9, objectClass: 'person', inferenceId: `${n}-${crypto.randomUUID()}` } });
    const d1 = await det('on');
    const stored = await svc.capture({ tenantId: a.tenantId, cameraId: a.cameraId, detectionId: d1.id, objectClass: 'person', cropBytes: jpeg, capturedAt: new Date('2026-09-29T10:00:00Z') });
    expect(stored.outcome).toBe('stored');
    expect((await call(a.admin, 'GET', a.siteId)).json.policy.storedPersonCrops).toBe(1);

    const off = await call(a.admin, 'PUT', a.siteId, { personCropsEnabled: false });
    expect(off.json.policy).toMatchObject({ personCropsEnabled: false, acknowledgedPurpose: null, acknowledgedByUserId: null, acknowledgedAt: null, storedPersonCrops: 1 }); // stored crops stay until retention ends
    const d2 = await det('off');
    await expect(svc.capture({ tenantId: a.tenantId, cameraId: a.cameraId, detectionId: d2.id, objectClass: 'person', cropBytes: jpeg, capturedAt: new Date('2026-09-29T10:00:00Z') })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(await prisma.auditEvent.count({ where: { tenantId: a.tenantId, action: 'CROP_POLICY_UPDATE' } })).toBe(2);
  });

  it('retention overrides apply to capture and null resets them to the default', async () => {
    process.env[FLAG] = 'true';
    const set = await call(a.admin, 'PUT', a.siteId, { nonPersonRetentionDays: 30 });
    expect(set.json.policy).toMatchObject({ nonPersonRetentionDays: 30, usingDefaultRetention: { nonPerson: false } });
    const d = await prisma.detectionEvent.create({ data: { tenantId: a.tenantId, cameraId: a.cameraId, type: 'VEHICLE_DETECTED', confidence: 0.9, objectClass: 'car', inferenceId: `car-${crypto.randomUUID()}` } });
    const t = new Date('2026-09-29T10:00:00Z');
    const r = await new CropCaptureService(prisma).capture({ tenantId: a.tenantId, cameraId: a.cameraId, detectionId: d.id, objectClass: 'car', cropBytes: jpeg, capturedAt: t });
    expect(r.outcome === 'stored' && r.crop.expiresAt.getTime() - t.getTime()).toBe(30 * 86_400_000);
    const reset = await call(a.admin, 'PUT', a.siteId, { nonPersonRetentionDays: null });
    expect(reset.json.policy).toMatchObject({ nonPersonRetentionDays: 14, usingDefaultRetention: { nonPerson: true } });
  });
});
