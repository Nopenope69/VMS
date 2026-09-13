import { PrismaClient, RuleActionType, RelayCommandState } from '@prisma/client';
import { RelayAdapter } from './adapters/relayAdapter';
import { NotificationAdapter } from './adapters/notificationAdapter';
import { PtzAdapter } from './adapters/ptzAdapter';
import { BookmarkAdapter } from './adapters/bookmarkAdapter';
import { AlarmLifecycle } from './alarmLifecycle';
import { RuleActionConfig } from './types';

export class ActionOutbox {
  private prisma: PrismaClient;
  private relayAdapter: RelayAdapter;
  private notificationAdapter: NotificationAdapter;
  private ptzAdapter: PtzAdapter;
  private bookmarkAdapter: BookmarkAdapter;
  private alarmLifecycle: AlarmLifecycle;

  private isRunning: boolean = false;
  private workerTimer: NodeJS.Timeout | null = null;
  private customHandlers: Map<RuleActionType, (config: Record<string, any>, context: any) => Promise<any>> =
    new Map();

  constructor(
    prisma: PrismaClient,
    deps: {
      relayAdapter: RelayAdapter;
      notificationAdapter: NotificationAdapter;
      ptzAdapter: PtzAdapter;
      bookmarkAdapter: BookmarkAdapter;
      alarmLifecycle: AlarmLifecycle;
    }
  ) {
    this.prisma = prisma;
    this.relayAdapter = deps.relayAdapter;
    this.notificationAdapter = deps.notificationAdapter;
    this.ptzAdapter = deps.ptzAdapter;
    this.bookmarkAdapter = deps.bookmarkAdapter;
    this.alarmLifecycle = deps.alarmLifecycle;
  }

  public registerCustomHandler(
    type: RuleActionType,
    handler: (config: Record<string, any>, context: any) => Promise<any>
  ): void {
    this.customHandlers.set(type, handler);
  }

