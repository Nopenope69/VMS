/**
 * Phase 2 AI pipeline against the real database and the real Express app (no Prisma mocks):
 * provenance-checked ingestion, spatial incidents, the IncidentOrchestrator bridge (alarms with
 * provenance), minimum-dwell milestones, the model registry and its audit trail, and the
 * worker-facing internal endpoints. Replaces the in-memory-database spatial test, which could not
 * see that the Incident table had no migration.
 */
import crypto from 'crypto';
import { PrismaClient, RuleTriggerType, RuleActionType, TripwireDirection } from '@prisma/client';
import { createTenantWithCamera, createUserWithToken, startApp } from './helpers/realDb';
import { ModelManifestService } from '../services/ai/modelManifest.service';
import { ModelRegistryService } from '../services/ai/modelRegistry.service';
import { AuditChainService } from '../services/audit/auditChain.service';
import { spatialEngine } from '../services/spatial/engine';
import { incidentOrchestrator } from '../composition';
import { markAutomationRulesChanged } from '../services/automation/ruleCache';
import { EvidenceArchive } from '../services/evidence/archive';
import { RecordingIndexService } from '../services/recording/recordingIndex.service';

// beforeAll starts the real app: on a cold ts-jest cache that compiles the whole backend, which
// takes longer than Jest's 5 s default on 2-core CI runners (CI run 36396607639).
jest.setTimeout(60000);

const prisma = new PrismaClient();
const SECRET = process.env.INTERNAL_API_SECRET as string;

let app: { url: string; close: () => Promise<void> };
let tenantId = '';
let cameraId = '';
let manifest: { id: string; sha256: string; name: string; version: string };
const task = `object_detection_test_${crypto.randomBytes(3).toString('hex')}`;

function provenance(frameTs: string, over: Record<string, any> = {}) {
  return {
    adapterId: 'vigilone-ai-worker', adapterVersion: '2.0.0-phase2', modelId: manifest.id, modelName: manifest.name,
    modelVersion: manifest.version, modelSha256: manifest.sha256, runtime: 'onnxruntime@1.30.0', executionProvider: 'cpu',
    inferenceId: crypto.randomUUID(), frameTimestampUtc: frameTs, ...over,
  };
}

function detection(trackId: string, centroid: { x: number; y: number }, t: number, over: Record<string, any> = {}) {
  const ts = new Date(t).toISOString();
  return {
    tenantId, cameraId, modelManifestId: manifest.id, inferenceId: crypto.randomUUID(), type: 'PERSON_DETECTED',
    objectClass: 'person', confidence: 0.9,
    boundingBox: { x: Math.max(0, centroid.x - 0.05), y: Math.max(0, centroid.y - 0.1), width: 0.1, height: 0.2 },
    centroid, trackId, trackState: 'CONFIRMED', timestamp: ts, provenance: provenance(ts), ...over,
  };
}

async function post(path: string, body: unknown, token = SECRET) {
  const res = await fetch(`${app.url}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}
async function get(path: string, token = SECRET) {
  const res = await fetch(`${app.url}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, json: (await res.json()) as any };
}
const ingest = (body: unknown) => post('/api/v1/internal/detections', body);

beforeAll(async () => {
  app = await startApp();
  ({ tenantId, cameraId } = await createTenantWithCamera(prisma, 'aipipe'));
  const m = await new ModelManifestService(prisma).registerModelManifest({
    name: `yolox-test-${crypto.randomBytes(3).toString('hex')}`, version: '0.1.1rc0', sha256: crypto.randomBytes(32).toString('hex'),
    codeLicense: 'Apache-2.0', weightLicense: 'Apache-2.0',
    trainingData: { source: 'COCO 2017 train', license: 'CC-BY-4.0', provenance: 'public-dataset', commercialUse: true },
    runtimeConfig: { runtime: 'onnxruntime', modelFormat: 'ONNX', inputWidth: 416, inputHeight: 416, colorSpace: 'BGR' },
    task, modelSignature: { decoder: 'yolox' }, weightsSource: 'test',
  });
  manifest = { id: m.id, sha256: m.sha256, name: m.name, version: m.version };
});

afterAll(async () => {
  await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await prisma.modelManifest.deleteMany({ where: { task } });
  await app.close();
  await prisma.$disconnect();
});

beforeEach(() => spatialEngine.clearTrackState());

