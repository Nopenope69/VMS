#!/usr/bin/env node
/**
 * Retrieval evaluation for crop search (Phase 5 exit gate): recall@k, hit@k and MRR of ranked results
 * against human-labelled relevant crops. Dependency-free.
 *
 *   node tools/eval/retrieval-eval.mjs --labels labels.json --results results.json [--k 1,5,10,20]
 *        [--real-site-data] [--dataset "Site X, 2026-10"] [--out metrics.json]
 *
 * labels.json  { "schema": "vigilone.retrieval-labels.v1",
 *                "queries": [ { "id": "q1", "queryCropId": "<crop>", "relevant": ["<crop>", ...] } ] }
 * results.json { "schema": "vigilone.retrieval-results.v1", "modelSha256": "<64 hex>",
 *                "queries": [ { "id": "q1", "ranked": ["<crop>", ...] } ] }   (best first, as the API returns them)
 *
 * Track mode (track search, North Star Bucket 2): labels `vigilone.track-retrieval-labels.v1` list relevant
 * TRACK ids per query (a query is `text` or a `queryCropId`), results `vigilone.track-retrieval-results.v1` rank
 * track ids. A crop query's own track (`queryTrackId`) is trivially found: it is removed from the ranking before
 * scoring (and counted), and may not be labelled relevant.
 *
 * The result is marked `evaluated: true` only with --real-site-data AND at least MIN_QUERIES labelled
 * queries; otherwise it says NOT EVALUATED and why. Inputs that would flatter the score are refused, not
 * skipped: a labelled query with no results, results for an unknown query, the query crop inside its own
 * ranking, duplicate crops in a ranking, or a query with nothing relevant.
 */
import fs from 'fs';
import { pathToFileURL } from 'url';

export const MIN_QUERIES = 100; // a proposal for a minimum, not an industry standard
const HEX64 = /^[a-f0-9]{64}$/;

export class RetrievalEvalError extends Error {}
const fail = (m) => {
  throw new RetrievalEvalError(m);
};

