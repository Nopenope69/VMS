/**
 * Camera-sabotage reports (ADR 0019) on the real database and the real Express app: the flag, validation, the
 * camera and tenant check, the canonical SCENE_CHANGE event with what was measured, a SCENE_CHANGE rule turning it
 * into an alarm, a repeated report evaluated once, and the events.v1 `camera.degraded` mapping.
 */
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera, startApp } from './helpers/realDb';
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
});
