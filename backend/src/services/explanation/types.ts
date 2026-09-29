/**
 * Explanation records (Phase 5, P5.2).
 *
 * An explanation states, in plain sentences, why an alarm exists. It is generated from recorded
 * facts by a fixed template. No model writes it, so it is a statement about the system's own
 * records, not an opinion about the scene. The facts, the text and the whole record are hashed,
 * and `vigilone-verify` recomputes all three and re-renders the text from the facts.
 */
import { z } from 'zod';

export const EXPLANATION_RECORD_SCHEMA = 'vigilone.explanation.v1';
export const EXPLANATIONS_DOCUMENT_SCHEMA = 'vigilone.explanations.v1';
export const EXPLAIN_TEMPLATE_V1 = 'explain-template.v1';

const HEX64 = /^[a-f0-9]{64}$/;
/** Canonical UTC timestamp: exactly what Date#toISOString produces. */
const isoUtc = z.string().refine((s) => {
  const t = Date.parse(s);
  return Number.isFinite(t) && new Date(t).toISOString() === s;
}, 'must be a canonical UTC ISO-8601 timestamp (Date#toISOString)');

export const CLOCK_STATUSES = ['OK', 'DRIFT', 'UNDETERMINED', 'UNKNOWN'] as const;

export const ExplanationFactsV1 = z
  .object({
    subject: z
      .object({
        kind: z.literal('ALARM'),
        id: z.string().min(1),
        tenantId: z.string().min(1),
        cameraId: z.string().min(1).nullable(),
      })
      .strict(),
    alarm: z
      .object({
        title: z.string(),
        severity: z.string().min(1),
        triggeredAtUtc: isoUtc,
      })
      .strict(),
    trigger: z
      .object({
        eventId: z.string().min(1).nullable(),
        type: z.string().min(1).nullable(),
        source: z.string().min(1).nullable(),
        timestampUtc: isoUtc.nullable(),
        severity: z.string().min(1).nullable(),
        /** The canonical event payload as recorded (JSON object), or null. */
        payload: z.record(z.unknown()).nullable(),
      })
      .strict(),
    rule: z
      .object({
        kind: z.enum(['AUTOMATION_RULE', 'EVENT_RULE']),
        id: z.string().min(1),
        name: z.string().nullable(),
        triggerType: z.string().nullable(),
        cooldownSeconds: z.number().finite().nullable(),
        conditions: z.unknown(),
        triggerConfig: z.unknown(),
      })
      .strict()
      .nullable(),
    models: z.array(
      z
        .object({
          name: z.string().min(1),
          version: z.string().min(1),
          sha256: z.string().regex(HEX64),
          task: z.string().nullable(),
          /** True only when a published evaluation exists for the model. */
          evaluated: z.boolean(),
        })
        .strict()
    ),
    detections: z.array(
      z
        .object({
          id: z.string().min(1),
          label: z.string().min(1),
          confidence: z.number().finite().min(0).max(1),
          frameTimestampUtc: isoUtc,
          modelSha256: z.string().regex(HEX64).nullable(),
        })
        .strict()
    ),
    correlated: z.array(
      z
        .object({
          eventId: z.string().min(1),
          type: z.string().min(1),
          timestampUtc: isoUtc,
        })
        .strict()
    ),
    cameraClock: z.object({ status: z.enum(CLOCK_STATUSES) }).strict(),
  })
  .strict();
export type ExplanationFactsV1 = z.infer<typeof ExplanationFactsV1>;

export interface ExplanationRecordV1 {
  schema: typeof EXPLANATION_RECORD_SCHEMA;
  templateVersion: string;
  /** SHA-256 of `ALARM:<alarmId>:<templateVersion>`: one explanation per alarm and template. */
  explanationId: string;
  generatedAtUtc: string;
  facts: ExplanationFactsV1;
  factsSha256: string;
  text: string;
  textSha256: string;
  /** SHA-256 over the canonical JSON of every other field. */
  recordSha256: string;
}

export interface ExplanationsDocumentV1 {
  schema: typeof EXPLANATIONS_DOCUMENT_SCHEMA;
  cameraId: string;
  window: { startUtc: string; endUtc: string };
  statement: string;
  explanations: ExplanationRecordV1[];
  /** SHA-256 over the canonical JSON of the sorted list of recordSha256 values. */
  digestSha256: string;
}
