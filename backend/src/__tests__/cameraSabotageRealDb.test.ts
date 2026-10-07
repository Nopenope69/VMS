/**
 * Camera-sabotage reports (ADR 0019) on the real database and the real Express app: the flag, validation, the
 * camera and tenant check, the canonical SCENE_CHANGE event with what was measured, a SCENE_CHANGE rule turning it
 * into an alarm, a repeated report evaluated once, and the events.v1 `camera.degraded` mapping. Then the end of a
 * condition (an informational CAMERA_TAMPER_CLEARED alert that fires no rule) and the footage-integrity overview.
 */
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera, createUserWithToken, startApp } from './helpers/realDb';
import { markAutomationRulesChanged } from '../services/automation/ruleCache';
import { sabotageEventId } from '../services/camera/cameraSabotage';
import { toEventV1 } from '../contracts/eventMapping.v1';
import { eventFromRow } from '../services/incident/orchestrator/incidentOrchestrator.service';

const prisma = new PrismaClient();
const SECRET = process.env.INTERNAL_API_SECRET as string;

let app: { url: string; close: () => Promise<void> };
let tenantId = '';
let cameraId = '';
let otherTenantId = '';
let otherCameraId = '';
let operator = { userId: '', token: '' };
let otherOperator = { userId: '', token: '' };

