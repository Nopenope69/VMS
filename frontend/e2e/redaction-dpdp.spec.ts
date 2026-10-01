/**
 * The redaction console and DPDP settings, end to end: a real browser, the built frontend, the real backend and a
 * seeded database (scripts/e2e/frontend-browser.sh). Each test checks what the backend stored or returned, not
 * only what the screen shows, so a payload the backend rejects fails the test.
 */
import fs from 'fs';
import crypto from 'crypto';
import { test, expect, Page, APIRequestContext } from '@playwright/test';

interface Seed {
  email: string;
  password: string;
  manifestId: string;
  completedJobId: string;
  derivativeSha256: string;
}

const seedFile = process.env.E2E_SEED_FILE;
if (!seedFile) throw new Error('E2E_SEED_FILE is not set: run these tests through scripts/e2e/frontend-browser.sh');
const seed: Seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));

// One worker, file order (playwright.config.ts): later tests build on earlier ones (job count, saved retention).
// Not 'serial', so one failure does not hide the results of the others.

async function signIn(page: Page) {
  await page.goto('/');
  await page.locator('input[type="email"]').fill(seed.email);
  await page.locator('input[type="password"]').fill(seed.password);
  await page.getByRole('button', { name: 'Sign In to Console' }).click();
  await page.getByRole('button', { name: /Evidence \(Sec\. 63\)/ }).click();
  await expect(page.getByText(/Sealed Evidence Packages \(1\)/)).toBeVisible();
}

/** The backend's own view, through the API with a fresh token. */
async function apiGet(request: APIRequestContext, path: string) {
  const login = await request.post('/api/v1/auth/login', { data: { email: seed.email, password: seed.password } });
  expect(login.status()).toBe(200);
  const { token } = await login.json();
  const res = await request.get(`/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status()).toBe(200);
  return res.json();
}

test('creates a plate redaction job that the backend stores as QUEUED for the sealed manifest', async ({ page, request }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'New Redaction Job' }).click();
  await expect(page.getByText('Create Privacy Redaction Job')).toBeVisible();
  // The source list shows the sealed package; faces are off by default (face processing is off in DPDP settings).
  await expect(page.getByRole('combobox')).not.toHaveValue('');
  await page.getByRole('button', { name: 'Enqueue Redaction Job' }).click();

  await expect(page.getByText('Create Privacy Redaction Job')).toBeHidden();
  const { jobs } = await apiGet(request, '/privacy/jobs');
  const created = jobs.find((j: any) => j.status === 'QUEUED');
  expect(created).toMatchObject({ sourceManifestId: seed.manifestId, redactionMode: 'LICENSE_PLATE', detectKinds: ['LICENSE_PLATE'], sampleFps: 4 });
  await expect(page.getByText(`RED_${created.id.slice(0, 8).toUpperCase()}`)).toBeVisible();
});

test("shows the backend's refusal when faces are asked for while face processing is off", async ({ page, request }) => {
  await signIn(page);
  const before = (await apiGet(request, '/privacy/jobs')).jobs.length;
  await page.getByRole('button', { name: 'New Redaction Job' }).click();
  await page.getByText(/^Faces/).click();
  await page.getByRole('button', { name: 'Enqueue Redaction Job' }).click();
  await expect(page.getByText(/face processing is switched off/i)).toBeVisible();
  expect((await apiGet(request, '/privacy/jobs')).jobs.length).toBe(before);
});

test('saves the DPDP retention periods and purposes, and shows the saved values when reopened', async ({ page, request }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'DPDP Settings' }).click();
  await expect(page.getByLabel('Plate read retention days')).toHaveValue('30');
  await page.getByLabel('Plate read retention days').fill('45');
  await page.getByLabel('Detection snapshot retention days').fill('60');
  await page.getByRole('button', { name: 'Save Compliance Policy' }).click();
  await expect(page.getByText('DPDP settings saved.')).toBeVisible();

  const { settings } = await apiGet(request, '/privacy/dpdp/settings');
  expect(settings).toMatchObject({ plateRetentionDays: 45, detectionSnapshotRetentionDays: 60, faceProcessingEnabled: false });

  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'DPDP Settings' }).click();
  await expect(page.getByLabel('Plate read retention days')).toHaveValue('45');
  await expect(page.getByLabel('Detection snapshot retention days')).toHaveValue('60');
});

test('reports the real purge counts: the 100-day-old plate read is deleted, then nothing more', async ({ page }) => {
  await signIn(page);
  page.on('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'DPDP Settings' }).click();
  await page.getByRole('button', { name: 'Trigger Purge Now' }).click();
  await expect(page.getByText(/Purge done: 1 plate reads,/)).toBeVisible();
  await page.getByRole('button', { name: 'Trigger Purge Now' }).click();
  await expect(page.getByText(/Purge done: 0 plate reads,/)).toBeVisible();
});

test('downloads the redacted MP4 with the signed-in user, byte for byte', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: /Video Redaction Jobs/ }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'MP4' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`redacted-${seed.completedJobId}.mp4`);
  const bytes = fs.readFileSync(await download.path());
  expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(seed.derivativeSha256);
});

test('shows a download failure instead of failing silently', async ({ page }) => {
  await signIn(page);
  // The seeded export has no package file, so the backend refuses it; the page must say so.
  await page.getByRole('button', { name: 'ZIP' }).first().click();
  await expect(page.getByRole('alert')).toContainText('Download failed');
});
