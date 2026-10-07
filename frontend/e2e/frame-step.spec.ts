/**
 * Frame stepping in a synchronised multi-camera view, end to end (scripts/e2e/frontend-browser.sh) with real recordings
 * (backend/scripts/e2e/seed-step.ts): two cameras at different frame rates whose frames never line up. After each step
 * every camera shows a real frame read from its own file, not a moment between two of its frames, and says so.
 */
import fs from 'fs';
import { test, expect } from '@playwright/test';

const seedFile = process.env.E2E_SEED_FILE;
if (!seedFile) throw new Error('E2E_SEED_FILE is not set: run these tests through scripts/e2e/frontend-browser.sh');
const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8')) as { password: string; frameStep: { email: string } };

test('after a step forward or back, both cameras show an exact frame of their own', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type="email"]').fill(seed.frameStep.email);
  await page.locator('input[type="password"]').fill(seed.password);
  await page.getByRole('button', { name: 'Sign In to Console' }).click();
  await page.getByRole('button', { name: /Investigation/ }).first().click();
  await expect(page.getByText('Step A').first()).toBeVisible();
  await expect(page.getByText('Step B').first()).toBeVisible();

  const ptsOf = async () => (await page.getByText(/^PTS:/).allTextContents()).map((t) => t.replace('PTS:', '').trim());
  let previous = await ptsOf();
  for (const name of ['Step Frame Forward', 'Step Frame Forward', 'Step Frame Backward']) {
    await page.getByRole('button', { name }).click();
    await expect(page.getByTestId('frame-exact')).toHaveCount(2);
    await expect(page.getByTestId('frame-approximate')).toHaveCount(0);
    await expect.poll(ptsOf).not.toEqual(previous);
    previous = await ptsOf();
  }
});