describe('P2.6 provenance on ingestion', () => {
  it('stores a detection with its provenance, SHA and object class', async () => {
    const body = detection('trk-prov', { x: 0.2, y: 0.2 }, Date.parse('2026-09-27T10:00:00Z'), { trackState: 'TENTATIVE' });
    const r = await ingest(body);
    expect(r.status).toBe(200);
    const row = await prisma.detectionEvent.findUnique({ where: { inferenceId: body.inferenceId } });
    expect(row).toMatchObject({ modelSha256: manifest.sha256, objectClass: 'person', modelManifestId: manifest.id });
    expect((row!.provenanceJson as any).inferenceId).toBe(body.provenance.inferenceId);
  });

  it('rejects a detection without provenance (400 PROVENANCE_REQUIRED) and stores nothing', async () => {
    const body: any = detection('trk-noprov', { x: 0.2, y: 0.2 }, Date.now());
    delete body.provenance;
    const r = await ingest(body);
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('PROVENANCE_REQUIRED');
    expect(await prisma.detectionEvent.count({ where: { inferenceId: body.inferenceId } })).toBe(0);
  });

  it('rejects provenance that names another model hash (409 PROVENANCE_MISMATCH)', async () => {
    const body: any = detection('trk-mm', { x: 0.2, y: 0.2 }, Date.now());
    body.provenance.modelSha256 = 'f'.repeat(64);
    const r = await ingest(body);
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('PROVENANCE_MISMATCH');
    expect(await prisma.detectionEvent.count({ where: { inferenceId: body.inferenceId } })).toBe(0);
  });

  it('is idempotent on inferenceId, also under concurrent retries', async () => {
    const body = detection('trk-idem', { x: 0.2, y: 0.2 }, Date.now(), { trackState: 'TENTATIVE' });
    const rs = await Promise.all([ingest(body), ingest(body), ingest(body)]);
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(new Set(rs.map((r) => r.json.detectionId)).size).toBe(1);
    expect(await prisma.detectionEvent.count({ where: { inferenceId: body.inferenceId } })).toBe(1);
  });

  it.each<[string, (b: any) => void, number, string]>([
    ['missing inferenceId', (b) => delete b.inferenceId, 400, 'INVALID_DETECTION'],
    ['confidence above 1', (b) => (b.confidence = 1.5), 400, 'INVALID_DETECTION'],
    ['unknown detection type', (b) => (b.type = 'UFO_DETECTED'), 400, 'INVALID_DETECTION'],
    ['camera of another tenant', (b) => (b.tenantId = 'some-other-tenant'), 404, 'CAMERA_NOT_FOUND'],
    ['unknown model manifest', (b) => (b.modelManifestId = 'no-such-model'), 404, 'MODEL_NOT_FOUND'],
  ])('rejects %s and stores nothing', async (_why, mutate, status, code) => {
    const body: any = detection('trk-bad', { x: 0.2, y: 0.2 }, Date.now());
    mutate(body);
    const r = await ingest(body);
    expect([r.status, r.json.code]).toEqual([status, code]);
    if (body.inferenceId) expect(await prisma.detectionEvent.count({ where: { inferenceId: body.inferenceId } })).toBe(0);
  });

  it('rejects detections from an inactive model (400 MODEL_INACTIVE)', async () => {
    await prisma.modelManifest.update({ where: { id: manifest.id }, data: { isActive: false } });
    try {
      const r = await ingest(detection('trk-inactive', { x: 0.2, y: 0.2 }, Date.now()));
      expect([r.status, r.json.code]).toEqual([400, 'MODEL_INACTIVE']);
    } finally {
      await prisma.modelManifest.update({ where: { id: manifest.id }, data: { isActive: true } });
    }
  });

  it('requires the internal secret', async () => {
    expect((await post('/api/v1/internal/detections', {}, 'wrong-secret')).status).toBe(403);
  });
});

