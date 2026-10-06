/**
 * Collects the facts for an incident summary (ADR 0016) from rows that already exist. Nothing is inferred, defaulted or
 * guessed: a fact that is not recorded is absent; a recorded value that does not fit the facts schema makes the summary
 * fail (loudly), never get patched. No number plate text, no operator-typed text and no description of a person is read
 * into the facts: only that a plate was read, that notes exist, and opaque ids.
 */
import { PrismaClient } from '@prisma/client';

export class IncidentSummaryError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'IncidentSummaryError';
  }
}

const MAX_CORRELATED = 200;
const MAX_STEPS = 50;
const HEX64 = /^[a-f0-9]{64}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const iso = (v: unknown): string | null => {
  const t = v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** When two facts share a moment, the cause comes before its effect. */
const TIE_ORDER = ['CORRELATED_EVENT', 'DETECTION', 'TRACK_SIGHTING', 'LINK_CONFIRMED', 'TRIGGER_EVENT', 'ALARM_RAISED', 'SECOND_OPINION', 'EVIDENCE_HOLD', 'ALARM_REPEATED', 'ACKNOWLEDGED', 'VERDICT', 'RESOLVED'];

interface RawFact {
  atUtc: string;
  kind: string;
  cameraId: string | null;
  data: Record<string, unknown>;
}

function triggerData(eventType: string, source: string | null, payload: Record<string, unknown> | null) {
  const p = payload ?? {};
  const conf = numOrNull(p.confidence);
  return {
    eventType,
    source,
    trackId: str(p.trackId),
    zoneId: str(p.zoneId),
    direction: str(p.direction),
    dwellSeconds: numOrNull(p.dwellTimeSeconds) ?? numOrNull(p.unattendedSeconds),
    thresholdSeconds: numOrNull(p.thresholdSeconds),
    objectClass: str(p.objectClass),
    confidence: eventType === 'AI_OBJECT_DETECTED' && conf !== null && conf >= 0 && conf <= 1 ? conf : null,
    plateRead: eventType === 'ANPR_MATCH' || p.kind === 'ANPR_MATCH',
  };
}

/** The facts for one alarm, exactly as recorded, numbered in time order. Throws IncidentSummaryError when the alarm is not this tenant's. */
export async function collectIncidentSummaryFacts(prisma: PrismaClient, tenantId: string, alarmId: string): Promise<unknown> {
  const alarm = await prisma.alarm.findUnique({
    where: { id: alarmId },
    include: { canonicalEvent: true, feedback: true, vlmVerifications: { orderBy: { createdAt: 'asc' } }, evidenceHolds: { orderBy: { createdAt: 'asc' } } },
  });
  if (!alarm || alarm.tenantId !== tenantId) throw new IncidentSummaryError(404, 'ALARM_NOT_FOUND', 'Alarm not found');

  const raw: RawFact[] = [];
  const meta = isObj(alarm.metadataJson) ? alarm.metadataJson : {};
  const isJourney = meta.source === 'JOURNEY';

  raw.push({
    atUtc: alarm.triggeredAt.toISOString(),
    kind: 'ALARM_RAISED',
    cameraId: alarm.cameraId,
    data: { title: alarm.title, severity: String(alarm.severity), source: isJourney ? 'JOURNEY' : alarm.automationRuleId || alarm.ruleId ? 'RULE' : null },
  });

  const ev = alarm.canonicalEvent;
  if (ev) {
    const wrapper = ev.payloadJson;
    const payload = isObj(wrapper) && isObj(wrapper.payload) ? wrapper.payload : null;
    raw.push({ atUtc: ev.timestampUtc.toISOString(), kind: 'TRIGGER_EVENT', cameraId: ev.cameraId, data: triggerData(ev.type, str(ev.source), payload) });

    const inferenceId = isObj(ev.provenanceJson) && typeof ev.provenanceJson.inferenceId === 'string' ? ev.provenanceJson.inferenceId : null;
    if (inferenceId) {
      const d = await prisma.detectionEvent.findFirst({ where: { tenantId, inferenceId } });
      if (d) {
        raw.push({
          atUtc: d.timestamp.toISOString(),
          kind: 'DETECTION',
          cameraId: d.cameraId,
          data: { label: d.objectClass ?? String(d.type), confidence: d.confidence, modelSha256: d.modelSha256 && HEX64.test(d.modelSha256) ? d.modelSha256 : null },
        });
      }
    }

    const chain = await prisma.canonicalEvent.findMany({
      where: { tenantId, correlationId: ev.correlationId, id: { not: ev.id }, timestampUtc: { lte: ev.timestampUtc } },
      orderBy: [{ timestampUtc: 'asc' }, { id: 'asc' }],
      take: MAX_CORRELATED + 1,
    });
    if (chain.length > MAX_CORRELATED) throw new IncidentSummaryError(422, 'SUMMARY_FACTS_REJECTED', `the correlation chain of event ${ev.id} has more than ${MAX_CORRELATED} earlier events; the summary would be incomplete`);
    for (const c of chain) raw.push({ atUtc: c.timestampUtc.toISOString(), kind: 'CORRELATED_EVENT', cameraId: c.cameraId, data: { eventType: c.type } });
  }

  if (alarm.occurrenceCount > 1 && alarm.lastActivityAt) {
    raw.push({ atUtc: alarm.lastActivityAt.toISOString(), kind: 'ALARM_REPEATED', cameraId: alarm.cameraId, data: { occurrences: alarm.occurrenceCount, lastActivityUtc: alarm.lastActivityAt.toISOString() } });
  }

  for (const v of alarm.vlmVerifications) {
    raw.push({
      atUtc: v.createdAt.toISOString(),
      kind: 'SECOND_OPINION',
      cameraId: v.cameraId,
      data: { answer: v.answer, targetClass: v.targetClass, modelName: v.modelName, modelVersion: v.modelVersion, modelSha256: v.modelSha256 },
    });
  }

  if (alarm.acknowledgedAt) raw.push({ atUtc: alarm.acknowledgedAt.toISOString(), kind: 'ACKNOWLEDGED', cameraId: alarm.cameraId, data: { userId: alarm.acknowledgedById ?? 'unrecorded' } });
  if (alarm.feedback) {
    raw.push({ atUtc: alarm.feedback.updatedAt.toISOString(), kind: 'VERDICT', cameraId: alarm.cameraId, data: { verdict: alarm.feedback.verdict, userId: alarm.feedback.userId, hasReason: Boolean(alarm.feedback.reason) } });
  }
  if (alarm.resolvedAt) raw.push({ atUtc: alarm.resolvedAt.toISOString(), kind: 'RESOLVED', cameraId: alarm.cameraId, data: { userId: alarm.resolvedById ?? 'unrecorded', hasNotes: Boolean(alarm.resolutionNotes) } });

  for (const h of alarm.evidenceHolds) {
    raw.push({ atUtc: h.createdAt.toISOString(), kind: 'EVIDENCE_HOLD', cameraId: h.cameraId, data: { windowStartUtc: h.windowStart.toISOString(), windowEndUtc: h.windowEnd.toISOString(), status: h.status } });
  }

  // A journey: the sightings recorded in the alarm (enriched from the track row while it exists) and the links an operator confirmed.
  if (isJourney && Array.isArray(meta.steps)) {
    const steps = (meta.steps as unknown[]).filter(isObj) as Array<Record<string, unknown>>;
    if (steps.length > MAX_STEPS) throw new IncidentSummaryError(422, 'SUMMARY_FACTS_REJECTED', `the journey has more than ${MAX_STEPS} sightings; the summary would be incomplete`);
    const ids = steps.map((s) => str(s.trackId)).filter((x): x is string => !!x);
    const rows = ids.length ? await prisma.objectTrack.findMany({ where: { tenantId, id: { in: ids } } }) : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const st of steps) {
      const trackId = str(st.trackId);
      const first = iso(st.firstSeenAt);
      const last = iso(st.lastSeenAt);
      if (!trackId || !first || !last) throw new IncidentSummaryError(422, 'SUMMARY_FACTS_REJECTED', 'a sighting recorded in the journey has no track id or no times');
      const row = byId.get(trackId);
      const zones = (Array.isArray(row?.zonesJson) ? (row!.zonesJson as unknown[]) : [])
        .filter(isObj)
        .map((z) => ({ name: typeof z.name === 'string' ? z.name : '', enteredUtc: iso(z.enteredAt), exitedUtc: iso(z.exitedAt) }))
        .filter((z): z is { name: string; enteredUtc: string; exitedUtc: string } => !!z.enteredUtc && !!z.exitedUtc);
      raw.push({
        atUtc: first,
        kind: 'TRACK_SIGHTING',
        cameraId: str(st.cameraId),
        data: { trackId, objectClass: row?.objectClass ?? str(meta.objectClass) ?? 'unknown', firstSeenUtc: first, lastSeenUtc: last, direction: row?.direction ?? null, zones },
      });
    }
    const linkIds = Array.isArray(meta.linkIds) ? meta.linkIds.filter((x): x is string => typeof x === 'string') : [];
    if (linkIds.length) {
      const links = await prisma.trackLink.findMany({ where: { tenantId, id: { in: linkIds }, status: 'CONFIRMED' }, orderBy: { decidedAt: 'asc' } });
      for (const l of links) {
        raw.push({ atUtc: l.decidedAt.toISOString(), kind: 'LINK_CONFIRMED', cameraId: null, data: { method: l.method, fromTrackId: l.fromTrackId, toTrackId: l.toTrackId, userId: l.decidedByUserId } });
      }
    }
  }

  const sorted = raw
    .map((f, i) => ({ f, i }))
    .sort((a, b) => Date.parse(a.f.atUtc) - Date.parse(b.f.atUtc) || TIE_ORDER.indexOf(a.f.kind) - TIE_ORDER.indexOf(b.f.kind) || a.i - b.i)
    .map(({ f }, i) => ({ id: `F${i + 1}`, ...f }));

  const cameraIds = [...new Set(sorted.map((f) => f.cameraId).filter((x): x is string => !!x))];
  const cams = cameraIds.length ? await prisma.camera.findMany({ where: { tenantId, id: { in: cameraIds } }, select: { id: true, name: true } }) : [];
  const names = new Map(cams.map((c) => [c.id, c.name]));

  return {
    subject: { kind: 'ALARM', id: alarm.id, tenantId: alarm.tenantId, cameraId: alarm.cameraId },
    cameras: cameraIds.map((id) => ({ id, name: names.get(id) ?? id })),
    timeline: sorted,
  };
}
