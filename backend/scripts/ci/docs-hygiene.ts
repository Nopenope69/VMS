/**
 * P0.6 documentation hygiene, run by check-repo-hygiene.ts (`npm run check:hygiene`).
 *
 *  1. No leaked local developer paths (/Users/<name>, /home/<name>, C:\Users\...) in tracked text.
 *  2. No file:/// links in Markdown (they point at someone's machine, not the repo).
 *  3. Self-authored verification/sign-off documents carry the INTERNAL SELF-ASSESSMENT marker,
 *     so nothing reads as an independent audit, certification or legal opinion.
 *  4. No hand-typed test pass counts in living docs; counts come from docs/generated/ (P0.5).
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

export interface DocsHygieneViolation {
  category: string;
  file: string;
  message: string;
}

export const SELF_ASSESSMENT_MARKER = 'INTERNAL SELF-ASSESSMENT.';

/** Historical critique documents that quote earlier leaks/claims verbatim as evidence. */
export const QUOTING_ALLOWLIST = [
  'docs/audits/CRITIQUE_DETAILED_AND_PATH_FORWARD_2026-09-11.md',
  'docs/audits/CRITIQUE_FOLLOWUP_2026-09-13.md',
  'docs/audits/CRITIQUE_REMEDIATION_VERIFICATION_2026-09-13.md',
];

/** Process/plan documents that describe sign-off roles without claiming any sign-off happened. */
export const PROCESS_DOC_ALLOWLIST = ['docs/audits/MASTER_COMMERCIALIZATION_EXECUTION_CONTRACT.md'];

const LOCAL_PATH = /\/Users\/[A-Za-z][\w.-]*\/|\/home\/(?!runner\/)[a-z][\w.-]*\/|[A-Z]:\\Users\\/;
const FILE_URL_LINK = /\]\(file:\/\//;
const SIGN_OFF_VOCAB =
  /independent(ly)?\s+verif|verification\s+gate|sign[- ]?off|signed\s+off|certified\s+by|approved\s+by|legal\s+opinion|attested\s+by/i;
const HAND_TYPED_COUNT =
  /\b\d+\s*\/\s*\d+\s+tests?\b|\b\d+\s+tests?\s+(passing|passed)\b|\b\d+\s+(test\s+)?suites?\s+(passing|passed)\b/i;

/** Living docs where test counts must never be typed by hand. */
const LIVING_DOCS = ['README.md', 'PROJECT_STATE.md', 'CONTEXT.md'];
const LIVING_DOC_DIRS = ['docs/operations', 'docs/contracts', 'docs/adr'];

function trackedFiles(repoRoot: string): string[] {
  try {
    return execSync('git ls-files', { cwd: repoRoot, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    const walk = (dir: string): string[] =>
      fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true }).flatMap((e) => {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) return ['node_modules', '.git', 'dist'].includes(e.name) ? [] : walk(rel);
        return [rel];
      });
    return walk('');
  }
}

function stripGeneratedBlocks(content: string): string {
  return content
    .replace(/<!-- TEST_STATUS:START[\s\S]*?<!-- TEST_STATUS:END -->/g, '')
    .replace(/<!-- FEATURE_FLAGS:START[\s\S]*?<!-- FEATURE_FLAGS:END -->/g, '');
}

export function runDocsHygiene(repoRoot: string): DocsHygieneViolation[] {
  const violations: DocsHygieneViolation[] = [];
  const files = trackedFiles(repoRoot).filter(
    (f) => /\.(md|ts|tsx|js|mjs|json|ya?ml|sh|txt)$/.test(f) && !/package-lock\.json$/.test(f) && fs.existsSync(path.join(repoRoot, f))
  );

  for (const rel of files) {
    const content = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const isQuoting = QUOTING_ALLOWLIST.includes(rel);
    const isSelf = rel === 'backend/scripts/ci/docs-hygiene.ts' || rel.endsWith('__tests__/docsHygiene.test.ts');

    if (!isQuoting && !isSelf) {
      const lines = content.split('\n');
      lines.forEach((line, i) => {
        if (LOCAL_PATH.test(line)) {
          violations.push({ category: 'Leaked Local Path', file: `${rel}:${i + 1}`, message: line.trim().slice(0, 160) });
        }
      });
    }

    if (!rel.endsWith('.md')) continue;

    if (!isQuoting && FILE_URL_LINK.test(content)) {
      violations.push({ category: 'Local file:// Link', file: rel, message: 'Markdown links to file:///; use a repo-relative path or inline code.' });
    }

    const isSelfAuthoredEvidence =
      /^docs\/audits\/STAGE_\d+_VERIFICATION_EVIDENCE\.md$/.test(rel) ||
      rel.startsWith('docs/operations/LEGAL_') ||
      // Audit/evidence docs are where claims of verification live. Operational templates with blank
      // customer sign-off fields (handover, acceptance checklist) are not claims and are exempt.
      (rel.startsWith('docs/audits/') &&
        SIGN_OFF_VOCAB.test(content) &&
        !QUOTING_ALLOWLIST.includes(rel) &&
        !PROCESS_DOC_ALLOWLIST.includes(rel));
    if (isSelfAuthoredEvidence && !content.includes(SELF_ASSESSMENT_MARKER)) {
      violations.push({
        category: 'Missing Self-Assessment Disclaimer',
        file: rel,
        message: `Uses verification/sign-off language but lacks the "${SELF_ASSESSMENT_MARKER}" disclaimer.`,
      });
    }

    const isLiving = LIVING_DOCS.includes(rel) || LIVING_DOC_DIRS.some((d) => rel.startsWith(`${d}/`));
    if (isLiving) {
      stripGeneratedBlocks(content)
        .split('\n')
        .forEach((line, i) => {
          if (HAND_TYPED_COUNT.test(line)) {
            violations.push({
              category: 'Hand-Typed Test Count',
              file: `${rel}:${i + 1}`,
              message: `Test counts must come from docs/generated/TEST_STATUS.md: "${line.trim().slice(0, 120)}"`,
            });
          }
        });
    }
  }
  return violations;
}
