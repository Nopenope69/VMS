import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { collect, CollectError } from '../retrieval-collect.mjs';
import { evaluate } from '../retrieval-eval.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHA = 'a'.repeat(64);
const SHA2 = 'b'.repeat(64);
const labels = { schema: 'vigilone.retrieval-labels.v1', queries: [
  { id: 'q1', queryCropId: 'C1', relevant: ['c2'] },
  { id: 'q2', queryCropId: 'C3', relevant: ['c4'] },
] };

/** A stub of POST /api/v1/search/crops. `behave(body, headers, n)` returns [status, json]. */
function stub(behave) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      seen.push({ url: req.url, headers: req.headers, body });
      const [status, json] = behave(body, req.headers, seen.length);
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(json));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}
const ok = (ids, sha = SHA, mode = 'ann') => [200, { model: { name: 'm', version: '1', sha256: sha }, mode, hits: ids.map((cropId) => ({ cropId, score: 0.9 })) }];

test('collects one ranking per labelled query, in the order returned, and the result scores with retrieval-eval', async () => {
  const s = await stub((body) => ok(body.cropId === 'C1' ? ['x', 'c2'] : ['c4']));
  try {
    const out = await collect(labels, { url: s.url + '/', token: 'T', k: 5 });
    assert.equal(out.schema, 'vigilone.retrieval-results.v1');
    assert.equal(out.modelSha256, SHA);
    assert.deepEqual(out.queries, [{ id: 'q1', ranked: ['x', 'c2'] }, { id: 'q2', ranked: ['c4'] }]);
    assert.deepEqual(s.seen.map((r) => r.body), [{ cropId: 'C1', limit: 5 }, { cropId: 'C3', limit: 5 }]);
    assert.equal(s.seen[0].headers.authorization, 'Bearer T');
    assert.equal(s.seen[0].url, '/api/v1/search/crops');
    const m = evaluate(labels, out, { ks: [1, 2] });
    assert.equal(m.k[2].recall, 1);
    assert.equal(m.k[1].recall, 0.5);
  } finally {
    s.server.close();
  }
});

test('sends the purpose headers and includePersons only when asked, and refuses persons without a purpose', async () => {
  const s = await stub(() => ok(['x']));
  try {
    await collect(labels, { url: s.url, token: 'T', includePersons: true, purpose: 'SECURITY_INCIDENT_INVESTIGATION', reference: 'FIR 1/2026', exact: true, modelSha: SHA });
    assert.equal(s.seen[0].headers['x-vigilone-purpose'], 'SECURITY_INCIDENT_INVESTIGATION');
    assert.equal(s.seen[0].headers['x-vigilone-purpose-reference'], 'FIR 1/2026');
    assert.deepEqual(s.seen[0].body, { cropId: 'C1', limit: 20, includePersons: true, exact: true, modelSha256: SHA });
    await assert.rejects(collect(labels, { url: s.url, token: 'T', includePersons: true }), /needs --purpose/);
  } finally {
    s.server.close();
  }
});

test('stops on the first refused or failed query and names it; nothing partial is returned', async () => {
  for (const [status, code] of [[403, 'PERSON_CROP_FORBIDDEN'], [404, 'EMBEDDING_NOT_FOUND'], [501, 'FEATURE_DISABLED'], [500, 'X']]) {
    const s = await stub((body, _h, n) => (n === 1 ? ok(['x']) : [status, { code, error: 'nope' }]));
    try {
      await assert.rejects(collect(labels, { url: s.url, token: 'T' }), (e) => e instanceof CollectError && new RegExp(`query q2: HTTP ${status} ${code}`).test(e.message));
    } finally {
      s.server.close();
    }
  }
  await assert.rejects(collect(labels, { url: 'http://127.0.0.1:1', token: 'T' }), /query q1: the search API is unreachable/);
});

test('refuses answers from different models, malformed answers and bad arguments', async () => {
  let s = await stub((_b, _h, n) => ok(['x'], n === 1 ? SHA : SHA2));
  try {
    await assert.rejects(collect(labels, { url: s.url, token: 'T' }), /answered by model b+, not a+/);
  } finally {
    s.server.close();
  }
  s = await stub(() => [200, { hits: 'nope' }]);
  try {
    await assert.rejects(collect(labels, { url: s.url, token: 'T' }), /not a search result with a model hash/);
    await assert.rejects(collect(labels, { url: s.url, token: 'T', modelSha: 'abc' }), /--model-sha/);
  } finally {
    s.server.close();
  }
  await assert.rejects(collect({ schema: 'x', queries: [] }, { url: 'u', token: 't' }), /vigilone.retrieval-labels.v1/);
  await assert.rejects(collect(labels, { url: 'http://x' }), /--url and --token/);
  await assert.rejects(collect(labels, { url: 'http://x', token: 't', k: 0 }), /--k/);
});

test('command line: writes the results file, reads the token from the environment, exits 1 on a refused query and 2 on usage', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retcollect-'));
  const s = await stub((body) => (body.cropId === 'C1' ? ok(['x', 'c2'], SHA, 'exact') : ok(['c4'])));
  try {
    const lf = path.join(dir, 'l.json');
    const out = path.join(dir, 'r.json');
    fs.writeFileSync(lf, JSON.stringify(labels));
    const script = path.join(here, '..', 'retrieval-collect.mjs');
    const run = (args, env = {}) =>
      new Promise((resolve) => {
        const p = spawn('node', [script, ...args], { env: { ...process.env, ...env } });
        let err = '';
        p.stderr.on('data', (c) => (err += c));
        p.on('close', (code) => resolve({ code, err }));
      });
    const good = await run(['--labels', lf, '--url', s.url, '--out', out], { VIGILONE_TOKEN: 'ENVTOKEN' });
    assert.equal(good.code, 0, good.err);
    assert.match(good.err, /collected 2 rankings from model a+ \(ann 1, exact 1\)/);
    assert.equal(s.seen[0].headers.authorization, 'Bearer ENVTOKEN');
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')).queries[0], { id: 'q1', ranked: ['x', 'c2'] });
    fs.rmSync(out);
    const noToken = await run(['--labels', lf, '--url', s.url, '--out', out], { VIGILONE_TOKEN: '' });
    assert.equal(noToken.code, 1);
    assert.equal(fs.existsSync(out), false); // nothing partial
    assert.equal((await run([])).code, 2);
  } finally {
    s.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
