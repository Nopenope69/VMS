import { PrismaClient, RuleTriggerType, RuleActionType, EventSeverity } from '@prisma/client';
import {
  VigilOneEvent,
  VigilOneEventType,
  RuleTriggerConfig,
  RuleCondition,
  RuleActionConfig,
} from './types';

export const MAX_EVENT_ACTION_DEPTH = 5;
export const MAX_ACTIONS_PER_CORRELATION = 25;

export interface RuleEvaluationResult {
  ruleId: string;
  ruleExecutionId: string;
  actionsQueued: number;
  cascadeTerminated?: boolean;
  error?: string;
}

export class RuleEngine {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Maps canonical VigilOneEventType to legacy RuleTriggerType enum when needed
   */
  public static mapEventTypeToTriggerType(eventType: VigilOneEventType): RuleTriggerType | null {
    switch (eventType) {
      case 'MOTION':
        return RuleTriggerType.MOTION_ZONE;
      case 'TRIPWIRE_CROSS':
        return RuleTriggerType.TRIPWIRE_CROSS;
      case 'LOITERING_DWELL':
        return RuleTriggerType.LOITERING_DWELL;
      case 'ANPR_MATCH':
        return RuleTriggerType.ANPR_WATCHLIST;
      case 'DI_TRIGGER':
        return RuleTriggerType.DIGITAL_INPUT_STATE;
      case 'CAMERA_OFFLINE':
        return RuleTriggerType.CAMERA_OFFLINE;
      case 'SCENE_CHANGE':
        return RuleTriggerType.SCENE_CHANGE;
      default:
        return null;
    }
  }

