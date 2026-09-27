/**
 * P3.5-P3.7 on the real database and the real Express app: validated rule CRUD with audit,
 * TIME_SCHEDULE in the camera's site time zone, PRECEDED_BY / NOT_PRECEDED_BY correlation over
 * stored canonical events, CAMERA_ANALYTIC triggers, the read-only rule preview, and operator
 * feedback with false-alarm statistics.
 */
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera, createUserWithToken, startApp } from './helpers/realDb';
import { createVigilOneEvent, fromDigitalInput } from '../services/incident/orchestrator/events';
import { IncidentOrchestrator } from '../services/incident/orchestrator/incidentOrchestrator.service';
import { markAutomationRulesChanged } from '../services/automation/ruleCache';

const prisma = new PrismaClient();
const orchestrator = new IncidentOrchestrator(prisma);
let app: { url: string; close: () => Promise<void> };
let tenantId = '';
let cameraId = '';
let admin = { userId: '', token: '' };
let operator = { userId: '', token: '' };
const cleanup: string[] = [];

async function api(method: string, p: string, body?: unknown, token = admin.token) {
  const res = await fetch(`${app.url}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
}

function personEvent(at: Date, over: Record<string, any> = {}) {
  const ev = createVigilOneEvent({
    tenantId, cameraId, source: 'VISION_AI', type: 'AI_OBJECT_DETECTED', severity: 'WARNING',
    payload: { kind: 'AI_OBJECT_DETECTED', objectClass: 'person', confidence: 0.9, bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.4 }, trackId: crypto.randomUUID(), dwellSeconds: 0, stage: 'confirmed', stageSeconds: 0 },
    ...over,
  } as any);
  ev.timestampUtc = at;
  return ev;
}

function diEvent(at: Date) {
  const ev = fromDigitalInput({ tenantId, cameraId, pinNumber: 1, state: 'HIGH' } as any);
  ev.timestampUtc = at;
  return ev;
}

async function createRule(body: Record<string, any>) {
  const r = await api('POST', '/automation/rules', { cooldownSeconds: 0, actions: [{ id: 'alarm', type: 'TRIGGER_ALARM', config: { severity: 'WARNING' } }], ...body });
  expect(r.status).toBe(201);
  markAutomationRulesChanged();
  return r.json.rule;
}

async function disableAll() {
  await prisma.automationRule.updateMany({ where: { tenantId }, data: { enabled: false } });
  markAutomationRulesChanged();
}

beforeAll(async () => {
  ({ tenantId, cameraId } = await createTenantWithCamera(prisma, 'rules', { timezone: 'Asia/Kolkata' }));
  cleanup.push(tenantId);
  admin = await createUserWithToken(prisma, tenantId, 'TENANT_ADMIN');
  operator = await createUserWithToken(prisma, tenantId, 'OPERATOR');
  app = await startApp();
});

afterAll(async () => {
  for (const id of cleanup) await prisma.tenant.delete({ where: { id } }).catch(() => undefined);
  await app?.close();
  await prisma.$disconnect();
});

describe('rule CRUD', () => {
  it('rejects invalid rules with RULE_INVALID and foreign references', async () => {
    const bad = await api('POST', '/automation/rules', { name: 'x', triggerType: 'PERSON_DETECTED', triggerConfig: { minConfidence: 2 }, actions: [{ id: 'a', type: 'TRIGGER_ALARM', config: {} }] });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe('RULE_INVALID');
    const other = await createTenantWithCamera(prisma, 'rules-other');
    cleanup.push(other.tenantId);
    const foreign = await api('POST', '/automation/rules', { name: 'x', triggerType: 'PERSON_DETECTED', triggerConfig: { cameraId: other.cameraId }, actions: [{ id: 'a', type: 'TRIGGER_ALARM', config: {} }] });
    expect(foreign.status).toBe(400);
    expect(foreign.json.error).toMatch(/camera of this tenant/);
  });

  it('create, replace and delete are audited', async () => {
    const rule = await createRule({ name: 'crud', triggerType: 'PERSON_DETECTED', enabled: false });
    const put = await api('PUT', `/automation/rules/${rule.id}`, { name: 'crud2', triggerType: 'PERSON_DETECTED', triggerConfig: { minConfidence: 0.7 }, enabled: false, actions: [{ id: 'alarm', type: 'TRIGGER_ALARM', config: {} }] });
    expect(put.status).toBe(200);
    expect(put.json.rule.triggerConfigJson).toEqual({ minConfidence: 0.7 });
    expect((await api('DELETE', `/automation/rules/${rule.id}`)).status).toBe(200);
    expect((await api('DELETE', `/automation/rules/${rule.id}`)).status).toBe(404);
    const actions = (await prisma.auditEvent.findMany({ where: { tenantId, resourceId: rule.id }, orderBy: { sequenceNumber: 'asc' } })).map((a) => a.action);
    expect(actions).toEqual(['AUTOMATION_RULE_CREATE', 'AUTOMATION_RULE_UPDATE', 'AUTOMATION_RULE_DELETE']);
  });
});

describe('live evaluation', () => {
  beforeEach(disableAll);

  it('TIME_SCHEDULE uses the site time zone (Asia/Kolkata) and event time', async () => {
    await createRule({
      name: 'night person', triggerType: 'PERSON_DETECTED',
      conditions: [{ type: 'TIME_SCHEDULE', operator: 'BETWEEN', value: { windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '22:00', end: '06:00' }] } }],
    });
    const inside = await orchestrator.ingestEvent(personEvent(new Date('2026-09-27T17:00:00Z'))); // 22:30 IST
    const outside = await orchestrator.ingestEvent(personEvent(new Date('2026-09-27T06:00:00Z'))); // 11:30 IST
    expect(inside.rulesTriggered).toBe(1);
    expect(outside.rulesTriggered).toBe(0);
  });

  it('NOT_PRECEDED_BY: a person without a badge swipe in the last 30 s raises; with one it does not', async () => {
    await createRule({ name: 'tailgate', triggerType: 'PERSON_DETECTED', conditions: [{ type: 'NOT_PRECEDED_BY', value: { eventTypes: ['DI_TRIGGER'], withinSeconds: 30 } }] });
    const t = new Date('2026-09-20T10:00:00Z');
    await orchestrator.ingestEvent(diEvent(new Date(t.getTime() - 10_000)));
    expect((await orchestrator.ingestEvent(personEvent(t))).rulesTriggered).toBe(0);
    // 40 s after the swipe: outside the window
    expect((await orchestrator.ingestEvent(personEvent(new Date(t.getTime() + 30_000)))).rulesTriggered).toBe(1);
    // A swipe AFTER the person does not count as preceding it
    const t2 = new Date('2026-09-20T11:00:00Z');
    await orchestrator.ingestEvent(diEvent(new Date(t2.getTime() + 5_000)));
    expect((await orchestrator.ingestEvent(personEvent(t2))).rulesTriggered).toBe(1);
  });

  it('PRECEDED_BY scopes to the same camera by default', async () => {
    await createRule({ name: 'after hours door', triggerType: 'PERSON_DETECTED', conditions: [{ type: 'PRECEDED_BY', value: { eventTypes: ['DI_TRIGGER'], withinSeconds: 60 } }] });
    const sp = `cam2_${crypto.randomBytes(3).toString('hex')}`;
    const siteId = (await prisma.camera.findUniqueOrThrow({ where: { id: cameraId } })).siteId!;
    const other = await prisma.camera.create({ data: { tenantId, siteId, name: 'cam2', streamPath: sp, ipAddress: '127.0.0.2', mainRtspUri: `rtsp://127.0.0.2:8554/${sp}` } });
    const t = new Date('2026-09-21T10:00:00Z');
    const di = diEvent(new Date(t.getTime() - 20_000));
    di.cameraId = other.id;
    await orchestrator.ingestEvent(di);
    expect((await orchestrator.ingestEvent(personEvent(t))).rulesTriggered).toBe(0);
    await orchestrator.ingestEvent(diEvent(new Date(t.getTime() - 5_000)));
    expect((await orchestrator.ingestEvent(personEvent(new Date(t.getTime() + 1)))).rulesTriggered).toBe(1);
  });

  it('a stored condition the engine cannot evaluate makes the rule not fire (fail closed)', async () => {
    const rule = await createRule({ name: 'legacy', triggerType: 'PERSON_DETECTED' });
    await prisma.automationRule.update({ where: { id: rule.id }, data: { conditionsJson: [{ type: 'CAMERA_TAG', operator: 'EQUALS', value: 'lobby' }] } });
    markAutomationRulesChanged();
    expect((await orchestrator.ingestEvent(personEvent(new Date('2026-09-22T10:00:00Z')))).rulesTriggered).toBe(0);
  });

  it('CAMERA_ANALYTIC rules match on analytic type and fire on start only', async () => {
    await createRule({ name: 'cam intrusion', triggerType: 'CAMERA_ANALYTIC', triggerConfig: { analyticTypes: ['INTRUSION'] } });
    const ca = (analyticType: string, state: boolean | null) =>
      createVigilOneEvent({ tenantId, cameraId, source: 'CAMERA_ANALYTICS', type: 'CAMERA_ANALYTIC', payload: { kind: 'CAMERA_ANALYTIC', protocol: 'HIKVISION_ISAPI', analyticType, state, vendorTopic: 'fielddetection' } } as any);
    expect((await orchestrator.ingestEvent(ca('INTRUSION', true))).rulesTriggered).toBe(1);
    expect((await orchestrator.ingestEvent(ca('INTRUSION', false))).rulesTriggered).toBe(0);
    expect((await orchestrator.ingestEvent(ca('LINE_CROSSING', true))).rulesTriggered).toBe(0);
  });
});

