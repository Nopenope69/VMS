#!/usr/bin/env node
/**
 * Collects the rankings the crop-search API returns for a labelled query set, in the format
 * retrieval-eval.mjs scores. Dependency-free (Node 18+ fetch).
 *
 *   node tools/eval/retrieval-collect.mjs --labels labels.json --url http://appliance:4000 --token <JWT>
 *        [--k 20] [--include-persons --purpose SECURITY_INCIDENT_INVESTIGATION [--reference "case ref"]]
 *        [--model-sha <64 hex>] [--exact] [--out results.json]
 *
 * With track labels (vigilone.track-retrieval-labels.v1) it sends POST /api/v1/tracks/search instead (each query by
 * `text` or `queryCropId`, with its optional `filters`) and writes vigilone.track-retrieval-results.v1 with the
 * ranked track ids.
 *
 * It sends one POST /api/v1/search/crops per labelled query (by cropId) and writes
 * { schema: vigilone.retrieval-results.v1, modelSha256, queries: [{ id, ranked: [cropId...] }] }.
 * It stops on the first problem and writes nothing: a failed or refused query, a query whose answer
 * came from a different model than the others, or a malformed answer. A partial results file would
 * quietly score as zeros, so there is no partial file.
 */
import fs from 'fs';
import { pathToFileURL } from 'url';

export class CollectError extends Error {}
const fail = (m) => {
  throw new CollectError(m);
};

export async function collect(labels, { url, token, k = 20, includePersons = false, purpose, reference, modelSha, exact = false, fetchImpl = fetch }) {
  const trackMode = labels?.schema === 'vigilone.track-retrieval-labels.v1';
  if ((!trackMode && labels?.schema !== 'vigilone.retrieval-labels.v1') || !Array.isArray(labels.queries) || labels.queries.length === 0) {
    fail('labels must be vigilone.retrieval-labels.v1 or vigilone.track-retrieval-labels.v1 with at least one query');
  }
  if (trackMode && (!Number.isInteger(k) || k < 1 || k > 50)) fail('--k must be a whole number from 1 to 50 for track search');
  if (!url || !token) fail('--url and --token are required');
  if (!Number.isInteger(k) || k < 1 || k > 100) fail('--k must be a whole number from 1 to 100');
  if (includePersons && !purpose) fail('--include-persons needs --purpose (person crops are purpose-limited and audited)');
  const endpoint = `${url.replace(/\/+$/, '')}${trackMode ? '/api/v1/tracks/search' : '/api/v1/search/crops'}`;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  if (purpose) headers['x-vigilone-purpose'] = purpose;
  if (reference) headers['x-vigilone-purpose-reference'] = reference;
  if (modelSha && !/^[a-f0-9]{64}$/.test(modelSha)) fail('--model-sha must be 64 lowercase hex characters');

  const queries = [];
  const modes = { ann: 0, exact: 0 };
  let seenModel = modelSha ?? null;
  for (const q of labels.queries) {
    if (typeof q.id !== 'string') fail('every labelled query needs an id');
    if (trackMode ? (typeof q.text === 'string') === (typeof q.queryCropId === 'string') : typeof q.queryCropId !== 'string') {
      fail(trackMode ? `query ${q.id} needs exactly one of text or queryCropId` : 'every labelled query needs an id and a queryCropId');
    }
    const what = trackMode && typeof q.text === 'string' ? { text: q.text } : { cropId: q.queryCropId };
    const body = { ...what, ...(trackMode && q.filters ? { filters: q.filters } : {}), limit: k, ...(includePersons ? { includePersons: true } : {}), ...(exact ? { exact: true } : {}), ...(modelSha ? { modelSha256: modelSha } : {}) };
    let res;
    try {
      res = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (e) {
      fail(`query ${q.id}: the search API is unreachable: ${e.message}`);
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* reported below */
    }
    if (!res.ok) fail(`query ${q.id}: HTTP ${res.status} ${json?.code ?? ''} ${json?.error ?? ''}`.trim());
    const answeredBy = trackMode ? json?.modelSha256 : json?.model?.sha256;
    const list = trackMode ? json?.results : json?.hits;
    if (!json || !Array.isArray(list) || !/^[a-f0-9]{64}$/.test(answeredBy ?? '')) fail(`query ${q.id}: the answer is not a search result with a model hash`);
    if (seenModel && answeredBy !== seenModel) fail(`query ${q.id}: answered by model ${answeredBy}, not ${seenModel}; rankings from different models cannot be scored together`);
    seenModel = answeredBy;
    modes[json.mode] = (modes[json.mode] ?? 0) + 1;
    queries.push({ id: q.id, ranked: trackMode ? list.map((r) => r.track?.id) : list.map((h) => h.cropId) });
    if (queries[queries.length - 1].ranked.some((x) => typeof x !== 'string')) fail(`query ${q.id}: a result has no ${trackMode ? 'track id' : 'crop id'}`);
  }
  return { schema: trackMode ? 'vigilone.track-retrieval-results.v1' : 'vigilone.retrieval-results.v1', modelSha256: seenModel, k, modes, collectedAtUtc: new Date().toISOString(), queries };
}

async function main() {
  const a = process.argv.slice(2);
  const get = (n) => {
    const i = a.indexOf(n);
    return i >= 0 ? a[i + 1] : undefined;
  };
  if (!get('--labels')) {
    console.error('usage: retrieval-collect.mjs --labels labels.json --url URL --token JWT [--k 20] [--include-persons --purpose P [--reference R]] [--model-sha HEX] [--exact] [--out results.json]');
    process.exit(2);
  }
  try {
    const out = await collect(JSON.parse(fs.readFileSync(get('--labels'), 'utf8')), {
      url: get('--url'),
      token: get('--token') ?? process.env.VIGILONE_TOKEN,
      k: get('--k') ? Number(get('--k')) : 20,
      includePersons: a.includes('--include-persons'),
      purpose: get('--purpose'),
      reference: get('--reference'),
      modelSha: get('--model-sha'),
      exact: a.includes('--exact'),
    });
    const text = JSON.stringify(out, null, 2) + '\n';
    if (get('--out')) fs.writeFileSync(get('--out'), text);
    else process.stdout.write(text);
    console.error(`collected ${out.queries.length} rankings from model ${out.modelSha256} (ann ${out.modes.ann ?? 0}, exact ${out.modes.exact ?? 0})`);
  } catch (e) {
    console.error(`retrieval-collect: ${e.message}`);
    process.exit(e instanceof CollectError ? 1 : 2);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