describe('spatial incidents and the orchestrator bridge (real DB)', () => {
  let wireId = '';

  beforeAll(async () => {
    const wire = await prisma.spatialAnalyticsRule.create({
      data: {
        tenantId, cameraId, name: 'South Gate', type: 'TRIPWIRE', direction: TripwireDirection.A_TO_B,
        lineCoordinatesJson: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }], cooldownSeconds: 10,
      },
    });
    wireId = wire.id;
    await prisma.automationRule.create({
      data: {
        tenantId, name: 'Gate breach -> alarm', triggerType: RuleTriggerType.TRIPWIRE_CROSS, cooldownSeconds: 0,
        triggerConfigJson: { spatialRuleId: wireId }, conditionsJson: [],
        actionsJson: [{ id: 'a1', type: RuleActionType.TRIGGER_ALARM, config: { severity: 'CRITICAL', title: 'Gate breach' } }],
      },
    });
  });

  it('A -> B crossing: one Incident, one canonical event, one alarm carrying the model provenance', async () => {
    const t0 = Date.parse('2026-09-27T11:00:00Z');
    expect((await ingest(detection('trk-ab', { x: 0.5, y: 0.7 }, t0))).status).toBe(200);
    const r2 = await ingest(detection('trk-ab', { x: 0.5, y: 0.3 }, t0 + 1000));
    expect(r2.json.incidentsCreated).toBe(1);

    const incidents = await prisma.incident.findMany({ where: { cameraId, trackId: 'trk-ab' } });
    expect(incidents).toHaveLength(1);
    expect((incidents[0].metadataJson as any).directionCrossed).toBe('A_TO_B');

    const canonical = await prisma.canonicalEvent.findUnique({ where: { id: `ev_incident_${incidents[0].id}` } });
    expect(canonical).toMatchObject({ type: 'TRIPWIRE_CROSS', cameraId });
    expect(canonical!.processedAt).not.toBeNull();
    expect((canonical!.provenanceJson as any).modelSha256).toBe(manifest.sha256);

    const alarms = await prisma.alarm.findMany({ where: { canonicalEventId: canonical!.id } });
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toMatchObject({ title: 'Gate breach', severity: 'CRITICAL', cameraId, state: 'ACTIVE' });
    expect((alarms[0].metadataJson as any).provenance.modelSha256).toBe(manifest.sha256);
    expect(alarms[0].automationRuleId).not.toBeNull();
  });

  it('B -> A on an A_TO_B wire and parallel motion create nothing', async () => {
    const t0 = Date.parse('2026-09-27T11:05:00Z');
    await ingest(detection('trk-ba', { x: 0.5, y: 0.3 }, t0));
    await ingest(detection('trk-ba', { x: 0.5, y: 0.8 }, t0 + 1000));
    for (let i = 0; i < 4; i++) await ingest(detection('trk-par', { x: 0.1 + i * 0.2, y: 0.7 }, t0 + i * 1000));
    expect(await prisma.incident.count({ where: { cameraId, trackId: { in: ['trk-ba', 'trk-par'] } } })).toBe(0);
  });

  it('evidence isolation: spatial incidents never call recording-index or evidence-manifest code', async () => {
    const manifestSpy = jest.spyOn(EvidenceArchive.prototype, 'createManifest');
    const indexSpy = jest.spyOn(RecordingIndexService.prototype, 'indexSegment');
    const t0 = Date.parse('2026-09-27T11:20:00Z');
    await ingest(detection('trk-iso', { x: 0.5, y: 0.7 }, t0));
    const r = await ingest(detection('trk-iso', { x: 0.5, y: 0.3 }, t0 + 1000));
    expect(r.json.incidentsCreated).toBe(1);
    expect(manifestSpy).not.toHaveBeenCalled();
    expect(indexSpy).not.toHaveBeenCalled();
    manifestSpy.mockRestore();
    indexSpy.mockRestore();
  });

  it('the database rejects a second incident for the same (camera, rule, track, cooldown bucket)', async () => {
    const inc = await prisma.incident.findFirst({ where: { cameraId, trackId: 'trk-ab' } });
    await expect(
      prisma.incident.create({
        data: { tenantId, cameraId, ruleId: wireId, trackId: 'trk-ab', cooldownBucket: inc!.cooldownBucket, ruleType: 'TRIPWIRE', title: 'dup' },
      })
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('loitering fires only after continuous dwell beyond the threshold', async () => {
    const zone = await prisma.spatialAnalyticsRule.create({
      data: {
        tenantId, cameraId, name: 'Vault', type: 'LOITERING', dwellThresholdSeconds: 15, cooldownSeconds: 30,
        polygonCoordinatesJson: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 }],
      },
    });
    const t0 = Date.parse('2026-09-27T11:10:00Z');
    let created = 0;
    for (let s = 0; s <= 16; s += 2) created += (await ingest(detection('trk-loiter', { x: 0.5, y: 0.5 }, t0 + s * 1000))).json.incidentsCreated;
    expect(created).toBe(1);
    const inc = await prisma.incident.findFirst({ where: { ruleId: zone.id, trackId: 'trk-loiter' } });
    expect((inc!.metadataJson as any).dwellDurationSeconds).toBeGreaterThanOrEqual(15);
  });

  it('crash recovery: a canonical event persisted but never processed is re-driven into an alarm', async () => {
    const id = `ev_recovery_${crypto.randomBytes(4).toString('hex')}`;
    await prisma.canonicalEvent.create({
      data: {
        id, tenantId, cameraId, type: 'TRIPWIRE_CROSS', source: 'SPATIAL_ANALYTICS', severity: 'WARNING',
        timestampUtc: new Date(), correlationId: `corr_${id}`, trackId: 'trk-crash',
        payloadJson: { payload: { kind: 'TRIPWIRE_CROSS', tripwireId: wireId, trackId: 'trk-crash', direction: 'FORWARD' }, depth: 0 },
        provenanceJson: provenance(new Date().toISOString()),
        createdAt: new Date(Date.now() - 60000),
      },
    });
    const n = await incidentOrchestrator.redriveInbox(5000, 500);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await prisma.alarm.count({ where: { canonicalEventId: id } })).toBe(1);
    expect((await prisma.canonicalEvent.findUnique({ where: { id } }))!.processedAt).not.toBeNull();
    // A second sweep does nothing (idempotent).
    await incidentOrchestrator.redriveInbox(5000, 500);
    expect(await prisma.alarm.count({ where: { canonicalEventId: id } })).toBe(1);
  });
});

