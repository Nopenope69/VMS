import { PrismaClient, Alarm, EventSeverity, RuleActionType } from '@prisma/client';
import { assertTenantBoundary } from '../../rbac/permissions';
import {
  VigilOneEvent,
  CommandContext,
  IngestResult,
  AlarmFilter,
} from './types';
import { RuleEngine } from './ruleEngine';
import { AlarmLifecycle } from './alarmLifecycle';
import { ActionOutbox } from './actionOutbox';
import { RelayAdapter, HardwareDriver, RelayExecuteParams, RelayExecuteResult } from './adapters/relayAdapter';
import { NotificationAdapter, DispatchNotificationRequest } from './adapters/notificationAdapter';
import { PtzAdapter } from './adapters/ptzAdapter';
import { BookmarkAdapter } from './adapters/bookmarkAdapter';

export class IncidentOrchestrator {
  private prisma: PrismaClient;
  private ruleEngine: RuleEngine;
  private alarmLifecycle: AlarmLifecycle;
  private actionOutbox: ActionOutbox;
  private relayAdapter: RelayAdapter;
  private notificationAdapter: NotificationAdapter;
  private ptzAdapter: PtzAdapter;
  private bookmarkAdapter: BookmarkAdapter;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
    this.ruleEngine = new RuleEngine(prisma);
    this.alarmLifecycle = new AlarmLifecycle(prisma);
    this.relayAdapter = new RelayAdapter(prisma);
    this.notificationAdapter = new NotificationAdapter(prisma);
    this.ptzAdapter = new PtzAdapter(prisma);
    this.bookmarkAdapter = new BookmarkAdapter(prisma);

    this.actionOutbox = new ActionOutbox(prisma, {
      relayAdapter: this.relayAdapter,
      notificationAdapter: this.notificationAdapter,
      ptzAdapter: this.ptzAdapter,
      bookmarkAdapter: this.bookmarkAdapter,
      alarmLifecycle: this.alarmLifecycle,
    });
  }

  public start(): void {
    this.actionOutbox.start();
  }

  public stop(): void {
    this.actionOutbox.stop();
  }

  public setHardwareDriver(driver: HardwareDriver): void {
    this.relayAdapter.setHardwareDriver(driver);
  }

  public registerCustomActionHandler(
    type: RuleActionType,
    handler: (config: Record<string, any>, context: any) => Promise<any>
  ): void {
    this.actionOutbox.registerCustomHandler(type, handler);
  }

  /**
   * Authoritative canonical event ingestion pipeline.
   * Evaluates automation rules, guards cascade depth, commits outbox records,
   * and dispatches actions.
   */
  public async ingestEvent(
    event: VigilOneEvent,
    context?: CommandContext
  ): Promise<IngestResult> {
    if (context?.tenantId) {
      assertTenantBoundary(event.tenantId, context.tenantId);
    }

    // 1. Evaluate event against automation rules with cascade depth guard
    const { results, cascadeTerminated } = await this.ruleEngine.evaluateEvent(event);

    if (cascadeTerminated) {
      return {
        eventId: event.id,
        correlationId: event.correlationId,
        rulesEvaluated: 0,
        rulesTriggered: 0,
        actionsQueued: 0,
        ruleExecutionIds: [],
        cascadeTerminated: true,
      };
    }

    let alarmCreated = false;
    let alarmId: string | undefined;

    // 2. Built-in System Rule: Automatic elevation of CRITICAL events
    const hasAlarmAction = results.some((r) => r.actionsQueued > 0);
    if (!hasAlarmAction && event.severity === EventSeverity.CRITICAL) {
      const alarm = await this.alarmLifecycle.elevateAlarm(
        {
          tenantId: event.tenantId,
          cameraId: event.cameraId,
          eventId: event.id,
          title: event.title || `Critical System Alarm: ${event.type}`,
          description: event.description || `Automatic alarm generated for critical ${event.type} event`,
          severity: EventSeverity.CRITICAL,
          metadataJson: event.payload as any,
        },
        context
      );
      alarmCreated = true;
      alarmId = alarm.id;
    }

    // 3. Drain pending actions in the outbox
    const totalQueued = results.reduce((sum, r) => sum + r.actionsQueued, 0);
    if (totalQueued > 0) {
      await this.actionOutbox.drainOutbox();
    }

    return {
      eventId: event.id,
      correlationId: event.correlationId,
      rulesEvaluated: results.length,
      rulesTriggered: results.filter((r) => r.actionsQueued > 0).length,
      actionsQueued: totalQueued,
      ruleExecutionIds: results.map((r) => r.ruleExecutionId),
      cascadeTerminated: false,
      alarmCreated,
      alarmId,
    };
  }

  // --- Alarm Lifecycle Public API ---

  public async getAlarm(alarmId: string, context: CommandContext): Promise<Alarm | null> {
    return this.alarmLifecycle.getAlarm(alarmId, context);
  }

  public async listAlarms(filter: AlarmFilter, context: CommandContext): Promise<Alarm[]> {
    return this.alarmLifecycle.listAlarms(filter, context);
  }

  public async acknowledgeAlarm(alarmId: string, context: CommandContext): Promise<Alarm> {
    return this.alarmLifecycle.acknowledgeAlarm(alarmId, context);
  }

  public async resolveAlarm(alarmId: string, notes: string, context: CommandContext): Promise<Alarm> {
    return this.alarmLifecycle.resolveAlarm(alarmId, notes, context);
  }

  public async elevateAlarm(
    data: {
      tenantId: string;
      cameraId?: string;
      eventId?: string;
      ruleId?: string;
      title: string;
      description?: string;
      severity?: EventSeverity;
      metadataJson?: any;
    },
    context?: CommandContext
  ): Promise<Alarm> {
    return this.alarmLifecycle.elevateAlarm(data, context);
  }

  // --- Outbox Management ---

  public async drainOutbox(batchSize?: number): Promise<number> {
    return this.actionOutbox.drainOutbox(batchSize);
  }

  // --- Hardware & Notification Direct Adapters (For compatibility shims) ---

  public async executeRelayCommand(params: RelayExecuteParams): Promise<RelayExecuteResult> {
    return this.relayAdapter.execute(params);
  }

  public async enqueueNotifications(req: DispatchNotificationRequest): Promise<number> {
    return this.notificationAdapter.enqueueAlarmNotifications(req);
  }
}

export const incidentOrchestrator = new IncidentOrchestrator(new PrismaClient());
export default incidentOrchestrator;
