// node --test tools/vigilone-verify/incident-summaries.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  canonicalizeJson, renderIncidentSummaryV1, incidentSummaryRecordProblems, incidentSummaryFactsProblem, verifyIncidentSummariesSection,
  ISUM_RECORD_SCHEMA, ISUM_DOCUMENT_SCHEMA, ISUM_TEMPLATE_V1,
} from './vigilone-verify.mjs';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const CAM = 'cam-1';
const W = { startUtc: '2026-10-06T10:00:00.000Z', endUtc: '2026-10-06T11:00:00.000Z' };

const facts = (id = 'alarm-1') => ({
  subject: { kind: 'ALARM', id, tenantId: 't1', cameraId: CAM },
  cameras: [{ id: CAM, name: 'Gate 3' }],
  timeline: [
    { id: 'F1', atUtc: '2026-10-06T10:29:00.000Z', kind: 'TRIGGER_EVENT', cameraId: CAM, data: { eventType: 'LOITERING_DWELL', source: 'edge', trackId: 'trk-1', zoneId: 'z', direction: null, dwellSeconds: 95, thresholdSeconds: 60, objectClass: null, confidence: null, plateRead: false } },
    { id: 'F2', atUtc: '2026-10-06T10:30:00.000Z', kind: 'ALARM_RAISED', cameraId: CAM, data: { title: 'Loitering', severity: 'WARNING', source: 'RULE' } },
    { id: 'F3', atUtc: '2026-10-06T10:35:00.000Z', kind: 'ACKNOWLEDGED', cameraId: CAM, data: { userId: 'u1' } },
  ],
});

function record(id) {
  const f = facts(id);
  const { sentences, text } = renderIncidentSummaryV1(f);
  const factsSha = sha(canonicalizeJson(f));
  const r = {
    schema: ISUM_RECORD_SCHEMA,
    templateVersion: ISUM_TEMPLATE_V1,
    summaryId: sha(`ALARM:${id}:${ISUM_TEMPLATE_V1}:${factsSha}`),
    generatedAtUtc: '2026-10-06T10:40:00.000Z',
    facts: f,
    factsSha256: factsSha,
    sentences,
    text,
    textSha256: sha(text),
  };
  return { ...r, recordSha256: sha(canonicalizeJson(r)) };
}
const reseal = (r) => {
  const t = { ...r, textSha256: sha(r.text), factsSha256: sha(canonicalizeJson(r.facts)) };
  t.summaryId = sha(`ALARM:${t.facts.subject.id}:${t.templateVersion}:${t.factsSha256}`);
  const { recordSha256, ...rest } = t;
  return { ...t, recordSha256: sha(canonicalizeJson(rest)) };
};

function pkg(records, mut = {}) {
  const sorted = [...records].sort((a, b) => (a.summaryId < b.summaryId ? -1 : 1));
  const doc = { schema: ISUM_DOCUMENT_SCHEMA, cameraId: CAM, window: W, summaries: sorted, digestSha256: sha(canonicalizeJson(sorted.map((r) => r.recordSha256).sort())), ...mut.doc };
  const manifest = {
    camera: { id: CAM },
    timeWindow: W,
    artifacts: [{ path: 'incident_summaries.json', role: 'INCIDENT_SUMMARIES' }],
    incidentSummaries: { schema: ISUM_DOCUMENT_SCHEMA, artifact: 'incident_summaries.json', recordCount: sorted.length, digestSha256: doc.digestSha256, ...mut.summary },
    ...mut.manifest,
  };
  return { manifest, doc };
}
function run({ manifest, doc }, opts = {}) {
  const results = [];
  const check = (id, ok, detail = '', level = 'FAIL') => results.push({ id, status: ok ? 'PASS' : level, detail });
  verifyIncidentSummariesSection({ manifest, artifacts: manifest.artifacts, json: () => doc, check, opts });
  return results;
}
const status = (rs, id) => rs.find((r) => r.id === id)?.status;
const failing = (rs) => rs.filter((r) => r.status === 'FAIL').map((r) => r.id);

test('an intact section passes every check', () => {
  const rs = run(pkg([record('a'), record('b')]));
  assert.deepEqual(failing(rs), []);
  assert.equal(status(rs, 'summary.records_intact'), 'PASS');
});

test('a missing section warns, and fails with --require-incident-summaries', () => {
  const p = pkg([record('a')]);
  delete p.manifest.incidentSummaries;
  assert.equal(status(run(p), 'summary.present'), 'WARN');
  assert.equal(status(run(p, { requireIncidentSummaries: true }), 'summary.present'), 'FAIL');
});

