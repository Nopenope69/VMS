/**
 * P4.1 ANPR on the real database and the real Express app: pipeline registration gated on human
 * approvals of every component, LPR camera mode, provenance-checked ingestion, multi-frame
 * voting, known-plate lists (exact / wildcard / regex), ANPR_MATCH events and alarms through the
 * orchestrator, audited plate queries, and the synthetic endpoint absent outside test mode.
 *
 * Approvals here come from a temporary file marked TEST-ONLY: it exercises the mechanism and is
 * not a licence decision (scripts/models/model-license-exceptions.json stays empty).
 */
jest.mock('../config/licenseKeys', () => {
  const c = require('crypto');
  const kp = c.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  return { VENDOR_LICENSE_PUBLIC_KEY: kp.publicKey, TEST_LICENSE_PRIVATE_KEY: kp.privateKey };
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera, createUserWithToken, startApp } from './helpers/realDb';
import { signLicensePayload } from '../utils/license';
import { markAutomationRulesChanged } from '../services/automation/ruleCache';

const { TEST_LICENSE_PRIVATE_KEY } = jest.requireMock('../config/licenseKeys');
const prisma = new PrismaClient();
const SECRET = process.env.INTERNAL_API_SECRET as string;
const REPO = path.resolve(__dirname, '..', '..', '..');
const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/models/models.lock.json'), 'utf8'));
const pipelineFile = path.join(REPO, 'scripts/models/pipelines/anpr-india-v1.json');
const pipelineDef = JSON.parse(fs.readFileSync(pipelineFile, 'utf8'));
const pipelineSha = crypto.createHash('sha256').update(fs.readFileSync(pipelineFile)).digest('hex');
const approvalsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'anpr-approvals-')), 'model-license-exceptions.json');

let app: { url: string; close: () => Promise<void> };
let tenantId = '';
let cameraId = '';
let admin = { userId: '', token: '' };
let manifestId = '';
const cleanup: string[] = [];

const internal = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(`${app.url}/api/v1/internal${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json()) as any };
};
const api = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(`${app.url}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
};

function manifestBody() {
  const comps = pipelineDef.components.map((c: any) => lock.candidateModels.find((m: any) => m.key === c.key));
  return {
    name: pipelineDef.name,
    version: pipelineDef.version,
    sha256: pipelineSha,
    task: 'plate_recognition',
    codeLicense: [...new Set(comps.map((c: any) => c.codeLicense))].join(' AND '),
    weightLicense: [...new Set(comps.map((c: any) => c.weightLicense))].join(' AND '),
    weightsSource: comps.map((c: any) => c.weightsSource).join('; '),
    trainingData: { source: 'components', license: 'HUMAN-APPROVED EXCEPTION', provenance: 'TEST-ONLY approvals', commercialUse: true },
    runtimeConfig: { runtime: 'onnxruntime', runtimeVersion: '1.30.0', executionProvider: 'cpu', inputWidth: 736, inputHeight: 736, colorSpace: 'BGR', modelFormat: 'ONNX' },
    modelSignature: { decoder: 'anpr_pipeline', components: pipelineDef.components },
    classes: { '0': 'license_plate' },
  };
}

function provenance(over: Record<string, any> = {}) {
  return {
    adapterId: 'vigilone-anpr', adapterVersion: '1.0.0-phase4', modelId: manifestId, modelName: pipelineDef.name, modelVersion: pipelineDef.version,
    modelSha256: pipelineSha, runtime: 'onnxruntime@1.30.0', executionProvider: 'cpu', inferenceId: crypto.randomUUID(), frameTimestampUtc: new Date().toISOString(),
    components: pipelineDef.components.map((c: any) => ({ role: c.role, modelName: c.key, modelVersion: 'x', modelSha256: c.sha256 })),
    ...over,
  };
}

const read = (plateText: string, at: Date, over: Record<string, any> = {}) => ({
  tenantId, cameraId, frameTimestampUtc: at.toISOString(),
  plates: [{ plateText, rawText: plateText, confidence: 0.9, bbox: { x: 0.4, y: 0.6, width: 0.2, height: 0.08 }, lines: 1, format: 'STANDARD' }],
  provenance: { ...provenance(), frameTimestampUtc: at.toISOString() },
  ...over,
});

