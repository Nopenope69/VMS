import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AuditChainService } from '../../audit/auditChain.service';
import { MetricsService } from '../../observability/metrics.service';
import { WorkflowError } from './alarmWorkflow.service';

/**
 * Operator verdicts on alarms (P3.7) and false-alarm statistics per rule and per model, the
 * input for tuning thresholds, dwell and schedules. The model is taken from the alarm's own
 * provenance; an alarm without provenance is counted under "no model", never attributed.
 */
export const FeedbackInput = z
  .object({
    verdict: z.enum(['FALSE_ALARM', 'TRUE_ALARM']),
    reason: z.string().max(500).optional(),
  })
  .strict();

export class AlarmFeedbackService {
  constructor(private prisma: PrismaClient) {}

  async record(alarmId: string, input: unknown, ctx: { tenantId: string; userId: string; clientIp?: string }) {
    const parsed = FeedbackInput.safeParse(input);
    if (!parsed.success) throw new WorkflowError(400, `Invalid feedback: ${parsed.error.issues[0].path.join('.')}: ${parsed.error.issues[0].message}`);
    const alarm = await this.prisma.alarm.findUnique({ where: { id: alarmId }, include: { canonicalEvent: { select: { provenanceJson: true } } } });
    if (!alarm || alarm.tenantId !== ctx.tenantId) throw new WorkflowError(404, 'Alarm not found');
    const prov: any = (alarm.metadataJson as any)?.provenance ?? alarm.canonicalEvent?.provenanceJson ?? null;
    const modelSha256 = typeof prov?.modelSha256 === 'string' && /^[a-f0-9]{64}$/.test(prov.modelSha256) ? prov.modelSha256 : null;
    const previous = await this.prisma.alarmFeedback.findUnique({ where: { alarmId } });
    const data = {
      verdict: parsed.data.verdict,
      reason: parsed.data.reason ?? null,
      userId: ctx.userId,
      automationRuleId: alarm.automationRuleId,
      cameraId: alarm.cameraId,
      modelSha256,
    };
    const row = await this.prisma.$transaction(async (tx) => {
      const r = await tx.alarmFeedback.upsert({ where: { alarmId }, create: { tenantId: ctx.tenantId, alarmId, ...data }, update: data });
      await AuditChainService.record(tx, {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        action: 'ALARM_FEEDBACK',
        resourceType: 'Alarm',
        resourceId: alarmId,
        ipAddress: ctx.clientIp || '127.0.0.1',
        metadata: { verdict: data.verdict, previousVerdict: previous?.verdict ?? null, reason: data.reason, automationRuleId: data.automationRuleId, modelSha256 },
      });
      return r;
    });
    MetricsService.incCounter('vigilone_alarm_feedback_total', 'Operator alarm verdicts', { verdict: data.verdict });
    return row;
  }

  /**
   * Per rule and per model in [from, to] (alarm trigger time): alarms raised, verdicts given and
   * the false-alarm rate among reviewed alarms. Rates are null when nothing was reviewed.
   */
  async stats(tenantId: string, from: Date, to: Date) {
    const byRule = await this.prisma.$queryRaw<Array<{ ruleId: string | null; ruleName: string | null; alarms: bigint; reviewed: bigint; falseAlarms: bigint }>>`
      SELECT a."automationRuleId" AS "ruleId", r."name" AS "ruleName",
             COUNT(*) AS "alarms",
             COUNT(f."id") AS "reviewed",
             COUNT(f."id") FILTER (WHERE f."verdict" = 'FALSE_ALARM') AS "falseAlarms"
        FROM "Alarm" a
        LEFT JOIN "AlarmFeedback" f ON f."alarmId" = a."id"
        LEFT JOIN "AutomationRule" r ON r."id" = a."automationRuleId"
       WHERE a."tenantId" = ${tenantId} AND a."triggeredAt" BETWEEN ${from} AND ${to}
       GROUP BY a."automationRuleId", r."name"
       ORDER BY COUNT(f."id") FILTER (WHERE f."verdict" = 'FALSE_ALARM') DESC, COUNT(*) DESC`;
    const byModel = await this.prisma.$queryRaw<Array<{ modelSha256: string | null; modelName: string | null; modelVersion: string | null; reviewed: bigint; falseAlarms: bigint }>>`
      SELECT f."modelSha256", m."name" AS "modelName", m."version" AS "modelVersion",
             COUNT(*) AS "reviewed",
             COUNT(*) FILTER (WHERE f."verdict" = 'FALSE_ALARM') AS "falseAlarms"
        FROM "AlarmFeedback" f
        JOIN "Alarm" a ON a."id" = f."alarmId"
        LEFT JOIN LATERAL (SELECT "name", "version" FROM "ModelManifest" mm WHERE mm."sha256" = f."modelSha256" ORDER BY mm."createdAt" DESC LIMIT 1) m ON TRUE
       WHERE f."tenantId" = ${tenantId} AND a."triggeredAt" BETWEEN ${from} AND ${to}
       GROUP BY f."modelSha256", m."name", m."version"
       ORDER BY COUNT(*) FILTER (WHERE f."verdict" = 'FALSE_ALARM') DESC`;
    const rate = (fa: bigint, rev: bigint) => (rev > BigInt(0) ? Number(fa) / Number(rev) : null);
    return {
      window: { from: from.toISOString(), to: to.toISOString() },
      byRule: byRule.map((r) => ({
        ruleId: r.ruleId, ruleName: r.ruleName, alarms: Number(r.alarms), reviewed: Number(r.reviewed), falseAlarms: Number(r.falseAlarms), falseAlarmRate: rate(r.falseAlarms, r.reviewed),
      })),
      byModel: byModel.map((m) => ({
        modelSha256: m.modelSha256, modelName: m.modelName, modelVersion: m.modelVersion, reviewed: Number(m.reviewed), falseAlarms: Number(m.falseAlarms), falseAlarmRate: rate(m.falseAlarms, m.reviewed),
      })),
    };
  }
}