describe('preview', () => {
  it('replays stored events without side effects and reports each stage', async () => {
    await disableAll();
    const day = new Date('2026-09-25T00:00:00Z');
    // 4 persons: 2 at night IST (17:00Z, 18:00Z), 2 by day (06:00Z, 06:00:10Z)
    for (const t of ['17:00:00', '18:00:00', '06:00:00', '06:00:10']) {
      const ev = personEvent(new Date(`2026-09-25T${t}Z`));
      await prisma.canonicalEvent.create({ data: (require('../services/incident/orchestrator/incidentOrchestrator.service').canonicalRow)(ev) });
    }
    const execBefore = await prisma.ruleExecutionRecord.count({ where: { tenantId } });
    const alarmsBefore = await prisma.alarm.count({ where: { tenantId } });
    const body = { triggerType: 'PERSON_DETECTED', from: day.toISOString(), to: new Date(day.getTime() + 86400_000).toISOString(), cooldownSeconds: 0 };
    const all = await api('POST', '/automation/rules/preview', body);
    expect(all.status).toBe(200);
    expect(all.json).toMatchObject({ scanned: 4, triggerMatched: 4, conditionsMatched: 4, wouldFire: 4, truncated: false });
    const night = await api('POST', '/automation/rules/preview', {
      ...body, conditions: [{ type: 'TIME_SCHEDULE', operator: 'BETWEEN', value: { windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '22:00', end: '06:00' }] } }],
    });
    expect(night.json).toMatchObject({ triggerMatched: 4, conditionsMatched: 2, wouldFire: 2 });
    const cooled = await api('POST', '/automation/rules/preview', { ...body, cooldownSeconds: 60 });
    expect(cooled.json.wouldFire).toBe(3); // 06:00:10 is inside 06:00:00's cooldown
    expect(await prisma.ruleExecutionRecord.count({ where: { tenantId } })).toBe(execBefore);
    expect(await prisma.alarm.count({ where: { tenantId } })).toBe(alarmsBefore);
    expect((await api('POST', '/automation/rules/preview', { ...body, from: '2026-01-01T00:00:00Z', to: '2026-09-01T00:00:00Z' })).status).toBe(400);
  });
});

