import crypto from 'crypto';
import { canonicalizeJson } from '../evidence/archive/canonicalJson';
import { CLOSING_STATEMENT_V1, isKnownTemplate, joinSentences, renderIncidentSummary } from './template';
import {
  INCIDENT_SUMMARIES_DOCUMENT_SCHEMA,
  INCIDENT_SUMMARY_RECORD_SCHEMA,
  INCIDENT_SUMMARY_TEMPLATE_V1,
  IncidentSummariesDocumentV1,
  IncidentSummaryFactsV1,
  IncidentSummaryRecordV1,
} from './types';

export class IncidentSummaryFactsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncidentSummaryFactsError';
  }
}

const sha256 = (v: string): string => crypto.createHash('sha256').update(v, 'utf8').digest('hex');

export const summaryIdFor = (alarmId: string, templateVersion: string, factsSha256: string): string => sha256(`ALARM:${alarmId}:${templateVersion}:${factsSha256}`);

const recordBody = (r: Omit<IncidentSummaryRecordV1, 'recordSha256'>) => ({
  schema: r.schema,
  templateVersion: r.templateVersion,
  summaryId: r.summaryId,
  generatedAtUtc: r.generatedAtUtc,
  facts: r.facts,
  factsSha256: r.factsSha256,
  sentences: r.sentences,
  text: r.text,
  textSha256: r.textSha256,
});

