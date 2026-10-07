/**
 * Footage integrity page (ADR 0018 and 0019), end to end against the real backend and the integrity tenant
 * (backend/scripts/e2e/seed-integrity.ts): an operator sees which camera is suspected tampered and since when, what
 * ended recently, how many recordings are sealed and held, and the backend's chain check run for real on real seals:
 * intact on one camera, a changed stored hash reported on the other.
 */
import fs from 'fs';
import { test, expect, Page } from '@playwright/test';

const seedFile = process.env.E2E_SEED_FILE;
if (!seedFile) throw new Error('E2E_SEED_FILE is not set: run these tests through scripts/e2e/frontend-browser.sh');
const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8')) as { password: string; integrity: { email: string; gateCamera: string; yardCamera: string } };

async function openIntegrity(page: Page) {
  await page.goto('/');
  await page.locator('input[type="email"]').fill(seed.integrity.email);
  await page.locator('input[type="password"]').fill(seed.password);
  await page.getByRole('button', { name: 'Sign In to Console' }).click();
  await page.getByRole('button', { name: 'Footage Integrity' }).first().click();
  await expect(page.getByTestId('footage-integrity-page')).toBeVisible();
}

const row = (page: Page, name: string) => page.getByTestId('integrity-camera').filter({ hasText: name });

test('an operator sees the covered camera, what ended recently, seals and held recordings', async ({ page }) => {
  await openIntegrity(page);
  await expect(page.getByText('1 camera suspected tampered')).toBeVisible();
  await expect(page.getByTestId('sabotage-off')).toHaveCount(0);
  await expect(page.getByTestId('sealing-off')).toHaveCount(0);

  const gate = row(page, seed.integrity.gateCamera);
  await expect(gate.getByText('Covered', { exact: true })).toBeVisible();
  await expect(gate.getByTestId('open-condition')).toContainText('Camera view covered or blocked since');
  await expect(gate.getByTestId('recent-conditions')).toContainText('Out of focus');
  await expect(gate.getByTestId('recent-conditions')).toContainText('10 min, restored');
  await expect(gate.getByTestId('seal-summary')).toContainText('3 sealed recordings');

  const yard = row(page, seed.integrity.yardCamera);
  await expect(yard.getByText('View normal')).toBeVisible();
  await expect(yard.getByText('1 recording held')).toBeVisible();
  await expect(yard.getByTestId('seal-summary')).toContainText('2 sealed recordings');
});

test('the chain check runs on the backend: intact on one camera, the changed hash reported on the other', async ({ page }) => {
  await openIntegrity(page);
  const gate = row(page, seed.integrity.gateCamera);
  await gate.getByTestId('check-chain').click();
  await expect(gate.getByTestId('chain-result')).toContainText('Chain intact: 3 seals checked.');

  const yard = row(page, seed.integrity.yardCamera);
  await yard.getByTestId('check-chain').click();
  await expect(yard.getByTestId('chain-result')).toContainText('Chain problems found');
  await expect(yard.getByTestId('chain-result')).toContainText('STORED_HASH_DIFFERS at seal 2');
});

test('a viewer has no footage integrity tab', async ({ page }) => {
  const s = JSON.parse(fs.readFileSync(seedFile!, 'utf8')) as { viewerEmail: string; password: string };
  await page.goto('/');
  await page.locator('input[type="email"]').fill(s.viewerEmail);
  await page.locator('input[type="password"]').fill(s.password);
  await page.getByRole('button', { name: 'Sign In to Console' }).click();
  await expect(page.getByRole('button', { name: 'Live Grid' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Footage Integrity' })).toHaveCount(0);
});
