/**
 * Spatial ROI search in the Smart Search modal, end to end (scripts/e2e/frontend-browser.sh): the request must
 * reach POST /api/v1/search/spatial-motion with the body the route reads and show the clusters it returns. The
 * browser runs in India Standard Time, so a time range built in UTC instead of local time misses the seeded
 * detections from an hour ago.
 */
import fs from 'fs';
import { test, expect } from '@playwright/test';

interface Seed {
  email: string;
  password: string;
}

const seedFile = process.env.E2E_SEED_FILE;
if (!seedFile) throw new Error('E2E_SEED_FILE is not set: run these tests through scripts/e2e/frontend-browser.sh');
const seed: Seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));

test.use({ timezoneId: 'Asia/Kolkata' });

test('finds the detections inside the drawn region as one cluster, and not the one outside it', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type="email"]').fill(seed.email);
  await page.locator('input[type="password"]').fill(seed.password);
  await page.getByRole('button', { name: 'Sign In to Console' }).click();
  await page.getByRole('button', { name: 'Investigation' }).click();
  await page.getByRole('button', { name: 'Smart Search' }).click();

  const response = page.waitForResponse((r) => r.url().endsWith('/api/v1/search/spatial-motion'));
  await page.getByRole('button', { name: 'Run Spatial Search' }).click();
  expect((await response).status()).toBe(200);

  await expect(page.getByRole('alert')).toBeHidden();
  await expect(page.getByText('Intersects Found (1 cluster, 2 detections)')).toBeVisible();
  await expect(page.getByText('PERSON_DETECTED')).toBeVisible();
  await expect(page.getByText('VEHICLE_DETECTED')).toBeHidden();
  await expect(page.getByText('90% peak')).toBeVisible();
});