const post = async (body: unknown) => {
  const r = await fetch(`${app.url}/api/v1/internal/camera-sabotage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as any };
};

const report = (over: Record<string, unknown> = {}) => {
  const confirmed = new Date(Date.now() - 1000);
  return {
    cameraId,
    tenantId,
    changeType: 'OCCLUSION',
    score: 0.98,
    threshold: 0.5,
    startedAtUtc: new Date(confirmed.getTime() - 10_000).toISOString(),
    confirmedAtUtc: confirmed.toISOString(),
    method: 'classical-v1',
    measurements: { meanLuma: 128, stdLuma: 3.1, darkFraction: 0, brightFraction: 0, sharpness: 0.9, referenceSharpness: 0.62, similarity: 0.02 },
    ...over,
  };
};

beforeAll(async () => {
  process.env.VIGILONE_FEATURE_CAMERA_SABOTAGE = 'true';
  ({ tenantId, cameraId } = await createTenantWithCamera(prisma, 'sabotage'));
  ({ tenantId: otherTenantId, cameraId: otherCameraId } = await createTenantWithCamera(prisma, 'sabotage-other'));
  operator = await createUserWithToken(prisma, tenantId, 'OPERATOR');
  otherOperator = await createUserWithToken(prisma, otherTenantId, 'OPERATOR');
  app = await startApp();
});

afterAll(async () => {
  delete process.env.VIGILONE_FEATURE_CAMERA_SABOTAGE;
  for (const id of [tenantId, otherTenantId]) await prisma.tenant.delete({ where: { id } }).catch(() => undefined);
  await app?.close();
  await prisma.$disconnect();
});

describe('POST /api/v1/internal/camera-sabotage', () => {
  it('answers 501 while the flag is off, and stores nothing', async () => {
    delete process.env.VIGILONE_FEATURE_CAMERA_SABOTAGE;
    try {
      const r = await post(report());
      expect(r.status).toBe(501);
      expect(r.json.code).toBe('FEATURE_DISABLED');
      expect(await prisma.canonicalEvent.count({ where: { tenantId } })).toBe(0);
    } finally {
      process.env.VIGILONE_FEATURE_CAMERA_SABOTAGE = 'true';
    }
  });

  it('requires the internal secret', async () => {
    const r = await fetch(`${app.url}/api/v1/internal/camera-sabotage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report()) });
    expect(r.status).toBe(401);
  });

  it.each([
    ['an unknown type', { changeType: 'SPRAY' }],
    ['a score above 1', { score: 1.5 }],
    ['an unknown method', { method: 'neural-v9' }],
    ['a missing measurement', { measurements: { meanLuma: 1 } }],
    ['an extra field', { verdict: 'guilty' }],
    ['a bad time', { startedAtUtc: 'yesterday' }],
    ['a confirmation before the start', { startedAtUtc: new Date().toISOString(), confirmedAtUtc: new Date(Date.now() - 60_000).toISOString() }],
  ])('refuses %s with 400', async (_name, over) => {
    const r = await post(report(over));
    expect(r.status).toBe(400);
    expect(await prisma.canonicalEvent.count({ where: { tenantId } })).toBe(0);
  });

  it('refuses a report from the future (clock skew) with 400 CLOCK_SKEW', async () => {
    const future = new Date(Date.now() + 10 * 60_000);
    const r = await post(report({ startedAtUtc: future.toISOString(), confirmedAtUtc: future.toISOString() }));
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('CLOCK_SKEW');
  });

  it('answers 404 for an unknown camera and for a camera of another tenant', async () => {
    expect((await post(report({ cameraId: '00000000-0000-4000-8000-000000000000' }))).status).toBe(404);
    const r = await post(report({ cameraId: otherCameraId }));
    expect(r.status).toBe(404);
    expect(r.json.code).toBe('CAMERA_NOT_FOUND');
    expect(await prisma.canonicalEvent.count({ where: { tenantId: { in: [tenantId, otherTenantId] } } })).toBe(0);
  });

  it('raises a SCENE_CHANGE event, which a SCENE_CHANGE rule turns into one alarm; a repeat is the same event', async () => {
    const rule = await prisma.automationRule.create({
      data: { tenantId, name: 'camera tamper', triggerType: 'SCENE_CHANGE', triggerConfigJson: { cameraId }, conditionsJson: [], actionsJson: [{ id: 'a', type: 'TRIGGER_ALARM', config: {} }], cooldownSeconds: 0 },
    });
    markAutomationRulesChanged();
    const body = report();
    const r = await post(body);
    expect(r.status).toBe(200);
    expect(r.json.eventId).toBe(sabotageEventId(cameraId, 'OCCLUSION', body.startedAtUtc));
    expect(r.json.rulesTriggered).toBe(1);

    const row = await prisma.canonicalEvent.findUniqueOrThrow({ where: { id: r.json.eventId } });
    expect(row.type).toBe('SCENE_CHANGE');
    expect(row.cameraId).toBe(cameraId);
    expect(row.timestampUtc.toISOString()).toBe(body.confirmedAtUtc);
    const payload = (row.payloadJson as any).payload;
    expect(payload).toMatchObject({ kind: 'SCENE_CHANGE', changeType: 'OCCLUSION', score: 0.98, threshold: 0.5, method: 'classical-v1', startedAtUtc: body.startedAtUtc });
    expect(payload.measurements).toEqual(body.measurements);

    const alarms = await prisma.alarm.findMany({ where: { tenantId } });
    expect(alarms).toHaveLength(1);
    expect(alarms[0].automationRuleId).toBe(rule.id);
    expect(alarms[0].canonicalEventId).toBe(r.json.eventId);

    // The worker retries after a timeout: same camera, type and start, so the same event, evaluated once.
    const again = await post(body);
    expect(again.status).toBe(200);
    expect(again.json.eventId).toBe(r.json.eventId);
    expect(again.json.duplicate).toBe(true);
    expect(await prisma.alarm.count({ where: { tenantId } })).toBe(1);

    // events.v1: camera.degraded with reason TAMPER_OCCLUSION, no AI provenance needed.
    const v1 = toEventV1(eventFromRow(row));
    expect(v1.type).toBe('camera.degraded');
    expect(v1.payload).toEqual({ reason: 'TAMPER_OCCLUSION' });

    await prisma.automationRule.delete({ where: { id: rule.id } });
    markAutomationRulesChanged();
  });

  it('BLINDED maps to TAMPER_BLINDED; without a rule the event is recorded and no alarm is raised', async () => {
    const before = await prisma.alarm.count({ where: { tenantId } });
    const body = report({
      changeType: 'BLINDED', score: 0.9, threshold: 0.4,
      measurements: { meanLuma: 251, stdLuma: 4, darkFraction: 0, brightFraction: 0.9, sharpness: 0.2, referenceSharpness: 0.62, similarity: 0.1 },
    });
    const r = await post(body);
    expect(r.status).toBe(200);
    expect(r.json.rulesTriggered).toBe(0);
    const row = await prisma.canonicalEvent.findUniqueOrThrow({ where: { id: r.json.eventId } });
    const stored = row.payloadJson as any;
    expect(stored.title).toBe('Camera blinded by bright light');
    expect(stored.description).toContain('90% of the picture is saturated');
    expect(stored.description).toContain('advisory');
    expect(toEventV1(eventFromRow(row)).payload).toEqual({ reason: 'TAMPER_BLINDED' });
    expect(await prisma.alarm.count({ where: { tenantId } })).toBe(before);
  });

  it('keeps one condition row per confirmed report, also for a repeat', async () => {
    const rows = await prisma.cameraSabotageCondition.findMany({ where: { tenantId }, orderBy: { confirmedAt: 'asc' } });
    expect(rows.map((r) => r.changeType).sort()).toEqual(['BLINDED', 'OCCLUSION']);
    expect(rows.every((r) => r.clearedAt === null && r.clearReason === null)).toBe(true);
  });
});

