/**
 * ADR 0015 on the real database and the real app: the ordered queue of open alarms with reasons, the
 * per-camera false-alarm report with proposals, the feature flag, permissions, tenant isolation, and that
 * nothing here changes an alarm or a rule.
 */
import crypto from 'crypto';
import { PrismaClient, RuleActionType, RuleTriggerType } from '@prisma/client';
import { createTenantWithCamera, createUserWithToken, startApp } from './helpers/realDb';

jest.setTimeout(60000);

const prisma = new PrismaClient();
let app: { url: string; close: () => Promise<void> };
let tenantId = '';
let cameraId = '';
let siteId = '';
let otherTenantId = '';
let admin = { userId: '', token: '' };
let operator = { userId: '', token: '' };
let viewer = { userId: '', token: '' };
let otherAdmin = { userId: '', token: '' };

const get = async (user: { token: string }, p: string) => {
  const r = await fetch(`${app.url}/api/v1/alarm-triage${p}`, { headers: { authorization: `Bearer ${user.token}` } });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
};

async function rule(actions: any[] = [{ id: 'a1', type: RuleActionType.TRIGGER_ALARM, config: {} }]) {
  return prisma.automationRule.create({
    data: { tenantId, name: `rule-${crypto.randomBytes(3).toString('hex')}`, triggerType: RuleTriggerType.MOTION_ZONE, triggerConfigJson: {}, conditionsJson: {}, actionsJson: actions },
  });
}
async function alarm(over: Record<string, any> = {}) {
  return prisma.alarm.create({ data: { tenantId, cameraId, title: 'a', severity: 'WARNING', ...over } });
}
async function verdict(alarmId: string, v: 'FALSE_ALARM' | 'TRUE_ALARM', ruleId: string | null) {
  await prisma.alarmFeedback.create({ data: { tenantId, alarmId, verdict: v, userId: admin.userId, automationRuleId: ruleId, cameraId } });
}
async function second(alarmId: string, answer: 'yes' | 'no' | 'unclear') {
  await prisma.vlmVerification.create({
    data: {
      tenantId, alarmId, cameraId, imageSource: 'SNAPSHOT', imageSha256: 'a'.repeat(64), targetClass: 'person', answer, reason: 'test',
      promptSha256: 'b'.repeat(64), modelName: 'test', modelVersion: '1', modelSha256: crypto.randomBytes(32).toString('hex'),
      adapterId: 'test', inferenceId: crypto.randomUUID(), provenanceJson: {}, latencyMs: 1,
    },
  });
}
/** A rule's past: n alarms on the camera, `falses` of them marked false, the rest true. */
async function pastAlarms(ruleId: string, n: number, falses: number) {
  for (let i = 0; i < n; i++) {
    const a = await alarm({ automationRuleId: ruleId, state: 'RESOLVED', resolvedAt: new Date() });
    await verdict(a.id, i < falses ? 'FALSE_ALARM' : 'TRUE_ALARM', ruleId);
  }
}

beforeAll(async () => {
  process.env.VIGILONE_FEATURE_ALARM_TRIAGE = 'true';
  ({ tenantId, cameraId, siteId } = await createTenantWithCamera(prisma, 'triage'));
  ({ tenantId: otherTenantId } = await createTenantWithCamera(prisma, 'triage-other'));
  admin = await createUserWithToken(prisma, tenantId, 'TENANT_ADMIN');
  operator = await createUserWithToken(prisma, tenantId, 'OPERATOR');
  viewer = await createUserWithToken(prisma, tenantId, 'VIEWER');
  otherAdmin = await createUserWithToken(prisma, otherTenantId, 'TENANT_ADMIN');
  app = await startApp();
});

afterAll(async () => {
  delete process.env.VIGILONE_FEATURE_ALARM_TRIAGE;
  for (const id of [tenantId, otherTenantId]) await prisma.tenant.delete({ where: { id } }).catch(() => undefined);
  await app?.close();
  await prisma.$disconnect();
});

afterEach(async () => {
  await prisma.alarm.deleteMany({ where: { tenantId } });
  await prisma.automationRule.deleteMany({ where: { tenantId } });
});

