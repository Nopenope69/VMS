/**
 * Incident summary records (ADR 0016).
 *
 * A summary tells the story of an alarm in plain sentences. It is generated from a numbered timeline of recorded facts
 * by a fixed template, and EVERY sentence ends with the facts it rests on ("[F1, F3]"). No model writes it. The facts, the
 * sentences and the whole record are hashed; `vigilone-verify` recomputes the hashes, re-renders the sentences from the
 * facts and checks that every citation points at a fact and every fact is cited.
 *
 * The facts schema is strict on purpose: it has no place for a number plate, an operator's typed text, or a description
 * of a person, so none of them can end up in a summary by accident.
 */
import { z } from 'zod';

export const INCIDENT_SUMMARY_RECORD_SCHEMA = 'vigilone.incident-summary.v1';
export const INCIDENT_SUMMARIES_DOCUMENT_SCHEMA = 'vigilone.incident-summaries.v1';
export const INCIDENT_SUMMARY_TEMPLATE_V1 = 'incident-summary.v1';

const HEX64 = /^[a-f0-9]{64}$/;
const isoUtc = z.string().refine((s) => {
  const t = Date.parse(s);
  return Number.isFinite(t) && new Date(t).toISOString() === s;
}, 'must be a canonical UTC ISO-8601 timestamp (Date#toISOString)');
const str = z.string().min(1);
const nstr = z.string().min(1).nullable();
const num = z.number().finite();
const unit = z.number().finite().min(0).max(1);

const base = { id: z.string().regex(/^F[1-9][0-9]*$/), atUtc: isoUtc, cameraId: nstr };
const fact = <K extends string, D extends z.ZodTypeAny>(kind: K, data: D) => z.object({ ...base, kind: z.literal(kind), data }).strict();

export const TimelineFactV1 = z.discriminatedUnion('kind', [
  fact('ALARM_RAISED', z.object({ title: z.string(), severity: str, source: z.enum(['RULE', 'JOURNEY']).nullable() }).strict()),
  fact(
    'TRIGGER_EVENT',
    z
      .object({
        eventType: str,
        source: nstr,
        trackId: nstr,
        zoneId: nstr,
        direction: nstr,
        dwellSeconds: num.nullable(),
        thresholdSeconds: num.nullable(),
        objectClass: nstr,
        confidence: unit.nullable(),
        /** True for a number plate read. The plate text is never recorded here. */
        plateRead: z.boolean(),
      })
      .strict()
  ),
  fact('CORRELATED_EVENT', z.object({ eventType: str }).strict()),
  fact('DETECTION', z.object({ label: str, confidence: unit, modelSha256: z.string().regex(HEX64).nullable() }).strict()),
  fact(
    'TRACK_SIGHTING',
    z
      .object({
        trackId: str,
        objectClass: str,
        firstSeenUtc: isoUtc,
        lastSeenUtc: isoUtc,
        direction: nstr,
        zones: z.array(z.object({ name: z.string(), enteredUtc: isoUtc, exitedUtc: isoUtc }).strict()),
      })
      .strict()
  ),
  fact('LINK_CONFIRMED', z.object({ method: z.enum(['PLATE', 'APPEARANCE']), fromTrackId: str, toTrackId: str, userId: str }).strict()),
  fact('ALARM_REPEATED', z.object({ occurrences: z.number().int().min(2), lastActivityUtc: isoUtc }).strict()),
  fact(
    'SECOND_OPINION',
    z.object({ answer: z.enum(['yes', 'no', 'unclear']), targetClass: str, modelName: str, modelVersion: str, modelSha256: z.string().regex(HEX64) }).strict()
  ),
  fact('ACKNOWLEDGED', z.object({ userId: str }).strict()),
  fact('VERDICT', z.object({ verdict: z.enum(['FALSE_ALARM', 'TRUE_ALARM']), userId: str, hasReason: z.boolean() }).strict()),
  fact('RESOLVED', z.object({ userId: str, hasNotes: z.boolean() }).strict()),
  fact('EVIDENCE_HOLD', z.object({ windowStartUtc: isoUtc, windowEndUtc: isoUtc, status: str }).strict()),
]);
export type TimelineFactV1 = z.infer<typeof TimelineFactV1>;
export type FactKind = TimelineFactV1['kind'];

export const IncidentSummaryFactsV1 = z
  .object({
    subject: z.object({ kind: z.literal('ALARM'), id: str, tenantId: str, cameraId: nstr }).strict(),
    cameras: z.array(z.object({ id: str, name: z.string() }).strict()),
    timeline: z.array(TimelineFactV1).min(1),
  })
  .strict()
  .superRefine((f, ctx) => {
    const add = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    f.timeline.forEach((t, i) => {
      if (t.id !== `F${i + 1}`) add(`fact ${i + 1} must be numbered F${i + 1}, not ${t.id}`);
      if (i > 0 && Date.parse(t.atUtc) < Date.parse(f.timeline[i - 1].atUtc)) add('facts must be in time order');
    });
    if (f.timeline.filter((t) => t.kind === 'ALARM_RAISED').length !== 1) add('there must be exactly one ALARM_RAISED fact');
    if (f.timeline.filter((t) => t.kind === 'TRIGGER_EVENT').length > 1) add('there can be at most one TRIGGER_EVENT fact');
    const ids = f.cameras.map((c) => c.id);
    if (new Set(ids).size !== ids.length) add('cameras must be unique');
    for (const t of f.timeline) if (t.cameraId && !ids.includes(t.cameraId)) add(`fact ${t.id} names camera ${t.cameraId}, which is not in the camera list`);
  });
export type IncidentSummaryFactsV1 = z.infer<typeof IncidentSummaryFactsV1>;

export interface SummarySentence {
  /** The sentence without its citation. */
  text: string;
  /** The fact ids it rests on. Empty only for the fixed closing statement. */
  cites: string[];
}

export interface IncidentSummaryRecordV1 {
  schema: typeof INCIDENT_SUMMARY_RECORD_SCHEMA;
  templateVersion: string;
  /** SHA-256 of `ALARM:<alarmId>:<templateVersion>:<factsSha256>`: one record per alarm, template and set of facts. */
  summaryId: string;
  generatedAtUtc: string;
  facts: IncidentSummaryFactsV1;
  factsSha256: string;
  sentences: SummarySentence[];
  /** The sentences joined with their citations, one per line. */
  text: string;
  textSha256: string;
  /** SHA-256 over the canonical JSON of every other field. */
  recordSha256: string;
}

export interface IncidentSummariesDocumentV1 {
  schema: typeof INCIDENT_SUMMARIES_DOCUMENT_SCHEMA;
  cameraId: string;
  window: { startUtc: string; endUtc: string };
  statement: string;
  summaries: IncidentSummaryRecordV1[];
  /** SHA-256 over the canonical JSON of the sorted list of recordSha256 values. */
  digestSha256: string;
}