describe('feedback', () => {
  it('records verdicts (changeable, audited) and reports false-alarm rates by rule and model', async () => {
    const rule = await createRule({ name: 'fb rule', triggerType: 'PERSON_DETECTED', enabled: false });
    const sha = 'a'.repeat(64);
    const mk = () => prisma.alarm.create({ data: { tenantId, cameraId, automationRuleId: rule.id, title: 'fb', severity: 'WARNING', metadataJson: { provenance: { modelSha256: sha } } } });
    const [a1, a2, a3] = [await mk(), await mk(), await mk()];
    expect((await api('POST', `/alarms/${a1.id}/feedback`, { verdict: 'MAYBE' }, operator.token)).status).toBe(400);
    expect((await api('POST', `/alarms/${a1.id}/feedback`, { verdict: 'TRUE_ALARM' }, operator.token)).status).toBe(200);
    expect((await api('POST', `/alarms/${a1.id}/feedback`, { verdict: 'FALSE_ALARM', reason: 'shadow' }, operator.token)).status).toBe(200);
    await api('POST', `/alarms/${a2.id}/feedback`, { verdict: 'TRUE_ALARM' }, operator.token);
    const fb = await prisma.alarmFeedback.findUniqueOrThrow({ where: { alarmId: a1.id } });
    expect(fb).toMatchObject({ verdict: 'FALSE_ALARM', reason: 'shadow', automationRuleId: rule.id, modelSha256: sha, userId: operator.userId });
    const audits = await prisma.auditEvent.findMany({ where: { tenantId, action: 'ALARM_FEEDBACK', resourceId: a1.id }, orderBy: { sequenceNumber: 'asc' } });
    expect(audits.map((a) => (a.metadataJson as any).previousVerdict)).toEqual([null, 'TRUE_ALARM']);

    const stats = await api('GET', '/alarms/feedback/stats', undefined, operator.token);
    expect(stats.status).toBe(200);
    const r = stats.json.byRule.find((x: any) => x.ruleId === rule.id);
    expect(r).toEqual({ ruleId: rule.id, ruleName: 'fb rule', alarms: 3, reviewed: 2, falseAlarms: 1, falseAlarmRate: 0.5 });
    const m = stats.json.byModel.find((x: any) => x.modelSha256 === sha);
    expect(m).toMatchObject({ reviewed: 2, falseAlarms: 1, falseAlarmRate: 0.5, modelName: null });
    void a3;
  });
});
