/**
 * P5.2 wiring on the real database: an alarm raised through AlarmLifecycle.elevateAlarm gets a stored
 * explanation built from recorded facts (canonical event, rule, detection, model, correlation chain)
 * when VIGILONE_FEATURE_EXPLANATIONS is on; nothing happens when it is off; and an explanation failure
 * never blocks the alarm but is logged, counted and audited.
 */
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera } from './helpers/realDb';
import { AlarmLifecycle } from '../services/incident/orchestrator/alarmLifecycle';
import { runExplanationHook } from '../services/explanation/explanationHook';
import { generateExplanationForAlarm, loadExplanationRecords } from '../services/explanation/explanationService';
import { verifyExplanationRecord } from '../services/explanation/explanation';
import { MetricsService } from '../services/observability/metrics.service';

jest.setTimeout(60000);

const prisma = new PrismaClient();
const FLAG = 'VIGILONE_FEATURE_EXPLANATIONS';
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const originalFlag = process.env[FLAG];
let tenantId = '';
let cameraId = '';
let modelSha = '';
let modelName = '';
let modelVersion = '';
let ruleId = '';
const t0 = new Date('2026-09-29T10:00:00.000Z');

const prov = (inferenceId: string) => ({ adapterId: 'ai-worker', adapterVersion: 't', modelId: 'm', modelName, modelVersion, modelSha256: modelSha, runtime: 'onnxruntime@1.30.0', inferenceId, frameTimestampUtc: t0.toISOString() });

async function canonical(id: string, opts: { at: Date; correlationId: string; payload?: unknown; provenance?: unknown; type?: string }) {
  return prisma.canonicalEvent.create({
    data: {
      id,
      tenantId,
      cameraId,
      type: opts.type ?? 'AI_OBJECT_DETECTED',
      source: 'VISION_AI',
      severity: 'INFO',
      timestampUtc: opts.at,
      correlationId: opts.correlationId,
      trackId: 'track-1',
      payloadJson: { payload: opts.payload ?? { kind: 'AI_OBJECT_DETECTED', objectClass: 'person', confidence: 0.91, trackId: 'track-1', dwellSeconds: 0, stage: 'confirmed', stageSeconds: 0 }, title: 'person detected' } as any,
      provenanceJson: opts.provenance as any,
    },
  });
}

