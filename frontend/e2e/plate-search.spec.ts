/**
 * Forensic plate search in the Smart Search modal, end to end: a real browser, the built frontend, the real backend
 * and a seeded database (scripts/e2e/frontend-browser.sh). The query must reach GET /api/v1/search/plates with a
 * declared purpose, show the seeded plate, and leave a PLATE_SEARCH_QUERY audit entry carrying that purpose; the
 * backend's refusals (no purpose, missing permission) must be shown, not swallowed.
 */
import fs from 'fs';
import { test, expect, Page, APIRequestContext } from '@playwright/test';

interface Seed {
  email: string;
  viewerEmail: string;
  password: string;
  cameraId: string;
  searchPlate: string;
}

const seedFile = process.env.E2E_SEED_FILE;
if (!seedFile) throw new Error('E2E_SEED_FILE is not set: run these tests through scripts/e2e/frontend-browser.sh');
const seed: Seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));

async function openPlateSearch(page: Page, email: string) {
  await page.goto('/');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(seed.password);
  await page.getByRole('button', { name: 'Sign In to Console' }).click();
  await page.getByRole('button', { name: 'Investigation' }).click();
  await page.getByRole('button', { name: 'Smart Search' }).click();
  await page.getByRole('button', { name: 'Forensic License Plate Search' }).click();
}

/** The admin's view of the audit chain, through the API with a fresh token. */
async function plateSearchAudits(request: APIRequestContext): Promise<any[]> {
  const login = await request.post('/api/v1/auth/login', { data: { email: seed.email, password: seed.password } });
  expect(login.status()).toBe(200);
  const { token } = await login.json();
  const res = await request.get('/api/v1/audit?action=PLATE_SEARCH_QUERY', { headers: { authorization: `Bearer ${token}` } });
  expect(res.status()).toBe(200);
  return (await res.json()).events;
}

test("shows the backend's PURPOSE_REQUIRED refusal when no purpose is declared, and audits nothing", async ({ page, request }) => {
  const before = (await plateSearchAudits(request)).length;
  await openPlateSearch(page, seed.email);
  await page.getByLabel('Plate query').fill(seed.searchPlate);
  await page.getByRole('button', { name: 'Find Vehicles' }).click();
  await expect(page.getByRole('alert')).toContainText('PURPOSE_REQUIRED');
  expect((await plateSearchAudits(request)).length).toBe(before);
});

test('finds the seeded plate under a declared purpose and reference, and audits the query with that purpose', async ({ page, request }) => {
  await openPlateSearch(page, seed.email);
  const purpose = page.getByLabel('Purpose of Query (DPDP)');
  // The list comes from the tenant's DPDP settings.
  await expect(purpose.locator('option[value="LAW_ENFORCEMENT_REQUEST"]')).toHaveCount(1);
  await purpose.selectOption('LAW_ENFORCEMENT_REQUEST');

  // This purpose needs a reference; without one the backend refuses and the page says so.
  await page.getByLabel('Plate query').fill('MH12*');
  await page.getByRole('button', { name: 'Find Vehicles' }).click();
  await expect(page.getByRole('alert')).toContainText('PURPOSE_REFERENCE_REQUIRED');

  await page.getByLabel('Case / Request Reference').fill('FIR 42/2026');
  await page.getByRole('button', { name: 'Find Vehicles' }).click();
  await expect(page.getByRole('alert')).toBeHidden();
  await expect(page.getByText(seed.searchPlate, { exact: true })).toBeVisible();
  await expect(page.getByText('Detected Vehicle Observations (1)')).toBeVisible();
  await expect(page.getByText('FOUR_WHEELER')).toBeVisible();

  const [latest] = await plateSearchAudits(request);
  expect(latest).toMatchObject({ action: 'PLATE_SEARCH_QUERY', resourceType: 'PlateData' });
  expect(latest.metadataJson).toMatchObject({
    category: 'PLATE',
    purpose: 'LAW_ENFORCEMENT_REQUEST',
    purposeReference: 'FIR 42/2026',
    resultCount: 1,
    filters: { plateQuery: 'MH12*' },
  });
});

test("shows the backend's 403 to a viewer without PLATE_DATA_QUERY", async ({ page, request }) => {
  const before = (await plateSearchAudits(request)).length;
  await openPlateSearch(page, seed.viewerEmail);
  await page.getByLabel('Plate query').fill(seed.searchPlate);
  await page.getByRole('button', { name: 'Find Vehicles' }).click();
  await expect(page.getByRole('alert')).toContainText("Required permission: 'PLATE_DATA_QUERY'");
  await expect(page.getByText(seed.searchPlate, { exact: true })).toBeHidden();
  expect((await plateSearchAudits(request)).length).toBe(before);
});
