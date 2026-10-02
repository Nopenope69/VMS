/**
 * Time-to-answer stopwatch (feature INVESTIGATION_TIMING, default OFF): the North Star's primary product metric.
 *
 * An operator starts the stopwatch when they take a question ("who entered the warehouse after 10 PM?") and stops
 * it as ANSWERED or ABANDONED. The console reports steps along the way (searches, results opened, cameras viewed,
 * exports). Every time is taken by the server clock, never the browser's. One stopwatch can be open per operator;
 * one left open longer than MAX_OPEN_MS is closed as ABANDONED when that operator starts the next, and is not
 * counted as an answer.
 *
 * The report is for the site as a whole: counts, median and 90th-percentile time to answer, the share answered
 * within the 60-second target (with its 95% interval), and steps per investigation. It deliberately has no
 * per-operator breakdown: it measures the product, not the people using it.
 */
import { PrismaClient } from '@prisma/client';

export const TARGET_SECONDS = 60;
export const MAX_OPEN_MS = 4 * 3_600_000;
export const STEP_KINDS = ['SEARCH', 'RESULT_OPENED', 'CAMERA_VIEWED', 'EXPORT'] as const;
export type StepKind = (typeof STEP_KINDS)[number];
export const OUTCOMES = ['ANSWERED', 'ABANDONED'] as const;
export type Outcome = (typeof OUTCOMES)[number];
/** Fewer answered investigations than this and the report says NOT EVALUATED (a proposed minimum). */
export const MIN_ANSWERED = 30;

export class TimingError extends Error {
  constructor(public status: number, public code: string, message: string, public timingId?: string) {
    super(message);
  }
}

const STEP_COLUMN: Record<StepKind, 'searches' | 'resultsOpened' | 'camerasViewed' | 'exports'> = {
  SEARCH: 'searches',
  RESULT_OPENED: 'resultsOpened',
  CAMERA_VIEWED: 'camerasViewed',
  EXPORT: 'exports',
};

/** Nearest-rank percentile of sorted-or-not values; null when empty. */
export function percentile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

/** Wilson score interval (95 %) for k successes in n trials. */
export function wilson95(k: number, n: number): [number, number] | null {
  if (n === 0) return null;
  const z = 1.959963984540054;
  const p = k / n;
  const den = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

const seconds = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 100) / 10;

export class InvestigationTimingService {
  constructor(private prisma: PrismaClient) {}

  /** The operator's open stopwatch, or null. */
  async current(tenantId: string, userId: string) {
    return this.prisma.investigationTiming.findFirst({ where: { tenantId, userId, outcome: 'OPEN' }, orderBy: { startedAt: 'desc' } });
  }

  async start(tenantId: string, userId: string, label?: string, now = new Date()) {
    const open = await this.current(tenantId, userId);
    if (open) {
      if (now.getTime() - open.startedAt.getTime() < MAX_OPEN_MS) {
        throw new TimingError(409, 'TIMING_ALREADY_OPEN', 'a stopwatch is already running for this operator: finish it first', open.id);
      }
      await this.prisma.investigationTiming.updateMany({ where: { id: open.id, outcome: 'OPEN' }, data: { outcome: 'ABANDONED', endedAt: now } });
    }
    try {
      return await this.prisma.investigationTiming.create({ data: { tenantId, userId, label: label?.trim() || null, startedAt: now } });
    } catch (err: any) {
      // Two starts at once: the partial unique index lets only one stopwatch be open per operator.
      if (err?.code === 'P2002') throw new TimingError(409, 'TIMING_ALREADY_OPEN', 'a stopwatch is already running for this operator: finish it first');
      throw err;
    }
  }

