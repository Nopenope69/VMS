/**
 * Alarm triage (ALARM_TRIAGE, ADR 0015), end to end against the real backend and the triage tenant
 * (backend/scripts/e2e/seed-triage.ts): the Triage tab lists every open alarm with the reasons for its place,
 * severity first, and a rule operators almost always marked false is offered a suggested change that nothing applies.
 */
import fs from 'fs';
import { test, expect, Page } from '@playwright/test';

const seedFile = process.env.E2E_SEED_FILE;
if (!seedFile) throw new Error('E2E_SEED_FILE is not set: run these tests through scripts/e2e/frontend-browser.sh');
const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8')) as { password: string; triage: { email: string; loudRuleName: string } };

async function openTriage(page: Page) {
  await page.goto('/');
  await page.locator('input[type="email"]').fill(seed.triage.email);
  await page.locator('input[type="password"]').fill(seed.password);
  await page.getByRole('button', { name: 'Sign In to Console' }).click();
  await page.getByRole('button', { name: 'Alarms' }).first().click();
  await page.getByTestId('triage-tab').click();
  await expect(page.getByTestId('alarm-triage-panel')).toBeVisible();
}

test('the queue lists every open alarm, severity first, with the reasons for each place', async ({ page }) => {
  await openTriage(page);
  const items = page.getByTestId('triage-item');
  await expect(items).toHaveCount(3);
  // CRITICAL first even though the model doubts it; then the alarm from the rule operators confirmed, then the noisy one.
  await expect(items.nth(0)).toContainText('Triage crash on dock');
  await expect(items.nth(0)).toContainText('could not see the detected object');
  await expect(items.nth(1)).toContainText('Triage door forced');
  await expect(items.nth(1)).toContainText('Operators confirmed 12 of 12');
  await expect(items.nth(1)).toContainText('repeated 5 times');
  await expect(items.nth(2)).toContainText('Triage dock motion');
  await expect(items.nth(2)).toContainText('Operators marked 12 of 12');
  await expect(items.nth(2)).toContainText('lowered');
});

test('a rule that was almost always false gets a suggestion, marked as not applied, with its numbers', async ({ page }) => {
  await openTriage(page);
  const proposals = page.getByTestId('triage-proposal');
  await expect(proposals).toHaveCount(1);
  await expect(proposals.first()).toContainText(seed.triage.loudRuleName);
  await expect(proposals.first()).toContainText('25 of 25 reviewed alarms');
  await expect(proposals.first()).toContainText('Nothing has been changed');
  await expect(page.getByTestId('triage-report')).toContainText('Dock camera');
});

test('the page only reads: the alarms are still active afterwards', async ({ page, request }) => {
  await openTriage(page);
  await expect(page.getByTestId('triage-item')).toHaveCount(3);
  const login = await request.post('/api/v1/auth/login', { data: { email: seed.triage.email, password: seed.password } });
  const token = (await login.json()).token as string;
  const r = await request.get('/api/v1/alarm-triage/queue', { headers: { authorization: `Bearer ${token}` } });
  expect((await r.json()).items).toHaveLength(3);
});