beforeAll(async () => {
  process.env.VIGILONE_FEATURE_ANPR = 'true';
  process.env.VIGILONE_MODEL_EXCEPTIONS = approvalsFile;
  fs.writeFileSync(approvalsFile, JSON.stringify({ approvals: [] }));
  ({ tenantId, cameraId } = await createTenantWithCamera(prisma, 'anpr'));
  cleanup.push(tenantId);
  admin = await createUserWithToken(prisma, tenantId, 'TENANT_ADMIN');
  const claims = { licenseId: `lic_anpr_${crypto.randomBytes(4).toString('hex')}`, tenantId, tier: 'ENTERPRISE', maxCameras: 16, features: ['ANPR'], issuedAt: new Date().toISOString(), expiresAt: null, kid: 'test' } as any;
  const art = signLicensePayload(claims, TEST_LICENSE_PRIVATE_KEY);
  await prisma.license.create({ data: { tenantId, licenseId: claims.licenseId, tier: 'ENTERPRISE', maxCameras: 16, features: ['ANPR'], signedPayload: art.signedPayload, signatureEd25519: art.signatureEd25519 } });
  app = await startApp();
});

afterAll(async () => {
  delete process.env.VIGILONE_FEATURE_ANPR;
  delete process.env.VIGILONE_MODEL_EXCEPTIONS;
  for (const id of cleanup) await prisma.tenant.delete({ where: { id } }).catch(() => undefined);
  await app?.close();
  await prisma.$disconnect();
});

describe('pipeline registration', () => {
  it('is refused while any component lacks a human approval for its exact SHA-256', async () => {
    const r = await internal('POST', '/model-manifests', manifestBody());
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/ppocrv4-det.*no human licence approval/);
    expect(r.json.error).toMatch(/fast-plate-ocr-cct-s-v2.*no human licence approval/);

    // An approval for a different hash does not count.
    fs.writeFileSync(approvalsFile, JSON.stringify({ approvals: pipelineDef.components.map((c: any) => ({ key: c.key, sha256: 'f'.repeat(64), approvedBy: 'TEST-ONLY', approvedAt: '2026-09-27', reason: 'test' })) }));
    expect((await internal('POST', '/model-manifests', manifestBody())).status).toBe(400);
  });

  it('is accepted once every component is approved (TEST-ONLY approvals file)', async () => {
    fs.writeFileSync(
      approvalsFile,
      JSON.stringify({ approvals: pipelineDef.components.map((c: any) => ({ key: c.key, sha256: c.sha256, approvedBy: 'TEST-ONLY (not a licence decision)', approvedAt: '2026-09-27', reason: 'integration test' })) })
    );
    const r = await internal('POST', '/model-manifests', manifestBody());
    expect(r.status).toBe(201);
    expect(r.json.manifest.task).toBe('plate_recognition');
    expect(r.json.manifest.weightLicense).toBe('Apache-2.0 AND MIT');
    manifestId = r.json.manifest.id;
  });
});

