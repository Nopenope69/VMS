// Track mode of the retrieval tools (track search, North Star Bucket 2): scoring ranked track ids against labelled
// relevant tracks, the query crop's own track removed before scoring, and the collector calling track search.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { collect, CollectError } from '../retrieval-collect.mjs';
import { evaluate, RetrievalEvalError } from '../retrieval-eval.mjs';

const SHA = 'a'.repeat(64);
const labels = {
  schema: 'vigilone.track-retrieval-labels.v1',
  queries: [
    { id: 'q1', text: 'white SUV at the gate', relevant: ['T1', 'T2'] },
    { id: 'q2', queryCropId: 'C9', queryTrackId: 'T9', relevant: ['T3'] },
  ],
};
const results = (q1, q2) => ({ schema: 'vigilone.track-retrieval-results.v1', modelSha256: SHA, queries: [{ id: 'q1', ranked: q1 }, { id: 'q2', ranked: q2 }] });

test('scores track rankings, removing the query crop\'s own track first', () => {
  // q1: T1 at rank 2, T2 at rank 4. q2: own track T9 first (removed), then T3 -> rank 1.
  const m = evaluate(labels, results(['X', 'T1', 'Y', 'T2'], ['T9', 'T3', 'Z']), { ks: [1, 2, 5] });
  assert.equal(m.mode, 'tracks');
  assert.equal(m.ownTracksRemoved, 1);
  assert.deepEqual(m.perQuery.map((p) => p.firstRelevantRank), [2, 1]);
  assert.equal(m.k[1].recall, (0 + 1) / 2);
  assert.equal(m.k[2].recall, (0.5 + 1) / 2);
  assert.equal(m.k[5].recall, 1);
  assert.equal(m.mrr, (1 / 2 + 1) / 2);
  assert.equal(m.evaluated, false);
});

test('refuses track labels that would flatter or cannot be scored', () => {
  const bad = (q) => () => evaluate({ ...labels, queries: [q] }, { ...results([], []), queries: [{ id: q.id, ranked: ['T1'] }] });
  assert.throws(bad({ id: 'a', text: 'x', queryCropId: 'C1', queryTrackId: 'T5', relevant: ['T1'] }), /exactly one of text or queryCropId/);
  assert.throws(bad({ id: 'a', queryCropId: 'C1', relevant: ['T1'] }), /needs queryTrackId/);
  assert.throws(bad({ id: 'a', queryCropId: 'C1', queryTrackId: 'T1', relevant: ['T1'] }), /own track.*relevant to itself/);
  assert.throws(() => evaluate(labels, { ...results([], []), schema: 'vigilone.retrieval-results.v1' }), RetrievalEvalError);
  assert.throws(() => evaluate(labels, { schema: 'vigilone.track-retrieval-results.v1', modelSha256: SHA, queries: [{ id: 'q1', ranked: ['T1'] }] }), /no results for labelled query q2/);
});

test('the collector sends text and crop queries with filters to track search and keeps the model consistent', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      seen.push({ url: req.url, body: JSON.parse(b), headers: req.headers });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ modelSha256: SHA, mode: 'exact', results: [{ track: { id: 'T1' } }, { track: { id: 'T2' } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const withFilters = { ...labels, queries: [{ ...labels.queries[0], filters: { cameraIds: ['cam-1'] } }, labels.queries[1]] };
    const out = await collect(withFilters, { url, token: 't', k: 10, includePersons: true, purpose: 'SECURITY_INCIDENT_INVESTIGATION' });
    assert.equal(out.schema, 'vigilone.track-retrieval-results.v1');
    assert.deepEqual(out.queries, [{ id: 'q1', ranked: ['T1', 'T2'] }, { id: 'q2', ranked: ['T1', 'T2'] }]);
    assert.ok(seen.every((s) => s.url === '/api/v1/tracks/search' && s.headers['x-vigilone-purpose'] === 'SECURITY_INCIDENT_INVESTIGATION'));
    assert.deepEqual(seen[0].body, { text: 'white SUV at the gate', filters: { cameraIds: ['cam-1'] }, limit: 10, includePersons: true });
    assert.deepEqual(seen[1].body, { cropId: 'C9', limit: 10, includePersons: true });
    await assert.rejects(collect(labels, { url, token: 't', k: 60 }), /from 1 to 50/);
    await assert.rejects(collect({ ...labels, queries: [{ id: 'x', relevant: ['T1'] }] }, { url, token: 't' }), CollectError);
  } finally {
    server.close();
  }
});
