/**
 * Dependency licence gate (action plan: "every new dependency ... must pass the licence gate").
 *
 * Reads the committed package-lock.json of backend, frontend, services/ai-worker and tools/sim/oidc and checks
 * every production (non-dev) package against the policy: MIT, Apache-2.0, BSD-2-Clause,
 * BSD-3-Clause, ISC. SPDX "A OR B" passes if any alternative is allowed; "A AND B" needs all.
 * Anything else must be listed in dependency-license-exceptions.json with a justification.
 * Copyleft (GPL, AGPL, LGPL, SSPL, CC-BY-NC) fails even if someone lists it as an exception.
 *
 *   npx ts-node scripts/ci/check-dependency-licenses.ts
 */
import fs from 'fs';
import path from 'path';

export const ALLOWED = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC']);
const FORBIDDEN = /(^|[^A-Z])(A?GPL|LGPL|SSPL|CC-BY-NC|BUSL|COMMONS-CLAUSE)/i;

export interface DependencyFinding {
  project: string;
  package: string;
  version: string;
  license: string;
  verdict: 'ALLOWED' | 'EXCEPTION' | 'FORBIDDEN' | 'UNLISTED';
}

/** Evaluates a (possibly compound) SPDX expression against the allowlist. */
export function spdxAllowed(expr: string): boolean {
  const e = expr.trim().replace(/^\((.*)\)$/, '$1').trim();
  if (/\sOR\s/i.test(e)) return e.split(/\s+OR\s+/i).some(spdxAllowed);
  if (/\sAND\s/i.test(e)) return e.split(/\s+AND\s+/i).every(spdxAllowed);
  return ALLOWED.has(e);
}

export function scanLockfile(project: string, lockPath: string, exceptions: any[]): DependencyFinding[] {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const out: DependencyFinding[] = [];
  for (const [p, meta] of Object.entries<any>(lock.packages || {})) {
    if (!p || meta.dev || meta.devOptional || meta.link) continue;
    const name = p.replace(/^.*node_modules\//, '');
    const raw = meta.license;
    const license = typeof raw === 'string' ? raw : raw ? JSON.stringify(raw) : 'UNDECLARED';
    let verdict: DependencyFinding['verdict'];
    if (FORBIDDEN.test(license)) verdict = 'FORBIDDEN';
    else if (spdxAllowed(license)) verdict = 'ALLOWED';
    else if (exceptions.some((x) => x.package === name && x.project === project && x.license === license)) verdict = 'EXCEPTION';
    else verdict = 'UNLISTED';
    out.push({ project, package: name, version: meta.version, license, verdict });
  }
  return out;
}

export function runDependencyLicenseGate(repoRoot = path.resolve(__dirname, '..', '..', '..')): boolean {
  const exceptions = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'dependency-license-exceptions.json'), 'utf8')
  ).exceptions;
  const projects: Array<[string, string]> = [
    ['backend', 'backend/package-lock.json'],
    ['frontend', 'frontend/package-lock.json'],
    ['services/ai-worker', 'services/ai-worker/package-lock.json'],
    // Test-only OIDC provider for the SSO tests (never shipped); audited so nothing unexpected enters CI.
    ['tools/sim/oidc', 'tools/sim/oidc/package-lock.json'],
  ];
  let ok = true;
  for (const [project, rel] of projects) {
    const lockPath = path.join(repoRoot, rel);
    if (!fs.existsSync(lockPath)) {
      console.error(`FAIL ${project}: ${rel} is missing (a lockfile is required to audit licences)`);
      ok = false;
      continue;
    }
    const findings = scanLockfile(project, lockPath, exceptions);
    const bad = findings.filter((f) => f.verdict === 'FORBIDDEN' || f.verdict === 'UNLISTED');
    const exc = findings.filter((f) => f.verdict === 'EXCEPTION');
    console.log(
      `${project}: ${findings.length} production packages, ${findings.length - exc.length - bad.length} allowed, ` +
        `${exc.length} listed exceptions, ${bad.length} violations`
    );
    for (const f of exc) console.log(`  exception: ${f.package}@${f.version} (${f.license})`);
    for (const f of bad) {
      console.error(`  ${f.verdict}: ${f.package}@${f.version} licence '${f.license}'`);
      ok = false;
    }
  }
  return ok;
}

if (require.main === module) {
  const ok = runDependencyLicenseGate();
  console.log(ok ? 'Dependency licence gate passed.' : 'Dependency licence gate FAILED.');
  process.exit(ok ? 0 : 1);
}
