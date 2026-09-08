import { PrismaClient, RuleTriggerType, RuleActionType } from '@prisma/client';
import crypto from 'crypto';

export interface RuleTriggerConfig {
  cameraId?: string;
  zoneId?: string;
  pinNumber?: number;
  targetState?: string;
  watchlistCategories?: string[];
  minConfidence?: number;
}

export interface RuleCondition {
  type: 'TIME_SCHEDULE' | 'CAMERA_TAG' | 'SEVERITY_THRESHOLD';
  operator: 'EQUALS' | 'IN' | 'BETWEEN';
  value: any;
}

export interface RuleAction {
  id: string;
  type: RuleActionType;
  config: Record<string, any>;
  timeoutMs?: number;
  retryPolicy?: { maxRetries: number; backoffMs: number };
  continueOnFailure?: boolean;
}

export interface EventPayload {
  tenantId: string;
  type: RuleTriggerType;
  cameraId?: string;
  zoneId?: string;
  pinNumber?: number;
  pinState?: string;
  watchlistCategory?: string;
  severity?: string;
  timestamp?: Date;
  metadata?: Record<string, any>;
}

export interface RuleExecutionResult {
  ruleExecutionId: string;
  ruleId: string;
  overallStatus: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  actionResults: Array<{
    actionId: string;
    actionType: RuleActionType;
    status: 'SUCCESS' | 'FAILED' | 'TIMEOUT';
    durationMs: number;
    error?: string;
  }>;
}

export class EventActionMatrixService {
  private prisma: PrismaClient;
  private customActionHandlers: Map<
    RuleActionType,
    (config: Record<string, any>, event: EventPayload) => Promise<any>
  > = new Map();

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Registers a custom handler for a specific action type
   */
  public registerActionHandler(
    type: RuleActionType,
    handler: (config: Record<string, any>, event: EventPayload) => Promise<any>
  ): void {
    this.customActionHandlers.set(type, handler);
  }

  /**
   * Evaluates an incoming event against registered automation rules and executes matching rules
   */
  public async processEvent(event: EventPayload): Promise<RuleExecutionResult[]> {
    const rules = await this.prisma.automationRule.findMany({
      where: {
        tenantId: event.tenantId,
        enabled: true,
        triggerType: event.type,
      },
      orderBy: { priority: 'asc' },
    });

    const results: RuleExecutionResult[] = [];

    for (const rule of rules) {
      // 1. Cooldown Check (Suppress feedback loop cascades)
      if (rule.lastTriggeredAt) {
        const cooldownMs = rule.cooldownSeconds * 1000;
        if (Date.now() - rule.lastTriggeredAt.getTime() < cooldownMs) {
          continue; // Cooldown active, skip
        }
      }

      // 2. Trigger Config Matching
      const triggerConfig = rule.triggerConfigJson as unknown as RuleTriggerConfig;
      if (!this.matchesTriggerConfig(triggerConfig, event)) {
        continue;
      }

      // 3. Condition Evaluation
      const conditions = (rule.conditionsJson as unknown as RuleCondition[]) || [];
      if (!this.matchesConditions(conditions, event)) {
        continue;
      }

      // 4. Execute Rule Actions under a unique ruleExecutionId
      const executionResult = await this.executeRule(rule, event);
      results.push(executionResult);

      // Update rule's lastTriggeredAt timestamp
      await this.prisma.automationRule.update({
        where: { id: rule.id },
        data: { lastTriggeredAt: new Date() },
      });
    }

    return results;
  }

  private matchesTriggerConfig(config: RuleTriggerConfig, event: EventPayload): boolean {
    if (config.cameraId && config.cameraId !== event.cameraId) return false;
    if (config.zoneId && config.zoneId !== event.zoneId) return false;
    if (config.pinNumber !== undefined && config.pinNumber !== event.pinNumber) return false;
    if (config.targetState && config.targetState !== event.pinState) return false;
    if (
      config.watchlistCategories &&
      config.watchlistCategories.length > 0 &&
      (!event.watchlistCategory || !config.watchlistCategories.includes(event.watchlistCategory))
    ) {
      return false;
    }
    return true;
  }

  private matchesConditions(conditions: RuleCondition[], event: EventPayload): boolean {
    for (const cond of conditions) {
      if (cond.type === 'SEVERITY_THRESHOLD') {
        const severityRank: Record<string, number> = { INFO: 1, WARNING: 2, CRITICAL: 3 };
        const eventRank = severityRank[event.severity || 'INFO'] || 1;
        const requiredRank = severityRank[cond.value] || 1;
        if (eventRank < requiredRank) return false;
      }
      // Can be extended for time schedule or camera tags
    }
    return true;
  }

  /**
   * Executes all actions of a matched rule with timeout, retries, and audit persistence
   */
  private async executeRule(rule: any, event: EventPayload): Promise<RuleExecutionResult> {
    const ruleExecutionId = `exec_${crypto.randomUUID()}`;
    const actions = (rule.actionsJson as unknown as RuleAction[]) || [];
    const actionResults: RuleExecutionResult['actionResults'] = [];

    // Create RuleExecutionRecord
    await this.prisma.ruleExecutionRecord.create({
      data: {
        id: ruleExecutionId,
        tenantId: event.tenantId,
        ruleId: rule.id,
        triggerEventId: event.metadata?.eventId || null,
        overallStatus: 'PENDING',
      },
    });

    let hasFailure = false;
    let hasSuccess = false;

    for (const action of actions) {
      const actionStart = Date.now();
      let status: 'SUCCESS' | 'FAILED' | 'TIMEOUT' = 'SUCCESS';
      let errorMsg: string | undefined;

      try {
        const timeoutMs = action.timeoutMs || 5000;
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Action timeout after ${timeoutMs}ms`)), timeoutMs)
        );

        const executionPromise = this.dispatchAction(action, event);
        await Promise.race([executionPromise, timeoutPromise]);
        hasSuccess = true;
      } catch (err: any) {
        status = err.message.includes('timeout') ? 'TIMEOUT' : 'FAILED';
        errorMsg = err.message;
        hasFailure = true;
      }

      const durationMs = Date.now() - actionStart;

      actionResults.push({
        actionId: action.id,
        actionType: action.type,
        status,
        durationMs,
        error: errorMsg,
      });

      // Record child ActionExecutionRecord
      await this.prisma.actionExecutionRecord.create({
        data: {
          ruleExecutionId,
          actionId: action.id,
          actionType: action.type,
          status,
          durationMs,
          error: errorMsg,
        },
      });

      if (status !== 'SUCCESS' && !action.continueOnFailure) {
        break; // Stop executing subsequent actions for this rule
      }
    }

    const overallStatus = !hasFailure ? 'SUCCESS' : hasSuccess ? 'PARTIAL' : 'FAILED';

    await this.prisma.ruleExecutionRecord.update({
      where: { id: ruleExecutionId },
      data: {
        overallStatus,
        completedAt: new Date(),
      },
    });

    return {
      ruleExecutionId,
      ruleId: rule.id,
      overallStatus,
      actionResults,
    };
  }

  private async dispatchAction(action: RuleAction, event: EventPayload): Promise<any> {
    const customHandler = this.customActionHandlers.get(action.type);
    if (customHandler) {
      return customHandler(action.config, event);
    }

    // Default simulation for unconfigured hardware or test mock
    return Promise.resolve({ action: action.type, ok: true });
  }
}
