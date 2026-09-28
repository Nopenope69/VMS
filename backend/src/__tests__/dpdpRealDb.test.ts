/**
 * P4.6 DPDP controls on the real HTTP/DB path: purpose limitation and audit on plate queries, RBAC
 * (viewers cannot read plate data), the per-tenant face switch (default off) and the retention
 * purge (honours incident holds and legal holds, deletes snapshot files only under the allowed
 * roots).
 */
jest.mock('../config/licenseKeys', () => {
  const c = require('crypto');
  const kp = c.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  return { VENDOR_LICENSE_PUBLIC_KEY: kp.publicKey, TEST_LICENSE_PRIVATE_KEY: kp.privateKey };
});

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PrismaClient, RedactionMode } from '@prisma/client';
import { createTenantWithCamera, createUserWithToken, startApp } from './helpers/realDb';
import { signLicensePayload } from '../utils/license';

const { TEST_LICENSE_PRIVATE_KEY } = jest.requireMock('../config/licenseKeys');

jest.setTimeout(60000);

const prisma = new PrismaClient();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dpdp-'));
const DAY = 86_400_000;
let tenantId = '';
let cameraId = '';
let adminId = '';
let admin = '';
let operator = '';
let viewer = '';
let app: { url: string; close: () => Promise<void> };
const env = { ...process.env };

beforeAll(async () => {
  process.env.VIGILONE_FEATURE_ANPR = 'true';
  process.env.VIGILONE_FEATURE_REDACTION = 'true';
  process.env.RECORDINGS_DIR = path.join(tmp, 'recordings');
  fs.mkdirSync(process.env.RECORDINGS_DIR, { recursive: true });
  ({ tenantId, cameraId } = await createTenantWithCamera(prisma, 'dpdp'));
  ({ userId: adminId, token: admin } = await createUserWithToken(prisma, tenantId, 'TENANT_ADMIN'));
  ({ token: operator } = await createUserWithToken(prisma, tenantId, 'OPERATOR'));
  ({ token: viewer } = await createUserWithToken(prisma, tenantId, 'VIEWER'));
  const claims = { licenseId: `lic_dpdp_${crypto.randomBytes(4).toString('hex')}`, tenantId, tier: 'ENTERPRISE', maxCameras: 16, features: ['ANPR'], issuedAt: new Date().toISOString(), expiresAt: null, kid: 'test' } as any;
  const art = signLicensePayload(claims, TEST_LICENSE_PRIVATE_KEY);
  await prisma.license.create({ data: { tenantId, licenseId: claims.licenseId, tier: 'ENTERPRISE', maxCameras: 16, features: ['ANPR'], signedPayload: art.signedPayload, signatureEd25519: art.signatureEd25519 } });
  app = await startApp();
});
afterAll(async () => {
  await app.close();
  await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await prisma.$disconnect();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.env = env;
});