describe('alarm triage (ADR 0015)', () => {
  it('answers 501 FEATURE_DISABLED while the flag is off', async () => {
    delete process.env.VIGILONE_FEATURE_ALARM_TRIAGE;
    const r = await get(admin, '/queue');
    process.env.VIGILONE_FEATURE_ALARM_TRIAGE = 'true';
    expect(r.status).toBe(501);
    expect(r.json.code).toBe('FEATURE_DISABLED');
  });

  it('lists every open alarm, severity first, and leaves them unchanged', async () => {
    const warn = await alarm({ title: 'warn' });
    const crit = await alarm({ title: 'crit', severity: 'CRITICAL' });
    await second(crit.id, 'no');
    await alarm({ title: 'resolved', state: 'RESOLVED', resolvedAt: new Date() });
    const before = await prisma.alarm.findMany({ where: { tenantId }, orderBy: { id: 'asc' } });

    const r = await get(operator, '/queue');
    expect(r.status).toBe(200);
    expect(r.json.advisory).toBe(true);
    expect(r.json.items.map((i: any) => i.title)).toEqual(['crit', 'warn']);
    expect(r.json.items[0].reasons.map((x: any) => x.code)).toEqual(['SECOND_OPINION_NO']);
    expect(await prisma.alarm.findMany({ where: { tenantId }, orderBy: { id: 'asc' } })).toEqual(before);
    expect(warn.id).toBeTruthy();
  });

  it('moves an alarm down inside its severity when its rule on this camera was mostly false, with the reason', async () => {
    const noisy = await rule();
    const steady = await rule();
    await pastAlarms(noisy.id, 12, 12);
    await pastAlarms(steady.id, 12, 0);
    const a = await alarm({ title: 'noisy', automationRuleId: noisy.id, triggeredAt: new Date(Date.now() - 120_000) });
    const b = await alarm({ title: 'steady', automationRuleId: steady.id, triggeredAt: new Date(Date.now() - 60_000) });

    const r = await get(operator, '/queue');
    expect(r.json.items.map((i: any) => i.title)).toEqual(['steady', 'noisy']);
    expect(r.json.items[1].reasons[0].code).toBe('HISTORY_MOSTLY_FALSE');
    expect(r.json.items[1].reasons[0].text).toMatch(/12 of 12/);
    expect([a.id, b.id]).toHaveLength(2);
  });

  it('shows an incident\'s repeat count as a reason', async () => {
    await alarm({ title: 'repeat', occurrenceCount: 6 });
    const r = await get(operator, '/queue');
    expect(r.json.items[0].reasons.map((x: any) => x.code)).toEqual(['REPEAT_ACTIVITY']);
  });

  it('never shows another tenant\'s alarms or history', async () => {
    const other = await prisma.alarm.create({ data: { tenantId: otherTenantId, title: 'theirs', severity: 'CRITICAL' } });
    const r = await get(operator, '/queue');
    expect(r.json.items.map((i: any) => i.alarmId)).not.toContain(other.id);
    const theirs = await get(otherAdmin, '/queue');
    expect(theirs.json.items.map((i: any) => i.alarmId)).toEqual([other.id]);
    await prisma.alarm.delete({ where: { id: other.id } });
  });

  it('reports false alarms per camera and proposes a window for a noisy rule without one, applying nothing', async () => {
    const noisy = await rule();
    await pastAlarms(noisy.id, 25, 25);
    const before = await prisma.automationRule.findUniqueOrThrow({ where: { id: noisy.id } });

    const r = await get(admin, '/report');
    expect(r.status).toBe(200);
    expect(r.json.byCamera[0]).toMatchObject({ cameraId, alarms: 25, reviewed: 25, falseAlarms: 25, falseAlarmRate: 1 });
    expect(r.json.proposals).toHaveLength(1);
    expect(r.json.proposals[0]).toMatchObject({ kind: 'ADD_INCIDENT_WINDOW', ruleId: noisy.id, cameraId, applied: false });
    expect(await prisma.automationRule.findUniqueOrThrow({ where: { id: noisy.id } })).toEqual(before);
  });

  it('asks for a review instead when the rule already has a window, and proposes nothing for a rule that was mostly right', async () => {
    const windowed = await rule([{ id: 'a1', type: RuleActionType.TRIGGER_ALARM, config: { incidentWindowSeconds: 300 } }]);
    const good = await rule();
    await pastAlarms(windowed.id, 22, 22);
    await pastAlarms(good.id, 22, 3);
    const r = await get(admin, '/report');
    expect(r.json.proposals.map((p: any) => [p.ruleId, p.kind])).toEqual([[windowed.id, 'REVIEW_RULE_SETTINGS']]);
  });

  it('keeps the report for people who may give alarm feedback', async () => {
    expect((await get(viewer, '/report')).status).toBe(403);
    expect((await get(operator, '/report')).status).toBe(200);
  });

  it('rejects a bad date range', async () => {
    expect((await get(admin, '/report?from=2026-10-05T00:00:00Z&to=2026-10-01T00:00:00Z')).status).toBe(400);
  });
});
