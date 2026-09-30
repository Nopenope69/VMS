/**
 * Explanation service (Phase 5, P5.2): collects the recorded facts for an alarm and stores the
 * explanation record built by the core (explain-template.v1, no model).
 *
 * Facts come only from rows that already exist: the alarm, the canonical event that raised it (with
 * its AI provenance), the rule, the detection named by that provenance's inferenceId, and earlier
 * events in the same correlation chain. Nothing is inferred or defaulted:
 *  - a fact that is not recorded is null or absent, never a guess;
 *  - a recorded value that does not fit the facts schema makes the explanation fail (loudly);
 *  - the camera clock status is UNKNOWN because no clock verdict is persisted, and one is not
 *    derived from the stored skew estimate (the estimate alone cannot say OK or DRIFT).
 *
 * Stored records are immutable: generating again for the same alarm and template returns the
 * stored record and never rewrites it.
 */
import { PrismaClient } from '@prisma/client';
import { buildExplanationRecord, ExplanationFactsError } from './explanation';
import { EXPLAIN_TEMPLATE_V1, ExplanationRecordV1 } from './types';

const HEX64 = /^[a-f0-9]{64}$/;
const MAX_CORRELATED = 500;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

interface ModelRef {
  name: string;
  version: string;
  sha256: string;
}

function modelRefFrom(source: string, prov: unknown): ModelRef | null {
  if (prov === null || prov === undefined) return null;
  if (!isObject(prov)) throw new ExplanationFactsError(`${source}: provenance is not an object`);
  const { modelName, modelVersion, modelSha256 } = prov;
  if (typeof modelName !== 'string' || !modelName || typeof modelVersion !== 'string' || !modelVersion || typeof modelSha256 !== 'string' || !HEX64.test(modelSha256)) {
    throw new ExplanationFactsError(`${source}: provenance does not name a model with a SHA-256`);
  }
  return { name: modelName, version: modelVersion, sha256: modelSha256 };
}

/** The facts for one alarm, exactly as recorded. Throws ExplanationFactsError when they cannot be stated. */
export async function collectExplanationFacts(prisma: PrismaClient, alarmId: string): Promise<unknown> {
  const alarm = await prisma.alarm.findUnique({
    where: { id: alarmId },
    include: { canonicalEvent: true, automationRule: true, rule: true },
  });
  if (!alarm) throw new ExplanationFactsError(`alarm ${alarmId} not found`);

  const ev = alarm.canonicalEvent;
  let trigger: Record<string, unknown> = { eventId: null, type: null, source: null, timestampUtc: null, severity: null, payload: null };
  const models = new Map<string, ModelRef>();
  let detections: unknown[] = [];
  let correlated: unknown[] = [];

  if (ev) {
    // CanonicalEvent.payloadJson wraps the event payload: { payload, title, description, ... }.
    const wrapper = ev.payloadJson;
    const payload = isObject(wrapper) ? wrapper.payload : undefined;
    if (payload !== undefined && payload !== null && !isObject(payload)) throw new ExplanationFactsError(`canonical event ${ev.id}: payload is not an object`);
    trigger = {
      eventId: ev.id,
      type: ev.type,
      source: ev.source,
      timestampUtc: ev.timestampUtc.toISOString(),
      severity: String(ev.severity),
      payload: payload ?? null,
    };

    const evModel = modelRefFrom(`canonical event ${ev.id}`, ev.provenanceJson);
    if (evModel) models.set(evModel.sha256, evModel);

    // The one detection the trigger's provenance names. Not "detections near the time": a link that
    // was recorded, or nothing.
    const inferenceId = isObject(ev.provenanceJson) && typeof ev.provenanceJson.inferenceId === 'string' ? ev.provenanceJson.inferenceId : null;
    if (inferenceId) {
      const d = await prisma.detectionEvent.findFirst({ where: { tenantId: alarm.tenantId, inferenceId } });
      if (d) {
        const dModel = modelRefFrom(`detection ${d.id}`, d.provenanceJson);
        if (dModel) models.set(dModel.sha256, dModel);
        detections = [
          {
            id: d.id,
            label: d.objectClass ?? String(d.type),
            confidence: d.confidence,
            frameTimestampUtc: d.timestamp.toISOString(),
            modelSha256: d.modelSha256 ?? dModel?.sha256 ?? null,
          },
        ];
      }
    }

    const chain = await prisma.canonicalEvent.findMany({
      where: { tenantId: alarm.tenantId, correlationId: ev.correlationId, id: { not: ev.id }, timestampUtc: { lte: ev.timestampUtc } },
      orderBy: [{ timestampUtc: 'asc' }, { id: 'asc' }],
      take: MAX_CORRELATED + 1,
    });
    if (chain.length > MAX_CORRELATED) throw new ExplanationFactsError(`correlation chain of event ${ev.id} has more than ${MAX_CORRELATED} earlier events; the explanation would be incomplete`);
    correlated = chain.map((c) => ({ eventId: c.id, type: c.type, timestampUtc: c.timestampUtc.toISOString() }));
  }

  const manifests = models.size
    ? await prisma.modelManifest.findMany({ where: { sha256: { in: [...models.keys()] } } })
    : [];
  const modelFacts = [...models.values()]
    .sort((a, b) => a.sha256.localeCompare(b.sha256))
    .map((m) => {
      const manifest = manifests.find((x) => x.sha256 === m.sha256 && x.name === m.name && x.version === m.version);
      // "evaluated" is true only when a published evaluation is recorded for exactly this model.
      return { name: m.name, version: m.version, sha256: m.sha256, task: manifest?.task ?? null, evaluated: manifest?.evaluationJson != null };
    });

  const rule = alarm.automationRule
    ? {
        kind: 'AUTOMATION_RULE' as const,
        id: alarm.automationRule.id,
        name: alarm.automationRule.name,
        triggerType: String(alarm.automationRule.triggerType),
        cooldownSeconds: alarm.automationRule.cooldownSeconds,
        conditions: alarm.automationRule.conditionsJson,
        triggerConfig: alarm.automationRule.triggerConfigJson,
      }
    : alarm.rule
    ? {
        kind: 'EVENT_RULE' as const,
        id: alarm.rule.id,
        name: alarm.rule.name,
        triggerType: String(alarm.rule.triggerType),
        cooldownSeconds: null,
        conditions: alarm.rule.conditionsJson ?? null,
        triggerConfig: null,
      }
    : null;

  return {
    subject: { kind: 'ALARM', id: alarm.id, tenantId: alarm.tenantId, cameraId: alarm.cameraId },
    alarm: { title: alarm.title, severity: String(alarm.severity), triggeredAtUtc: alarm.triggeredAt.toISOString() },
    trigger,
    rule,
    models: modelFacts,
    detections,
    correlated,
    cameraClock: { status: 'UNKNOWN' },
  };
}