/** Builds a record from facts. Facts that do not satisfy the schema are refused, never patched. */
export function buildIncidentSummaryRecord(factsInput: unknown, generatedAt: Date, templateVersion: string = INCIDENT_SUMMARY_TEMPLATE_V1): IncidentSummaryRecordV1 {
  const parsed = IncidentSummaryFactsV1.safeParse(factsInput);
  if (!parsed.success) {
    throw new IncidentSummaryFactsError(`incident summary facts rejected: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  }
  if (Number.isNaN(generatedAt.getTime())) throw new IncidentSummaryFactsError('generatedAt is not a valid date');
  // Exactly what a JSON round trip (and PostgreSQL JSONB) gives back, so hashed and stored facts are the same bytes.
  const facts = IncidentSummaryFactsV1.parse(JSON.parse(JSON.stringify(parsed.data)));
  const { sentences, text } = renderIncidentSummary(facts, templateVersion);
  const factsSha256 = sha256(canonicalizeJson(facts));
  const partial: Omit<IncidentSummaryRecordV1, 'recordSha256'> = {
    schema: INCIDENT_SUMMARY_RECORD_SCHEMA,
    templateVersion,
    summaryId: summaryIdFor(facts.subject.id, templateVersion, factsSha256),
    generatedAtUtc: generatedAt.toISOString(),
    facts,
    factsSha256,
    sentences,
    text,
    textSha256: sha256(text),
  };
  return { ...partial, recordSha256: sha256(canonicalizeJson(recordBody(partial))) };
}

export interface IncidentSummaryProblem {
  summaryId: string;
  problem: string;
}

/** Recomputes every hash, re-renders the sentences from the facts and checks the citations. Empty = intact. */
export function verifyIncidentSummaryRecord(record: IncidentSummaryRecordV1): IncidentSummaryProblem[] {
  const id = typeof record?.summaryId === 'string' ? record.summaryId : '(no id)';
  const problems: IncidentSummaryProblem[] = [];
  const add = (problem: string) => problems.push({ summaryId: id, problem });
  if (!record || record.schema !== INCIDENT_SUMMARY_RECORD_SCHEMA) return [{ summaryId: id, problem: 'unknown record schema' }];
  const parsed = IncidentSummaryFactsV1.safeParse(record.facts);
  if (!parsed.success) return [{ summaryId: id, problem: 'facts do not satisfy the schema' }];
  const facts = parsed.data;
  const factsSha256 = sha256(canonicalizeJson(record.facts));
  if (factsSha256 !== record.factsSha256) add('factsSha256 does not match the facts');
  if (typeof record.text !== 'string' || sha256(record.text) !== record.textSha256) add('textSha256 does not match the text');
  if (sha256(canonicalizeJson(recordBody(record))) !== record.recordSha256) add('recordSha256 does not match the record');
  if (record.summaryId !== summaryIdFor(facts.subject.id, record.templateVersion, factsSha256)) add('summaryId does not match the alarm, template and facts');

  // Citations: every one points at a fact, every sentence but the closing statement has one, every fact is cited.
  const known = new Set(facts.timeline.map((f) => f.id));
  const cited = new Set<string>();
  const sentences = Array.isArray(record.sentences) ? record.sentences : [];
  sentences.forEach((s, i) => {
    const cites = Array.isArray(s?.cites) ? s.cites : [];
    for (const c of cites) {
      if (!known.has(c)) add(`sentence ${i + 1} cites unknown fact ${c}`);
      cited.add(c);
    }
    const last = i === sentences.length - 1;
    if (!last && cites.length === 0) add(`sentence ${i + 1} has no citation`);
    if (last && (cites.length !== 0 || s?.text !== CLOSING_STATEMENT_V1)) add('the last sentence must be the fixed closing statement, with no citation');
  });
  for (const f of facts.timeline) if (!cited.has(f.id)) add(`fact ${f.id} is not cited by any sentence`);

  if (!isKnownTemplate(record.templateVersion)) add(`unknown template version ${record.templateVersion}`);
  else {
    const rendered = renderIncidentSummary(facts, record.templateVersion);
    // Compared canonically: key order must not matter (canonical JSON sorts keys, JSONB reorders them).
    if (canonicalizeJson(rendered.sentences) !== canonicalizeJson(sentences) || rendered.text !== record.text || joinSentences(sentences) !== record.text) {
      add('the sentences and citations are not what the template renders from the facts');
    }
  }
  return problems;
}

export const digestOf = (records: Array<Pick<IncidentSummaryRecordV1, 'recordSha256'>>): string => sha256(canonicalizeJson(records.map((r) => r.recordSha256).sort()));

export function buildIncidentSummariesDocument(input: {
  cameraId: string;
  window: { startUtc: string; endUtc: string };
  records: IncidentSummaryRecordV1[];
}): IncidentSummariesDocumentV1 {
  const ids = new Set<string>();
  const alarms = new Set<string>();
  for (const r of input.records) {
    if (ids.has(r.summaryId) || alarms.has(r.facts.subject.id)) throw new IncidentSummaryFactsError(`duplicate summary for alarm ${r.facts.subject.id}`);
    ids.add(r.summaryId);
    alarms.add(r.facts.subject.id);
    if (r.facts.subject.cameraId !== input.cameraId) throw new IncidentSummaryFactsError(`summary ${r.summaryId} belongs to camera ${r.facts.subject.cameraId}, not ${input.cameraId}`);
    const raised = r.facts.timeline.find((f) => f.kind === 'ALARM_RAISED')!;
    const t = Date.parse(raised.atUtc);
    if (t < Date.parse(input.window.startUtc) || t > Date.parse(input.window.endUtc)) throw new IncidentSummaryFactsError(`summary ${r.summaryId} is outside the export window`);
    const problems = verifyIncidentSummaryRecord(r);
    if (problems.length) throw new IncidentSummaryFactsError(`summary ${r.summaryId} is not intact: ${problems.map((p) => p.problem).join('; ')}`);
  }
  const summaries = [...input.records].sort((a, b) => a.summaryId.localeCompare(b.summaryId));
  return {
    schema: INCIDENT_SUMMARIES_DOCUMENT_SCHEMA,
    cameraId: input.cameraId,
    window: input.window,
    statement:
      'Each summary is generated from numbered recorded facts by a fixed template; every sentence cites the facts it rests on. ' +
      'It is not a model opinion and does not by itself show that the event occurred.',
    summaries,
    digestSha256: digestOf(summaries),
  };
}
