import { AlarmState, PrismaClient, RuleActionType } from '@prisma/client';
import { PairHistory, proposeRuleChanges, rankAlarms, TriageAlarm } from './alarmTriage';

/** How far back operator verdicts count (matches the false-alarm report's default). */
const HISTORY_DAYS = 30;
const QUEUE_LIMIT = 200;

/**
 * ADR 0015: reads open alarms and operator verdicts, applies the pure rules in `alarmTriage.ts`, and returns an
 * ordered queue and rule-change proposals. It writes nothing.
 */
export class AlarmTriageService {
  constructor(private prisma: PrismaClient) {}

  private async history(tenantId: string, from: Date, to: Date): Promise<PairHistory[]> {
    const rows = await this.prisma.$queryRaw<Array<{ ruleId: string | null; cameraId: string | null; alarms: bigint; reviewed: bigint; falseAlarms: bigint }>>`
      SELECT a."automationRuleId" AS "ruleId", a."cameraId" AS "cameraId",
             COUNT(*) AS "alarms",
             COUNT(f."id") AS "reviewed",
             COUNT(f."id") FILTER (WHERE f."verdict" = 'FALSE_ALARM') AS "falseAlarms"
        FROM "Alarm" a
        LEFT JOIN "AlarmFeedback" f ON f."alarmId" = a."id"
       WHERE a."tenantId" = ${tenantId} AND a."triggeredAt" BETWEEN ${from} AND ${to}
       GROUP BY a."automationRuleId", a."cameraId"`;
    return rows.map((r) => ({ ruleId: r.ruleId, cameraId: r.cameraId, alarms: Number(r.alarms), reviewed: Number(r.reviewed), falseAlarms: Number(r.falseAlarms) }));
  }

  /** Open (ACTIVE) alarms, most important first, each with the reasons behind its position. Hides nothing. */
  async queue(tenantId: string, now: Date = new Date()) {
    const alarms = await this.prisma.alarm.findMany({
      where: { tenantId, state: AlarmState.ACTIVE },
      include: {
        camera: { select: { name: true } },
        vlmVerifications: { select: { answer: true }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { triggeredAt: 'asc' },
      take: QUEUE_LIMIT,
    });
    const history = await this.history(tenantId, new Date(now.getTime() - HISTORY_DAYS * 86400_000), now);
    const input: TriageAlarm[] = alarms.map((a) => {
      const answer = a.vlmVerifications[0]?.answer;
      return {
        id: a.id,
        severity: a.severity,
        triggeredAt: a.triggeredAt,
        ackDueAt: a.ackDueAt,
        occurrenceCount: a.occurrenceCount,
        ruleId: a.automationRuleId,
        cameraId: a.cameraId,
        vlmAnswer: answer === 'yes' || answer === 'no' || answer === 'unclear' ? answer : null,
      };
    });
    const byId = new Map(alarms.map((a) => [a.id, a]));
    return {
      generatedAt: now.toISOString(),
      advisory: true,
      note: 'Order only. Every open alarm is listed. The second-opinion answer and the history move an alarm inside its severity, never above a more severe one.',
      items: rankAlarms(input, now, history).map((r) => {
        const a = byId.get(r.alarmId)!;
        return { ...r, title: a.title, cameraId: a.cameraId, cameraName: a.camera?.name ?? null, triggeredAt: a.triggeredAt, occurrenceCount: a.occurrenceCount };
      }),
    };
  }

  /** False-alarm report per camera and per rule+camera, and proposed rule changes. Applies none of them. */
  async report(tenantId: string, from: Date, to: Date) {
    const history = await this.history(tenantId, from, to);
    const ruleIds = [...new Set(history.map((h) => h.ruleId).filter((x): x is string => !!x))];
    const rules = await this.prisma.automationRule.findMany({ where: { tenantId, id: { in: ruleIds } }, select: { id: true, name: true, actionsJson: true } });
    const ruleInfo = new Map(
      rules.map((r) => [
        r.id,
        {
          name: r.name,
          hasWindow: ((r.actionsJson as any[]) || []).some((a) => a?.type === RuleActionType.TRIGGER_ALARM && Number(a?.config?.incidentWindowSeconds) > 0),
        },
      ])
    );

    const cameras = new Map<string | null, { alarms: number; reviewed: number; falseAlarms: number }>();
    for (const h of history) {
      const c = cameras.get(h.cameraId) ?? { alarms: 0, reviewed: 0, falseAlarms: 0 };
      c.alarms += h.alarms;
      c.reviewed += h.reviewed;
      c.falseAlarms += h.falseAlarms;
      cameras.set(h.cameraId, c);
    }
    const names = new Map(
      (await this.prisma.camera.findMany({ where: { tenantId, id: { in: [...cameras.keys()].filter((x): x is string => !!x) } }, select: { id: true, name: true } })).map((c) => [c.id, c.name])
    );

    return {
      window: { from: from.toISOString(), to: to.toISOString() },
      byCamera: [...cameras.entries()]
        .map(([cameraId, c]) => ({ cameraId, cameraName: cameraId ? names.get(cameraId) ?? null : null, ...c, falseAlarmRate: c.reviewed > 0 ? c.falseAlarms / c.reviewed : null }))
        .sort((a, b) => b.falseAlarms - a.falseAlarms || b.alarms - a.alarms),
      proposals: proposeRuleChanges(history, ruleInfo),
      note: 'Proposals are suggestions with their evidence. Nothing is applied; change a rule in the rule editor and check it with the dry run.',
    };
  }
}
