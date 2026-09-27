/**
 * CLI for the ai-adapter.v1 conformance kit.
 *   npm run conformance:ai-adapter -- --url http://127.0.0.1:7010 [--burst 16] [--allow-egress] [--json out.json]
 * Exit 0 when every check passes, 1 otherwise.
 */
import fs from 'fs';
import { runAiAdapterConformance } from '../../src/contracts/conformance/aiAdapterConformance';

async function main() {
  const args = process.argv.slice(2);
  const get = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const url = get('--url');
  if (!url) {
    console.error('usage: ai-adapter.ts --url <adapter base URL> [--burst N] [--allow-egress] [--json file]');
    process.exit(1);
  }
  const checks = await runAiAdapterConformance({
    baseUrl: url,
    burst: get('--burst') ? Number(get('--burst')) : undefined,
    airGapped: !args.includes('--allow-egress'),
  });
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