describe('the end of a condition (state CLEARED)', () => {
  const clearedOf = (confirmedBody: ReturnType<typeof report>, over: Record<string, unknown> = {}) => ({
    state: 'CLEARED',
    cameraId: confirmedBody.cameraId,
    tenantId: confirmedBody.tenantId,
    changeType: confirmedBody.changeType,
    startedAtUtc: confirmedBody.startedAtUtc,
    clearedAtUtc: new Date().toISOString(),
    clearReason: 'RESTORED',
    method: 'classical-v1',
    ...over,
  });

  it('closes the condition once and records a camera-restored alert that fires no rule', async () => {
    const rule = await prisma.automationRule.create({
      data: { tenantId, name: 'tamper (cleared test)', triggerType: 'SCENE_CHANGE', triggerConfigJson: {}, conditionsJson: [], actionsJson: [{ id: 'a', type: 'TRIGGER_ALARM', config: {} }], cooldownSeconds: 0 },
    });
    markAutomationRulesChanged();
    const body = report({ changeType: 'DEFOCUS', score: 0.7, threshold: 0.5, startedAtUtc: new Date(Date.now() - 120_000).toISOString(), confirmedAtUtc: new Date(Date.now() - 100_000).toISOString() });
    expect((await post(body)).status).toBe(200);
    const alarmsBefore = await prisma.alarm.count({ where: { tenantId } });

    const clearedAt = new Date(Date.now() - 5000).toISOString();
    const r = await post(clearedOf(body, { clearedAtUtc: clearedAt }));
    expect(r.status).toBe(200);
    expect(r.json.eventId).toBe(`${sabotageEventId(cameraId, 'DEFOCUS', body.startedAtUtc)}_cleared`);
    expect(r.json.rulesTriggered).toBe(0);
    const row = await prisma.cameraSabotageCondition.findUniqueOrThrow({ where: { eventId: sabotageEventId(cameraId, 'DEFOCUS', body.startedAtUtc) } });
    expect(row.clearedAt?.toISOString()).toBe(clearedAt);
    expect(row.clearReason).toBe('RESTORED');

    const ev = await prisma.canonicalEvent.findUniqueOrThrow({ where: { id: r.json.eventId } });
    expect(ev.type).toBe('SYSTEM_ALERT');
    expect(ev.severity).toBe('INFO');
    const stored = ev.payloadJson as any;
    expect(stored.title).toBe('Camera view restored');
    expect(stored.payload).toMatchObject({ alertCode: 'CAMERA_TAMPER_CLEARED', subsystem: 'camera-sabotage', details: { changeType: 'DEFOCUS', clearReason: 'RESTORED' } });
    expect(toEventV1(eventFromRow(ev))).toMatchObject({ type: 'system.alert', payload: { code: 'CAMERA_TAMPER_CLEARED' } });
    expect(await prisma.alarm.count({ where: { tenantId } })).toBe(alarmsBefore);

    // A retry keeps the first recorded time.
    const again = await post(clearedOf(body, { clearedAtUtc: new Date().toISOString() }));
    expect(again.status).toBe(200);
    expect(again.json.duplicate).toBe(true);
    const still = await prisma.cameraSabotageCondition.findUniqueOrThrow({ where: { id: row.id } });
    expect(still.clearedAt?.toISOString()).toBe(clearedAt);

    await prisma.automationRule.delete({ where: { id: rule.id } });
    markAutomationRulesChanged();
  });

  it('refuses the end of a condition that was never reported (404), and a bad reason (400)', async () => {
    const never = report({ changeType: 'DISPLACEMENT', startedAtUtc: new Date(Date.now() - 999_000).toISOString() });
    const r = await post(clearedOf(never));
    expect(r.status).toBe(404);
    expect(r.json.code).toBe('CONDITION_NOT_FOUND');
    expect((await post(clearedOf(never, { clearReason: 'FIXED' }))).status).toBe(400);
  });

  it('the other tenant cannot close this tenant\'s condition', async () => {
    const body = report({ changeType: 'DISPLACEMENT', score: 0.8, threshold: 0.55 });
    expect((await post(body)).status).toBe(200);
    const r = await post(clearedOf(body, { tenantId: otherTenantId }));
    expect(r.status).toBe(404);
    const row = await prisma.cameraSabotageCondition.findUniqueOrThrow({ where: { eventId: sabotageEventId(cameraId, 'DISPLACEMENT', body.startedAtUtc) } });
    expect(row.clearedAt).toBeNull();
  });
});

