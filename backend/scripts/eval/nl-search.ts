/**
 * Scores plain-language search on the labelled sets in src/__tests__/fixtures/nl-search/.
 *
 *   npx ts-node scripts/eval/nl-search.ts                         # rules only, every set
 *   npx ts-node scripts/eval/nl-search.ts --rewrite-url http://127.0.0.1:7015 --model-id <registered id>
 *                                                                  # with the query-rewrite adapter
 *   ... --set holdout-2 --json out.json
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { evaluate, LabelledSet } from '../../src/services/search/queryParserEval';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const dir = path.resolve(__dirname, '../../src/__tests__/fixtures/nl-search');
const sets = arg('set') ? [arg('set')!] : fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
const url = arg('rewrite-url');
const modelId = arg('model-id');

const rewriteMs: number[] = [];
/** The adapter call the product makes: the request and the site's camera and zone names. */
const rewriterFor = (set: LabelledSet) => async (text: string): Promise<string> => {
  const t0 = Date.now();
  const r = await fetch(`${url}/v1/rewrite-text`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contract: 'ai-adapter.v1', requestId: crypto.randomUUID(), tenantId: 'eval', modelId, text, vocabulary: [...set.cameras, ...set.zones], deadlineMs: 30000 }),
  });
  const j: any = await r.json();
  rewriteMs.push(Date.now() - t0);
  if (j.status !== 'ok') throw new Error(`rewrite failed: ${j.errorCode} ${j.message}`);
  return j.rewrite.text;
};

(async () => {
  const out: Record<string, unknown> = {};
  for (const name of sets) {
    const set = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8')) as LabelledSet;
    const t0 = Date.now();
    const r = await evaluate(set, url ? rewriterFor(set) : undefined);
    out[name] = { ...r, ms: Date.now() - t0 };
    console.log(`${name}: ${r.fullyRight}/${r.cases} fully right, field accuracy ${r.fieldAccuracy}, ${r.rewrites} rewritten`);
    for (const m of r.misses) console.log(`   ${m.q}  ->  ${m.read}\n      ${m.wrong.join('\n      ')}`);
  }
  if (rewriteMs.length) {
    rewriteMs.sort((a, b) => a - b);
    out.rewriteMs = { count: rewriteMs.length, median: rewriteMs[Math.floor(rewriteMs.length / 2)], max: rewriteMs[rewriteMs.length - 1] };
    console.log(`rewrites: ${rewriteMs.length}, median ${out.rewriteMs && (out.rewriteMs as any).median} ms, max ${rewriteMs[rewriteMs.length - 1]} ms`);
  }
  if (arg('json')) fs.writeFileSync(arg('json')!, JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
