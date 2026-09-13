import prisma from '../../config/database';
import { PrismaClient, Alarm, AlarmState, Event, EventSeverity } from '@prisma/client';
import { IncidentOrchestrator } from '../incident/orchestrator/incidentOrchestrator.service';

/**
 * @deprecated Use IncidentOrchestrator (backend/src/services/incident/orchestrator/) directly.
 * Compatibility shim delegating to authoritative IncidentOrchestrator facade.
 */
export class AlarmService {
  private prisma: PrismaClient;
  private orchestrator: IncidentOrchestrator;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
    this.orchestrator = new IncidentOrchestrator(prisma);
  }

  async listAlarms(
    tenantId: string,
    filter?: {
      state?: AlarmState;
      severity?: EventSeverity;
      cameraId?: string;
    }
  ): Promise<Alarm[]> {
    return this.orchestrator.listAlarms(filter || {}, { tenantId });
  }

  async acknowledgeAlarm(alarmId: string, tenantId: string, userId: string): Promise<Alarm> {
    return this.orchestrator.acknowledgeAlarm(alarmId, {
      tenantId,
      actorUserId: userId,
    });
  }

  async resolveAlarm(
    alarmId: string,
    tenantId: string,
    userId: string,
    notes: string
  ): Promise<Alarm> {
    return this.orchestrator.resolveAlarm(alarmId, notes, {
      tenantId,
      actorUserId: userId,
    });
  }

  /**
   * Processes a raw Event and evaluates if it triggers an operational Alarm.
   * Delegates to IncidentOrchestrator alarm elevation.
   */
  async evaluateEventForAlarms(event: Event, tenantId: string): Promise<Alarm | null> {
    // Check if there is an active matching legacy EventRule
    const matchingRule = await this.prisma.eventRule.findFirst({
      where: {
        tenantId,
        triggerType: event.type,
        enabled: true,
      },
    });

    const shouldRaiseAlarm =
      Boolean(matchingRule) ||
      event.severity === EventSeverity.WARNING ||
      event.severity === EventSeverity.CRITICAL;

    if (!shouldRaiseAlarm) {
      return null;
    }

    return this.orchestrator.elevateAlarm(
      {
        tenantId,
        cameraId: event.cameraId || undefined,
        eventId: event.id,
        ruleId: matchingRule?.id,
        title: matchingRule ? `Rule Triggered: ${matchingRule.name}` : `Alarm: ${event.title}`,
        description: event.description || undefined,
        severity: event.severity,
        metadataJson: (event.metadata as any) || undefined,
      },
      { tenantId }
    );
  }

  /**
   * Direct programmatic creation of an Alarm.
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
    return this.orchestrator.elevateAlarm(data, { tenantId: data.tenantId });
  }
}

export const alarmService = new AlarmService(prisma);
export default alarmService;