describe('GET /api/v1/footage-integrity/cameras', () => {
  const get = async (token: string | null) => {
    const r = await fetch(`${app.url}/api/v1/footage-integrity/cameras`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.status, json: (await r.json()) as any };
  };

  it('needs a signed-in user', async () => {
    expect((await get(null)).status).toBe(401);
  });

  it('lists the caller\'s cameras with open and recent conditions, seals and held recordings', async () => {
    const segment = await prisma.recordingSegment.create({
      data: {
        tenantId, cameraId, filePath: `/tmp/footage-integrity-${cameraId}.mp4`, startTime: new Date(Date.now() - 600_000), endTime: new Date(Date.now() - 540_000),
        durationMs: 60_000, sizeBytes: BigInt(1000), sha256Hash: 'a'.repeat(64), status: 'CORRUPTED', quarantineReason: 'HASH_MISMATCH',
      },
    });
    const r = await get(operator.token);
    expect(r.status).toBe(200);
    expect(r.json.features).toEqual({ cameraSabotage: true, footageSealing: false });
    expect(r.json.cameras).toHaveLength(1);
    const cam = r.json.cameras[0];
    expect(cam.cameraId).toBe(cameraId);
    // Open: OCCLUSION, BLINDED and DISPLACEMENT from the tests above; DEFOCUS was cleared.
    expect(cam.sabotage.open.map((c: any) => c.changeType).sort()).toEqual(['BLINDED', 'DISPLACEMENT', 'OCCLUSION']);
    expect(cam.sabotage.recent).toHaveLength(1);
    expect(cam.sabotage.recent[0]).toMatchObject({ changeType: 'DEFOCUS', clearReason: 'RESTORED', title: 'Camera out of focus or lens obscured' });
    expect(cam.sabotage.recent[0].measurements).toHaveProperty('sharpness');
    expect(cam.seals).toEqual({ count: 0, lastSealedAt: null });
    expect(cam.heldSegments).toBe(1);
    await prisma.recordingSegment.delete({ where: { id: segment.id } });
  });

  it('shows another tenant nothing of this one, and says when a feature is off', async () => {
    delete process.env.VIGILONE_FEATURE_CAMERA_SABOTAGE;
    try {
      const r = await get(otherOperator.token);
      expect(r.status).toBe(200);
      expect(r.json.features.cameraSabotage).toBe(false);
      expect(r.json.cameras.map((c: any) => c.cameraId)).toEqual([otherCameraId]);
      expect(r.json.cameras[0].sabotage).toEqual({ open: [], recent: [] });
    } finally {
      process.env.VIGILONE_FEATURE_CAMERA_SABOTAGE = 'true';
    }
  });
});