  public start(pollIntervalMs = 2000): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.workerTimer = setInterval(() => {
      this.drainOutbox().catch((err) =>
        console.error('[ActionOutbox] Worker cycle error:', err)
      );
    }, pollIntervalMs);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.workerTimer) {
      clearInterval(this.workerTimer);
      this.workerTimer = null;
    }
  }

  /**
   * Claims and processes pending actions from the persistent outbox table.
   * Resumes cleanly across restarts.
   */
  public async drainOutbox(batchSize = 25): Promise<number> {
    const pendingActions = await this.prisma.actionExecutionRecord.findMany({
      where: { status: 'PENDING' },
      include: {
        ruleExecution: {
          include: {
            rule: true,
          },
        },
      },
      take: batchSize,
      orderBy: { startedAt: 'asc' },
    });

    if (pendingActions.length === 0) {
      return 0;
    }

    let processedCount = 0;

    for (const actionRecord of pendingActions) {
      // Optimistic claim
      const updated = await this.prisma.actionExecutionRecord.updateMany({
        where: { id: actionRecord.id, status: 'PENDING' },
        data: {
          status: 'PROCESSING',
          startedAt: new Date(),
          attempt: actionRecord.attempt + 1,
        },
      });

      if (updated.count === 0) {
        // Claimed by another worker
        continue;
      }

      const start = Date.now();
      let status: 'SUCCESS' | 'FAILED' | 'TIMEOUT' = 'SUCCESS';
      let resultJson: any = null;
      let errorMsg: string | undefined;

      try {
        const rule = actionRecord.ruleExecution?.rule;
        const actionsConfig = (rule?.actionsJson as unknown as RuleActionConfig[]) || [];
        const actionConfig =
          actionsConfig.find((a) => a.id === actionRecord.actionId) || {
            id: actionRecord.actionId,
            type: actionRecord.actionType,
            config: {},
          };

        const context = {
          tenantId: actionRecord.ruleExecution.tenantId,
          ruleExecutionId: actionRecord.ruleExecutionId,
          correlationId: actionRecord.ruleExecution.correlationId,
          triggerEventId: actionRecord.ruleExecution.triggerEventId,
        };

        resultJson = await this.dispatchAction(actionConfig, context);
      } catch (err: any) {
        status = err.message?.includes('timeout') ? 'TIMEOUT' : 'FAILED';
        errorMsg = err.message || 'Execution failure';
      }

      const durationMs = Date.now() - start;

      // Update action record with result
      await this.prisma.actionExecutionRecord.update({
        where: { id: actionRecord.id },
        data: {
          status,
          durationMs,
          resultJson: resultJson || undefined,
          error: errorMsg,
          completedAt: new Date(),
        },
      });

      // Update parent RuleExecutionRecord status
      await this.reconcileRuleExecution(actionRecord.ruleExecutionId);
      processedCount++;
    }

    return processedCount;
  }

  private async dispatchAction(actionConfig: RuleActionConfig, context: any): Promise<any> {
    const custom = this.customHandlers.get(actionConfig.type);
    if (custom) {
      return custom(actionConfig.config, context);
    }

    switch (actionConfig.type) {
      case RuleActionType.FIRE_DO_RELAY: {
        const pinNumber = Number(actionConfig.config.pinNumber);
        const command = actionConfig.config.command || 'SET_HIGH';
        const pulseDurationMs = actionConfig.config.durationMs || actionConfig.config.pulseDurationMs;

        const relayResult = await this.relayAdapter.execute({
          tenantId: context.tenantId,
          pinNumber,
          command,
          pulseDurationMs,
          issuedBy: context.correlationId || 'AutomatedRule',
        });

        if (relayResult.lifecycleState === RelayCommandState.COMMAND_FAILED) {
          throw new Error(relayResult.error || `Relay pin ${pinNumber} command execution failed`);
        }
        return relayResult;
      }

      case RuleActionType.DISPATCH_NOTIFICATION: {
        return await this.notificationAdapter.enqueueAlarmNotifications({
          tenantId: context.tenantId,
          alarmId: actionConfig.config.alarmId || context.triggerEventId || 'alarm_auto',
          title: actionConfig.config.title || 'Automated Notification',
          description: actionConfig.config.description,
          severity: actionConfig.config.severity || 'WARNING',
          cameraName: actionConfig.config.cameraName,
        });
      }

      case RuleActionType.TRIGGER_ALARM: {
        return await this.alarmLifecycle.elevateAlarm(
          {
            tenantId: context.tenantId,
            cameraId: actionConfig.config.cameraId,
            eventId: context.triggerEventId,
            ruleId: actionConfig.id,
            title: actionConfig.config.title || 'Rule Triggered Alarm',
            description: actionConfig.config.description,
            severity: actionConfig.config.severity,
          },
          { tenantId: context.tenantId, correlationId: context.correlationId }
        );
      }

      case RuleActionType.PTZ_PRESET_GOTO: {
        const ptzResult = await this.ptzAdapter.gotoPreset({
          tenantId: context.tenantId,
          cameraId: actionConfig.config.cameraId,
          presetToken: actionConfig.config.presetToken,
          presetName: actionConfig.config.presetName,
        });

        if (!ptzResult.success) {
          throw new Error(ptzResult.message || `PTZ goto preset failed for camera ${actionConfig.config.cameraId}`);
        }
        return ptzResult;
      }

      case RuleActionType.BOOKMARK_SEGMENT: {
        return await this.bookmarkAdapter.bookmark({
          tenantId: context.tenantId,
          cameraId: actionConfig.config.cameraId,
          segmentId: actionConfig.config.segmentId,
          timestamp: actionConfig.config.timestamp ? new Date(actionConfig.config.timestamp) : undefined,
          reason: actionConfig.config.reason,
        });
      }

      case RuleActionType.START_HIGH_RES_RECORDING: {
        throw new Error('FEATURE_DEFERRED_FOR_V1: Dynamic high-resolution stream profile switching is deferred for v1');
      }

      default:
        throw new Error(`UNSUPPORTED_ACTION_TYPE: Action type '${actionConfig.type}' is not supported or deferred for v1`);
    }
  }

  private async reconcileRuleExecution(ruleExecutionId: string): Promise<void> {
    const allActions = await this.prisma.actionExecutionRecord.findMany({
      where: { ruleExecutionId },
    });

    const hasPending = allActions.some((a) => a.status === 'PENDING' || a.status === 'PROCESSING');
    if (hasPending) {
      return; // Still in progress
    }

    const hasFailure = allActions.some((a) => a.status === 'FAILED' || a.status === 'TIMEOUT');
    const hasSuccess = allActions.some((a) => a.status === 'SUCCESS');

    const overallStatus = !hasFailure ? 'SUCCESS' : hasSuccess ? 'PARTIAL' : 'FAILED';

    await this.prisma.ruleExecutionRecord.update({
      where: { id: ruleExecutionId },
      data: {
        overallStatus,
        completedAt: new Date(),
      },
    });
  }
}