beforeAll(async () => {
  ({ tenantId, cameraId } = await createTenantWithCamera(prisma, 'expl'));
  modelName = `expl-model-${tenantId.slice(0, 8)}`;
  modelVersion = '1.0.0';
  modelSha = sha(`expl-${tenantId}`);
  await prisma.modelManifest.create({ data: { name: modelName, version: modelVersion, sha256: modelSha, task: 'object_detection', codeLicense: 'Apache-2.0', weightLicense: 'Apache-2.0', trainingDataJson: {}, runtimeConfigJson: {}, isActive: true } });
  const rule = await prisma.automationRule.create({
    data: { tenantId, name: 'Person in yard', triggerType: 'PERSON_DETECTED', cooldownSeconds: 45, triggerConfigJson: { minDwellSeconds: 5 }, conditionsJson: { cameraIds: [cameraId] }, actionsJson: [{ type: 'TRIGGER_ALARM' }] },
  });
  ruleId = rule.id;
});
afterAll(async () => {
  if (originalFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = originalFlag;
  await prisma.modelManifest.deleteMany({ where: { sha256: modelSha } });
  await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await prisma.$disconnect();
});
afterEach(() => {
  delete process.env[FLAG];
  jest.restoreAllMocks();
});

describe('P5.2 explanation on alarm elevation (real database)', () => {
  it('flag OFF (the default): the alarm is raised and nothing is written', async () => {
    const alarm = await new AlarmLifecycle(prisma).elevateAlarm({ tenantId, cameraId, title: 'flag off' });
    expect(alarm.id).toBeTruthy();
    expect(await prisma.explanation.count({ where: { alarmId: alarm.id } })).toBe(0);
    expect(await prisma.auditEvent.count({ where: { tenantId, action: 'EXPLANATION_FAILED', resourceId: alarm.id } })).toBe(0);
  });

  it('flag ON: the stored record states the recorded facts, verifies, and is not rewritten on a second call', async () => {
    process.env[FLAG] = 'true';
    const infer = `inf-${crypto.randomUUID()}`;
    const corr = `corr-${crypto.randomUUID()}`;
    await prisma.detectionEvent.create({ data: { tenantId, cameraId, type: 'PERSON_DETECTED', confidence: 0.91, objectClass: 'person', inferenceId: infer, modelSha256: modelSha, provenanceJson: prov(infer) as any, timestamp: t0 } });
    const earlier = await canonical(`ev_${crypto.randomUUID()}`, { at: new Date(t0.getTime() - 5000), correlationId: corr, type: 'MOTION', payload: { kind: 'MOTION', score: 0.4 } });
    await canonical(`ev_${crypto.randomUUID()}`, { at: new Date(t0.getTime() + 3000), correlationId: corr }); // later than the trigger: not an "earlier" event
    const trigger = await canonical(`ev_${crypto.randomUUID()}`, { at: t0, correlationId: corr, provenance: prov(infer) });

    const alarm = await new AlarmLifecycle(prisma).elevateAlarm({ tenantId, cameraId, canonicalEventId: trigger.id, automationRuleId: ruleId, title: 'Person in yard', severity: 'CRITICAL' });

    const row = await prisma.explanation.findUniqueOrThrow({ where: { alarmId_templateVersion: { alarmId: alarm.id, templateVersion: 'explain-template.v1' } } });
    const rec: any = row.recordJson;
    expect(verifyExplanationRecord(rec)).toEqual([]);
    expect(row).toMatchObject({ tenantId, cameraId, explanationId: rec.explanationId, recordSha256: rec.recordSha256 });
    expect(row.alarmTriggeredAt.toISOString()).toBe(alarm.triggeredAt.toISOString());

    expect(rec.facts.trigger).toMatchObject({ eventId: trigger.id, type: 'AI_OBJECT_DETECTED', source: 'VISION_AI', timestampUtc: t0.toISOString(), payload: { kind: 'AI_OBJECT_DETECTED', objectClass: 'person', confidence: 0.91 } });
    expect(rec.facts.rule).toMatchObject({ kind: 'AUTOMATION_RULE', id: ruleId, name: 'Person in yard', triggerType: 'PERSON_DETECTED', cooldownSeconds: 45, conditions: { cameraIds: [cameraId] } });
    expect(rec.facts.models).toEqual([{ name: modelName, version: modelVersion, sha256: modelSha, task: 'object_detection', evaluated: false }]);
    expect(rec.facts.detections).toEqual([expect.objectContaining({ label: 'person', confidence: 0.91, frameTimestampUtc: t0.toISOString(), modelSha256: modelSha })]);
    expect(rec.facts.correlated).toEqual([{ eventId: earlier.id, type: 'MOTION', timestampUtc: earlier.timestampUtc.toISOString() }]);
    expect(rec.facts.cameraClock).toEqual({ status: 'UNKNOWN' });
    expect(rec.text).toContain('Rule "Person in yard"');
    expect(rec.text).toContain('A model detected "person" with confidence 0.91.');
    expect(rec.text).toContain('not evaluated on site data');

    const again = await generateExplanationForAlarm(prisma, alarm.id, new Date(t0.getTime() + 999_000));
    expect(again.created).toBe(false);
    expect(again.record.recordSha256).toBe(rec.recordSha256);
    expect(await prisma.explanation.count({ where: { alarmId: alarm.id } })).toBe(1);

    // The export loader returns exactly this record for the camera and window.
    const loaded = await loadExplanationRecords(prisma, tenantId, cameraId, new Date(t0.getTime() - 60_000), new Date(Date.now() + 60_000));
    expect(loaded.map((r) => r.explanationId)).toContain(rec.explanationId);
  });

  it('an alarm with no linked event or rule still gets an honest record that says so', async () => {
    process.env[FLAG] = 'true';
    const alarm = await new AlarmLifecycle(prisma).elevateAlarm({ tenantId, cameraId, title: 'manual alarm' });
    const rec: any = (await prisma.explanation.findFirstOrThrow({ where: { alarmId: alarm.id } })).recordJson;
    expect(rec.facts.trigger).toMatchObject({ eventId: null, type: null, payload: null });
    expect(rec.facts.rule).toBeNull();
    expect(rec.facts.models).toEqual([]);
    expect(rec.text).toContain('No triggering event is linked to this alarm.');
    expect(rec.text).toContain('No automation rule is linked to this alarm.');
    expect(rec.text).toContain('No AI model is recorded for this alarm.');
  });

  it('a model with a published evaluation is marked evaluated; an unregistered model is named but has no task', async () => {
    process.env[FLAG] = 'true';
    await prisma.modelManifest.update({ where: { id: (await prisma.modelManifest.findFirstOrThrow({ where: { sha256: modelSha } })).id }, data: { evaluationJson: { map50: 0.5 } } });
    try {
      const infer = `inf-${crypto.randomUUID()}`;
      const ev = await canonical(`ev_${crypto.randomUUID()}`, { at: t0, correlationId: `corr-${crypto.randomUUID()}`, provenance: prov(infer) });
      const ghostSha = sha(`ghost-${tenantId}`);
      const ev2 = await canonical(`ev_${crypto.randomUUID()}`, { at: t0, correlationId: `corr-${crypto.randomUUID()}`, provenance: { ...prov(infer), modelName: 'ghost', modelSha256: ghostSha } });
      const a1 = await new AlarmLifecycle(prisma).elevateAlarm({ tenantId, cameraId, canonicalEventId: ev.id, title: 'evaluated' });
      const a2 = await new AlarmLifecycle(prisma).elevateAlarm({ tenantId, cameraId, canonicalEventId: ev2.id, title: 'unregistered' });
      const r1: any = (await prisma.explanation.findFirstOrThrow({ where: { alarmId: a1.id } })).recordJson;
      const r2: any = (await prisma.explanation.findFirstOrThrow({ where: { alarmId: a2.id } })).recordJson;
      expect(r1.facts.models).toEqual([expect.objectContaining({ sha256: modelSha, evaluated: true })]);
      expect(r2.facts.models).toEqual([{ name: 'ghost', version: modelVersion, sha256: ghostSha, task: null, evaluated: false }]);
    } finally {
      await prisma.modelManifest.updateMany({ where: { sha256: modelSha }, data: { evaluationJson: undefined } });
    }
  });

  it('a failure never blocks the alarm and is logged, counted and audited', async () => {
    process.env[FLAG] = 'true';
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // Provenance without a model SHA-256 is refused by the facts collector: "cannot state its facts".
    const bad = await canonical(`ev_${crypto.randomUUID()}`, { at: t0, correlationId: `corr-${crypto.randomUUID()}`, provenance: { modelName: 'x', modelVersion: '1', modelSha256: 'not-a-hash' } });
    const before = MetricsService.getValue('vigilone_explanations_total', { outcome: 'failed' }) ?? 0;
    const alarm = await new AlarmLifecycle(prisma).elevateAlarm({ tenantId, cameraId, canonicalEventId: bad.id, title: 'unexplainable' });

    expect(await prisma.alarm.findUnique({ where: { id: alarm.id } })).toMatchObject({ id: alarm.id, state: 'ACTIVE', title: 'unexplainable' });
    expect(await prisma.explanation.count({ where: { alarmId: alarm.id } })).toBe(0);
    const audit = await prisma.auditEvent.findMany({ where: { tenantId, action: 'EXPLANATION_FAILED', resourceId: alarm.id } });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0].metadataJson)).toContain('does not name a model');
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(`alarm ${alarm.id}`));
    expect(MetricsService.getValue('vigilone_explanations_total', { outcome: 'failed' })).toBe(before + 1);
  });

  it('a failing generator and a failing audit write are both reported and the hook still does not throw', async () => {
    process.env[FLAG] = 'true';
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const brokenPrisma: any = { $transaction: () => Promise.reject(new Error('audit store down')), $executeRaw: () => Promise.reject(new Error('audit store down')) };
    const outcome = await runExplanationHook(brokenPrisma, { id: 'alarm-x', tenantId }, () => Promise.reject(new Error('boom')));
    expect(outcome).toBe('failed');
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('boom'));
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('could not audit'));
    expect(MetricsService.getValue('vigilone_explanation_audit_failures_total')).toBeGreaterThanOrEqual(1);
  });

  it('with the flag off the hook does not even call the generator', async () => {
    const generate = jest.fn();
    expect(await runExplanationHook(prisma, { id: 'a', tenantId }, generate)).toBe('disabled');
    expect(generate).not.toHaveBeenCalled();
  });
});