describe('AI object events and minimum dwell (P3.7 foundation)', () => {
  it('a person rule fires once per track; a 5 s minimum-dwell rule fires only after 5 s of tracking', async () => {
    const { tenantId: t2, cameraId: c2 } = await createTenantWithCamera(prisma, 'aiobj');
    try {
      await prisma.automationRule.create({
        data: {
          tenantId: t2, name: 'Any person', triggerType: RuleTriggerType.PERSON_DETECTED, cooldownSeconds: 0,
          triggerConfigJson: { objectClasses: ['person'], minConfidence: 0.5 }, conditionsJson: [],
          actionsJson: [{ id: 'a', type: RuleActionType.TRIGGER_ALARM, config: { title: 'Person' } }],
        },
      });
      await prisma.automationRule.create({
        data: {
          tenantId: t2, name: 'Person lingering', triggerType: RuleTriggerType.PERSON_DETECTED, cooldownSeconds: 0,
          triggerConfigJson: { minDwellSeconds: 5 }, conditionsJson: [],
          actionsJson: [{ id: 'a', type: RuleActionType.TRIGGER_ALARM, config: { title: 'Lingering' } }],
        },
      });
      markAutomationRulesChanged(); // rules written directly, as the automation API does on create
      const t0 = Date.parse('2026-09-27T12:00:00Z');
      const first = new Date(t0).toISOString();
      for (let s = 0; s <= 6; s += 1) {
        const body: any = detection('trk-dwell', { x: 0.3, y: 0.3 }, t0 + s * 1000, { tenantId: t2, cameraId: c2, trackFirstSeenAt: first });
        const r = await ingest(body);
        expect(r.status).toBe(200);
        if (s === 0) {
          const titles = (await prisma.alarm.findMany({ where: { tenantId: t2 } })).map((a) => a.title);
          expect(titles).toEqual(['Person']);
        }
      }
      const alarms = await prisma.alarm.findMany({ where: { tenantId: t2 }, orderBy: { triggeredAt: 'asc' } });
      expect(alarms.map((a) => a.title)).toEqual(['Person', 'Lingering']);
      // A vehicle never matches the person rules.
      await ingest(detection('trk-car', { x: 0.6, y: 0.6 }, t0, { tenantId: t2, cameraId: c2, type: 'VEHICLE_DETECTED', objectClass: 'car' }));
      expect(await prisma.alarm.count({ where: { tenantId: t2 } })).toBe(2);
    } finally {
      await prisma.tenant.delete({ where: { id: t2 } });
    }
  });
});

