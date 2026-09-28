import crypto from 'crypto';
import { PrismaClient, RuleTriggerType } from '@prisma/client';
import { RuleEngine } from '../services/incident/orchestrator/ruleEngine';
import { createVigilOneEvent, fromMotionEvent } from '../services/incident/orchestrator/events';

/**
 * Regression (found by running the real server against Postgres): evaluateEvent passed the raw
 * event type into the RuleTriggerType enum filter, so Prisma rejected the query for MOTION,
 * ANPR_MATCH, DI_TRIGGER, STREAM_DEGRADED and SYSTEM_ALERT events and no rule could fire.
 * Mocked-Prisma unit tests could not see this; this test uses the real database.
 */
describe('RuleEngine against the real database', () => {
  const prisma = new PrismaClient();
  const suffix = crypto.randomBytes(4).toString('hex');
  let tenantId = '';

  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: `rules-${suffix}`, slug: `rules-${suffix}` } });
    tenantId = tenant.id;
    await prisma.automationRule.create({
      data: {
        tenantId,
        name: 'motion rule',
        enabled: true,
        triggerType: RuleTriggerType.MOTION_ZONE,
        triggerConfigJson: {},
        conditionsJson: [],
        actionsJson: [],
      } as any,
    });
  });

  afterAll(async () => {
    await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('only ever queries enum-valid trigger types', () => {
    expect(RuleEngine.candidateTriggerTypes('MOTION')).toEqual([RuleTriggerType.MOTION_ZONE]);
    expect(RuleEngine.candidateTriggerTypes('SYSTEM_ALERT')).toEqual([]);
    expect(RuleEngine.candidateTriggerTypes('TRIPWIRE_CROSS')).toEqual([RuleTriggerType.TRIPWIRE_CROSS]);
  });

  it('a MOTION event reaches a MOTION_ZONE rule (the query no longer throws)', async () => {
    const engine = new RuleEngine(prisma);
    const findMany = jest.spyOn(prisma.automationRule, 'findMany');
    const out = await engine.evaluateEvent(fromMotionEvent({ tenantId, cameraId: 'cam-x', score: 0.7 }));
    expect(out.cascadeTerminated).toBe(false);
    const returned = await (findMany.mock.results[0].value as Promise<any[]>);
    expect(returned.map((r) => r.name)).toEqual(['motion rule']);
    findMany.mockRestore();
  });

  it('a SYSTEM_ALERT event with no applicable trigger type evaluates to no rules without error', async () => {
    const engine = new RuleEngine(prisma);
    const ev = createVigilOneEvent({
      tenantId,
      type: 'SYSTEM_ALERT',
      payload: { kind: 'SYSTEM_ALERT', subsystem: 'storage', alertCode: 'X', message: 'y' },
    });
    await expect(engine.evaluateEvent(ev)).resolves.toEqual({ results: [], cascadeTerminated: false });
  });
});
