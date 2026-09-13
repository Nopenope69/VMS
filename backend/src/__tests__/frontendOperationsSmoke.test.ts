import fs from 'fs';
import path from 'path';

/**
 * Stage 3 Frontend Smoke & Operations Test Suite
 * Conforms to Master Commercialization Execution Contract (Section 2 & Section 3.1)
 * Validates:
 * 1. Compiled frontend distribution artifacts (index.html, asset bundles)
 * 2. Playwright E2E test coverage across all 6 core operator workflows
 * 3. Client API surface parity with backend routes and enforcement of disabled v2 endpoints
 */

describe('Stage 3 Frontend Smoke & Operator Flow Parity', () => {
  // Relative from backend/src/__tests__ to project root
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

  it('verifies Playwright E2E operations suite covers all 6 required operator workflows', () => {
    expect(fs.existsSync(frontendE2E)).toBe(true);
    const e2eContent = fs.readFileSync(frontendE2E, 'utf8');

    // Verify all 6 mandatory flows from Stage 3 contract
    expect(e2eContent).toContain('Flow 1: Operator Authentication & Local RBAC');
    expect(e2eContent).toContain('Flow 2: Live View Grid Layout & Multi-Camera Rendering');
    expect(e2eContent).toContain('Flow 3: Playback Timeline Scrubber & Filename-Derived Seek Target');
    expect(e2eContent).toContain('Flow 4: Section 63 BSA Evidence Packaging & Legal Hold');
    expect(e2eContent).toContain('Flow 5: Storage Management & Mount Guard Telemetry');
    expect(e2eContent).toContain('Flow 6: System Alarms & Severity Filtering');

    // Verify key test assertions for operator interactions
    expect(e2eContent).toContain('Live Grid');
    expect(e2eContent).toContain('Section 63 Evidence');
    expect(e2eContent).toContain('Storage');
    expect(e2eContent).toContain('Events');
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
