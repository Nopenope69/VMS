#!/usr/bin/env node
// Turns a drill's check log (TSV: status \t name \t detail) into JSON + markdown.
// Statuses: PASS | FAIL | NOT_VERIFIED | INFO | MANUAL (INFO and MANUAL never decide the verdict;
// MANUAL items are listed for a human to sign off). Verdict: FAIL if any check failed; INCONCLUSIVE if any check could not be verified; else PASS.
// usage: fault-report.mjs <checks.tsv> <outDir> <drill> <target> <simulated:true|false> <startedIso>
import fs from 'node:fs';
import path from 'node:path';

const [tsv, outDir, drill, target, simulated, startedAtUtc] = process.argv.slice(2);
const checks = fs.existsSync(tsv)
  ? fs.readFileSync(tsv, 'utf8').split('\n').filter(Boolean).map((l) => {
      const [status, name, ...rest] = l.split('\t');
      return { status, name, detail: rest.join('\t') };
    })
  : [];
// INFO lines are measurements, not checks; they never decide the verdict.
const decisive = checks.filter((c) => c.status !== 'INFO' && c.status !== 'MANUAL');
const manual = checks.filter((c) => c.status === 'MANUAL').length;
const kind = process.env.REPORT_KIND || 'fault drill';
const schema = process.env.REPORT_SCHEMA || 'vigilone.fault-drill.v1';
const verdict = decisive.length === 0
  ? 'INCONCLUSIVE'
  : decisive.some((c) => c.status === 'FAIL') ? 'FAIL' : decisive.some((c) => c.status === 'NOT_VERIFIED') ? 'INCONCLUSIVE' : 'PASS';
const isSim = simulated === 'true';
const report = { schema, drill, target, simulated: isSim, startedAtUtc, finishedAtUtc: new Date().toISOString(), checks, verdict, manualItemsOutstanding: manual };
const base = `${isSim ? 'SIMULATED_' : ''}${startedAtUtc.replace(/[:.]/g, '-')}_${drill}`;
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `${base}.json`), JSON.stringify(report, null, 2) + '\n');
fs.writeFileSync(
  path.join(outDir, `${base}.md`),
  [
    `# ${isSim ? 'SIMULATED ' : ''}${kind}: ${drill}`,
    '',
    `Target: \`${target}\`. Verdict: **${verdict}**${manual ? ` (automated checks only; ${manual} manual item(s) need a human)` : ''}. ${startedAtUtc} to ${report.finishedAtUtc}.`,
    '',
    '| Check | Status | Detail |',
    '| --- | --- | --- |',
    ...checks.map((c) => `| ${c.name} | ${c.status} | ${c.detail.replace(/\|/g, '\\|')} |`),
    '',
  ].join('\n')
);
console.log(`[${kind}] ${drill}: ${verdict}${manual ? ` + ${manual} MANUAL` : ''} -> ${path.join(outDir, base)}.{json,md}`);
process.exit(verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 3);