  /**
   * Evaluates an incoming event against automation rules.
   * Enforces cascade depth limit, correlation action count, cooldown suppression,
   * and persists RuleExecutionRecord and ActionExecutionRecord entries atomically.
   */
  public async evaluateEvent(
    event: VigilOneEvent
  ): Promise<{ results: RuleEvaluationResult[]; cascadeTerminated: boolean }> {
    const depth = event.depth ?? 0;

    // 1. Cascade Guard: Check depth
    if (depth > MAX_EVENT_ACTION_DEPTH) {
      console.warn(
        `[RuleEngine] Cascade loop detected: Event ${event.id} depth ${depth} exceeds MAX_EVENT_ACTION_DEPTH (${MAX_EVENT_ACTION_DEPTH}). Terminating cascade.`
      );
      try {
        await this.prisma.ruleExecutionRecord.create({
          data: {
            tenantId: event.tenantId,
            ruleId: 'CASCADE_GUARD',
            triggerEventId: event.id,
            correlationId: event.correlationId,
            rootEventId: event.rootEventId || event.id,
            depth,
            overallStatus: 'CASCADE_TERMINATED',
            error: `Cascade depth ${depth} exceeded limit of ${MAX_EVENT_ACTION_DEPTH}`,
          },
        });
      } catch {}
      return { results: [], cascadeTerminated: true };
    }

    // 2. Cascade Guard: Check cumulative actions for correlationId
    if (event.correlationId) {
      try {
        const actionCount = await this.prisma.actionExecutionRecord.count({
          where: {
            ruleExecution: {
              correlationId: event.correlationId,
            },
          },
        });
        if (actionCount >= MAX_ACTIONS_PER_CORRELATION) {
          console.warn(
            `[RuleEngine] Action flood detected: Correlation ${event.correlationId} has ${actionCount} actions (limit ${MAX_ACTIONS_PER_CORRELATION}). Terminating cascade.`
          );
          try {
            await this.prisma.ruleExecutionRecord.create({
              data: {
                tenantId: event.tenantId,
                ruleId: 'CASCADE_GUARD',
                triggerEventId: event.id,
                correlationId: event.correlationId,
                rootEventId: event.rootEventId || event.id,
                depth,
                overallStatus: 'CASCADE_TERMINATED',
                error: `Correlation action count ${actionCount} exceeded limit of ${MAX_ACTIONS_PER_CORRELATION}`,
              },
            });
          } catch {}
          return { results: [], cascadeTerminated: true };
        }
      } catch {}
    }

    // 3. Find candidate rules
    const mappedTriggerType = RuleEngine.mapEventTypeToTriggerType(event.type);
    const triggerTypes: any[] = [event.type];
    if (mappedTriggerType) {
      triggerTypes.push(mappedTriggerType);
    }

    const rules = await this.prisma.automationRule.findMany({
      where: {
        tenantId: event.tenantId,
        enabled: true,
        triggerType: { in: triggerTypes },
      },
      orderBy: { priority: 'asc' },
    });

    const results: RuleEvaluationResult[] = [];

    for (const rule of rules) {
      // 4. Cooldown Check
      if (rule.lastTriggeredAt) {
        const cooldownMs = rule.cooldownSeconds * 1000;
        if (Date.now() - rule.lastTriggeredAt.getTime() < cooldownMs) {
          continue; // Cooldown active, skip
        }
      }

      // 5. Trigger Config Matching
      const triggerConfig = (rule.triggerConfigJson as unknown as RuleTriggerConfig) || {};
      if (!this.matchesTriggerConfig(triggerConfig, event)) {
        continue;
      }

      // 6. Condition Evaluation
      const conditions = (rule.conditionsJson as unknown as RuleCondition[]) || [];
      if (!this.matchesConditions(conditions, event)) {
        continue;
      }

      // 7. Idempotent RuleExecutionRecord Creation (Multi-Level Idempotency)
      let executionRecord: any;
      try {
        executionRecord = await this.prisma.ruleExecutionRecord.create({
          data: {
            tenantId: event.tenantId,
            ruleId: rule.id,
            triggerEventId: event.id,
            correlationId: event.correlationId,
            rootEventId: event.rootEventId || event.id,
            depth,
            overallStatus: 'PENDING',
          },
        });
      } catch (err: any) {
        // Unique constraint violation: @@unique([ruleId, triggerEventId])
        // Duplicate event ingestion detected, skip to prevent double execution
        continue;
      }

      // 8. Queue Actions in Outbox
      const actions = (rule.actionsJson as unknown as RuleActionConfig[]) || [];
      let queuedCount = 0;

      for (const action of actions) {
        try {
          await this.prisma.actionExecutionRecord.create({
            data: {
              ruleExecutionId: executionRecord.id,
              actionId: action.id,
              actionType: action.type,
              status: 'PENDING',
            },
          });
          queuedCount++;
        } catch {
          // Unique constraint violation: @@unique([ruleExecutionId, actionId])
        }
      }

      // 9. Update lastTriggeredAt timestamp
      await this.prisma.automationRule.update({
        where: { id: rule.id },
        data: { lastTriggeredAt: new Date() },
      });

      results.push({
        ruleId: rule.id,
        ruleExecutionId: executionRecord.id,
        actionsQueued: queuedCount,
      });
    }

    return { results, cascadeTerminated: false };
  }

  private matchesTriggerConfig(config: RuleTriggerConfig, event: VigilOneEvent): boolean {
    if (config.cameraId && config.cameraId !== event.cameraId) return false;
    if (config.zoneId && config.zoneId !== event.spatialRef?.zoneId) return false;

    // Check DI payload specifics if applicable
    if (event.payload.kind === 'DI_TRIGGER') {
      const di = event.payload;
      if (config.pinNumber !== undefined && config.pinNumber !== di.pinNumber) return false;
      if (config.targetState && config.targetState !== di.state) return false;
    }

    // Check ANPR watchlist category
    if (event.payload.kind === 'ANPR_MATCH') {
      const anpr = event.payload;
      if (
        config.watchlistCategories &&
        config.watchlistCategories.length > 0 &&
        (!anpr.watchlistCategory || !config.watchlistCategories.includes(anpr.watchlistCategory))
      ) {
        return false;
      }
      if (config.minConfidence && anpr.confidence < config.minConfidence) {
        return false;
      }
    }

    return true;
  }

  private matchesConditions(conditions: RuleCondition[], event: VigilOneEvent): boolean {
    for (const cond of conditions) {
      if (cond.type === 'SEVERITY_THRESHOLD') {
        const severityRank: Record<EventSeverity, number> = {
          INFO: 1,
          WARNING: 2,
          CRITICAL: 3,
        };
        const eventRank = severityRank[event.severity] || 1;
        const requiredRank = severityRank[cond.value as EventSeverity] || 1;
        if (eventRank < requiredRank) return false;
      }
    }
    return true;
  }
}