  async step(tenantId: string, userId: string, id: string, kind: StepKind, now = new Date()) {
    await this.ownOpen(tenantId, userId, id);
    const column = STEP_COLUMN[kind];
    await this.prisma.investigationTiming.updateMany({ where: { id, outcome: 'OPEN' }, data: { [column]: { increment: 1 } } });
    if (kind === 'RESULT_OPENED') {
      // Only the first one counts; the condition makes it safe against two steps arriving together.
      await this.prisma.investigationTiming.updateMany({ where: { id, outcome: 'OPEN', firstResultOpenedAt: null }, data: { firstResultOpenedAt: now } });
    }
    return this.prisma.investigationTiming.findUniqueOrThrow({ where: { id } });
  }

  async finish(tenantId: string, userId: string, id: string, outcome: Outcome, now = new Date()) {
    await this.ownOpen(tenantId, userId, id);
    const done = await this.prisma.investigationTiming.updateMany({ where: { id, outcome: 'OPEN' }, data: { outcome, endedAt: now } });
    if (done.count === 0) throw new TimingError(409, 'TIMING_CLOSED', 'this stopwatch has already been stopped');
    const t = await this.prisma.investigationTiming.findUniqueOrThrow({ where: { id } });
    return { ...t, seconds: seconds(t.startedAt, t.endedAt!) };
  }

  /** Site-wide report over stopwatches started in [from, to). */
  async report(tenantId: string, from: Date, to: Date, now = new Date()) {
    const rows = await this.prisma.investigationTiming.findMany({ where: { tenantId, startedAt: { gte: from, lt: to } } });
    const answered = rows.filter((r) => r.outcome === 'ANSWERED' && r.endedAt);
    const durations = answered.map((r) => seconds(r.startedAt, r.endedAt!));
    const toFirst = answered.filter((r) => r.firstResultOpenedAt).map((r) => seconds(r.startedAt, r.firstResultOpenedAt!));
    const steps = answered.map((r) => r.searches + r.resultsOpened + r.camerasViewed + r.exports);
    const withinTarget = durations.filter((d) => d <= TARGET_SECONDS).length;
    const open = rows.filter((r) => r.outcome === 'OPEN');
    const evaluated = answered.length >= MIN_ANSWERED;
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      targetSeconds: TARGET_SECONDS,
      verdict: evaluated
        ? { evaluated: true, reason: `${answered.length} answered investigations` }
        : { evaluated: false, reason: `NOT EVALUATED: ${answered.length} answered investigations, fewer than the ${MIN_ANSWERED} needed` },
      started: rows.length,
      answered: answered.length,
      abandoned: rows.filter((r) => r.outcome === 'ABANDONED').length,
      stillOpen: open.filter((r) => now.getTime() - r.startedAt.getTime() < MAX_OPEN_MS).length,
      staleOpen: open.filter((r) => now.getTime() - r.startedAt.getTime() >= MAX_OPEN_MS).length,
      timeToAnswerSeconds: { p50: percentile(durations, 0.5), p90: percentile(durations, 0.9), max: durations.length ? Math.max(...durations) : null },
      timeToFirstResultSeconds: { p50: percentile(toFirst, 0.5), p90: percentile(toFirst, 0.9), measured: toFirst.length },
      answeredWithinTarget: answered.length ? withinTarget / answered.length : null,
      answeredWithinTargetCi95: wilson95(withinTarget, answered.length),
      stepsPerAnswer: { p50: percentile(steps, 0.5), p90: percentile(steps, 0.9) },
    };
  }

  /** The stopwatch exists, belongs to this operator (anything else is not found) and is still running. */
  private async ownOpen(tenantId: string, userId: string, id: string) {
    const t = await this.prisma.investigationTiming.findUnique({ where: { id } });
    if (!t || t.tenantId !== tenantId || t.userId !== userId) throw new TimingError(404, 'TIMING_NOT_FOUND', 'stopwatch not found');
    if (t.outcome !== 'OPEN') throw new TimingError(409, 'TIMING_CLOSED', 'this stopwatch has already been stopped');
    return t;
  }
}
