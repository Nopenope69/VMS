/**
 * Person down and fence climbing on the real database and the real Express app: rules made through the API
 * (validated, tenant-checked), automation rules routing them to alarms, and synthetic tracks with body pose posted to the
 * internal detections endpoint. A fall seen and a climb over a fence each become incidents, canonical events and alarms
 * carrying the model provenance; the cases that must stay quiet do. The pose here is synthetic: this tests the rules
 * and the wiring, not how well the model reads real camera views.
 */
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera, createUserWithToken, startApp } from './helpers/realDb';
import { ModelManifestService } from '../services/ai/modelManifest.service';
import { toEventV1 } from '../contracts/eventMapping.v1';

jest.setTimeout(60000);

const prisma = new PrismaClient();
const SECRET = process.env.INTERNAL_API_SECRET as string;
const T0 = Date.parse('2026-10-06T09:00:00Z');
const ZONE = [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.9 }, { x: 0.2, y: 0.9 }];
const BASE = [{ x: 0.1, y: 0.7 }, { x: 0.9, y: 0.7 }];
const TOP = [{ x: 0.1, y: 0.4 }, { x: 0.9, y: 0.4 }];

let app: { url: string; close: () => Promise<void> };
let tenantId = '';
let cameraId = '';
let otherCameraId = '';
let otherTenantId = '';
let admin = { userId: '', token: '' };
let viewer = { userId: '', token: '' };
let manifest: { id: string; sha256: string; name: string; version: string };
const task = `object_detection_pose_${crypto.randomBytes(3).toString('hex')}`;

type Kp = [number, number, number];
/** 17 weak keypoints with chosen indices set (5/6 shoulders, 9/10 wrists, 11/12 hips). */
function pose(set: Record<number, [number, number]>): { method: string; model: object; meanScore: number; keypoints: Kp[] } {
  const keypoints: Kp[] = Array.from({ length: 17 }, () => [0.5, 0.5, 0.05]);
  for (const [i, [x, y]] of Object.entries(set)) keypoints[Number(i)] = [x, y, 0.9];
  return { method: 'rtmpose-s-body7-simcc-v1', model: { name: 'rtmpose-s-body7-256x192', sha256: 'a'.repeat(64) }, meanScore: 0.5, keypoints };
}
const standing = () => pose({ 5: [0.49, 0.5], 6: [0.51, 0.5], 11: [0.49, 0.7], 12: [0.51, 0.7] });
const lying = () => pose({ 5: [0.4, 0.78], 6: [0.4, 0.8], 11: [0.58, 0.78], 12: [0.58, 0.8] });
const climber = (hipY: number, wristY: number) => pose({ 11: [0.48, hipY], 12: [0.52, hipY], 9: [0.47, wristY], 10: [0.53, wristY] });

function person(trackId: string, t: number, attributesJson: any, box = { x: 0.44, y: 0.55, width: 0.12, height: 0.3 }) {
  const ts = new Date(t).toISOString();
  return {
    tenantId, cameraId, modelManifestId: manifest.id, inferenceId: crypto.randomUUID(), type: 'PERSON_DETECTED', objectClass: 'person', confidence: 0.8,
    boundingBox: box, trackId, trackState: 'CONFIRMED', timestamp: ts, attributesJson,
    provenance: {
      adapterId: 'vigilone-ai-worker', adapterVersion: '2.0.0', modelId: manifest.id, modelName: manifest.name, modelVersion: manifest.version,
      modelSha256: manifest.sha256, runtime: 'onnxruntime@1.30.0', executionProvider: 'cpu', inferenceId: crypto.randomUUID(), frameTimestampUtc: ts,
    },
  };
}
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

let downRuleId = '';
let fenceRuleId = '';

