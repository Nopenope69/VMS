/**
 * Fail-loud gate (P0.4). Scans runtime code (backend/src, services/ai-worker/src; tests excluded)
 * for patterns that have produced fake success before (docs/audits/SYSTEMIC_FAKE_SUCCESS_AUDIT_2026-09-12.md):
 * success literals inside catch blocks, mock/stub fallbacks, in-memory stand-ins for external
 * systems, non-production (rather than test-only) fallbacks, invented hashes, invented versions
 * and hard-coded model names.
 *
 * Every match must be listed in fake-success-allowlist.json with a justification. Entries are
 * keyed on file + pattern id + the trimmed line text, so editing a flagged line forces a re-review.
 *
 *   npm run check:no-fake-success
 *   npm run check:no-fake-success -- --print-allowlist-skeleton   # emit entries for new matches
 */
import fs from 'fs';
import path from 'path';

export interface PatternRule {
  id: string;
  description: string;
  regex: RegExp;
}

export interface Finding {
  file: string;
  line: number;
  patternId: string;
  text: string;
}

export interface AllowlistEntry {
  file: string;
  patternId: string;
  text: string;
  justification: string;
}

export const PATTERN_RULES: PatternRule[] = [
  {
    id: 'MOCK_OR_STUB_IDENTIFIER',
    description: 'mock/stub/fake/dummy identifiers or runtime names in runtime code',
    regex: /\b(mock|fake|dummy)[A-Z_]\w*|\b(mock|fake|stub)-[a-z]\w*|'test-stub'/,
  },
  {
    id: 'IN_MEMORY_EXTERNAL_STORE',
    description: 'in-memory stand-in for an external system (object store, device, queue)',
    regex: /\b(s3Store|inMemoryStore|fakeStore|memoryBucket)\b/,
  },
  {
    id: 'NON_TEST_ENV_FALLBACK',
    description: "behaviour switched on 'not production' or 'development' instead of NODE_ENV=test",
    // Matches process.env.NODE_ENV and setting('NODE_ENV') (config/settings.ts) alike.
    regex: /NODE_ENV(?:['"]\))?\s*!==?\s*['"]production['"]|NODE_ENV(?:['"]\))?\s*===?\s*['"]development['"]/,
  },
  {
    id: 'HARDCODED_CONFIRMATION',
    description: 'literal hardware/transport confirmation',
    regex: /\bconfirmed:\s*true\b/,
  },
  {
    id: 'INVENTED_HASH',
    description: 'all-zero or literal 64-hex hash',
    regex: /'0'\.repeat\(64\)|["'`]0{64}["'`]|["'`][0-9a-f]{64}["'`]/,
  },
  {
    id: 'INVENTED_VERSION',
    description: 'literal semantic version / firmware string',
    regex: /(firmwareVersion|modelVersion|version|Version)\s*[:=]\s*['"]\d+\.\d+\.\d+['"]/,
  },
  {
    id: 'HARDCODED_MODEL_NAME',
    description: 'hard-coded detector/model family name',
    regex: /\b(yolo[\w-]*|mobilenet[\w-]*|efficientdet[\w-]*|rt-?detr[\w-]*|rf-?detr[\w-]*|ssd_mobilenet[\w-]*)\b/i,
  },
  {
    id: 'SUCCESS_IN_CATCH',
    description: 'success literal returned from inside a catch block',
    // Evaluated by the catch-block scanner below, not line-by-line.
    regex: /(success|ok|confirmed|verified|healthy):\s*true\b|['"](COMPLETED|CONFIRMED|SUCCESS|VERIFIED)['"]|\.COMPLETED\b/,
  },
];

const SCAN_ROOTS = ['backend/src', 'services/ai-worker/src'];

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function listTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : listTsFiles(full);
    return e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') && !e.name.endsWith('.test.ts') ? [full] : [];
  });
}

/** Returns [startLine, endLine] (0-based, inclusive) of each catch block body. */
export function findCatchBlocks(lines: string[]): Array<[number, number]> {
  const blocks: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/\bcatch\s*(\([^)]*\))?\s*\{/.test(lines[i])) continue;
    let depth = 0;
    let started = false;
    for (let j = i; j < lines.length; j++) {
      const line = lines[j].replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');
      const startCol = j === i ? line.search(/\bcatch\b/) : 0;
      for (const ch of line.slice(startCol)) {
        if (ch === '{') {
          depth++;
          started = true;
        } else if (ch === '}') {
          depth--;
        }
      }
      if (started && depth <= 0) {
        blocks.push([i, j]);
        break;
      }
    }
  }
  return blocks;
}

