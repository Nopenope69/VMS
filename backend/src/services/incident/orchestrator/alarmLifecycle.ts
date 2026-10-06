import { PrismaClient, Alarm, AlarmState, EventSeverity } from '@prisma/client';
import { assertTenantBoundary } from '../../rbac/permissions';
import { AuditChainService } from '../../audit/auditChain.service';
import { runExplanationHook } from '../../explanation/explanationHook';
import { CommandContext, AlarmFilter } from './types';
import { decideIncidentJoin } from './incidentWindow';

/** How many joined triggers an alarm remembers in its metadata (the count keeps growing past this). */
const MAX_REMEMBERED_CONTINUATIONS = 50;

export class AlarmLifecycle {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * AuditEvent.userId references User. The SYSTEM actor has no user row, so it is recorded in the
   * metadata, never as userId (a foreign-key violation aborts the whole transaction).
   */
  private static auditUserId(actorUserId?: string): string | null {
    return actorUserId || null;
  }

  private async executeTransaction<T>(action: (tx: any) => Promise<T>): Promise<T> {
    if (typeof (this.prisma as any).$transaction === 'function') {
      return await this.prisma.$transaction(action);
    }
    return await action(this.prisma);
  }

  public async getAlarm(alarmId: string, context: CommandContext): Promise<Alarm | null> {
    const alarm = await this.prisma.alarm.findUnique({
      where: { id: alarmId },
      include: {
        camera: { select: { id: true, name: true } },
        event: true,
      },
    });

    if (!alarm) {
      return null;
    }

    assertTenantBoundary(alarm.tenantId, context.tenantId);
    return alarm;
  }

  public async listAlarms(filter: AlarmFilter, context: CommandContext): Promise<Alarm[]> {
    return this.prisma.alarm.findMany({
      where: {
        tenantId: context.tenantId,
        ...(filter?.state ? { state: filter.state } : {}),
        ...(filter?.severity ? { severity: filter.severity } : {}),
        ...(filter?.cameraId ? { cameraId: filter.cameraId } : {}),
      },
      include: {
        camera: { select: { id: true, name: true } },
        event: true,
      },
      orderBy: { triggeredAt: 'desc' },
      take: filter?.limit ?? 100,
      skip: filter?.offset ?? 0,
    });
  }

  /**
   * Transitions alarm from ACTIVE -> ACKNOWLEDGED.
   * Atomically commits state change and audit event.
   */
  public async acknowledgeAlarm(alarmId: string, context: CommandContext): Promise<Alarm> {
    const existing = await this.prisma.alarm.findUnique({ where: { id: alarmId } });
    if (!existing) {
      const err: any = new Error('Alarm not found');
      err.statusCode = 404;
      throw err;
    }

    assertTenantBoundary(existing.tenantId, context.tenantId);

    if (existing.state === AlarmState.RESOLVED) {
      const err: any = new Error('Cannot acknowledge an already resolved alarm');
      err.statusCode = 400;
      throw err;
    }

    const acknowledgeTime = new Date();
    const userId = context.actorUserId || 'SYSTEM';

    return await this.executeTransaction(async (tx) => {
      const updated = await tx.alarm.update({
        where: { id: alarmId },
        data: {
          state: AlarmState.ACKNOWLEDGED,
          acknowledgedAt: acknowledgeTime,
          acknowledgedById: userId,
        },
      });

      // Alarm state and its audit entry commit together or not at all. A swallowed audit error
      // would leave Postgres with an aborted transaction whose COMMIT silently rolls back.
      await AuditChainService.record(tx, {
        tenantId: context.tenantId,
        userId: AlarmLifecycle.auditUserId(context.actorUserId),
        action: 'ALARM_ACKNOWLEDGE',
        resourceType: 'Alarm',
        resourceId: alarmId,
        ipAddress: context.clientIp || '127.0.0.1',
        userAgent: context.userAgent || null,
        metadata: {
          previousState: existing.state,
          newState: AlarmState.ACKNOWLEDGED,
          correlationId: context.correlationId,
          actor: context.actorUserId || 'SYSTEM',
        },
      });

      return updated;
    });
  }

  /**
   * Transitions alarm to RESOLVED.
   * Atomically commits state change, notes, and audit event.
   */
  public async resolveAlarm(alarmId: string, notes: string, context: CommandContext): Promise<Alarm> {
    const existing = await this.prisma.alarm.findUnique({ where: { id: alarmId } });
    if (!existing) {
      const err: any = new Error('Alarm not found');
      err.statusCode = 404;
      throw err;
    }

    assertTenantBoundary(existing.tenantId, context.tenantId);

    const resolveTime = new Date();
    const userId = context.actorUserId || 'SYSTEM';

    return await this.executeTransaction(async (tx) => {
      const updated = await tx.alarm.update({
        where: { id: alarmId },
        data: {
          state: AlarmState.RESOLVED,
          resolvedAt: resolveTime,
          resolvedById: userId,
          resolutionNotes: notes,
        },
      });

      await AuditChainService.record(tx, {
        tenantId: context.tenantId,
        userId: AlarmLifecycle.auditUserId(context.actorUserId),
        action: 'ALARM_RESOLVE',
        resourceType: 'Alarm',
        resourceId: alarmId,
        ipAddress: context.clientIp || '127.0.0.1',
        userAgent: context.userAgent || null,
        metadata: {
          previousState: existing.state,
          newState: AlarmState.RESOLVED,
          notes,
          correlationId: context.correlationId,
          actor: context.actorUserId || 'SYSTEM',
        },
      });

      return updated;
    });
  }