describe('LPR mode and ingestion', () => {
  it('refuses reads from a camera that is not in LPR mode, and reads without valid provenance', async () => {
    expect((await internal('POST', '/anpr/observations', read('MH12AB1234', new Date()))).json.code).toBe('CAMERA_NOT_IN_LPR_MODE');
    const cfg = await api('PUT', `/anpr/cameras/${cameraId}/lpr`, { lprMode: true, fps: 2, roi: [0.1, 0.4, 0.9, 1] });
    expect(cfg.status).toBe(200);
    expect(cfg.json.camera.lprMode).toBe(true);
    await prisma.auditEvent.findFirstOrThrow({ where: { tenantId, action: 'ANPR_LPR_MODE_ENABLE', resourceId: cameraId } });
    expect((await api('PUT', `/anpr/cameras/${cameraId}/lpr`, { lprMode: true, roi: [0.9, 0, 0.1, 1] })).status).toBe(400);

    const bad = await internal('POST', '/anpr/observations', read('MH12AB1234', new Date(), { provenance: provenance({ modelSha256: 'a'.repeat(64) }) }));
    expect(bad.status).toBe(422);
    expect(bad.json.code).toBe('PROVENANCE_UNKNOWN_MODEL');
    const noComp = provenance();
    delete (noComp as any).components;
    expect((await internal('POST', '/anpr/observations', read('MH12AB1234', new Date(), { provenance: noComp }))).json.code).toBe('PROVENANCE_COMPONENTS_REQUIRED');

    const cams = await internal('GET', '/anpr/cameras');
    expect(cams.json.cameras.find((c: any) => c.cameraId === cameraId).lpr).toMatchObject({ fps: 2, roi: [0.1, 0.4, 0.9, 1] });
  });

  it('votes reads of one plate into one observation with provenance, and a wildcard list entry raises an alarm through the orchestrator', async () => {
    const wl = await api('POST', '/anpr/watchlist', { plateNumber: 'MH12*', matchType: 'WILDCARD', category: 'SUSPECT', alertOnMatch: true, severity: 'CRITICAL', notes: 'fleet under watch' });
    expect(wl.status).toBe(200);
    expect((await api('POST', '/anpr/watchlist', { plateNumber: 'MH(12)+', matchType: 'REGEX' })).status).toBe(400);
    await prisma.automationRule.create({
      data: { tenantId, name: 'any watchlist', triggerType: 'ANPR_WATCHLIST', triggerConfigJson: { watchlistCategories: ['SUSPECT'] }, conditionsJson: [], actionsJson: [{ id: 'a', type: 'TRIGGER_ALARM', config: {} }], cooldownSeconds: 0 },
    });
    markAutomationRulesChanged();

    const t0 = Date.now();
    // Three frames: two agree, one with an OCR slip in the number (8 read as B) -> voted away.
    for (const [i, p] of ['MH12AB1234', 'MH12AB1234', 'MH12AB12B4'].entries()) {
      const r = await internal('POST', '/anpr/observations', read(p, new Date(t0 + i * 500)));
      expect(r.status).toBe(200);
    }
    const obs = await prisma.vehicleObservation.findMany({ where: { cameraId } });
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ normalizedPlate: 'MH12AB1234', plateNumber: 'MH 12 AB 1234', stateCode: 'MH', observationCount: 3, plateFormat: 'STANDARD', matchedWatchlistId: wl.json.entry.id });
    expect((obs[0].provenanceJson as any).modelSha256).toBe(pipelineSha);
    expect((obs[0].provenanceJson as any).components).toHaveLength(2);

    const events = await prisma.canonicalEvent.findMany({ where: { tenantId, type: 'ANPR_MATCH' }, orderBy: { createdAt: 'asc' } });
    expect(events.map((e) => (e.payloadJson as any).payload.watchlistCategory ?? null)).toEqual([null, 'SUSPECT']);
    expect((events[1].provenanceJson as any).modelSha256).toBe(pipelineSha);

    const alarms = await prisma.alarm.findMany({ where: { tenantId } });
    // One alarm from the list entry (alertOnMatch) and one from the ANPR_WATCHLIST rule, both
    // linked to the same canonical event; nothing for the plain plate read.
    expect(alarms).toHaveLength(2);
    expect(alarms.every((a) => a.canonicalEventId === events[1].id)).toBe(true);
    const byRule = alarms.find((a) => a.automationRuleId);
    const byList = alarms.find((a) => !a.automationRuleId)!;
    expect(byRule).toBeDefined();
    expect(byList).toMatchObject({ title: 'Known plate MH12AB1234 (SUSPECT)', severity: 'CRITICAL' });
    expect((byList.metadataJson as any).provenance.modelSha256).toBe(pipelineSha);
    await prisma.auditEvent.findFirstOrThrow({ where: { tenantId, action: 'ALARM_CREATE', resourceId: byList.id } });
  });

  it('a different plate on the same camera is a separate observation; exact and regex entries match', async () => {
    await api('POST', '/anpr/watchlist', { plateNumber: 'ka-05-c-7788', category: 'WHITELIST', alertOnMatch: false });
    await api('POST', '/anpr/watchlist', { plateNumber: '[0-9]{2}BH[0-9]{4}[A-Z]{1,2}', matchType: 'REGEX', category: 'VIP', alertOnMatch: false });
    const t0 = Date.now() + 5000;
    await internal('POST', '/anpr/observations', read('KA05C7788', new Date(t0)));
    await internal('POST', '/anpr/observations', read('22BH4567AA', new Date(t0 + 100)));
    const byPlate = Object.fromEntries((await prisma.vehicleObservation.findMany({ where: { cameraId }, include: { matchedWatchlist: true } })).map((o) => [o.normalizedPlate, o.matchedWatchlist?.category ?? null]));
    expect(byPlate).toMatchObject({ KA05C7788: 'WHITELIST', '22BH4567AA': 'VIP', MH12AB1234: 'SUSPECT' });
  });

  it('plate queries are audited (DPDP) and the synthetic detect endpoint does not exist', async () => {
    const q = await api('GET', '/anpr/observations?plateQuery=MH12&purpose=SECURITY_INCIDENT_INVESTIGATION');
    expect(q.status).toBe(200);
    expect(q.json.observations.map((o: any) => o.normalizedPlate)).toEqual(['MH12AB1234']);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId, action: 'ANPR_OBSERVATIONS_QUERY' }, orderBy: { sequenceNumber: 'desc' } });
    expect(audit.metadataJson).toMatchObject({ purpose: 'SECURITY_INCIDENT_INVESTIGATION', category: 'PLATE', filters: { plateQuery: 'MH12' } });
    expect((await api('POST', '/anpr/detect', { cameraId, plateText: 'MH12AB1234' })).status).toBe(404);
  });

  it('with the ANPR flag off the internal endpoints answer 501', async () => {
    delete process.env.VIGILONE_FEATURE_ANPR;
    try {
      expect((await internal('POST', '/anpr/observations', read('MH12AB1234', new Date()))).status).toBe(501);
    } finally {
      process.env.VIGILONE_FEATURE_ANPR = 'true';
    }
  });
});
