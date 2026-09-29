// node --test tools/vigilone-verify/explanations.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { canonicalizeJson, renderExplanationV1, verifyExplanationsSection, explanationRecordProblems, EXPLAIN_RECORD_SCHEMA, EXPLAIN_DOCUMENT_SCHEMA, EXPLAIN_TEMPLATE_V1 } from './vigilone-verify.mjs';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const CAM = 'cam-1';
const W = { startUtc: '2026-09-29T10:00:00.000Z', endUtc: '2026-09-29T11:00:00.000Z' };

const facts = (id = 'alarm-1') => ({
  subject: { kind: 'ALARM', id, tenantId: 't1', cameraId: CAM },
  alarm: { title: 'Tripwire', severity: 'HIGH', triggeredAtUtc: '2026-09-29T10:30:00.000Z' },
  trigger: { eventId: 'ev1', type: 'TRIPWIRE_CROSS', source: 'edge', timestampUtc: '2026-09-29T10:30:00.000Z', severity: 'HIGH', payload: { direction: 'IN' } },
  rule: null,
  models: [{ name: 'yolo', version: '1', sha256: 'a'.repeat(64), task: 'detect', evaluated: true }],
  detections: [{ id: 'd1', label: 'person', confidence: 0.9, frameTimestampUtc: '2026-09-29T10:30:00.000Z', modelSha256: 'a'.repeat(64) }],
  correlated: [],
  cameraClock: { status: 'OK' },
});

function record(id) {
  const f = facts(id);
  const text = renderExplanationV1(f);
  const r = {
    schema: EXPLAIN_RECORD_SCHEMA,
    explanationId: sha(`ALARM:${id}:${EXPLAIN_TEMPLATE_V1}`),
    templateVersion: EXPLAIN_TEMPLATE_V1,
    generatedAtUtc: '2026-09-29T10:31:00.000Z',
    facts: f,
    factsSha256: sha(canonicalizeJson(f)),
    text,
    textSha256: sha(text),
  };
  return { ...r, recordSha256: sha(canonicalizeJson(r)) };
}

function pkg(records, mut = {}) {
  const sorted = [...records].sort((a, b) => (a.explanationId < b.explanationId ? -1 : 1));
  const doc = {
    schema: EXPLAIN_DOCUMENT_SCHEMA,
    cameraId: CAM,
    window: W,
    explanations: sorted,
    digestSha256: sha(canonicalizeJson(sorted.map((r) => r.recordSha256).sort())),
    ...mut.doc,
  };
  const manifest = {
    camera: { id: CAM },
    timeWindow: W,
    artifacts: [{ path: 'explanations.json', role: 'EXPLANATIONS' }],
    explanations: { schema: EXPLAIN_DOCUMENT_SCHEMA, artifact: 'explanations.json', recordCount: sorted.length, digestSha256: doc.digestSha256, ...mut.summary },
    ...mut.manifest,
  };
  return { manifest, doc };
}

function run({ manifest, doc }, opts = {}) {
  const results = [];
  const check = (id, ok, detail = '', level = 'FAIL') => results.push({ id, status: ok ? 'PASS' : level, detail });
  const warn = (id, detail) => results.push({ id, status: 'WARN', detail });
  verifyExplanationsSection({ manifest, artifacts: manifest.artifacts, json: () => doc, check, warn, opts });
  return results;
}
const status = (rs, id) => rs.find((r) => r.id === id)?.status;
const failing = (rs) => rs.filter((r) => r.status === 'FAIL').map((r) => r.id);

test('an intact section passes every check', () => {
  const rs = run(pkg([record('a'), record('b')]));
  assert.deepEqual(failing(rs), []);
  assert.equal(status(rs, 'explain.records_intact'), 'PASS');
});

test('a missing section warns, and fails with --require-explanations', () => {
  const p = pkg([record('a')]);
  delete p.manifest.explanations;
  assert.equal(status(run(p), 'explain.present'), 'WARN');
  assert.equal(status(run(p, { requireExplanations: true }), 'explain.present'), 'FAIL');
});

test('unbound artifact fails', () => {
  const p = pkg([record('a')]);
  p.manifest.artifacts = [{ path: 'explanations.json', role: 'OTHER' }];
  assert.ok(failing(run(p)).includes('explain.artifact_bound'));
});

test('edited text is caught even when hashes are recomputed', () => {
  const r = record('a');
  const text = r.text.replace('was raised at', 'was created at');
  const t = { ...r, text, textSha256: sha(text) };
  const { recordSha256, ...rest } = t;
  const forged = { ...t, recordSha256: sha(canonicalizeJson(rest)) };
  assert.ok(explanationRecordProblems(forged).some((p) => /template renders/.test(p)));
  assert.ok(failing(run(pkg([forged]))).includes('explain.records_intact'));
});

test('edited facts without rehash are caught', () => {
  const r = record('a');
  r.facts.alarm.severity = 'LOW';
  assert.ok(failing(run(pkg([r]))).includes('explain.records_intact'));
});

test('unknown template version is caught', () => {
  const r = { ...record('a'), templateVersion: 'explain-template.v9' };
  assert.ok(explanationRecordProblems(r).length > 0);
});

test('extra fact members are refused', () => {
  const r = record('a');
  r.facts.extra = 1;
  assert.match(explanationRecordProblems(r)[0], /unexpected members/);
});

test('dropping a record breaks the summary', () => {
  const p = pkg([record('a'), record('b')]);
  p.doc.explanations.pop();
  assert.ok(failing(run(p)).includes('explain.summary_matches'));
});

test('a wrong signed digest breaks the summary', () => {
  assert.ok(failing(run(pkg([record('a')], { summary: { digestSha256: '0'.repeat(64) } }))).includes('explain.summary_matches'));
});

test('duplicates fail', () => {
  const r = record('a');
  const p = pkg([r, r]);
  assert.ok(failing(run(p)).includes('explain.unique'));
});

test('another camera or window fails scope', () => {
  const p = pkg([record('a')], { manifest: { camera: { id: 'cam-2' } } });
  assert.ok(failing(run(p)).includes('explain.scope'));
  const q = pkg([record('a')], { manifest: { timeWindow: { startUtc: '2026-09-29T12:00:00.000Z', endUtc: '2026-09-29T13:00:00.000Z' } } });
  assert.ok(failing(run(q)).includes('explain.scope'));
});

test('model missing from AI provenance is a warning, not a failure', () => {
  const p = pkg([record('a')], { manifest: { aiProvenance: { models: [] } } });
  const rs = run(p);
  assert.equal(status(rs, 'explain.models_in_ai_provenance'), 'WARN');
  assert.deepEqual(failing(rs), []);
});
