/**
 * Time-to-answer stopwatch (feature INVESTIGATION_TIMING) on the real database and the real app: one running
 * stopwatch per operator (also under concurrent starts), server-clock times, steps and the first opened result,
 * ownership, stale stopwatches, the site report's numbers and verdict, permissions, and the flag.
 */
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera, createUserWithToken, startApp } from './helpers/realDb';
import { InvestigationTimingService, MAX_OPEN_MS, MIN_ANSWERED, percentile } from '../services/investigation/investigationTiming.service';

jest.setTimeout(60000);

const prisma = new PrismaClient();
let app: { url: string; close: () => Promise<void> };
let tenantId = '';
let reportTenantId = '';
let admin = { userId: '', token: '' };
let operator = { userId: '', token: '' };
let operator2 = { userId: '', token: '' };

async function call(user: { token: string }, method: string, p: string, body?: unknown) {
  const r = await fetch(`${app.url}/api/v1/investigations/timings${p}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${user.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
}

beforeAll(async () => {
  process.env.VIGILONE_FEATURE_INVESTIGATION_TIMING = 'true';
  ({ tenantId } = await createTenantWithCamera(prisma, 'timing'));
  ({ tenantId: reportTenantId } = await createTenantWithCamera(prisma, 'timing-report'));
  admin = await createUserWithToken(prisma, tenantId, 'TENANT_ADMIN');
  operator = await createUserWithToken(prisma, tenantId, 'OPERATOR');
  operator2 = await createUserWithToken(prisma, tenantId, 'OPERATOR');
  app = await startApp();
});

afterAll(async () => {
  delete process.env.VIGILONE_FEATURE_INVESTIGATION_TIMING;
  for (const id of [tenantId, reportTenantId]) await prisma.tenant.delete({ where: { id } }).catch(() => undefined);
  await app.close();
  await prisma.$disconnect();
});

describe('one investigation', () => {
  it('starts, counts steps, records the first opened result and stops, all on the server clock', async () => {
    const before = Date.now();
    const s = await call(operator, 'POST', '', { label: 'who entered the store room after 10 PM', startedAt: '2020-01-01T00:00:00Z' });
    expect(s.status).toBe(400); // the client cannot set times
    const started = await call(operator, 'POST', '', { label: 'who entered the store room after 10 PM' });
    expect(started.status).toBe(201);
    const id = started.json.timing.id;
    expect(Date.parse(started.json.timing.startedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect((await call(operator, 'GET', '/current')).json.timing.id).toBe(id);

    const step = async (kind: string) => expect((await call(operator, 'POST', `/${id}/steps`, { kind })).status).toBe(200);
    for (const kind of ['SEARCH', 'SEARCH', 'CAMERA_VIEWED']) await step(kind);
    expect((await prisma.investigationTiming.findUniqueOrThrow({ where: { id } })).firstResultOpenedAt).toBeNull();
    await step('RESULT_OPENED');
    const firstOpened = (await prisma.investigationTiming.findUniqueOrThrow({ where: { id } })).firstResultOpenedAt!;
    await new Promise((r) => setTimeout(r, 20));
    for (const kind of ['RESULT_OPENED', 'EXPORT']) await step(kind);
    const mid = await prisma.investigationTiming.findUniqueOrThrow({ where: { id } });
    expect(mid).toMatchObject({ searches: 2, camerasViewed: 1, resultsOpened: 2, exports: 1, outcome: 'OPEN' });
    expect(firstOpened.getTime()).toBeGreaterThanOrEqual(mid.startedAt.getTime());

    const done = await call(operator, 'POST', `/${id}/finish`, { outcome: 'ANSWERED' });
    expect(done.status).toBe(200);
    expect(done.json.timing.outcome).toBe('ANSWERED');
    expect(done.json.timing.seconds).toBeGreaterThanOrEqual(0);
    // The second RESULT_OPENED did not move the first-result time.
    expect((await prisma.investigationTiming.findUniqueOrThrow({ where: { id } })).firstResultOpenedAt!.getTime()).toBe(firstOpened.getTime());
    expect((await call(operator, 'GET', '/current')).json.timing).toBeNull();

    // Stopped means stopped.
    expect((await call(operator, 'POST', `/${id}/steps`, { kind: 'SEARCH' })).json.code).toBe('TIMING_CLOSED');
    expect((await call(operator, 'POST', `/${id}/finish`, { outcome: 'ABANDONED' })).json.code).toBe('TIMING_CLOSED');
  });

  it('allows one running stopwatch per operator, also when two starts race', async () => {
    const rs = await Promise.all(Array.from({ length: 5 }, () => call(operator2, 'POST', '', {})));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409).every((r) => r.json.code === 'TIMING_ALREADY_OPEN')).toBe(true);
    expect(await prisma.investigationTiming.count({ where: { userId: operator2.userId, outcome: 'OPEN' } })).toBe(1);
    const open = rs.find((r) => r.status === 201)!.json.timing.id;
    const again = await call(operator2, 'POST', '', {});
    expect(again.json).toMatchObject({ code: 'TIMING_ALREADY_OPEN', timingId: open });
    await call(operator2, 'POST', `/${open}/finish`, { outcome: 'ABANDONED' });
  });

  it('another operator\'s stopwatch is not found; bad steps and outcomes are refused', async () => {
    const mine = (await call(operator, 'POST', '', {})).json.timing.id;
    expect((await call(operator2, 'POST', `/${mine}/steps`, { kind: 'SEARCH' })).status).toBe(404);
    expect((await call(operator2, 'POST', `/${mine}/finish`, { outcome: 'ANSWERED' })).status).toBe(404);
    expect((await call(operator, 'POST', `/${mine}/steps`, { kind: 'COFFEE' })).json.code).toBe('INVALID_TIMING_REQUEST');
    expect((await call(operator, 'POST', `/${mine}/finish`, { outcome: 'SOLVED' })).json.code).toBe('INVALID_TIMING_REQUEST');
    expect((await call(operator, 'POST', '', { label: 'x'.repeat(121) })).json.code).toBe('INVALID_TIMING_REQUEST');
    await call(operator, 'POST', `/${mine}/finish`, { outcome: 'ABANDONED' });
  });

  it('closes a stopwatch left running past the limit as ABANDONED when the operator starts the next', async () => {
    const svc = new InvestigationTimingService(prisma);
    const user = crypto.randomUUID();
    const t0 = new Date('2026-10-01T08:00:00Z');
    const old = await svc.start(reportTenantId, user, undefined, t0);
    await expect(svc.start(reportTenantId, user, undefined, new Date(t0.getTime() + MAX_OPEN_MS - 1000))).rejects.toMatchObject({ code: 'TIMING_ALREADY_OPEN' });
    const next = await svc.start(reportTenantId, user, undefined, new Date(t0.getTime() + MAX_OPEN_MS + 1000));
    expect((await prisma.investigationTiming.findUniqueOrThrow({ where: { id: old.id } })).outcome).toBe('ABANDONED');
    expect(next.outcome).toBe('OPEN');
    await prisma.investigationTiming.deleteMany({ where: { tenantId: reportTenantId } });
  });
});

describe('site report', () => {
  const t0 = new Date('2026-09-01T00:00:00Z').getTime();
  async function seed(answeredSeconds: number[], extra: { abandoned?: number; open?: number } = {}) {
    await prisma.investigationTiming.deleteMany({ where: { tenantId: reportTenantId } });
    const rows = answeredSeconds.map((s, i) => ({
      tenantId: reportTenantId,
      userId: `u${i}`,
      startedAt: new Date(t0 + i * 3_600_000),
      firstResultOpenedAt: new Date(t0 + i * 3_600_000 + 5000),
      endedAt: new Date(t0 + i * 3_600_000 + s * 1000),
      outcome: 'ANSWERED',
      searches: 2,
      resultsOpened: 1,
      camerasViewed: i % 3,
      exports: 0,
    }));
    for (let i = 0; i < (extra.abandoned ?? 0); i++) rows.push({ ...rows[0], userId: `a${i}`, outcome: 'ABANDONED' });
    await prisma.investigationTiming.createMany({ data: rows });
    for (let i = 0; i < (extra.open ?? 0); i++) await prisma.investigationTiming.create({ data: { tenantId: reportTenantId, userId: `o${i}`, startedAt: new Date(t0 + i * 1000) } });
  }
  const report = (from = '2026-08-01T00:00:00Z', to = '2026-11-01T00:00:00Z', now = new Date('2026-10-01T00:00:00Z')) =>
    new InvestigationTimingService(prisma).report(reportTenantId, new Date(from), new Date(to), now);

  it('reports median, 90th percentile, share within 60 s and steps; abandoned and open ones are not answers', async () => {
    // 40 answers: 10, 20, ..., 400 seconds.
    const secs = Array.from({ length: 40 }, (_, i) => (i + 1) * 10);
    await seed(secs, { abandoned: 3, open: 2 });
    const r = await report();
    expect(r).toMatchObject({ started: 45, answered: 40, abandoned: 3, stillOpen: 0, staleOpen: 2, targetSeconds: 60 });
    expect(r.verdict.evaluated).toBe(true);
    expect(r.timeToAnswerSeconds).toEqual({ p50: percentile(secs, 0.5), p90: percentile(secs, 0.9), max: 400 });
    expect(r.timeToAnswerSeconds.p50).toBe(200);
    expect(r.timeToAnswerSeconds.p90).toBe(360);
    expect(r.answeredWithinTarget).toBeCloseTo(6 / 40);
    expect(r.answeredWithinTargetCi95![0]).toBeLessThan(6 / 40);
    expect(r.timeToFirstResultSeconds).toMatchObject({ p50: 5, measured: 40 });
    expect(r.stepsPerAnswer.p50).toBe(4);
  });

  it('says NOT EVALUATED with too few answers, and counts only the chosen window', async () => {
    await seed(Array.from({ length: MIN_ANSWERED - 1 }, () => 30));
    expect((await report()).verdict).toMatchObject({ evaluated: false, reason: expect.stringMatching(/fewer than the 30/) });
    expect((await report('2026-09-01T05:00:00Z', '2026-09-01T10:00:00Z')).answered).toBe(5);
  });

  it('is served to AUDIT_VIEW only, for the caller\'s own tenant', async () => {
    expect((await call(operator, 'GET', '/report')).status).toBe(403);
    const r = await call(admin, 'GET', '/report?from=2026-01-01T00:00:00Z');
    expect(r.status).toBe(200);
    expect(r.json.report.answered).toBe(1); // the one answered in the first test, not the other tenant's
    expect((await call(admin, 'GET', '/report?from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z')).json.code).toBe('INVALID_TIMING_REQUEST');
  });
});

it('answers 501 FEATURE_DISABLED while the feature is off', async () => {
  process.env.VIGILONE_FEATURE_INVESTIGATION_TIMING = 'false';
  try {
    const r = await call(operator, 'GET', '/current');
    expect(r.status).toBe(501);
    expect(r.json.code).toBe('FEATURE_DISABLED');
  } finally {
    process.env.VIGILONE_FEATURE_INVESTIGATION_TIMING = 'true';
  }
});
