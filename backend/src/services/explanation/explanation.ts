import crypto from 'crypto';
import { canonicalizeJson } from '../evidence/archive/canonicalJson';
import { isKnownTemplate, renderExplanation } from './template';
import {
  EXPLAIN_TEMPLATE_V1,
  EXPLANATION_RECORD_SCHEMA,
  EXPLANATIONS_DOCUMENT_SCHEMA,
  ExplanationFactsV1,
  ExplanationRecordV1,
  ExplanationsDocumentV1,
} from './types';

export class ExplanationFactsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExplanationFactsError';
  }
}

const sha256 = (v: string): string => crypto.createHash('sha256').update(v, 'utf8').digest('hex');

export const explanationIdFor = (subjectKind: 'ALARM', subjectId: string, templateVersion: string): string =>
  sha256(`${subjectKind}:${subjectId}:${templateVersion}`);

const recordBody = (r: Omit<ExplanationRecordV1, 'recordSha256'>) => ({
  schema: r.schema,
  templateVersion: r.templateVersion,
  explanationId: r.explanationId,
  generatedAtUtc: r.generatedAtUtc,
  facts: r.facts,
  factsSha256: r.factsSha256,
  text: r.text,
  textSha256: r.textSha256,
});

/**
 * Builds a record from facts. Facts that do not satisfy the schema are refused, never patched:
 * an explanation that cannot state its facts must not exist.
 */
export function buildExplanationRecord(
  factsInput: unknown,
  generatedAt: Date,
  templateVersion: string = EXPLAIN_TEMPLATE_V1
): ExplanationRecordV1 {
  const parsed = ExplanationFactsV1.safeParse(factsInput);
  if (!parsed.success) {
    throw new ExplanationFactsError(`explanation facts rejected: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  }
  if (Number.isNaN(generatedAt.getTime())) throw new ExplanationFactsError('generatedAt is not a valid date');
  // Store exactly what a JSON round trip (and PostgreSQL JSONB) would give back: undefined members
  // in free-form fields become null, so the hashed facts and the stored facts are the same bytes.
  const facts = ExplanationFactsV1.parse(JSON.parse(JSON.stringify(parsed.data, (_key, value) => (value === undefined ? null : value))));
  const text = renderExplanation(facts, templateVersion);
  const partial: Omit<ExplanationRecordV1, 'recordSha256'> = {
    schema: EXPLANATION_RECORD_SCHEMA,
    templateVersion,
    explanationId: explanationIdFor(facts.subject.kind, facts.subject.id, templateVersion),
    generatedAtUtc: generatedAt.toISOString(),
    facts,
    factsSha256: sha256(canonicalizeJson(facts)),
    text,
    textSha256: sha256(text),
  };
  return { ...partial, recordSha256: sha256(canonicalizeJson(recordBody(partial))) };
}

export interface ExplanationProblem {
  explanationId: string;
  problem: string;
}

/** Recomputes every hash and re-renders the text from the facts. Returns the problems found (empty = intact). */
export function verifyExplanationRecord(record: ExplanationRecordV1): ExplanationProblem[] {
  const id = typeof record?.explanationId === 'string' ? record.explanationId : '(no id)';
  const problems: ExplanationProblem[] = [];
  const add = (problem: string) => problems.push({ explanationId: id, problem });
  if (!record || record.schema !== EXPLANATION_RECORD_SCHEMA) return [{ explanationId: id, problem: 'unknown record schema' }];
  const parsed = ExplanationFactsV1.safeParse(record.facts);
  if (!parsed.success) return [{ explanationId: id, problem: 'facts do not satisfy the schema' }];
  if (sha256(canonicalizeJson(record.facts)) !== record.factsSha256) add('factsSha256 does not match the facts');
  if (sha256(record.text) !== record.textSha256) add('textSha256 does not match the text');
  if (sha256(canonicalizeJson(recordBody(record))) !== record.recordSha256) add('recordSha256 does not match the record');
  if (record.explanationId !== explanationIdFor(parsed.data.subject.kind, parsed.data.subject.id, record.templateVersion)) add('explanationId does not match the subject and template');
  if (!isKnownTemplate(record.templateVersion)) add(`unknown template version ${record.templateVersion}`);
  else if (renderExplanation(parsed.data, record.templateVersion) !== record.text) add('the text is not what the template renders from the facts');
  return problems;
}

export const digestOf = (records: Array<Pick<ExplanationRecordV1, 'recordSha256'>>): string =>
  sha256(canonicalizeJson(records.map((r) => r.recordSha256).sort()));

export function buildExplanationsDocument(input: {
  cameraId: string;
  window: { startUtc: string; endUtc: string };
  records: ExplanationRecordV1[];
}): ExplanationsDocumentV1 {
  const ids = new Set<string>();
  for (const r of input.records) {
    if (ids.has(r.explanationId)) throw new ExplanationFactsError(`duplicate explanation ${r.explanationId}`);
    ids.add(r.explanationId);
    if (r.facts.subject.cameraId !== input.cameraId) throw new ExplanationFactsError(`explanation ${r.explanationId} belongs to camera ${r.facts.subject.cameraId}, not ${input.cameraId}`);
    const t = Date.parse(r.facts.alarm.triggeredAtUtc);
    if (t < Date.parse(input.window.startUtc) || t > Date.parse(input.window.endUtc)) throw new ExplanationFactsError(`explanation ${r.explanationId} is outside the export window`);
    const problems = verifyExplanationRecord(r);
    if (problems.length) throw new ExplanationFactsError(`explanation ${r.explanationId} is not intact: ${problems.map((p) => p.problem).join('; ')}`);
  }
  const explanations = [...input.records].sort((a, b) => a.explanationId.localeCompare(b.explanationId));
  return {
    schema: EXPLANATIONS_DOCUMENT_SCHEMA,
    cameraId: input.cameraId,
    window: input.window,
    statement:
      'Each explanation is generated from recorded facts by a fixed template. It is not a model opinion. ' +
      'It states why the system raised the alarm; it does not by itself show that the event occurred.',
    explanations,
    digestSha256: digestOf(explanations),
  };
}