/** 95% Wilson score interval for k successes in n trials. */
export function wilson(k, n, z = 1.959963984540054) {
  if (n === 0) return { low: 0, high: 1 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { low: Math.max(0, c - h), high: Math.min(1, c + h) };
}

export function evaluate(labels, results, { ks = [1, 5, 10, 20], realSiteData = false, dataset = null } = {}) {
  const trackMode = labels?.schema === 'vigilone.track-retrieval-labels.v1';
  if (!trackMode && labels?.schema !== 'vigilone.retrieval-labels.v1') fail('labels.schema must be vigilone.retrieval-labels.v1 or vigilone.track-retrieval-labels.v1');
  const resultsSchema = trackMode ? 'vigilone.track-retrieval-results.v1' : 'vigilone.retrieval-results.v1';
  if (results?.schema !== resultsSchema) fail(`results.schema must be ${resultsSchema} for these labels`);
  if (!HEX64.test(results.modelSha256 ?? '')) fail('results.modelSha256 must be the SHA-256 of the embedding model that produced the rankings');
  if (!Array.isArray(labels.queries) || labels.queries.length === 0) fail('labels has no queries');
  if (!ks.length || ks.some((k) => !Number.isInteger(k) || k < 1)) fail('k values must be positive integers');

  const ranked = new Map();
  for (const r of results.queries ?? []) {
    if (ranked.has(r.id)) fail(`results list query ${r.id} twice`);
    ranked.set(r.id, r.ranked);
  }
  const ids = new Set();
  const per = [];
  const unit = trackMode ? 'track' : 'crop';
  let selfRemoved = 0;
  for (const q of labels.queries) {
    if (typeof q.id !== 'string' || !q.id) fail('a labelled query has no id');
    if (ids.has(q.id)) fail(`labels list query ${q.id} twice`);
    ids.add(q.id);
    if (trackMode && (typeof q.text === 'string') === (typeof q.queryCropId === 'string')) fail(`query ${q.id} needs exactly one of text or queryCropId`);
    if (!Array.isArray(q.relevant) || q.relevant.length === 0) fail(`query ${q.id} has no relevant ${unit}s; it cannot be scored`);
    const relevant = new Set(q.relevant);
    if (relevant.size !== q.relevant.length) fail(`query ${q.id} lists a relevant ${unit} twice`);
    const self = trackMode ? q.queryTrackId : q.queryCropId;
    if (self && relevant.has(self)) fail(`query ${q.id}: the query ${trackMode ? "crop's own track" : 'crop'} is listed as relevant to itself`);
    if (trackMode && q.queryCropId && !q.queryTrackId) fail(`query ${q.id}: a crop query needs queryTrackId (its own track, which is removed from the ranking)`);
    let list = ranked.get(q.id);
    if (!list) fail(`no results for labelled query ${q.id} (a missing answer is not a zero, and is not skipped)`);
    if (new Set(list).size !== list.length) fail(`results for ${q.id} contain a ${unit} twice`);
    if (trackMode) {
      if (self && list.includes(self)) {
        selfRemoved++;
        list = list.filter((t) => t !== self);
      }
    } else if (list.includes(q.queryCropId)) fail(`results for ${q.id} contain the query crop itself`);
    const at = {};
    for (const k of ks) {
      const top = new Set(list.slice(0, k));
      const found = [...relevant].filter((c) => top.has(c)).length;
      at[k] = { recall: found / relevant.size, hit: found > 0 };
    }
    const first = list.findIndex((c) => relevant.has(c));
    per.push({ id: q.id, relevant: relevant.size, returned: list.length, firstRelevantRank: first < 0 ? null : first + 1, at });
  }
  for (const id of ranked.keys()) if (!ids.has(id)) fail(`results for unknown query ${id}`);

  const n = per.length;
  const byK = {};
  for (const k of ks) {
    const hits = per.filter((p) => p.at[k].hit).length;
    byK[k] = { recall: per.reduce((s, p) => s + p.at[k].recall, 0) / n, hitRate: hits / n, hitRate95: wilson(hits, n) };
  }
  const evaluated = realSiteData && n >= MIN_QUERIES;
  return {
    schema: 'vigilone.retrieval-metrics.v1',
    mode: trackMode ? 'tracks' : 'crops',
    modelSha256: results.modelSha256,
    dataset,
    queries: n,
    k: byK,
    mrr: per.reduce((s, p) => s + (p.firstRelevantRank ? 1 / p.firstRelevantRank : 0), 0) / n,
    ...(trackMode ? { ownTracksRemoved: selfRemoved } : {}),
    evaluated,
    status: evaluated
      ? 'EVALUATED'
      : `NOT EVALUATED: ${!realSiteData ? 'not declared as real site data (--real-site-data)' : `only ${n} labelled queries, at least ${MIN_QUERIES} needed`}`,
    perQuery: per,
  };
}

function main() {
  const a = process.argv.slice(2);
  const get = (name) => {
    const i = a.indexOf(name);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const labelsPath = get('--labels');
  const resultsPath = get('--results');
  if (!labelsPath || !resultsPath) {
    console.error('usage: retrieval-eval.mjs --labels labels.json --results results.json [--k 1,5,10,20] [--real-site-data] [--dataset "name"] [--out metrics.json]');
    process.exit(2);
  }
  try {
    const m = evaluate(JSON.parse(fs.readFileSync(labelsPath, 'utf8')), JSON.parse(fs.readFileSync(resultsPath, 'utf8')), {
      ks: (get('--k') ?? '1,5,10,20').split(',').map(Number),
      realSiteData: a.includes('--real-site-data'),
      dataset: get('--dataset') ?? null,
    });
    const out = JSON.stringify(m, null, 2);
    if (get('--out')) fs.writeFileSync(get('--out'), out + '\n');
    else console.log(out);
    console.error(`${m.status}; ${m.queries} queries; ${Object.entries(m.k).map(([k, v]) => `recall@${k}=${v.recall.toFixed(3)}`).join(' ')}; MRR=${m.mrr.toFixed(3)}`);
  } catch (e) {
    console.error(`retrieval-eval: ${e.message}`);
    process.exit(e instanceof RetrievalEvalError ? 1 : 2);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
