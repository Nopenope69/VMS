/**
 * Threat rules without a new model, on the real database and the real Express app: rules made through the API
 * (validated, tenant-checked), automation rules routing them to alarms, and synthetic tracks posted to the internal
 * detections endpoint. An unattended bag and a car against a one-way arrow each become one incident, one canonical
 * event and one alarm carrying the model provenance; the cases that must stay quiet do.
 */
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera, createUserWithToken, startApp } from './helpers/realDb';
import { ModelManifestService } from '../services/ai/modelManifest.service';
import { toEventV1 } from '../contracts/eventMapping.v1';

jest.setTimeout(60000);

const prisma = new PrismaClient();
const SECRET = process.env.INTERNAL_API_SECRET as string;
const T0 = Date.parse('2026-10-04T21:00:00Z');
const ZONE = [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.9 }, { x: 0.2, y: 0.9 }];

let app: { url: string; close: () => Promise<void> };
let tenantId = '';
let cameraId = '';
let otherTenantId = '';
let otherCameraId = '';
let admin = { userId: '', token: '' };
let viewer = { userId: '', token: '' };
let manifest: { id: string; sha256: string; name: string; version: string };
const task = `object_detection_threat_${crypto.randomBytes(3).toString('hex')}`;

function detection(trackId: string, t: number, box: { x: number; y: number; width: number; height: number }, objectClass: string, type: string) {
  const ts = new Date(t).toISOString();
  return {
    tenantId, cameraId, modelManifestId: manifest.id, inferenceId: crypto.randomUUID(), type, objectClass, confidence: 0.8, boundingBox: box,
    trackId, trackState: 'CONFIRMED', timestamp: ts,
    provenance: {
      adapterId: 'vigilone-ai-worker', adapterVersion: '2.0.0', modelId: manifest.id, modelName: manifest.name, modelVersion: manifest.version,
      modelSha256: manifest.sha256, runtime: 'onnxruntime@1.30.0', executionProvider: 'cpu', inferenceId: crypto.randomUUID(), frameTimestampUtc: ts,
    },
  };
}
/** A box whose centre is (cx, cy). */
const at = (cx: number, cy: number, w = 0.04, h = 0.06) => ({ x: +(cx - w / 2).toFixed(4), y: +(cy - h / 2).toFixed(4), width: w, height: h });
const bag = (track: string, t: number, cx = 0.5, cy = 0.6) => detection(track, t, at(cx, cy), 'suitcase', 'OBJECT_DETECTED');
const person = (track: string, t: number, cx: number, cy = 0.5) => detection(track, t, at(cx, cy, 0.06, 0.25), 'person', 'PERSON_DETECTED');
const car = (track: string, t: number, cx: number) => detection(track, t, at(cx, 0.5, 0.12, 0.08), 'car', 'VEHICLE_DETECTED');

