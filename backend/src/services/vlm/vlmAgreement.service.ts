/**
 * How the VLM second opinion compares with operator verdicts (AlarmFeedback), the Phase 5 exit-gate number
 * for the VLM ("VLM precision/recall published"). Only alarms that have both a second opinion from the chosen
 * model and an operator verdict count. Reading the answers as a false-alarm detector ("no" = the object is
 * not there, so probably a false alarm):
 *
 *  - falseAlarmsFlagged: of the alarms operators marked FALSE_ALARM, the share the model answered "no";
 *  - noPrecision: of the model's "no" answers, the share operators marked FALSE_ALARM;
 *  - trueAlarmsDoubted: of the alarms operators marked TRUE_ALARM, the share the model answered "no". This is
 *    the harmful error, and the reason the answer is advisory only.
 *
 * Each share comes with a 95% Wilson interval. The report says EVALUATED only with at least MIN_EVALUATED
 * alarms that have both (a proposal, not a standard), and never on its own makes the second opinion act.
 */
import { PrismaClient } from '@prisma/client';

export const MIN_EVALUATED = 100;
const Z = 1.959963984540054;

export interface Share {
  numerator: number;
  denominator: number;
  value: number | null;
  ci95: [number, number] | null;
}

export function wilson(k: number, n: number): Share {
  if (n === 0) return { numerator: k, denominator: n, value: null, ci95: null };
  const p = k / n;
  const z2 = Z * Z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  const r = (x: number) => Math.round(x * 10000) / 10000;
  return { numerator: k, denominator: n, value: r(p), ci95: [r(Math.max(0, centre - half)), r(Math.min(1, centre + half))] };
}

export interface AgreementReport {
  status: 'EVALUATED' | 'NOT EVALUATED';
  reason: string | null;
  model: { name: string; version: string; sha256: string } | null;
  window: { from: string; to: string };
  alarmsWithBoth: number;
  /** counts[answer][verdict] */
  counts: Record<'yes' | 'no' | 'unclear', Record<'TRUE_ALARM' | 'FALSE_ALARM', number>>;
  falseAlarmsFlagged: Share;
  noPrecision: Share;
  trueAlarmsDoubted: Share;
  unclearRate: Share;
}

export async function vlmAgreement(prisma: PrismaClient, tenantId: string, from: Date, to: Date, modelSha256?: string): Promise<AgreementReport> {
  let sha = modelSha256;
  if (!sha) {
    const last = await prisma.vlmVerification.findFirst({ where: { tenantId }, orderBy: { createdAt: 'desc' }, select: { modelSha256: true } });
    sha = last?.modelSha256;
  }
  const counts = { yes: { TRUE_ALARM: 0, FALSE_ALARM: 0 }, no: { TRUE_ALARM: 0, FALSE_ALARM: 0 }, unclear: { TRUE_ALARM: 0, FALSE_ALARM: 0 } };
  let model: AgreementReport['model'] = null;
  if (sha) {
    const rows = await prisma.vlmVerification.findMany({
      where: { tenantId, modelSha256: sha, alarm: { triggeredAt: { gte: from, lt: to }, feedback: { isNot: null } } },
      select: { answer: true, modelName: true, modelVersion: true, modelSha256: true, alarm: { select: { feedback: { select: { verdict: true } } } } },
    });
    for (const r of rows) {
      const verdict = r.alarm.feedback?.verdict;
      if ((verdict === 'TRUE_ALARM' || verdict === 'FALSE_ALARM') && (r.answer === 'yes' || r.answer === 'no' || r.answer === 'unclear')) counts[r.answer][verdict]++;
      model = { name: r.modelName, version: r.modelVersion, sha256: r.modelSha256 };
    }
  }
  const n = (Object.values(counts) as Array<Record<string, number>>).reduce((s, c) => s + c.TRUE_ALARM + c.FALSE_ALARM, 0);
  const falseTotal = counts.yes.FALSE_ALARM + counts.no.FALSE_ALARM + counts.unclear.FALSE_ALARM;
  const trueTotal = counts.yes.TRUE_ALARM + counts.no.TRUE_ALARM + counts.unclear.TRUE_ALARM;
  const noTotal = counts.no.TRUE_ALARM + counts.no.FALSE_ALARM;
  const evaluated = n >= MIN_EVALUATED;
  return {
    status: evaluated ? 'EVALUATED' : 'NOT EVALUATED',
    reason: evaluated ? null : `${n} alarm(s) have both a second opinion and an operator verdict; at least ${MIN_EVALUATED} are needed`,
    model,
    window: { from: from.toISOString(), to: to.toISOString() },
    alarmsWithBoth: n,
    counts,
    falseAlarmsFlagged: wilson(counts.no.FALSE_ALARM, falseTotal),
    noPrecision: wilson(counts.no.FALSE_ALARM, noTotal),
    trueAlarmsDoubted: wilson(counts.no.TRUE_ALARM, trueTotal),
    unclearRate: wilson(counts.unclear.TRUE_ALARM + counts.unclear.FALSE_ALARM, n),
  };
}