export function scanSource(relFile: string, source: string): Finding[] {
  const lines = source.split('\n');
  const findings: Finding[] = [];
  const lineRules = PATTERN_RULES.filter((r) => r.id !== 'SUCCESS_IN_CATCH');
  lines.forEach((line, idx) => {
    if (isCommentLine(line)) return;
    for (const rule of lineRules) {
      if (rule.regex.test(line)) {
        findings.push({ file: relFile, line: idx + 1, patternId: rule.id, text: line.trim() });
      }
    }
  });
  const catchRule = PATTERN_RULES.find((r) => r.id === 'SUCCESS_IN_CATCH')!;
  for (const [start, end] of findCatchBlocks(lines)) {
    for (let k = start; k <= end; k++) {
      if (!isCommentLine(lines[k]) && catchRule.regex.test(lines[k])) {
        findings.push({ file: relFile, line: k + 1, patternId: catchRule.id, text: lines[k].trim() });
      }
    }
  }
  return findings;
}

export function scanRepo(repoRoot: string): Finding[] {
  const findings: Finding[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of listTsFiles(path.join(repoRoot, root))) {
      const rel = path.relative(repoRoot, file).split(path.sep).join('/');
      findings.push(...scanSource(rel, fs.readFileSync(file, 'utf8')));
    }
  }
  return findings;
}

const keyOf = (x: { file: string; patternId: string; text: string }) => `${x.file}::${x.patternId}::${x.text}`;

export function evaluate(findings: Finding[], allowlist: AllowlistEntry[]) {
  const allowed = new Map(allowlist.map((a) => [keyOf(a), a]));
  const unjustified = allowlist.filter((a) => !a.justification || a.justification.trim().length < 15);
  const violations = findings.filter((f) => !allowed.has(keyOf(f)));
  const findingKeys = new Set(findings.map(keyOf));
  const stale = allowlist.filter((a) => !findingKeys.has(keyOf(a)));
  return { violations, stale, unjustified };
}

function main() {
  const repoRoot = path.resolve(__dirname, '../../..');
  const allowlistPath = path.join(__dirname, 'fake-success-allowlist.json');
  const allowlist: AllowlistEntry[] = JSON.parse(fs.readFileSync(allowlistPath, 'utf8')).entries;
  const findings = scanRepo(repoRoot);
  const { violations, stale, unjustified } = evaluate(findings, allowlist);

  if (process.argv.includes('--print-allowlist-skeleton')) {
    console.log(
      JSON.stringify(
        violations.map((v) => ({ file: v.file, patternId: v.patternId, text: v.text, justification: 'TODO' })),
        null,
        2
      )
    );
    return;
  }

  console.log(`🔍 Fail-loud gate: ${findings.length} pattern matches, ${allowlist.length} allowlisted.`);
  let failed = false;
  if (violations.length > 0) {
    failed = true;
    console.error(`\n❌ ${violations.length} un-allowlisted fake-success pattern(s):`);
    for (const v of violations) {
      const rule = PATTERN_RULES.find((r) => r.id === v.patternId)!;
      console.error(`  ${v.file}:${v.line} [${v.patternId}] ${rule.description}\n      ${v.text}`);
    }
    console.error(
      '\nFix the code to fail closed, or (only if it is genuinely not fake success) add an entry with a justification to backend/scripts/ci/fake-success-allowlist.json.'
    );
  }
  if (unjustified.length > 0) {
    failed = true;
    console.error(`\n❌ ${unjustified.length} allowlist entr(y/ies) without a real justification (>= 15 chars).`);
  }
  if (stale.length > 0) {
    failed = true;
    console.error(`\n❌ ${stale.length} stale allowlist entr(y/ies) no longer match any code; remove them:`);
    for (const s of stale) console.error(`  ${s.file} [${s.patternId}] ${s.text}`);
  }
  if (failed) process.exit(1);
  console.log('✅ No un-allowlisted fake-success patterns.');
}

if (require.main === module) {
  main();
}