beforeAll(async () => {
  ({ tenantId, cameraId } = await createTenantWithCamera(prisma, 'pose'));
  ({ tenantId: otherTenantId, cameraId: otherCameraId } = await createTenantWithCamera(prisma, 'pose-other'));
  admin = await createUserWithToken(prisma, tenantId, 'TENANT_ADMIN');
  viewer = await createUserWithToken(prisma, tenantId, 'VIEWER');
  const m = await new ModelManifestService(prisma).registerModelManifest({
    name: `yolox-pose-${crypto.randomBytes(3).toString('hex')}`, version: '0.1.1rc0', sha256: crypto.randomBytes(32).toString('hex'),
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
  const downBody = () => ({ cameraId, name: 'Platform 2', type: 'PERSON_DOWN', polygonCoordinates: ZONE, dwellThresholdSeconds: 10 });
  const fenceBody = () => ({ cameraId, name: 'North fence', type: 'FENCE_CLIMB', polygonCoordinates: ZONE, lineCoordinates: BASE, params: { topLine: TOP, protectedSide: 'LEFT' } });

  it('refuses malformed rules, another tenant\'s camera and a user without the permission', async () => {
    const down = downBody();
    const fence = fenceBody();
    expect((await call(admin, 'POST', '/spatial-rules', { ...down, dwellThresholdSeconds: 1 })).status).toBe(400);
    expect((await call(admin, 'POST', '/spatial-rules', { ...down, polygonCoordinates: ZONE.slice(0, 2) })).status).toBe(400);
    expect((await call(admin, 'POST', '/spatial-rules', { ...down, params: { stillTolerance: 5 } })).status).toBe(400);
    expect((await call(admin, 'POST', '/spatial-rules', { ...down, params: { surprise: 1 } })).status).toBe(400);
    expect((await call(admin, 'POST', '/spatial-rules', { ...fence, params: undefined })).status).toBe(400); // no fence top
    expect((await call(admin, 'POST', '/spatial-rules', { ...fence, params: { topLine: TOP } })).status).toBe(400); // no protected side
    expect((await call(admin, 'POST', '/spatial-rules', { ...fence, params: { topLine: TOP, protectedSide: 'UP' } })).status).toBe(400);
    expect((await call(admin, 'POST', '/spatial-rules', { ...fence, lineCoordinates: undefined })).status).toBe(400);
    expect((await call(admin, 'POST', '/spatial-rules', { ...down, cameraId: otherCameraId })).status).toBe(404);
    expect((await call(viewer, 'POST', '/spatial-rules', down)).status).toBe(403);
    expect(await prisma.spatialAnalyticsRule.count({ where: { cameraId: { in: [cameraId, otherCameraId] } } })).toBe(0);
  });

  it('creates both rules and alarm rules for them', async () => {
    const d = await call(admin, 'POST', '/spatial-rules', downBody());
    expect(d.status).toBe(201);
    expect(d.json.rule).toMatchObject({ type: 'PERSON_DOWN', dwellThresholdSeconds: 10, cooldownSeconds: 120 });
    downRuleId = d.json.rule.id;
    const f = await call(admin, 'POST', '/spatial-rules', fenceBody());
    expect(f.status).toBe(201);
    expect(f.json.rule.paramsJson).toEqual({ topLine: TOP, protectedSide: 'LEFT' });
    fenceRuleId = f.json.rule.id;

    for (const [triggerType, spatialRuleId, title] of [['PERSON_DOWN', downRuleId, 'Person down'], ['FENCE_CLIMB', fenceRuleId, 'Fence climbing']] as const) {
      const r = await call(admin, 'POST', '/automation/rules', {
        name: `${title} -> alarm`, triggerType, triggerConfig: { spatialRuleId }, conditions: [],
        actions: [{ id: 'a1', type: 'TRIGGER_ALARM', config: { severity: 'CRITICAL', title } }], cooldownSeconds: 0, enabled: true,
      });
      expect({ status: r.status, body: r.json }).toMatchObject({ status: 201 });
    }
  });
});

describe('person down', () => {
  it('seen going down and staying down for 10 s: one incident, one event, one alarm with provenance', async () => {
    let alertAt = -1;
    for (let s = 0; s <= 40; s++) {
      const body = s < 5 ? person('walker-1', T0 + s * 1000, { pose: standing() }) : person('walker-1', T0 + s * 1000, { pose: lying() }, { x: 0.3, y: 0.7, width: 0.3, height: 0.1 });
      const r = await ingest(body);
      if (r.incidentsCreated && alertAt < 0) alertAt = s;
    }
    expect(alertAt).toBe(15); // lying from 5 s, alert once it has lasted 10 s
    const incidents = await prisma.incident.findMany({ where: { cameraId, ruleId: downRuleId } });
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ trackId: 'walker-1', ruleType: 'PERSON_DOWN', title: 'Person down: Platform 2' });
    expect(incidents[0].description).toContain('advisory');
    expect(incidents[0].metadataJson).toMatchObject({ downKind: 'FALL', basis: 'pose' });

    const canonical = await prisma.canonicalEvent.findUniqueOrThrow({ where: { id: `ev_incident_${incidents[0].id}` } });
    expect(canonical).toMatchObject({ type: 'PERSON_DOWN', cameraId });
    expect((canonical.provenanceJson as any).modelSha256).toBe(manifest.sha256);
    const alarms = await prisma.alarm.findMany({ where: { canonicalEventId: canonical.id } });
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toMatchObject({ title: 'Person down', severity: 'CRITICAL', state: 'ACTIVE' });
  });

  it('maps to the events.v1 type ai.person_down', async () => {
    const incident = await prisma.incident.findFirstOrThrow({ where: { cameraId, ruleId: downRuleId } });
    const row = await prisma.canonicalEvent.findUniqueOrThrow({ where: { id: `ev_incident_${incident.id}` } });
    const payload = (row.payloadJson as any).payload;
    const v1 = toEventV1({ ...(row as any), timestampUtc: row.timestampUtc, payload, provenance: row.provenanceJson as any } as any);
    expect(v1).toMatchObject({ type: 'ai.person_down', payload: { zoneId: downRuleId, trackId: 'walker-1', kind: 'FALL', thresholdSeconds: 10, basis: 'pose' } });
  });

  it('stays quiet for someone who sits down and gets up, and for detections without a pose', async () => {
    const t = T0 + 3_600_000;
    for (let s = 0; s <= 30; s++) {
      await ingest(person('stander', t + s * 1000, { pose: standing() }));
      // lies for 6 s only, then up again
      await ingest(person('briefly', t + s * 1000, { pose: s >= 5 && s < 11 ? lying() : standing() }));
      // no pose at all (the worker sends one only every so often)
      await ingest(person('no-pose', t + s * 1000, {}, { x: 0.3, y: 0.7, width: 0.3, height: 0.1 }));
    }
    expect(await prisma.incident.count({ where: { cameraId, ruleId: downRuleId, trackId: { in: ['stander', 'briefly', 'no-pose'] } } })).toBe(0);
  });

  it('ignores a malformed pose instead of half-using it', async () => {
    const t = T0 + 7_200_000;
    const bad = { pose: { keypoints: [[0.5, 0.5, 0.9]] } };
    for (let s = 0; s <= 30; s++) await ingest(person('malformed', t + s * 1000, bad, { x: 0.3, y: 0.7, width: 0.3, height: 0.1 }));
    expect(await prisma.incident.count({ where: { cameraId, ruleId: downRuleId, trackId: 'malformed' } })).toBe(0);
  });
});