async function ingest(body: unknown) {
  const r = await fetch(`${app.url}/api/v1/internal/detections`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` }, body: JSON.stringify(body) });
  const json = (await r.json()) as any;
  expect(r.status).toBe(200);
  return json;
}
async function call(user: { token: string }, method: string, p: string, body?: unknown) {
  const r = await fetch(`${app.url}/api/v1${p}`, { method, headers: { authorization: `Bearer ${user.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
}

let bagRuleId = '';
let wayRuleId = '';

beforeAll(async () => {
  ({ tenantId, cameraId } = await createTenantWithCamera(prisma, 'threat'));
  ({ tenantId: otherTenantId, cameraId: otherCameraId } = await createTenantWithCamera(prisma, 'threat-other'));
  admin = await createUserWithToken(prisma, tenantId, 'TENANT_ADMIN');
  viewer = await createUserWithToken(prisma, tenantId, 'VIEWER');
  const m = await new ModelManifestService(prisma).registerModelManifest({
    name: `yolox-threat-${crypto.randomBytes(3).toString('hex')}`, version: '0.1.1rc0', sha256: crypto.randomBytes(32).toString('hex'),
    codeLicense: 'Apache-2.0', weightLicense: 'Apache-2.0',
    trainingData: { source: 'COCO 2017 train', license: 'CC-BY-4.0', provenance: 'public-dataset', commercialUse: true },
    runtimeConfig: { runtime: 'onnxruntime', modelFormat: 'ONNX', inputWidth: 416, inputHeight: 416, colorSpace: 'BGR' },
    task, modelSignature: { decoder: 'yolox' }, weightsSource: 'test',
  });
  manifest = { id: m.id, sha256: m.sha256, name: m.name, version: m.version };
  app = await startApp();
});

afterAll(async () => {
  for (const id of [tenantId, otherTenantId]) await prisma.tenant.delete({ where: { id } }).catch(() => undefined);
  await prisma.modelManifest.deleteMany({ where: { task } });
  await app.close();
  await prisma.$disconnect();
});

describe('rules through the API', () => {
  it('refuses malformed rules, another tenant\'s camera and a user without the permission', async () => {
    const good = { cameraId, name: 'Platform 1', type: 'UNATTENDED_OBJECT', polygonCoordinates: ZONE, dwellThresholdSeconds: 60 };
    // Pixel coordinates (what the old screen sent) are refused.
    expect((await call(admin, 'POST', '/spatial-rules', { ...good, polygonCoordinates: ZONE.map((p) => ({ x: p.x * 640, y: p.y * 360 })) })).status).toBe(400);
    expect((await call(admin, 'POST', '/spatial-rules', { ...good, polygonCoordinates: ZONE.slice(0, 2) })).status).toBe(400);
    expect((await call(admin, 'POST', '/spatial-rules', { ...good, type: 'NONSENSE' })).status).toBe(400);
    expect((await call(admin, 'POST', '/spatial-rules', { ...good, dwellThresholdSeconds: 2 })).status).toBe(400);
    expect((await call(admin, 'POST', '/spatial-rules', { ...good, params: { ownerRadius: 5 } })).status).toBe(400);
    expect((await call(admin, 'POST', '/spatial-rules', { ...good, type: 'WRONG_WAY' })).status).toBe(400); // no arrow
    expect((await call(admin, 'POST', '/spatial-rules', { ...good, cameraId: otherCameraId })).status).toBe(404);
    expect((await call(viewer, 'POST', '/spatial-rules', good)).status).toBe(403);
    expect(await prisma.spatialAnalyticsRule.count({ where: { cameraId: { in: [cameraId, otherCameraId] } } })).toBe(0);
  });

  it('creates the two rules and alarm rules for them', async () => {
    const b = await call(admin, 'POST', '/spatial-rules', { cameraId, name: 'Platform 1', type: 'UNATTENDED_OBJECT', polygonCoordinates: ZONE, dwellThresholdSeconds: 60 });
    expect(b.status).toBe(201);
    expect(b.json.rule).toMatchObject({ type: 'UNATTENDED_OBJECT', dwellThresholdSeconds: 60, cooldownSeconds: 300 });
    bagRuleId = b.json.rule.id;
    const w = await call(admin, 'POST', '/spatial-rules', {
      cameraId, name: 'One-way lane', type: 'WRONG_WAY', polygonCoordinates: ZONE,
      lineCoordinates: [{ x: 0.3, y: 0.5 }, { x: 0.7, y: 0.5 }], params: { objectClasses: ['car', 'truck'] },
    });
    expect(w.status).toBe(201);
    expect(w.json.rule.paramsJson).toEqual({ objectClasses: ['car', 'truck'] });
    wayRuleId = w.json.rule.id;
    const listed = await call(admin, 'GET', `/spatial-rules/${cameraId}`);
    expect(listed.json.rules.map((r: any) => r.type).sort()).toEqual(['UNATTENDED_OBJECT', 'WRONG_WAY']);

    for (const [triggerType, spatialRuleId, title] of [['UNATTENDED_OBJECT', bagRuleId, 'Unattended bag'], ['WRONG_WAY', wayRuleId, 'Wrong way']] as const) {
      const r = await call(admin, 'POST', '/automation/rules', {
        name: `${title} -> alarm`, triggerType, triggerConfig: { spatialRuleId }, conditions: [],
        actions: [{ id: 'a1', type: 'TRIGGER_ALARM', config: { severity: 'CRITICAL', title } }], cooldownSeconds: 0, enabled: true,
      });
      expect(r.status).toBe(201);
    }
  });
});

describe('unattended object', () => {
  it('a suitcase left still with nobody near for 60 s: one incident, one event, one alarm with provenance', async () => {
    // Its owner stands next to it for 20 s, then walks out of the picture; the suitcase stays.
    let alertAt = -1;
    for (let s = 0; s <= 100; s++) {
      if (s < 20) await ingest(person('owner-1', T0 + s * 1000, 0.53, 0.5));
      const r = await ingest(bag('bag-1', T0 + s * 1000));
      if (r.incidentsCreated && alertAt < 0) alertAt = s;
    }
    // Owner last seen at 19 s, grace 3 s, alone from 23 s, alert at 83 s.
    expect(alertAt).toBe(83);
    const incidents = await prisma.incident.findMany({ where: { cameraId, ruleId: bagRuleId } });
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ trackId: 'bag-1', ruleType: 'UNATTENDED_OBJECT', title: 'Unattended suitcase: Platform 1' });
    expect((incidents[0].metadataJson as any).unattendedSeconds).toBe(60);

    const canonical = await prisma.canonicalEvent.findUnique({ where: { id: `ev_incident_${incidents[0].id}` } });
    expect(canonical).toMatchObject({ type: 'UNATTENDED_OBJECT', cameraId });
    expect((canonical!.provenanceJson as any).modelSha256).toBe(manifest.sha256);

    const alarms = await prisma.alarm.findMany({ where: { canonicalEventId: canonical!.id } });
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toMatchObject({ title: 'Unattended bag', severity: 'CRITICAL', state: 'ACTIVE' });
    expect((alarms[0].metadataJson as any).provenance.modelSha256).toBe(manifest.sha256);
  });

  it('maps to the events.v1 type ai.unattended_object', async () => {
    const incident = await prisma.incident.findFirstOrThrow({ where: { cameraId, ruleId: bagRuleId } });
    const row = await prisma.canonicalEvent.findUniqueOrThrow({ where: { id: `ev_incident_${incident.id}` } });
    const payload = (row.payloadJson as any).payload;
    const v1 = toEventV1({ ...(row as any), timestampUtc: row.timestampUtc, payload, provenance: row.provenanceJson as any } as any);
    expect(v1).toMatchObject({ type: 'ai.unattended_object', payload: { zoneId: bagRuleId, trackId: 'bag-1', objectClass: 'suitcase', unattendedSeconds: 60, thresholdSeconds: 60 } });
  });

  it('stays quiet while its owner stays beside it, and for a person (not a bag) standing still', async () => {
    const t = T0 + 3_600_000;
    for (let s = 0; s <= 90; s++) {
      await ingest(person('owner-2', t + s * 1000, 0.42, 0.5));
      await ingest(bag('bag-2', t + s * 1000, 0.4, 0.6));
      await ingest(person('statue', t + s * 1000, 0.7, 0.5));
    }
    expect(await prisma.incident.count({ where: { cameraId, ruleId: bagRuleId, trackId: { in: ['bag-2', 'statue', 'owner-2'] } } })).toBe(0);
  });
});

