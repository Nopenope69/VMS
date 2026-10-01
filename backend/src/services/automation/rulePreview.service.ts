import { PrismaClient, RuleTriggerType } from '@prisma/client';
import { RuleEngine } from '../incident/orchestrator/ruleEngine';
import { eventFromRow } from '../incident/orchestrator/incidentOrchestrator.service';
import { RULE_TRIGGERS } from '../incident/orchestrator/eventKinds';

export const PREVIEW_MAX_EVENTS = 5000;
export const PREVIEW_MAX_DAYS = 31;

export interface PreviewResult {
  window: { from: string; to: string };
  scanned: number;
  truncated: boolean;
  triggerMatched: number;
  conditionsMatched: number;
  /** Matches left after applying the rule's cooldown in event-time order. */
  wouldFire: number;
  samples: Array<{ eventId: string; type: string; cameraId: string | null; timestampUtc: string; objectClass?: string; analyticType?: string }>;
}

/**
 * Replays stored canonical events through a draft rule (P3.5). Read-only: nothing is written,
 * no action runs. It uses the engine's own matching code, so the preview cannot drift from what
 * the rule would do live. Limitation: it replays events that were stored (detections below the
 * worker's thresholds or outside motion-gated periods were never events), not recorded video.
 */
export class RulePreviewService {
  private engine: RuleEngine;
  constructor(private prisma: PrismaClient) {
    this.engine = new RuleEngine(prisma);
  }

  async preview(
    tenantId: string,
    rule: { triggerType: RuleTriggerType; triggerConfig: Record<string, unknown>; conditions: unknown[]; cooldownSeconds: number },
    from: Date,
    to: Date
  ): Promise<PreviewResult> {
    const rows = await this.prisma.canonicalEvent.findMany({
      where: { tenantId, type: RULE_TRIGGERS[rule.triggerType].eventKind, timestampUtc: { gte: from, lte: to } },
      orderBy: { timestampUtc: 'asc' },
      take: PREVIEW_MAX_EVENTS + 1,
    });
    const truncated = rows.length > PREVIEW_MAX_EVENTS;
    const scanned = rows.slice(0, PREVIEW_MAX_EVENTS);
    let triggerMatched = 0;
    let conditionsMatched = 0;
    let wouldFire = 0;
    let lastFire = -Infinity;
    const samples: PreviewResult['samples'] = [];
    for (const row of scanned) {
      const ev = eventFromRow(row);
      if (!RuleEngine.candidateTriggerTypes(ev.type, ev.payload).includes(rule.triggerType)) continue;
      if (!(await this.engine.matchesRule({ triggerConfigJson: rule.triggerConfig, conditionsJson: [] }, ev))) continue;
      triggerMatched++;
      if (!(await this.engine.matchesRule({ triggerConfigJson: rule.triggerConfig, conditionsJson: rule.conditions }, ev))) continue;
      conditionsMatched++;
      const t = row.timestampUtc.getTime();
      if (t - lastFire < rule.cooldownSeconds * 1000) continue;
      lastFire = t;
      wouldFire++;
      if (samples.length < 20) {
        const p: any = ev.payload;
        samples.push({
          eventId: row.id,
          type: row.type,
          cameraId: row.cameraId,
          timestampUtc: row.timestampUtc.toISOString(),
          ...(p?.objectClass ? { objectClass: p.objectClass } : {}),
          ...(p?.analyticType ? { analyticType: p.analyticType } : {}),
        });
      }
    }
    return { window: { from: from.toISOString(), to: to.toISOString() }, scanned: scanned.length, truncated, triggerMatched, conditionsMatched, wouldFire, samples };
  }
}
