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
});