export interface GenerateOutcome {
  record: ExplanationRecordV1;
  /** False when a stored record already existed for this alarm and template (returned unchanged). */
  created: boolean;
}

/** Builds the explanation for an alarm and stores it. Throws on any problem; the caller decides what that means. */
export async function generateExplanationForAlarm(prisma: PrismaClient, alarmId: string, now: Date = new Date()): Promise<GenerateOutcome> {
  const facts = await collectExplanationFacts(prisma, alarmId);
  const record = buildExplanationRecord(facts, now, EXPLAIN_TEMPLATE_V1);
  try {
    await prisma.explanation.create({
      data: {
        tenantId: record.facts.subject.tenantId,
        alarmId,
        cameraId: record.facts.subject.cameraId,
        alarmTriggeredAt: new Date(record.facts.alarm.triggeredAtUtc),
        explanationId: record.explanationId,
        templateVersion: record.templateVersion,
        recordSha256: record.recordSha256,
        recordJson: record as any,
        generatedAt: new Date(record.generatedAtUtc),
      },
    });
    return { record, created: true };
  } catch (err: any) {
    if (err?.code !== 'P2002') throw err;
    const stored = await prisma.explanation.findUnique({ where: { alarmId_templateVersion: { alarmId, templateVersion: record.templateVersion } } });
    if (!stored) throw new ExplanationFactsError(`explanation for alarm ${alarmId} conflicts with an existing row but none matches alarm and template`);
    return { record: stored.recordJson as unknown as ExplanationRecordV1, created: false };
  }
}

/** Stored records for a camera whose alarm was raised inside [start, end], for an evidence export. */
export async function loadExplanationRecords(prisma: PrismaClient, tenantId: string, cameraId: string, start: Date, end: Date): Promise<ExplanationRecordV1[]> {
  const rows = await prisma.explanation.findMany({
    where: { tenantId, cameraId, alarmTriggeredAt: { gte: start, lte: end } },
    orderBy: { explanationId: 'asc' },
  });
  return rows.map((r) => {
    const rec = r.recordJson as unknown as ExplanationRecordV1;
    if (!rec || rec.explanationId !== r.explanationId || rec.recordSha256 !== r.recordSha256) {
      throw new ExplanationFactsError(`stored explanation ${r.id} does not match its own row (explanationId or recordSha256)`);
    }
    return rec;
  });
}
