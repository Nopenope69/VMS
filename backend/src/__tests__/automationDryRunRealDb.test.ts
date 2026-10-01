/**
 * POST /api/v1/automation/dry-run must never change state. An earlier version ran a separate rule engine that set
 * lastTriggeredAt on every matching rule; the live RuleEngine reads that field for cooldown, so testing an
 * intrusion rule silenced the real one for its cooldown period. Real database, real API.
 */
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera, createUserWithToken, startApp } from './helpers/realDb';

jest.setTimeout(60000);

describe('automation dry run (real database)', () => {
  const prisma = new PrismaClient();
  let app: { url: string; close: () => Promise<void> };
  let tenantId = '';
  let cameraId = '';
  let admin = '';
  const dryRun = async (body: unknown) => {
    const r = await fetch(`${app.url}/api/v1/automation/dry-run`, { method: 'POST', headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as any };
  };
  const rule = (name: string, extra: Record<string, unknown> = {}) =>
    prisma.automationRule.create({
      data: { tenantId, name, enabled: true, triggerType: 'DIGITAL_INPUT_STATE', triggerConfigJson: { pinNumber: 3 }, conditionsJson: [], actionsJson: [{ id: 'a1', type: 'RAISE_ALARM', config: {} }], cooldownSeconds: 300, ...extra } as any,
    });

  beforeAll(async () => {
    app = await startApp();
    ({ tenantId, cameraId } = await createTenantWithCamera(prisma, 'dryrun'));
    admin = (await createUserWithToken(prisma, tenantId, 'TENANT_ADMIN')).token;
  });
  afterAll(async () => {
    await app.close();
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  it('reports the matching rules and changes nothing: no lastTriggeredAt, no execution record', async () => {
    const fires = await rule('door sensor pin 3');
    const other = await rule('pin 4 only', { triggerConfigJson: { pinNumber: 4 } });
    const r = await dryRun({ type: 'DI_TRIGGER', cameraId, payload: { pinNumber: 3, state: 'HIGH' } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ evaluatedRules: 2, executed: false });
    expect(r.json.matchedRules.map((m: any) => m.ruleId)).toEqual([fires.id]);
    expect(r.json.matchedRules[0]).toMatchObject({ suppressedByCooldown: false, cooldownEndsAt: null });
    for (const id of [fires.id, other.id]) {
      expect((await prisma.automationRule.findUnique({ where: { id } }))!.lastTriggeredAt).toBeNull();
    }
    expect(await prisma.ruleExecutionRecord.count({ where: { tenantId } })).toBe(0);
  });

  it('says when a real event would be held back by the rule\'s cooldown', async () => {
    const recent = await rule('recently fired', { lastTriggeredAt: new Date(Date.now() - 60_000) });
    const r = await dryRun({ type: 'DI_TRIGGER', payload: { pinNumber: 3, state: 'HIGH' } });
    const m = r.json.matchedRules.find((x: any) => x.ruleId === recent.id);
    expect(m.suppressedByCooldown).toBe(true);
    expect(Date.parse(m.cooldownEndsAt)).toBeGreaterThan(Date.now());
    expect((await prisma.automationRule.findUnique({ where: { id: recent.id } }))!.lastTriggeredAt!.getTime()).toBeLessThan(Date.now() - 50_000);
  });

  it('rejects an unknown event type and a non-object payload', async () => {
    expect((await dryRun({ type: 'NOT_A_TYPE' })).status).toBe(400);
    expect((await dryRun({ type: 'DI_TRIGGER', payload: 'x' })).status).toBe(400);
  });
});
