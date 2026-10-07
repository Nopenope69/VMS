import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests against the real backend and a seeded scratch database. Run them with
 * scripts/e2e/frontend-browser.sh, which starts the backend and `vite preview` and writes the seed file.
 * The specs listed below are wired in. e2e/operations.spec.ts is not: it predates this setup, logs in with
 * credentials no database has, and has never run.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: process.env.E2E_ONLY ? [process.env.E2E_ONLY] : ['redaction-dpdp.spec.ts', 'plate-search.spec.ts', 'spatial-search.spec.ts', 'investigation-stopwatch.spec.ts', 'investigation-workspace.spec.ts', 'operations.spec.ts', 'threat-rules.spec.ts', 'pose-rules.spec.ts', 'plain-language-search.spec.ts', 'alarm-triage.spec.ts', 'incident-summary.spec.ts', 'footage-integrity.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: process.env.VIGILONE_BASE_URL || 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
