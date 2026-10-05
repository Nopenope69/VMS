import { AlarmState, EventSeverity } from '@prisma/client';

/**
 * ADR 0014: one incident, one alarm. A later trigger of the same rule on the same camera joins the open alarm
 * while activity continues, and starts a new alarm after a quiet gap, after the operator resolved the alarm, or
 * when the incident has run for too long.
 */

/** One incident never grows past this, however long the activity lasts, so a long event cannot hide a new one. */
export const MAX_INCIDENT_SPAN_SECONDS = 3600;

const RANK: Record<EventSeverity, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };

export interface OpenAlarmView {
  state: AlarmState;
  severity: EventSeverity;
  triggeredAt: Date;
  lastActivityAt: Date | null;
}

export type IncidentDecision = { action: 'CREATE' } | { action: 'JOIN'; escalate: boolean };

export function decideIncidentJoin(
  existing: OpenAlarmView | null,
  now: Date,
  windowSeconds: number | undefined,
  newSeverity: EventSeverity
): IncidentDecision {
  if (!windowSeconds || windowSeconds <= 0 || !existing) return { action: 'CREATE' };
  if (existing.state === 'RESOLVED') return { action: 'CREATE' };

  const lastActivity = existing.lastActivityAt ?? existing.triggeredAt;
  const quietMs = now.getTime() - lastActivity.getTime();
  if (quietMs > windowSeconds * 1000) return { action: 'CREATE' };
  if (now.getTime() - existing.triggeredAt.getTime() > MAX_INCIDENT_SPAN_SECONDS * 1000) return { action: 'CREATE' };

  return { action: 'JOIN', escalate: RANK[newSeverity] > RANK[existing.severity] };
}
