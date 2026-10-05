/**
 * ADR 0014 on the real database and the real orchestrator: one incident, one alarm. Triggers of the same rule on
 * the same camera join the open alarm while activity continues; a quiet gap, a resolved alarm or a more severe
 * trigger behaves as the decision says; without a window, behaviour is unchanged.
 */
import { PrismaClient, EventSeverity, RuleActionType, RuleTriggerType } from '@prisma/client';
import { createTenantWithCamera } from './helpers/realDb';
import { IncidentOrchestrator, fromMotionEvent } from '../services/incident/orchestrator';

jest.setTimeout(60000);

const prisma = new PrismaClient();
const orchestrator = new IncidentOrchestrator(prisma);
const tenants: string[] = [];
let tenantId = '';
let cameraId = '';
let otherCameraId = '';

async function rule(windowSeconds?: number, severity: EventSeverity = EventSeverity.WARNING) {
  return prisma.automationRule.create({
    data: {
      tenantId,
      name: `rule-${Math.random().toString(16).slice(2, 8)}`,
      cooldownSeconds: 0,
      triggerType: RuleTriggerType.MOTION_ZONE,
      triggerConfigJson: {},
      conditionsJson: {},
      actionsJson: [
        { id: 'a1', type: RuleActionType.TRIGGER_ALARM, config: { title: 'Motion', severity, incidentWindowSeconds: windowSeconds } },
        { id: 'a2', type: RuleActionType.DISPATCH_NOTIFICATION, config: {} },
      ],
    },
  });
}

async function fire(onCamera = cameraId, severity: EventSeverity = EventSeverity.INFO) {
  const ev = fromMotionEvent({ tenantId, cameraId: onCamera, score: 0.9, severity });
  await orchestrator.ingestEvent(ev);
  await orchestrator.drainOutbox();
  return ev;
}

const alarmsFor = (ruleId: string) => prisma.alarm.findMany({ where: { tenantId, automationRuleId: ruleId }, orderBy: { triggeredAt: 'asc' } });

beforeAll(async () => {
  ({ tenantId, cameraId } = await createTenantWithCamera(prisma, 'incwin'));
  tenants.push(tenantId);
  const siteId = (await prisma.camera.findUniqueOrThrow({ where: { id: cameraId } })).siteId;
  otherCameraId = (await prisma.camera.create({ data: { tenantId, siteId, name: 'second', streamPath: `second_${Date.now()}`, ipAddress: '127.0.0.2', mainRtspUri: 'rtsp://127.0.0.2/x' } })).id;
});

afterAll(async () => {
  for (const id of tenants) await prisma.tenant.delete({ where: { id } }).catch(() => undefined);
  await prisma.$disconnect();
});

afterEach(async () => {
  await prisma.automationRule.deleteMany({ where: { tenantId } });
  await prisma.alarm.deleteMany({ where: { tenantId } });
});

describe('incident window (ADR 0014)', () => {
  it('without a window every trigger raises its own alarm, as before', async () => {
    const r = await rule(undefined);
    await fire();
    await fire();
    expect(await alarmsFor(r.id)).toHaveLength(2);
  });

  it('with a window, repeated triggers join one alarm and count their occurrences', async () => {
    const r = await rule(300);
    await fire();
    await fire();
    await fire();
    const alarms = await alarmsFor(r.id);
    expect(alarms).toHaveLength(1);
    expect(alarms[0].occurrenceCount).toBe(3);
    expect(alarms[0].lastActivityAt).not.toBeNull();
    expect(((alarms[0].metadataJson as any).continuations as any[]).length).toBe(2);
  });

  it('records each join in the audit chain', async () => {
    const r = await rule(300);
    await fire();
    await fire();
    const [a] = await alarmsFor(r.id);
    const joins = await prisma.auditEvent.count({ where: { tenantId, action: 'ALARM_CONTINUE', resourceId: a.id } });
    expect(joins).toBe(1);
  });

  it('keeps cameras apart: the same rule on another camera raises its own alarm', async () => {
    const r = await rule(300);
    await fire(cameraId);
    await fire(otherCameraId);
    expect(await alarmsFor(r.id)).toHaveLength(2);
  });

  it('starts a new incident after a quiet gap longer than the window', async () => {
    const r = await rule(300);
    await fire();
    await prisma.alarm.updateMany({ where: { automationRuleId: r.id }, data: { lastActivityAt: new Date(Date.now() - 10 * 60_000), triggeredAt: new Date(Date.now() - 10 * 60_000) } });
    await fire();
    expect(await alarmsFor(r.id)).toHaveLength(2);
  });

  it('starts a new incident once the operator has resolved the alarm', async () => {
    const r = await rule(300);
    await fire();
    await prisma.alarm.updateMany({ where: { automationRuleId: r.id }, data: { state: 'RESOLVED', resolvedAt: new Date() } });
    await fire();
    expect(await alarmsFor(r.id)).toHaveLength(2);
  });

  it('joins an acknowledged alarm', async () => {
    const r = await rule(300);
    await fire();
    await prisma.alarm.updateMany({ where: { automationRuleId: r.id }, data: { state: 'ACKNOWLEDGED', acknowledgedAt: new Date() } });
    await fire();
    const alarms = await alarmsFor(r.id);
    expect(alarms).toHaveLength(1);
    expect(alarms[0].occurrenceCount).toBe(2);
  });

  it('a joining trigger does not re-run the notification, and the action still succeeds', async () => {
    const r = await rule(300);
    const first = await fire();
    const second = await fire();
    const execs = await prisma.actionExecutionRecord.findMany({
      where: { actionType: RuleActionType.DISPATCH_NOTIFICATION, ruleExecution: { ruleId: r.id } },
      include: { ruleExecution: true },
    });
    const byEvent = (id: string) => execs.find((e) => e.ruleExecution.triggerEventId === id)!;
    expect(byEvent(first.id).status).toBe('SUCCESS');
    expect(byEvent(second.id).status).toBe('SUCCESS');
    expect((byEvent(second.id).resultJson as any).suppressed).toBe('INCIDENT_CONTINUATION');
  });
  it('a rule made more severe mid-incident raises the open alarm and notifies again; it never lowers it', async () => {
    const r = await rule(300, EventSeverity.WARNING);
    await fire();
    const actions = (r.actionsJson as any[]).map((a) => (a.type === RuleActionType.TRIGGER_ALARM ? { ...a, config: { ...a.config, severity: EventSeverity.CRITICAL } } : a));
    await prisma.automationRule.update({ where: { id: r.id }, data: { actionsJson: actions } });
    const second = await fire();
    let [alarm] = await alarmsFor(r.id);
    expect(alarm.severity).toBe('CRITICAL');
    const note = await prisma.actionExecutionRecord.findFirstOrThrow({
      where: { actionType: RuleActionType.DISPATCH_NOTIFICATION, ruleExecution: { ruleId: r.id, triggerEventId: second.id } },
    });
    expect((note.resultJson as any).escalated).toBe(true);

    const lowered = actions.map((a) => (a.type === RuleActionType.TRIGGER_ALARM ? { ...a, config: { ...a.config, severity: EventSeverity.INFO } } : a));
    await prisma.automationRule.update({ where: { id: r.id }, data: { actionsJson: lowered } });
    await fire();
    [alarm] = await alarmsFor(r.id);
    expect(alarm.severity).toBe('CRITICAL');
    expect(alarm.occurrenceCount).toBe(3);
  });
});
