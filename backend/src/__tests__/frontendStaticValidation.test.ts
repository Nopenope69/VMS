import fs from 'fs';
import path from 'path';
import { ensureFrontendDist } from './helpers/ensureFrontendDist';

/**
 * Frontend Static Distribution & Contract Validation Test Suite
 *
 * HONEST SCOPE NOTICE:
 * This test validates static frontend distribution assets, API client contract configurations,
 * and the structural presence of Playwright test definitions.
 *
 * It validates static artifacts on disk. It DOES NOT execute a live headless browser.
 * The browser tests (frontend/e2e/*.spec.ts, operations.spec.ts among them) run against the real backend in the
 * frontend-browser-tests CI job (scripts/e2e/frontend-browser.sh); this suite only checks they are wired in.
 */

describe('Frontend Static Distribution & Contract Validation Test Suite', () => {
  const rootDir = path.resolve(__dirname, '../../..');
  const frontendDist = path.join(rootDir, 'frontend/dist');
  const frontendE2E = path.join(rootDir, 'frontend/e2e/operations.spec.ts');
  const frontendApi = path.join(rootDir, 'frontend/src/services/api.ts');

  beforeAll(() => {
    // If frontend/dist is missing on local dev or fresh clone, build it (production mode).
    ensureFrontendDist();
  }, 300000);

  it('verifies production frontend dist bundle exists and references assets', () => {
    expect(fs.existsSync(frontendDist)).toBe(true);
    const indexHtmlPath = path.join(frontendDist, 'index.html');
    expect(fs.existsSync(indexHtmlPath)).toBe(true);

    const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
    expect(indexHtml).toContain('<!doctype html>');
    expect(indexHtml).toContain('<div id="root"></div>');
    expect(indexHtml).toMatch(/\/assets\/index-.*\.js/);
    expect(indexHtml).toMatch(/\/assets\/index-.*\.css/);
  });

  it('the operator browser tests exist, define tests and are in the Playwright run (not left unexecuted)', () => {
    expect(fs.existsSync(frontendE2E)).toBe(true);
    const e2eContent = fs.readFileSync(frontendE2E, 'utf8');
    expect((e2eContent.match(/^test\(/gm) || []).length).toBeGreaterThanOrEqual(4);
    // They use the seeded tenant, not a hard-coded account.
    expect(e2eContent).toContain('E2E_SEED_FILE');
    expect(e2eContent).not.toContain('admin123');
    const config = fs.readFileSync(path.join(rootDir, 'frontend/playwright.config.ts'), 'utf8');
    expect(config).toContain("'operations.spec.ts'");
  });

  it('verifies client API configuration routes to /api/v1 and maintains local credential auth', () => {
    expect(fs.existsSync(frontendApi)).toBe(true);
    const apiCode = fs.readFileSync(frontendApi, 'utf8');

    // Base URL is locked to /api/v1
    expect(apiCode).toContain("baseURL: '/api/v1'");

    // Interceptor refreshes using local auth
    expect(apiCode).toContain('/auth/refresh');
    expect(apiCode).toContain('/auth/login');
  });

  it('verifies frontend login and settings preserve v1 core edge focus (no SSO callback invocations)', () => {
    const loginPath = path.join(rootDir, 'frontend/src/pages/Login.tsx');
    const loginCode = fs.readFileSync(loginPath, 'utf8');

    // Login uses local username/password and first-run bootstrap
    expect(loginCode).toContain('/auth/login');
    expect(loginCode).toContain('/auth/bootstrap');
    // Ensure no broken v2 sso callback calls
    expect(loginCode).not.toContain('/sso/callback');
  });
});