  /**
   * Explicit programmatic elevation of an event or trigger to an operational Alarm.
   */
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
      /** ADR 0014: join an open alarm of the same rule and camera while activity continues. 0 or unset: always raise a new alarm. */
      incidentWindowSeconds?: number;
    },
    context?: CommandContext
  ): Promise<Alarm> {
    const tenantId = context?.tenantId || data.tenantId;

    const joined = await this.joinOpenIncident(data, tenantId, context);
    if (joined) return joined;

    const alarm = await this.executeTransaction(async (tx) => {
      const alarm = await tx.alarm.create({
        data: {
          tenantId,
          cameraId: data.cameraId,
          eventId: data.eventId,
          ruleId: data.ruleId,
          canonicalEventId: data.canonicalEventId,
          automationRuleId: data.automationRuleId,
          title: data.title,
          description: data.description,
          severity: data.severity || EventSeverity.WARNING,
          state: AlarmState.ACTIVE,
          metadataJson: data.metadataJson || undefined,
          lastActivityAt: data.incidentWindowSeconds ? new Date() : undefined,
          lastCanonicalEventId: data.incidentWindowSeconds ? data.canonicalEventId : undefined,
        },
      });

      await AuditChainService.record(tx, {
        tenantId,
        userId: AlarmLifecycle.auditUserId(context?.actorUserId),
        action: 'ALARM_CREATE',
        resourceType: 'Alarm',
        resourceId: alarm.id,
        ipAddress: context?.clientIp || '127.0.0.1',
        userAgent: context?.userAgent || null,
        metadata: {
          title: data.title,
          severity: data.severity || EventSeverity.WARNING,
          eventId: data.eventId,
          ruleId: data.ruleId,
          canonicalEventId: data.canonicalEventId,
          automationRuleId: data.automationRuleId,
          correlationId: context?.correlationId,
          actor: context?.actorUserId || 'SYSTEM',
        },
      });

      return alarm;
    });

    // After the commit, so a failure here can never undo or delay the alarm. The hook does not
    // throw; it audits and logs its own failures (feature flag EXPLANATIONS, default OFF).
    await runExplanationHook(this.prisma, alarm);
    return alarm;
  }
  /**
   * ADR 0014. When the rule asked for an incident window and an open alarm of the same rule and camera is still
   * inside it, the trigger joins that alarm: the count and last-activity time move, a more severe trigger raises
   * the severity (never lowers it), and the join is audited. Returns null when a new alarm must be raised.
   */
  private async joinOpenIncident(
    data: { cameraId?: string; automationRuleId?: string; canonicalEventId?: string; severity?: EventSeverity; incidentWindowSeconds?: number },
    tenantId: string,
    context?: CommandContext
  ): Promise<Alarm | null> {
    if (!data.incidentWindowSeconds || !data.cameraId || !data.automationRuleId) return null;

    return this.executeTransaction(async (tx) => {
      const existing = await tx.alarm.findFirst({
        where: {
          tenantId,
          automationRuleId: data.automationRuleId,
          cameraId: data.cameraId,
          state: { in: [AlarmState.ACTIVE, AlarmState.ACKNOWLEDGED] },
        },
        orderBy: { triggeredAt: 'desc' },
      });
      const severity = data.severity || EventSeverity.WARNING;
      const now = new Date();
      const decision = decideIncidentJoin(existing, now, data.incidentWindowSeconds, severity);
      if (decision.action === 'CREATE' || !existing) return null;

      const meta = (existing.metadataJson as Record<string, any> | null) || {};
      const continuations = Array.isArray(meta.continuations) ? meta.continuations : [];
      continuations.push({ eventId: data.canonicalEventId ?? null, at: now.toISOString(), escalated: decision.escalate });

      const updated = await tx.alarm.update({
        where: { id: existing.id },
        data: {
          lastActivityAt: now,
          occurrenceCount: { increment: 1 },
          lastCanonicalEventId: data.canonicalEventId,
          ...(decision.escalate ? { severity } : {}),
          metadataJson: { ...meta, continuations: continuations.slice(-MAX_REMEMBERED_CONTINUATIONS) },
        },
      });

      await AuditChainService.record(tx, {
        tenantId,
        userId: AlarmLifecycle.auditUserId(context?.actorUserId),
        action: 'ALARM_CONTINUE',
        resourceType: 'Alarm',
        resourceId: existing.id,
        ipAddress: context?.clientIp || '127.0.0.1',
        userAgent: context?.userAgent || null,
        metadata: {
          canonicalEventId: data.canonicalEventId,
          occurrenceCount: updated.occurrenceCount,
          escalatedTo: decision.escalate ? severity : null,
          correlationId: context?.correlationId,
          actor: context?.actorUserId || 'SYSTEM',
        },
      });

      return updated;
    });
  }
}