describe('fence climbing', () => {
  it('a hand over the fence top for 1.5 s, then across: CLIMBING and CROSSED, each one incident and one alarm', async () => {
    const t = T0 + 10_800_000;
    const stages: Record<string, number> = {};
    for (let s = 0; s <= 8; s++) {
      const attributes = s <= 3 ? { pose: climber(0.72, 0.3) } : { pose: climber(0.66, 0.5) };
      const r = await ingest(person('climber-1', t + s * 1000, attributes, { x: 0.44, y: 0.45, width: 0.12, height: 0.3 }));
      if (r.incidentsCreated) stages[`s${s}`] = r.incidentsCreated;
    }
    expect(Object.keys(stages)).toEqual(['s2', 's4']); // climbing at 2 s (1.5 s of raised hand), crossed at 4 s
    const incidents = await prisma.incident.findMany({ where: { cameraId, ruleId: fenceRuleId }, orderBy: { timestamp: 'asc' } });
    expect(incidents.map((i) => (i.metadataJson as any).stage)).toEqual(['CLIMBING', 'CROSSED']);
    expect(incidents.map((i) => i.title)).toEqual(['Fence climbing: North fence', 'Fence crossed: North fence']);
    const events = await prisma.canonicalEvent.findMany({ where: { id: { in: incidents.map((i) => `ev_incident_${i.id}`) } } });
    expect(events.every((e) => e.type === 'FENCE_CLIMB')).toBe(true);
    expect(await prisma.alarm.count({ where: { canonicalEventId: { in: events.map((e) => e.id) }, title: 'Fence climbing' } })).toBe(2);
    const v1 = toEventV1({ ...(events[1] as any), timestampUtc: events[1].timestampUtc, payload: (events[1].payloadJson as any).payload, provenance: events[1].provenanceJson as any } as any);
    expect(v1).toMatchObject({ type: 'ai.fence_climb', payload: { zoneId: fenceRuleId, trackId: 'climber-1', stage: 'CROSSED' } });
  });

  it('stays quiet for hands down at the fence, a person who starts inside, and a track without pose', async () => {
    const t = T0 + 14_400_000;
    for (let s = 0; s <= 10; s++) {
      await ingest(person('hands-down', t + s * 1000, { pose: climber(0.72, 0.6) }));
      await ingest(person('guard-inside', t + s * 1000, { pose: climber(0.62, 0.3) }));
      await ingest(person('no-pose-fence', t + s * 1000, {}));
    }
    expect(await prisma.incident.count({ where: { cameraId, ruleId: fenceRuleId, trackId: { in: ['hands-down', 'guard-inside', 'no-pose-fence'] } } })).toBe(0);
  });

  it('a rule whose stored settings are no longer valid says nothing', async () => {
    const broken = await prisma.spatialAnalyticsRule.create({
      data: { tenantId, cameraId, name: 'Broken fence', type: 'FENCE_CLIMB', polygonCoordinatesJson: ZONE as any, lineCoordinatesJson: BASE as any, paramsJson: { protectedSide: 'LEFT' }, cooldownSeconds: 60 },
    });
    const t = T0 + 18_000_000;
    for (let s = 0; s <= 6; s++) await ingest(person('climber-2', t + s * 1000, { pose: climber(0.72, 0.3) }));
    expect(await prisma.incident.count({ where: { ruleId: broken.id } })).toBe(0);
  });
});
