#!/usr/bin/env node
/**
 * vigilone-adapter-conformance --url http://127.0.0.1:7010 [--burst 16] [--allow-egress] [--json out.json]
 * The same black-box checks VigilOne runs against its own worker. Exit 0 when every check passes.
 */
import fs from 'fs';
import { runAiAdapterConformance } from '../contract/conformance/aiAdapterConformance';

async function main() {
  const args = process.argv.slice(2);
  const get = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const url = get('--url');
  if (!url) {
    console.error('usage: vigilone-adapter-conformance --url <adapter base URL> [--burst N] [--allow-egress] [--json file]');
    process.exit(2);
  }
  const checks = await runAiAdapterConformance({ baseUrl: url, burst: get('--burst') ? Number(get('--burst')) : undefined, airGapped: !args.includes('--allow-egress') });
  for (const c of checks) console.log(`${c.passed ? 'PASS' : 'FAIL'}  ${c.id.padEnd(32)} ${c.description}${c.detail ? `  [${c.detail.trim()}]` : ''}`);
  const failed = checks.filter((c) => !c.passed).length;
  console.log(`\nai-adapter.v1 conformance: ${checks.length - failed}/${checks.length} checks passed against ${url}`);
  const out = get('--json');
  if (out) fs.writeFileSync(out, JSON.stringify({ url, at: new Date().toISOString(), checks }, null, 2) + '\n');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('conformance run failed:', e?.message || e);
  process.exit(1);
});
