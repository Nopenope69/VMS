import path from 'path';
import { runSecretsAudit } from '../scripts/auditSecrets';

describe('Secrets Hygiene & Environment Auditor', () => {
  const repoRoot = path.resolve(__dirname, '../../../');

  it('should pass audit on the current repository with 0 blocking findings', () => {
    const report = runSecretsAudit(repoRoot);
    expect(report.passed).toBe(true);
    const criticals = report.findings.filter((f) => f.severity === 'CRITICAL');
    expect(criticals.length).toBe(0);
  });

  it('should flag insecure/default JWT secrets when running in production mode', () => {
    const originalEnv = process.env.NODE_ENV;
    const originalJwt = process.env.JWT_SECRET;

    try {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = 'short_and_insecure';

      const report = runSecretsAudit(repoRoot);
      expect(report.passed).toBe(false);
      const jwtFinding = report.findings.find((f) => f.check === 'PROD_INSECURE_JWT_SECRET');
      expect(jwtFinding).toBeDefined();
      expect(jwtFinding?.severity).toBe('CRITICAL');
    } finally {
      process.env.NODE_ENV = originalEnv;
      process.env.JWT_SECRET = originalJwt;
    }
  });

  it('should flag default INTERNAL_API_SECRET when in production mode', () => {
    const originalEnv = process.env.NODE_ENV;
    const originalSecret = process.env.INTERNAL_API_SECRET;

    try {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = 'a_very_long_and_secure_jwt_secret_with_more_than_32_characters!';
      process.env.INTERNAL_API_SECRET = 'vigilone_internal_secret_token_98234'; // default fallback

      const report = runSecretsAudit(repoRoot);
      expect(report.passed).toBe(false);
      const finding = report.findings.find((f) => f.check === 'PROD_DEFAULT_INTERNAL_SECRET');
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('HIGH');
    } finally {
      process.env.NODE_ENV = originalEnv;
      process.env.INTERNAL_API_SECRET = originalSecret;
    }
  });

  describe('P0.3 default-credential and setup-token checks', () => {
    const fsMod = require('fs') as typeof import('fs');
    const osMod = require('os') as typeof import('os');
    const pathMod = require('path') as typeof import('path');

    const makeRepo = (files: Record<string, string>): string => {
      const dir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'vigilone-audit-'));
      for (const [rel, content] of Object.entries(files)) {
        const full = pathMod.join(dir, rel);
        fsMod.mkdirSync(pathMod.dirname(full), { recursive: true });
        fsMod.writeFileSync(full, content);
      }
      return dir;
    };
    const goodCompose = 'services:\n  backend:\n    environment:\n      - SETUP_TOKEN=${SETUP_TOKEN:-}\n';

    it('flags a README that advertises the published default password', () => {
      const root = makeRepo({ 'README.md': 'log in with Password123!', 'docker-compose.yml': goodCompose });
      const report = runSecretsAudit(root);
      expect(report.findings.some((f) => f.check === 'PUBLISHED_DEFAULT_CREDENTIAL')).toBe(true);
      expect(report.passed).toBe(false);
    });

    it('flags frontend source that pre-fills the retired setup token', () => {
      const root = makeRepo({
        'frontend/src/pages/Wizard.tsx': "setSetupToken('vigilone_dev_setup_token_99182')",
        'docker-compose.yml': goodCompose,
      });
      const report = runSecretsAudit(root);
      expect(report.findings.some((f) => f.check === 'PUBLISHED_DEFAULT_CREDENTIAL')).toBe(true);
    });

    it('flags a compose file that does not pass SETUP_TOKEN to the backend', () => {
      const root = makeRepo({ 'docker-compose.yml': 'services:\n  backend:\n    environment:\n      - PORT=4000\n' });
      const report = runSecretsAudit(root);
      expect(report.findings.some((f) => f.check === 'COMPOSE_SETUP_TOKEN_NOT_PASSED')).toBe(true);
    });

    it('flags missing/short/default SETUP_TOKEN and the known dev encryption key in production', () => {
      const saved = { ...process.env };
      try {
        process.env.NODE_ENV = 'production';
        process.env.JWT_SECRET = 'a_very_long_and_secure_jwt_secret_with_more_than_32_characters!';
        process.env.INTERNAL_API_SECRET = 'b'.repeat(40);
        process.env.CREDENTIAL_ENCRYPTION_KEY = 'eGlhOHBqa2w4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=';
        for (const token of [undefined, 'short', 'vigilone_dev_setup_token_99182']) {
          if (token === undefined) delete process.env.SETUP_TOKEN;
          else process.env.SETUP_TOKEN = token;
          const report = runSecretsAudit(makeRepo({ 'docker-compose.yml': goodCompose }));
          expect(report.findings.some((f) => f.check === 'PROD_INSECURE_SETUP_TOKEN')).toBe(true);
          expect(report.findings.some((f) => f.check === 'PROD_KNOWN_ENCRYPTION_KEY')).toBe(true);
          expect(report.passed).toBe(false);
        }
      } finally {
        process.env = saved;
      }
    });

    it('passes a clean fixture repo', () => {
      const root = makeRepo({ 'README.md': 'Use the installer-generated token.', 'docker-compose.yml': goodCompose });
      const report = runSecretsAudit(root);
      expect(report.findings.filter((f) => f.check.startsWith('PUBLISHED') || f.check.startsWith('COMPOSE'))).toEqual([]);
    });
  });
});
