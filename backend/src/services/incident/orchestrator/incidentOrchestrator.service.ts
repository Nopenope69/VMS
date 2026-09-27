import prisma from '../../../config/database';
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

  private inboxTimer: NodeJS.Timeout | null = null;

  public start(): void {
    this.actionOutbox.start();
    if (!this.inboxTimer) {
      this.inboxTimer = setInterval(() => {
        this.redriveInbox().catch((err) => console.error('[IncidentOrchestrator] inbox re-drive failed:', err));
      }, 10000);
    }
  }

  public stop(): void {
    this.actionOutbox.stop();
    if (this.inboxTimer) {
      clearInterval(this.inboxTimer);
      this.inboxTimer = null;
    }
  }

  /**
   * Transactional inbox: every canonical event is persisted before rules run (idempotent on the
   * event id). Returns 'processed' when this id was already fully handled.
   */
  private async recordCanonicalEvent(event: VigilOneEvent): Promise<'new' | 'pending' | 'processed'> {
    try {
      await this.prisma.canonicalEvent.create({ data: canonicalRow(event) });
      return 'new';
    } catch (err: any) {
      if (err?.code !== 'P2002') throw err;
      const existing = await this.prisma.canonicalEvent.findUnique({ where: { id: event.id }, select: { processedAt: true } });
      return existing?.processedAt ? 'processed' : 'pending';
    }
  }

  /**
   * Crash recovery: events persisted but never marked processed (process died between the insert
   * and rule evaluation) are evaluated again. Rule and action idempotency keys prevent doubles.
   */
  public async redriveInbox(olderThanMs = 5000, batch = 50): Promise<number> {
    const rows = await this.prisma.canonicalEvent.findMany({
      where: { processedAt: null, createdAt: { lt: new Date(Date.now() - olderThanMs) } },
      orderBy: { createdAt: 'asc' },
      take: batch,
    });
    for (const r of rows) {
      await this.ingestEvent(eventFromRow(r));
    }
    return rows.length;
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

    // 0. Persist the canonical event (transactional inbox); a fully processed duplicate stops here.
    const inbox = await this.recordCanonicalEvent(event);
    if (inbox === 'processed') {
      return {
        eventId: event.id,
        correlationId: event.correlationId,
        rulesEvaluated: 0,
        rulesTriggered: 0,
        actionsQueued: 0,
        ruleExecutionIds: [],
        duplicate: true,
      };
    }

    // 1. Evaluate event against automation rules with cascade depth guard
    const { results, cascadeTerminated } = await this.ruleEngine.evaluateEvent(event);

    if (cascadeTerminated) {
      await this.markProcessed(event.id);
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
          canonicalEventId: event.id,
          title: event.title || `Critical System Alarm: ${event.type}`,
          description: event.description || `Automatic alarm generated for critical ${event.type} event`,
          severity: EventSeverity.CRITICAL,
          metadataJson: { eventType: event.type, payload: event.payload, provenance: event.provenance ?? null } as any,
        },
        context
      );
      alarmCreated = true;
      alarmId = alarm.id;
    }

    // 3. Drain pending actions in the outbox
    const totalQueued = results.reduce((sum, r) => sum + r.actionsQueued, 0);
    // Rules evaluated and actions durably queued: the event is processed. Actions run from the outbox.
    await this.markProcessed(event.id);
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

  private async markProcessed(eventId: string): Promise<void> {
    await this.prisma.canonicalEvent.update({ where: { id: eventId }, data: { processedAt: new Date() } });
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
      canonicalEventId?: string;
      automationRuleId?: string;
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

export const incidentOrchestrator = new IncidentOrchestrator(prisma);
export default incidentOrchestrator;

/** Row persisted in CanonicalEvent for an orchestrator event (transactional inbox). */
export function canonicalRow(event: VigilOneEvent) {
  return {
    id: event.id,
    tenantId: event.tenantId,
    cameraId: event.cameraId ?? null,
    type: event.type,
    source: event.source,
    severity: event.severity,
    timestampUtc: event.timestampUtc instanceof Date ? event.timestampUtc : new Date(event.timestampUtc),
    correlationId: event.correlationId,
    trackId: event.trackId ?? null,
    payloadJson: {
      payload: event.payload,
      title: event.title ?? null,
      description: event.description ?? null,
      rootEventId: event.rootEventId ?? null,
      depth: event.depth ?? 0,
      spatialRef: event.spatialRef ?? null,
      evidenceRef: event.evidenceRef ?? null,
    } as any,
    provenanceJson: (event.provenance as any) ?? undefined,
  };
}

function eventFromRow(r: any): VigilOneEvent {
  const p = r.payloadJson || {};
  return {
    id: r.id,
    tenantId: r.tenantId,
    cameraId: r.cameraId ?? undefined,
    source: r.source,
    type: r.type,
    timestampUtc: r.timestampUtc,
    severity: r.severity,
    correlationId: r.correlationId,
    rootEventId: p.rootEventId ?? undefined,
    depth: p.depth ?? 0,
    trackId: r.trackId ?? undefined,
    spatialRef: p.spatialRef ?? undefined,
    evidenceRef: p.evidenceRef ?? undefined,
    title: p.title ?? undefined,
    description: p.description ?? undefined,
    payload: p.payload,
    provenance: r.provenanceJson ?? undefined,
  };
}