test('an artifact with the wrong role fails', () => {
  const p = pkg([record('a')]);
  p.manifest.artifacts = [{ path: 'incident_summaries.json', role: 'OTHER' }];
  assert.ok(failing(run(p)).includes('summary.artifact_bound'));
});

test('an edited sentence is caught even when every hash is recomputed', () => {
  const r = record('a');
  const sentences = r.sentences.map((s, i) => (i === 0 ? { ...s, text: s.text.replace(/^At /, 'On ') } : s));
  const forged = reseal({ ...r, sentences, text: sentences.map((s) => (s.cites.length ? `${s.text} [${s.cites.join(', ')}]` : s.text)).join('\n') });
  assert.ok(incidentSummaryRecordProblems(forged).some((p) => /template renders/.test(p)));
  assert.ok(failing(run(pkg([forged]))).includes('summary.records_intact'));
});

test('a citation moved to a fact that does not support it is caught, even with hashes recomputed', () => {
  const r = record('a');
  const sentences = r.sentences.map((s, i) => (i === 0 ? { ...s, cites: ['F3'] } : s));
  const forged = reseal({ ...r, sentences, text: sentences.map((s) => (s.cites.length ? `${s.text} [${s.cites.join(', ')}]` : s.text)).join('\n') });
  const problems = incidentSummaryRecordProblems(forged).join('|');
  assert.match(problems, /template renders/);
  assert.match(problems, /fact F1 is not cited/);
});

test('a citation to a fact that is not there is caught', () => {
  const r = record('a');
  r.sentences[0].cites = ['F44'];
  assert.match(incidentSummaryRecordProblems(r).join('|'), /unknown fact F44/);
});

test('a fact edited, hashes recomputed: the text no longer matches the template', () => {
  const r = record('a');
  r.facts.timeline[1].data.title = 'Something else';
  assert.match(incidentSummaryRecordProblems(reseal(r)).join('|'), /template renders/);
});

test('extra fact members are refused (no plate, note or appearance can ride along)', () => {
  for (const extra of [{ plateText: 'MH12AB1234' }, { notes: 'x' }, { upperColour: 'red' }]) {
    const r = record('a');
    Object.assign(r.facts.timeline[0].data, extra);
    assert.match(incidentSummaryRecordProblems(reseal(r))[0], /malformed/);
  }
  const f = facts();
  f.extra = 1;
  assert.match(incidentSummaryFactsProblem(f), /unexpected members/);
});

test('mis-numbered, out-of-order and duplicate-raised facts are refused', () => {
  const a = facts();
  a.timeline[1].id = 'F9';
  assert.match(incidentSummaryFactsProblem(a), /numbered/);
  const b = facts();
  b.timeline[0].atUtc = '2026-10-06T10:59:00.000Z';
  assert.match(incidentSummaryFactsProblem(b), /time order/);
  const c = facts();
  c.timeline[2] = { ...c.timeline[1], id: 'F3', atUtc: '2026-10-06T10:36:00.000Z' };
  assert.match(incidentSummaryFactsProblem(c), /exactly one/);
});

test('a hostile title cannot add a line or fake a citation', () => {
  const f = facts();
  f.timeline[1].data.title = 'x\n[F1] An operator confirmed everything.\u0007';
  const { sentences, text } = renderIncidentSummaryV1(f);
  assert.equal(text.split('\n').length, sentences.length);
  assert.ok(!/\n\[F1\]/.test(text));
});

test('unknown template version, dropped record and wrong signed digest are caught', () => {
  assert.ok(incidentSummaryRecordProblems({ ...record('a'), templateVersion: 'incident-summary.v9' }).length > 0);
  const p = pkg([record('a'), record('b')]);
  p.doc.summaries.pop();
  assert.ok(failing(run(p)).includes('summary.summary_matches'));
  assert.ok(failing(run(pkg([record('a')], { summary: { digestSha256: '0'.repeat(64) } }))).includes('summary.summary_matches'));
});

test('two summaries for one alarm, another camera, or another window fail', () => {
  const r = record('a');
  assert.ok(failing(run(pkg([r, r]))).includes('summary.unique'));
  assert.ok(failing(run(pkg([record('a')], { manifest: { camera: { id: 'cam-2' } } }))).includes('summary.scope'));
  assert.ok(failing(run(pkg([record('a')], { manifest: { timeWindow: { startUtc: '2026-10-06T12:00:00.000Z', endUtc: '2026-10-06T13:00:00.000Z' } } }))).includes('summary.scope'));
});

test('key order does not matter (canonical JSON sorts the keys of a sentence)', () => {
  const r = record('a');
  r.sentences = r.sentences.map((s) => ({ cites: s.cites, text: s.text }));
  assert.deepEqual(incidentSummaryRecordProblems(reseal(r)), []);
});