const call = async (token: string, method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${app.url}/api/v1${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
};
const audits = (action: string) => prisma.auditEvent.findMany({ where: { tenantId, action }, orderBy: { timestampUtc: 'asc' } });

describe('P4.6 purpose limitation, RBAC and audit on plate queries', () => {
  it('refuses a plate query without a purpose, with an unknown purpose, or without a needed reference', async () => {
    expect((await call(operator, 'GET', '/anpr/observations')).json.code).toBe('PURPOSE_REQUIRED');
    expect((await call(operator, 'GET', '/anpr/observations', undefined, { 'x-vigilone-purpose': 'CURIOSITY' })).json.code).toBe('PURPOSE_UNKNOWN');
    expect((await call(operator, 'GET', '/anpr/observations', undefined, { 'x-vigilone-purpose': 'LAW_ENFORCEMENT_REQUEST' })).json.code).toBe('PURPOSE_REFERENCE_REQUIRED');
    expect((await call(operator, 'GET', '/anpr/watchlist')).status).toBe(400);
    expect(await audits('ANPR_OBSERVATIONS_QUERY')).toHaveLength(0);
  });

  it('answers with a declared purpose and audits who, why, filters and result size', async () => {
    await prisma.vehicleObservation.create({ data: { tenantId, cameraId, plateNumber: 'MH 12 AB 1234', normalizedPlate: 'MH12AB1234' } });
    const r = await call(operator, 'GET', '/anpr/observations?plateQuery=MH12', undefined, { 'x-vigilone-purpose': 'LAW_ENFORCEMENT_REQUEST', 'x-vigilone-purpose-reference': 'FIR 123/2026 Pune' });
    expect(r.status).toBe(200);
    expect(r.json.observations).toHaveLength(1);
    const a = await audits('ANPR_OBSERVATIONS_QUERY');
    expect(a).toHaveLength(1);
    expect(a[0].metadataJson).toMatchObject({ category: 'PLATE', purpose: 'LAW_ENFORCEMENT_REQUEST', purposeReference: 'FIR 123/2026 Pune', resultCount: 1, filters: expect.objectContaining({ plateQuery: 'MH12' }) });
    expect((await call(operator, 'GET', '/anpr/watchlist?purpose=ACCESS_CONTROL')).status).toBe(200);
    expect(await audits('ANPR_WATCHLIST_QUERY')).toHaveLength(1);
  });

  it('viewers cannot read plate data at all', async () => {
    expect((await call(viewer, 'GET', '/anpr/observations', undefined, { 'x-vigilone-purpose': 'AUDIT_REVIEW' })).status).toBe(403);
  });

  it('a purpose the tenant disallowed is refused (settings change audited)', async () => {
    const put = await call(admin, 'PUT', '/privacy/dpdp/settings', { allowedPurposes: ['SECURITY_INCIDENT_INVESTIGATION'] });
    expect(put.status).toBe(200);
    expect((await call(operator, 'GET', '/anpr/observations', undefined, { 'x-vigilone-purpose': 'ACCESS_CONTROL' })).json.code).toBe('PURPOSE_NOT_PERMITTED');
    expect((await call(operator, 'GET', '/anpr/observations', undefined, { 'x-vigilone-purpose': 'SECURITY_INCIDENT_INVESTIGATION' })).status).toBe(200);
    const a = await audits('DPDP_SETTINGS_UPDATE');
    expect((a[0].metadataJson as any).after.allowedPurposes).toEqual(['SECURITY_INCIDENT_INVESTIGATION']);
    expect((await call(operator, 'PUT', '/privacy/dpdp/settings', { plateRetentionDays: 5 })).status).toBe(403);
  });
});

describe('P4.6 face switch (default off)', () => {
  it('is off by default; turning it on needs an explicit acknowledgement; face redaction follows it', async () => {
    expect((await call(admin, 'GET', '/privacy/dpdp/settings')).json.settings.faceProcessingEnabled).toBe(false);
    const m = await prisma.evidenceManifest.create({ data: { tenantId, createdByUserId: adminId, startUtc: new Date(), endUtc: new Date(), cameraIdsJson: [cameraId], masterEvidenceHash: 'a'.repeat(64), sourceMetadataJson: {}, segmentManifestJson: [] } });
    const face = await call(admin, 'POST', '/privacy/jobs', { sourceManifestId: m.id, redactionMode: 'FACE' });
    expect(face.status).toBe(403);
    expect(face.json.code).toBe('REDACTION_FACE_PROCESSING_DISABLED');
    expect((await call(admin, 'POST', '/privacy/jobs', { sourceManifestId: m.id, redactionMode: 'LICENSE_PLATE' })).status).toBe(201);

    expect((await call(admin, 'PUT', '/privacy/dpdp/settings', { faceProcessingEnabled: true })).json.code).toBe('BIOMETRIC_ACKNOWLEDGEMENT_REQUIRED');
    expect((await call(admin, 'PUT', '/privacy/dpdp/settings', { faceProcessingEnabled: true, acknowledgeBiometricProcessing: true })).status).toBe(200);
    expect((await call(admin, 'POST', '/privacy/jobs', { sourceManifestId: m.id, redactionMode: RedactionMode.FACE })).status).toBe(201);
    const a = await audits('DPDP_SETTINGS_UPDATE');
    expect((a[a.length - 1].metadataJson as any)).toMatchObject({ biometricAcknowledged: true, before: { faceProcessingEnabled: false }, after: { faceProcessingEnabled: true } });
    await call(admin, 'PUT', '/privacy/dpdp/settings', { faceProcessingEnabled: false });
  });

  it('camera face analytics are dropped while the switch is off', async () => {
    const { CameraEventManager } = require('../services/cameraEvents/cameraEventManager.service');
    const ingested: any[] = [];
    const mgr = new CameraEventManager(prisma, (ev: any) => ingested.push(ev));
    const r = { lastState: new Map() };
    const ev = (analyticType: string) => ({ protocol: 'HIKVISION_ISAPI', analyticType, state: true, vendorTopic: analyticType.toLowerCase() });
    expect(await mgr.handle(r, tenantId, cameraId, ev('FACE'))).toBe(false);
    expect(await mgr.handle(r, tenantId, cameraId, ev('LINE_CROSSING'))).toBe(true);
  });
});

describe('P4.6 retention purge', () => {
  it('deletes expired plate reads and snapshot files, keeps held and recent ones, audits the run', async () => {
    await call(admin, 'PUT', '/privacy/dpdp/settings', { plateRetentionDays: 7, detectionSnapshotRetentionDays: 3 });
    const now = Date.now();
    const snap = (n: string) => {
      const f = path.join(process.env.RECORDINGS_DIR!, `${n}.jpg`);
      fs.writeFileSync(f, crypto.randomBytes(64));
      return f;
    };
    const old = await prisma.vehicleObservation.create({ data: { tenantId, cameraId, plateNumber: 'KA01AB1111', normalizedPlate: 'KA01AB1111', firstSeenAt: new Date(now - 10 * DAY), lastSeenAt: new Date(now - 10 * DAY), bestSnapshotPath: snap('old-plate') } });
    const recent = await prisma.vehicleObservation.create({ data: { tenantId, cameraId, plateNumber: 'KA01AB2222', normalizedPlate: 'KA01AB2222', firstSeenAt: new Date(now - DAY), lastSeenAt: new Date(now - DAY) } });
    const heldObs = await prisma.vehicleObservation.create({ data: { tenantId, cameraId, plateNumber: 'KA01AB3333', normalizedPlate: 'KA01AB3333', firstSeenAt: new Date(now - 20 * DAY), lastSeenAt: new Date(now - 20 * DAY) } });
    const alarm = await prisma.alarm.create({ data: { tenantId, cameraId, title: 'held', severity: 'CRITICAL' } });
    await prisma.incidentEvidenceHold.create({ data: { tenantId, alarmId: alarm.id, cameraId, windowStart: new Date(now - 21 * DAY), windowEnd: new Date(now - 19 * DAY), expiresAt: new Date(now + 30 * DAY) } });
    const outside = await prisma.vehicleObservation.create({ data: { tenantId, cameraId, plateNumber: 'KA01AB4444', normalizedPlate: 'KA01AB4444', firstSeenAt: new Date(now - 9 * DAY), lastSeenAt: new Date(now - 9 * DAY), bestSnapshotPath: '/etc/hostname' } });
    const detSnap = snap('old-detection');
    const det = await prisma.detectionEvent.create({ data: { tenantId, cameraId, type: 'PERSON_DETECTED', timestamp: new Date(now - 5 * DAY), snapshotPath: detSnap } });

    const r = await call(admin, 'POST', '/privacy/dpdp/purge');
    expect(r.status).toBe(200);
    expect(r.json.result).toMatchObject({ plateReadsDeleted: 2, plateReadsHeld: 1, detectionSnapshotsDeleted: 1, snapshotFilesOutsideRoots: 1 });
    expect(await prisma.vehicleObservation.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await prisma.vehicleObservation.findUnique({ where: { id: outside.id } })).toBeNull();
    expect(await prisma.vehicleObservation.findUnique({ where: { id: recent.id } })).not.toBeNull();
    expect(await prisma.vehicleObservation.findUnique({ where: { id: heldObs.id } })).not.toBeNull();
    expect(fs.existsSync(path.join(process.env.RECORDINGS_DIR!, 'old-plate.jpg'))).toBe(false);
    expect(fs.existsSync('/etc/hostname')).toBe(true);
    expect(fs.existsSync(detSnap)).toBe(false);
    expect((await prisma.detectionEvent.findUniqueOrThrow({ where: { id: det.id } })).snapshotPath).toBeNull();
    const a = await audits('DPDP_RETENTION_PURGE');
    expect((a[a.length - 1].metadataJson as any)).toMatchObject({ plateReadsDeleted: 2, plateRetentionDays: 7 });
    expect((await call(admin, 'GET', '/privacy/dpdp/settings')).json.settings.lastPurgeAt).toBeTruthy();
  });
});
