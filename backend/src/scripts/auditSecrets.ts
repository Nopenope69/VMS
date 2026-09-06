import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

export interface AuditFinding {
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  check: string;
  message: string;
  remediation: string;
}

export interface SecretsAuditReport {
  passed: boolean;
  findings: AuditFinding[];
  timestamp: string;
}

export function runSecretsAudit(repoRoot: string): SecretsAuditReport {
  const findings: AuditFinding[] = [];

  // 1. Check if real .env files are tracked by Git
  try {
    const gitTracked = execSync('git ls-files', { cwd: repoRoot, encoding: 'utf8' });
    const trackedFiles = gitTracked.split('\n');
    for (const f of trackedFiles) {
      if (/^\.env($|\.)/i.test(path.basename(f)) && !f.endsWith('.example')) {
        findings.push({
          severity: 'CRITICAL',
          check: 'GIT_TRACKED_SECRETS',
          message: `Tracked environment secret file in git: ${f}`,
          remediation: `Run 'git rm --cached ${f}' and ensure ${f} is listed in .gitignore`,
        });
      }
    }
  } catch (err: any) {
    // If not in git context, scan filesystem directly
    const candidateEnv = path.join(repoRoot, '.env');
    if (fs.existsSync(candidateEnv)) {
      findings.push({
        severity: 'HIGH',
        check: 'LOCAL_ENV_DETECTED',
        message: 'Local .env file exists in root. Ensure it is never staged or committed.',
        remediation: 'Verify .env is in .gitignore before committing.',
      });
    }
  }

  // 2. Check .gitignore covers env files
  const gitignorePath = path.join(repoRoot, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
    if (!gitignoreContent.includes('.env')) {
      findings.push({
        severity: 'HIGH',
        check: 'GITIGNORE_MISSING_ENV',
        message: '.gitignore does not explicitly ignore .env files',
        remediation: 'Add ".env" and ".env.*" to root .gitignore',
      });
    }
  }

  // 3. Audit .env.example for hardcoded secrets
  const envExamplePath = path.join(repoRoot, '.env.example');
  if (fs.existsSync(envExamplePath)) {
    const envExampleContent = fs.readFileSync(envExamplePath, 'utf8');
    const secretKeys = ['JWT_SECRET', 'POSTGRES_PASSWORD', 'CREDENTIAL_ENCRYPTION_KEY', 'SETUP_TOKEN', 'INTERNAL_API_SECRET'];
    for (const line of envExampleContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [k, v] = trimmed.split('=');
      if (k && secretKeys.includes(k.trim())) {
        const val = (v || '').trim();
        if (val && !val.startsWith('CHANGE_ME_')) {
          findings.push({
            severity: 'MEDIUM',
            check: 'ENV_EXAMPLE_UNPROTECTED_SECRET',
            message: `.env.example contains non-placeholder value for ${k.trim()}`,
            remediation: `Replace value of ${k.trim()} in .env.example with CHANGE_ME_... placeholder`,
          });
        }
      }
    }
  }

  // 4. If running in production mode, verify environment runtime values
  if (process.env.NODE_ENV === 'production') {
    const jwt = process.env.JWT_SECRET;
    if (!jwt || jwt.length < 32 || jwt.includes('dev_jwt_signing_key')) {
      findings.push({
        severity: 'CRITICAL',
        check: 'PROD_INSECURE_JWT_SECRET',
        message: 'Production JWT_SECRET is weak, default, or under 32 characters.',
        remediation: 'Generate a 32+ character high-entropy key with "openssl rand -hex 32".',
      });
    }

    const internalSecret = process.env.INTERNAL_API_SECRET;
    if (!internalSecret || internalSecret.includes('internal_secret_token_98234')) {
      findings.push({
        severity: 'HIGH',
        check: 'PROD_DEFAULT_INTERNAL_SECRET',
        message: 'Production INTERNAL_API_SECRET is using the fallback development token.',
        remediation: 'Set a custom high-entropy INTERNAL_API_SECRET.',
      });
    }
  }

  // 5. Audit appliance key file permissions if present on disk
  const applianceKeyPath = '/etc/vigilone/appliance.key';
  if (fs.existsSync(applianceKeyPath)) {
    try {
      const stats = fs.statSync(applianceKeyPath);
      const modeOctal = (stats.mode & 0o777).toString(8);
      if (modeOctal !== '600' && modeOctal !== '400') {
        findings.push({
          severity: 'HIGH',
          check: 'APPLIANCE_KEY_PERMISSIONS_INSECURE',
          message: `${applianceKeyPath} has permissions ${modeOctal} (expected 0600 or 0400).`,
          remediation: `Run 'chmod 600 ${applianceKeyPath}' to prevent local unprivileged read access.`,
        });
      }
    } catch (err: any) {
      // Ignored if permissions cannot be inspected
    }
  }

  const hasCriticalOrHigh = findings.some((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH');

  return {
    passed: !hasCriticalOrHigh,
    findings,
    timestamp: new Date().toISOString(),
  };
}

// Direct CLI execution
if (require.main === module) {
  const repoRoot = path.resolve(__dirname, '../../../');
  console.log(`[SecretsAuditor] Running secrets audit on: ${repoRoot}`);
  const report = runSecretsAudit(repoRoot);

  if (report.findings.length === 0) {
    console.log('[SecretsAuditor] ✓ All security hygiene checks passed. No secret leaks or policy violations detected.');
    process.exit(0);
  }

  console.log(`[SecretsAuditor] Audit completed with ${report.findings.length} findings:`);
  for (const f of report.findings) {
    console.log(`  [${f.severity}] ${f.check}: ${f.message}`);
    console.log(`    ↳ Remediation: ${f.remediation}`);
  }

  if (!report.passed) {
    console.error('[SecretsAuditor] ✗ Audit failed due to CRITICAL or HIGH severity findings.');
    process.exit(1);
  } else {
    console.log('[SecretsAuditor] ✓ No blocking findings. Warnings only.');
    process.exit(0);
  }
}
