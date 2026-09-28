import { PrismaClient, EventSeverity, Prisma } from '@prisma/client';
import { RuleConditionSchema, ValidatedCondition } from './ruleSchema';
import { MetricsService } from '../observability/metrics.service';
import type { VigilOneEvent } from '../incident/orchestrator/types';

/**
 * Rule condition evaluation (P3.5 time schedules, P3.6 event correlation).
 *
 * Fail closed: a condition that cannot be evaluated exactly (unknown type, invalid stored JSON,
 * no resolvable time zone) makes the rule not match, and is counted in
 * vigilone_rule_condition_errors_total. It never silently passes.
 */
const SEVERITY_RANK: Record<EventSeverity, number> = { INFO: 1, WARNING: 2, CRITICAL: 3 };
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function conditionError(reason: string) {
  MetricsService.incCounter('vigilone_rule_condition_errors_total', 'Rule conditions that could not be evaluated (rule did not fire)', { reason });
}

/** Local weekday and minute-of-day of an instant in an IANA zone. */
export function localClock(at: Date, timeZone: string): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { day: WEEKDAY[get('weekday')], minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** True when the instant falls inside any window (end exclusive; overnight windows supported). */
export function inSchedule(at: Date, timeZone: string, windows: Array<{ days: number[]; start: string; end: string }>): boolean {
  const { day, minute } = localClock(at, timeZone);
  const prevDay = (day + 6) % 7;
  return windows.some((w) => {
    const s = toMin(w.start);
    const e = toMin(w.end);
    if (s < e) return w.days.includes(day) && minute >= s && minute < e;
    return (w.days.includes(day) && minute >= s) || (w.days.includes(prevDay) && minute < e);
  });
}

export class RuleConditionEvaluator {
  private tzCache = new Map<string, { tz: string | null; at: number }>();

  constructor(private prisma: PrismaClient) {}

  /** Camera's site zone; for camera-less events, the tenant's only site's zone. Null if ambiguous. */
  async siteTimeZone(tenantId: string, cameraId?: string | null): Promise<string | null> {
    const key = `${tenantId}:${cameraId ?? '-'}`;
    const hit = this.tzCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.tz;
    let tz: string | null = null;
    if (cameraId) {
      const cam = await this.prisma.camera.findUnique({ where: { id: cameraId }, select: { site: { select: { timezone: true } } } });
      tz = cam?.site?.timezone ?? null;
    } else {
      const sites = await this.prisma.site.findMany({ where: { tenantId }, select: { timezone: true }, distinct: ['timezone'], take: 2 });
      tz = sites.length === 1 ? sites[0].timezone : null;
    }
    this.tzCache.set(key, { tz, at: Date.now() });
    return tz;
  }

  async matches(rawConditions: unknown, event: VigilOneEvent): Promise<boolean> {
    const list = Array.isArray(rawConditions) ? rawConditions : [];
    for (const raw of list) {
      const parsed = RuleConditionSchema.safeParse(raw);
      if (!parsed.success) {
        conditionError(`invalid_${String((raw as any)?.type ?? 'unknown').toLowerCase()}`);
        return false;
      }
      if (!(await this.matchOne(parsed.data, event))) return false;
    }
    return true;
  }

  private async matchOne(c: ValidatedCondition, event: VigilOneEvent): Promise<boolean> {
    const at = event.timestampUtc instanceof Date ? event.timestampUtc : new Date(event.timestampUtc);
    switch (c.type) {
      case 'SEVERITY_THRESHOLD':
        return (SEVERITY_RANK[event.severity] || 1) >= SEVERITY_RANK[c.value];
      case 'TIME_SCHEDULE': {
        const tz = c.value.timezone ?? (await this.siteTimeZone(event.tenantId, event.cameraId));
        if (!tz) {
          conditionError('no_timezone');
          return false;
        }
        const inside = inSchedule(at, tz, c.value.windows);
        return c.operator === 'BETWEEN' ? inside : !inside;
      }
      case 'PRECEDED_BY':
      case 'NOT_PRECEDED_BY': {
        const v = c.value;
        if (v.scope === 'SAME_CAMERA' && !event.cameraId) {
          conditionError('no_camera_for_same_camera_scope');
          return false;
        }
        const where: Prisma.CanonicalEventWhereInput = {
          tenantId: event.tenantId,
          type: { in: v.eventTypes },
          id: { not: event.id },
          // Strictly before the event, within the window (event time, not processing time).
          timestampUtc: { gte: new Date(at.getTime() - v.withinSeconds * 1000), lt: at },
          ...(v.scope === 'SAME_CAMERA' ? { cameraId: event.cameraId } : v.scope === 'CAMERA' ? { cameraId: v.cameraId } : {}),
          ...(v.objectClasses ? { OR: v.objectClasses.map((cls) => ({ payloadJson: { path: ['payload', 'objectClass'], equals: cls } })) } : {}),
        };
        const found = await this.prisma.canonicalEvent.findFirst({ where, select: { id: true } });
        return c.type === 'PRECEDED_BY' ? !!found : !found;
      }
    }
  }
}
