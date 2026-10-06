/**
 * Incident summary (INCIDENT_SUMMARY, ADR 0016), end to end against the real backend and the triage tenant
 * (backend/scripts/e2e/seed-triage.ts): an operator opens an alarm, writes its summary, and reads sentences that each end
 * with the recorded facts they rest on; the facts are listed, and pressing the button again after the incident moved on
 * gives a new snapshot.
 */
import fs from 'fs';
import { test, expect, Page } from '@playwright/test';

const seedFile = process.env.E2E_SEED_FILE;
if (!seedFile) throw new Error('E2E_SEED_FILE is not set: run these tests through scripts/e2e/frontend-browser.sh');
const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8')) as { password: string; triage: { email: string; alarms: { summary: string } } };

async function openResolve(page: Page) {
  await page.goto('/');
  await page.locator('input[type="email"]').fill(seed.triage.email);
  await page.locator('input[type="password"]').fill(seed.password);
  await page.getByRole('button', { name: 'Sign In to Console' }).click();
  await page.getByRole('button', { name: 'Alarms' }).first().click();
  await page.getByRole('button', { name: 'In Review' }).click(); // acknowledged alarms are listed here
  const row = page.getByRole('row', { name: /Summary alarm/ });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Resolve' }).click();
  await expect(page.getByTestId('alarm-incident-summary')).toBeVisible();
}

test('writes a summary whose every sentence cites recorded facts, and lists those facts', async ({ page }) => {
  await openResolve(page);
  const panel = page.getByTestId('alarm-incident-summary');
  await expect(panel).toContainText('No summary has been written for this alarm yet.');
  await panel.getByRole('button', { name: 'Write summary' }).click();

  const sentences = panel.getByTestId('incident-summary-sentences').getByRole('listitem');
  await expect(sentences.first()).toContainText('the alarm "Summary alarm" with severity WARNING was raised on camera "Dock camera"');
  await expect(panel).toContainText('was acknowledged by user');
  await expect(panel).toContainText('not a model opinion');
  // Every sentence but the closing statement ends with a citation, and every cited fact is listed.
  const count = await sentences.count();
  await expect(panel.getByTestId('incident-summary-cites')).toHaveCount(count - 1);
  await panel.getByText(/Recorded facts \(\d+\)/).click();
  await expect(panel.getByTestId('incident-summary-facts')).toContainText('F1 ');
  await expect(panel.getByTestId('incident-summary-facts')).toContainText('ALARM_RAISED');
  await expect(panel).toContainText('It is in the audit chain');
});

test('reopening shows the stored summary; pressing the button again after the incident moved on takes a new snapshot', async ({ page, request }) => {
  await openResolve(page);
  const panel = page.getByTestId('alarm-incident-summary');
  await expect(panel.getByTestId('incident-summary-sentences')).toBeVisible(); // stored by the previous test
  const login = await request.post('/api/v1/auth/login', { data: { email: seed.triage.email, password: seed.password } });
  const token = (await login.json()).token as string;
  const get = async () => (await request.get(`/api/v1/incident-summaries/alarms/${seed.triage.alarms.summary}`, { headers: { authorization: `Bearer ${token}` } })).json();
  const before = await get();
  const done = await request.post(`/api/v1/alarms/${seed.triage.alarms.summary}/resolve`, { headers: { authorization: `Bearer ${token}` }, data: { notes: 'handled' } });
  expect(done.status()).toBe(200);
  await panel.getByRole('button', { name: 'Update summary' }).click();
  await expect(panel).toContainText('was resolved by user');
  const after = await get();
  expect(after.record.summaryId).not.toBe(before.record.summaryId);
});