describe('wrong way', () => {
  it('a car against the one-way arrow: one incident and one alarm; with the arrow and a person against it: nothing', async () => {
    const t = T0 + 7_200_000;
    const xs = [0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4];
    for (const [i, x] of xs.entries()) {
      await ingest(car('car-wrong', t + i * 1000, x));
      await ingest(car('car-right', t + i * 1000, 1 - x));
      await ingest(person('walker-wrong', t + i * 1000, x, 0.7)); // persons are not watched by this rule
    }
    const incidents = await prisma.incident.findMany({ where: { cameraId, ruleId: wayRuleId } });
    expect(incidents.map((i) => i.trackId)).toEqual(['car-wrong']);
    expect(incidents[0]).toMatchObject({ ruleType: 'WRONG_WAY', title: 'Wrong way: One-way lane' });
    expect((incidents[0].metadataJson as any).angleDegrees).toBe(180);
    const canonical = await prisma.canonicalEvent.findUniqueOrThrow({ where: { id: `ev_incident_${incidents[0].id}` } });
    expect(canonical.type).toBe('WRONG_WAY');
    expect(await prisma.alarm.count({ where: { canonicalEventId: canonical.id, title: 'Wrong way' } })).toBe(1);
  });

  it('bags never fire person or vehicle automation rules', async () => {
    const r = await call(admin, 'POST', '/automation/rules', {
      name: 'Any vehicle', triggerType: 'VEHICLE_DETECTED', triggerConfig: {}, conditions: [],
      actions: [{ id: 'a1', type: 'TRIGGER_ALARM', config: { severity: 'WARNING', title: 'Vehicle seen' } }], cooldownSeconds: 0, enabled: true,
    });
    expect(r.status).toBe(201);
    const t = T0 + 9_000_000;
    for (let s = 0; s < 3; s++) await ingest(bag('bag-3', t + s * 1000, 0.1, 0.1));
    expect(await prisma.alarm.count({ where: { tenantId, title: 'Vehicle seen' } })).toBe(0);
    await ingest(car('car-x', t, 0.1));
    expect(await prisma.alarm.count({ where: { tenantId, title: 'Vehicle seen' } })).toBe(1);
  });
});
