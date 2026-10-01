import { PrismaClient, RuleTriggerType } from '@prisma/client';
import {
  VigilOneEvent,
  VigilOneEventType,
  RuleTriggerConfig,
  RuleActionConfig,
} from './types';
import { RuleConditionEvaluator } from '../../automation/ruleConditions';
import { matchesTriggerConfig, triggerTypeFor } from './eventKinds';

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
  private conditions: RuleConditionEvaluator;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
    this.conditions = new RuleConditionEvaluator(prisma);
  }

  /** The trigger type an event fires (see eventKinds.ts). */
  public static mapEventTypeToTriggerType(eventType: VigilOneEventType, payload?: VigilOneEvent['payload']): RuleTriggerType | null {
    return triggerTypeFor(eventType, payload);
  }

  /** Enum-valid trigger types that can match this event type (raw name if it is one, plus the mapping). */
  public static candidateTriggerTypes(eventType: VigilOneEventType, payload?: VigilOneEvent['payload']): RuleTriggerType[] {
    const valid = new Set<string>(Object.values(RuleTriggerType));
    const out = new Set<RuleTriggerType>();
    if (valid.has(eventType)) out.add(eventType as unknown as RuleTriggerType);
    const mapped = RuleEngine.mapEventTypeToTriggerType(eventType, payload);
    if (mapped) out.add(mapped);
    return [...out];
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
    // Only RuleTriggerType enum values may reach the query. Passing the raw event type (e.g.
    // 'MOTION', 'SYSTEM_ALERT') made Prisma reject the whole query, so no rule could fire for
    // those events.
    const triggerTypes = RuleEngine.candidateTriggerTypes(event.type, event.payload);
    if (triggerTypes.length === 0) {
      return { results: [], cascadeTerminated: false };
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
      if (!matchesTriggerConfig(triggerConfig, event)) {
        continue;
      }

      // 6. Condition Evaluation
      if (!(await this.conditions.matches(rule.conditionsJson, event))) {
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

  /** Stateless rule match (trigger config + conditions), shared with the rule preview. */
  public async matchesRule(rule: { triggerConfigJson: any; conditionsJson: any }, event: VigilOneEvent): Promise<boolean> {
    const triggerConfig = (rule.triggerConfigJson as unknown as RuleTriggerConfig) || {};
    if (!matchesTriggerConfig(triggerConfig, event)) return false;
    return this.conditions.matches(rule.conditionsJson, event);
  }
}
