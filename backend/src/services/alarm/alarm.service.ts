import { PrismaClient, Alarm, AlarmState, Event, EventSeverity } from '@prisma/client';
import { assertTenantBoundary } from '../rbac/permissions';

export class AlarmService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async listAlarms(
    tenantId: string,
    filter?: {
      state?: AlarmState;
      severity?: EventSeverity;
      cameraId?: string;
    }
  ): Promise<Alarm[]> {
    return this.prisma.alarm.findMany({
      where: {
        tenantId,
        ...(filter?.state ? { state: filter.state } : {}),
        ...(filter?.severity ? { severity: filter.severity } : {}),
        ...(filter?.cameraId ? { cameraId: filter.cameraId } : {}),
      },
      include: {
        camera: { select: { id: true, name: true } },
        event: true,
      },
      orderBy: { triggeredAt: 'desc' },
      take: 100,
    });
  }

  async acknowledgeAlarm(alarmId: string, tenantId: string, userId: string): Promise<Alarm> {
    const alarm = await this.prisma.alarm.findUnique({ where: { id: alarmId } });
    if (!alarm) {
      const err: any = new Error('Alarm not found');
      err.statusCode = 404;
      throw err;
    }
    assertTenantBoundary(alarm.tenantId, tenantId);

    if (alarm.state === AlarmState.RESOLVED) {
      const err: any = new Error('Cannot acknowledge an already resolved alarm');
      err.statusCode = 400;
      throw err;
    }

    return this.prisma.alarm.update({
      where: { id: alarmId },
      data: {
        state: AlarmState.ACKNOWLEDGED,
        acknowledgedAt: new Date(),
        acknowledgedById: userId,
      },
    });
  }

  async resolveAlarm(
    alarmId: string,
    tenantId: string,
    userId: string,
    notes: string
  ): Promise<Alarm> {
    const alarm = await this.prisma.alarm.findUnique({ where: { id: alarmId } });
    if (!alarm) {
      const err: any = new Error('Alarm not found');
      err.statusCode = 404;
      throw err;
    }
    assertTenantBoundary(alarm.tenantId, tenantId);

    return this.prisma.alarm.update({
      where: { id: alarmId },
      data: {
        state: AlarmState.RESOLVED,
        resolvedAt: new Date(),
        resolvedById: userId,
        resolutionNotes: notes,
      },
    });
  }

  /**
   * Processes a raw Event and evaluates if it triggers an operational Alarm.
   */
  async evaluateEventForAlarms(event: Event, tenantId: string): Promise<Alarm | null> {
    // Check if there is an active matching EventRule
    const matchingRule = await this.prisma.eventRule.findFirst({
      where: {
        tenantId,
        triggerType: event.type,
        enabled: true,
      },
    });

    // An alarm is raised if a rule matched OR if the event severity is WARNING / CRITICAL
    const shouldRaiseAlarm =
      Boolean(matchingRule) ||
      event.severity === EventSeverity.WARNING ||
      event.severity === EventSeverity.CRITICAL;

    if (!shouldRaiseAlarm) {
      return null;
    }

    return this.prisma.alarm.create({
      data: {
        tenantId,
        cameraId: event.cameraId,
        eventId: event.id,
        ruleId: matchingRule?.id,
        title: matchingRule ? `Rule Triggered: ${matchingRule.name}` : `Alarm: ${event.title}`,
        description: event.description,
        severity: event.severity,
        state: AlarmState.ACTIVE,
        metadataJson: (event.metadata as any) || undefined,
      },
    });
  }

  /**
   * Direct programmatic creation of an Alarm (e.g. from Watchlist, Watchdog).
   */
  async createAlarm(data: {
    tenantId: string;
    cameraId?: string;
    eventId?: string;
    ruleId?: string;
    title: string;
    description?: string;
    severity?: EventSeverity;
    metadataJson?: any;
  }): Promise<Alarm> {
    return this.prisma.alarm.create({
      data: {
        tenantId: data.tenantId,
        cameraId: data.cameraId,
        eventId: data.eventId,
        ruleId: data.ruleId,
        title: data.title,
        description: data.description,
        severity: data.severity || EventSeverity.WARNING,
        state: AlarmState.ACTIVE,
        metadataJson: data.metadataJson || undefined,
      },
    });
  }
}

export const alarmService = new AlarmService(new PrismaClient());
export default alarmService;
