import fs from 'fs';
import path from 'path';

/**
 * Frontend Static Distribution & Contract Validation Test Suite
 *
 * HONEST SCOPE NOTICE:
 * This test validates static frontend distribution assets, API client contract configurations,
 * and the structural presence of Playwright test definitions.
 *
 * It validates static artifacts on disk. It DOES NOT execute a live headless browser.
 * Real browser-based end-to-end execution is performed via Playwright separately
 * (frontend/e2e/operations.spec.ts) in environments with browser dependencies installed.
 */

describe('Frontend Static Distribution & Contract Validation Test Suite', () => {
  const rootDir = path.resolve(__dirname, '../../..');
  const frontendDist = path.join(rootDir, 'frontend/dist');
  const frontendE2E = path.join(rootDir, 'frontend/e2e/operations.spec.ts');
  const frontendApi = path.join(rootDir, 'frontend/src/services/api.ts');

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

  it('verifies Playwright E2E test file exists and defines operator workflow specifications', () => {
    expect(fs.existsSync(frontendE2E)).toBe(true);
    const e2eContent = fs.readFileSync(frontendE2E, 'utf8');

    // Verify operator flow definitions are present in spec file
    expect(e2eContent).toContain('Flow 1: Operator Authentication & Local RBAC');
    expect(e2eContent).toContain('Flow 2: Live View Grid Layout & Multi-Camera Rendering');
    expect(e2eContent).toContain('Flow 3: Playback Timeline Scrubber & Filename-Derived Seek Target');
    expect(e2eContent).toContain('Flow 4: Section 63 BSA Evidence Packaging & Legal Hold');
    expect(e2eContent).toContain('Flow 5: Storage Management & Mount Guard Telemetry');
    expect(e2eContent).toContain('Flow 6: System Alarms & Severity Filtering');
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
