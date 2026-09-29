import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { evaluate, MIN_QUERIES, RetrievalEvalError, wilson } from '../retrieval-eval.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHA = 'a'.repeat(64);
const labels = (queries) => ({ schema: 'vigilone.retrieval-labels.v1', queries });
const results = (queries) => ({ schema: 'vigilone.retrieval-results.v1', modelSha256: SHA, queries });
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

// Hand-computed set. q1: relevant {a,b}, ranking [x,a,y,b]  -> rank of first relevant 2, recall@1=0, @2=0.5, @4=1
//                    q2: relevant {c},   ranking [c,x]      -> rank 1, recall@1=1
//                    q3: relevant {d,e}, ranking [x,y,z]    -> nothing found
const L = labels([
  { id: 'q1', queryCropId: 'Q1', relevant: ['a', 'b'] },
  { id: 'q2', queryCropId: 'Q2', relevant: ['c'] },
  { id: 'q3', queryCropId: 'Q3', relevant: ['d', 'e'] },
]);
const R = results([
  { id: 'q1', ranked: ['x', 'a', 'y', 'b'] },
  { id: 'q2', ranked: ['c', 'x'] },
  { id: 'q3', ranked: ['x', 'y', 'z'] },
]);

test('recall@k, hit rate and MRR equal the hand-computed values', () => {
  const m = evaluate(L, R, { ks: [1, 2, 4] });
  close(m.k[1].recall, (0 + 1 + 0) / 3);
  close(m.k[2].recall, (0.5 + 1 + 0) / 3);
  close(m.k[4].recall, (1 + 1 + 0) / 3);
  close(m.k[1].hitRate, 1 / 3);
  close(m.k[4].hitRate, 2 / 3);
  close(m.mrr, (1 / 2 + 1 + 0) / 3);
  assert.deepEqual(m.perQuery.map((p) => p.firstRelevantRank), [2, 1, null]);
  assert.equal(m.queries, 3);
});

test('Wilson interval matches known values and is ordered around the proportion', () => {
  const w = wilson(8, 10);
  assert.ok(Math.abs(w.low - 0.4901625) < 1e-4 && Math.abs(w.high - 0.9433178) < 1e-4, JSON.stringify(w));
  assert.deepEqual(wilson(0, 0), { low: 0, high: 1 });
  const z = wilson(0, 20);
  assert.equal(z.low, 0);
  assert.ok(z.high > 0.1 && z.high < 0.2);
});

test('it never says EVALUATED without real site data and enough queries', () => {
  assert.match(evaluate(L, R).status, /NOT EVALUATED: not declared as real site data/);
  assert.match(evaluate(L, R, { realSiteData: true }).status, new RegExp(`only 3 labelled queries, at least ${MIN_QUERIES}`));
  const many = Array.from({ length: MIN_QUERIES }, (_, i) => ({ id: `q${i}`, queryCropId: `Q${i}`, relevant: [`r${i}`] }));
  const res = many.map((q) => ({ id: q.id, ranked: [q.relevant[0]] }));
  const m = evaluate(labels(many), results(res), { realSiteData: true });
  assert.equal(m.evaluated, true);
  assert.equal(m.status, 'EVALUATED');
  assert.equal(evaluate(labels(many), results(res), { realSiteData: false }).evaluated, false);
});

test('inputs that would flatter the score are refused, not skipped', () => {
  const bad = (labelsIn, resultsIn, re) => assert.throws(() => evaluate(labelsIn, resultsIn), (e) => e instanceof RetrievalEvalError && re.test(e.message));
  bad(L, results(R.queries.slice(0, 2)), /no results for labelled query q3/);
  bad(L, results([...R.queries, { id: 'q9', ranked: [] }]), /unknown query q9/);
  bad(L, results([...R.queries, R.queries[0]]), /twice/);
  bad(L, results([{ id: 'q1', ranked: ['Q1', 'a'] }, R.queries[1], R.queries[2]]), /contain the query crop itself/);
  bad(L, results([{ id: 'q1', ranked: ['a', 'a'] }, R.queries[1], R.queries[2]]), /contain a crop twice/);
  bad(labels([{ id: 'q1', queryCropId: 'Q1', relevant: [] }]), results([{ id: 'q1', ranked: [] }]), /no relevant crops/);
  bad(labels([{ id: 'q1', queryCropId: 'Q1', relevant: ['Q1'] }]), results([{ id: 'q1', ranked: [] }]), /relevant to itself/);
  bad(labels([{ id: 'q1', queryCropId: 'Q1', relevant: ['a', 'a'] }]), results([{ id: 'q1', ranked: [] }]), /relevant crop twice/);
  assert.throws(() => evaluate({ ...L, schema: 'x' }, R), /labels.schema/);
  assert.throws(() => evaluate(L, { ...R, modelSha256: 'nope' }), /modelSha256/);
  assert.throws(() => evaluate(L, R, { ks: [0] }), /positive integers/);
});

test('command line: writes metrics, prints the status, exits 1 on refused input and 2 on usage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reteval-'));
  try {
    const lf = path.join(dir, 'l.json');
    const rf = path.join(dir, 'r.json');
    const out = path.join(dir, 'm.json');
    fs.writeFileSync(lf, JSON.stringify(L));
    fs.writeFileSync(rf, JSON.stringify(R));
    const script = path.join(here, '..', 'retrieval-eval.mjs');
    const ok = spawnSync('node', [script, '--labels', lf, '--results', rf, '--k', '1,4', '--out', out], { encoding: 'utf8' });
    assert.equal(ok.status, 0);
    assert.match(ok.stderr, /NOT EVALUATED/);
    close(JSON.parse(fs.readFileSync(out, 'utf8')).k[4].recall, 2 / 3);
    fs.writeFileSync(rf, JSON.stringify(results(R.queries.slice(0, 1))));
    assert.equal(spawnSync('node', [script, '--labels', lf, '--results', rf], { encoding: 'utf8' }).status, 1);
    assert.equal(spawnSync('node', [script], { encoding: 'utf8' }).status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