describe('model registry and audit trail (P2.6)', () => {
  it('bootstrap deploy, operator deploy and rollback are exclusive per task and audited in the chain', async () => {
    const reg = new ModelRegistryService(prisma);
    const svc = new ModelManifestService(prisma);
    const mk = (suffix: string) =>
      svc.registerModelManifest({
        name: `reg-${suffix}-${crypto.randomBytes(3).toString('hex')}`, version: '1', sha256: crypto.randomBytes(32).toString('hex'),
        codeLicense: 'MIT', weightLicense: 'MIT',
        trainingData: { source: 's', license: 'CC-BY-4.0', provenance: 'public-dataset', commercialUse: true },
        runtimeConfig: { runtime: 'onnxruntime', modelFormat: 'ONNX', inputWidth: 64, inputHeight: 64, colorSpace: 'RGB' },
        task, modelSignature: { decoder: 'yolox' },
      });
    const a = await mk('a');
    const b = await mk('b');

    const boot = await post('/api/v1/internal/ai/models/bootstrap-deploy', { modelManifestId: a.id, adapterId: 'test-worker' });
    // The suite's own manifest may already be deployed for this task by an earlier test; bootstrap never replaces.
    const deployedNow = await reg.getDeployed(task);
    expect(boot.status).toBe(200);
    expect(deployedNow).not.toBeNull();

    const { token: adminToken } = await createUserWithToken(prisma, tenantId, 'SUPER_ADMIN');
    const { token: opToken } = await createUserWithToken(prisma, tenantId, 'OPERATOR');
    expect((await post(`/api/v1/ai/models/${b.id}/deploy`, { reason: 'try' }, opToken)).status).toBe(403);
    expect((await post(`/api/v1/ai/models/${b.id}/deploy`, {}, adminToken)).json.code).toBe('REASON_REQUIRED');
    const d = await post(`/api/v1/ai/models/${b.id}/deploy`, { reason: 'upgrade to b' }, adminToken);
    expect(d.status).toBe(200);
    expect((await reg.getDeployed(task))!.id).toBe(b.id);
    expect(await prisma.modelManifest.count({ where: { task, deployed: true } })).toBe(1);

    const rb = await post('/api/v1/ai/models/rollback', { task, reason: 'b misbehaves' }, adminToken);
    expect(rb.status).toBe(200);
    expect(rb.json.model.id).not.toBe(b.id);

    const w = await post('/api/v1/internal/ai/model-events', {
      action: 'MODEL_LOAD_REFUSED', modelManifestId: b.id, adapterId: 'test-worker', reasonCode: 'MODEL_INTEGRITY_FAILED', computedSha256: '0'.repeat(64),
    });
    expect(w.status).toBe(201);

    const actions = (await prisma.auditEvent.findMany({ where: { tenantId, resourceType: 'ModelManifest' }, orderBy: { sequenceNumber: 'asc' } })).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['MODEL_DEPLOY', 'MODEL_ROLLBACK', 'MODEL_LOAD_REFUSED']));
    const verify = await AuditChainService.verifyChain(prisma, tenantId);
    expect(verify.valid).toBe(true);

    const status = await get('/api/v1/ai/models', adminToken);
    expect(status.status).toBe(200);
    expect(status.json.models.find((m: any) => m.id === b.id).evaluationStatus).toBe('NOT_EVALUATED');
  });

  it('the worker reads the deployed model and camera activity over the internal API', async () => {
    const dep = await get(`/api/v1/internal/ai/models/deployed?task=${task}`);
    expect(dep.status).toBe(200);
    expect(dep.json.model.task).toBe(task);
    const act = await get('/api/v1/internal/ai/activity');
    expect(act.status).toBe(200);
    const cam = act.json.cameras.find((c: any) => c.cameraId === cameraId);
    expect(cam.armed).toBe(true); // has an enabled spatial rule
  });
});

describe('regression: system-raised alarms are persisted with their audit entry', () => {
  it('an alarm raised without a human actor exists after commit and is audit-chained (was silently rolled back)', async () => {
    // Before the fix the SYSTEM actor was written to AuditEvent.userId (a foreign key to User); the
    // swallowed error aborted the transaction and COMMIT rolled the alarm back while the caller
    // received the alarm object as if it had been stored.
    const alarm = await incidentOrchestrator.elevateAlarm({ tenantId, cameraId, title: 'system alarm', severity: 'WARNING' });
    expect(await prisma.alarm.findUnique({ where: { id: alarm.id } })).not.toBeNull();
    const audit = await prisma.auditEvent.findFirst({ where: { tenantId, action: 'ALARM_CREATE', resourceId: alarm.id } });
    expect(audit).toMatchObject({ userId: null });
    expect((audit!.metadataJson as any).actor).toBe('SYSTEM');
  });
});
