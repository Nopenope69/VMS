/**
 * The time-to-answer stopwatch on the Investigation page, end to end (scripts/e2e/frontend-browser.sh): the
 * operator starts it with a question, a camera they assign is counted, and "Answered" stops it. The backend's own
 * records are checked, not only the screen.
 */
import fs from 'fs';
import { test, expect, APIRequestContext } from '@playwright/test';

const seedFile = process.env.E2E_SEED_FILE;
if (!seedFile) throw new Error('E2E_SEED_FILE is not set: run these tests through scripts/e2e/frontend-browser.sh');
const seed: { email: string; password: string } = JSON.parse(fs.readFileSync(seedFile, 'utf8'));

async function apiGet(request: APIRequestContext, path: string) {
  const login = await request.post('/api/v1/auth/login', { data: { email: seed.email, password: seed.password } });
  expect(login.status()).toBe(200);
  const { token } = await login.json();
  const res = await request.get(`/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status()).toBe(200);
  return res.json();
}

test('times an investigation from question to answer, counting the camera the operator assigns', async ({ page, request }) => {
  await page.goto('/');
  await page.locator('input[type="email"]').fill(seed.email);
  await page.locator('input[type="password"]').fill(seed.password);
  await page.getByRole('button', { name: 'Sign In to Console' }).click();
  await page.getByRole('button', { name: /Investigation/ }).first().click();

  await page.getByLabel('Question being investigated').fill('who opened the gate at 9 PM');
  await page.getByRole('button', { name: 'Start stopwatch' }).click();
  await expect(page.getByRole('button', { name: 'Answered' })).toBeVisible();
  const running = (await apiGet(request, '/investigations/timings/current')).timing;
  expect(running).toMatchObject({ label: 'who opened the gate at 9 PM', outcome: 'OPEN', camerasViewed: 0 });

  // The seeded camera is on the grid at load (not counted); unassigning and assigning it again is a step.
  await page.getByRole('button', { name: 'Unassign camera' }).first().click();
  await page.getByRole('button', { name: /\+ Assign Gate camera/ }).click();
  await expect(page.getByText(/0S 0R 1C 0E/)).toBeVisible();

  await page.getByRole('button', { name: 'Answered' }).click();
  await expect(page.getByText(/Answered in 0:\d\d/)).toBeVisible();
  expect((await apiGet(request, '/investigations/timings/current')).timing).toBeNull();
  const report = (await apiGet(request, '/investigations/timings/report')).report;
  expect(report).toMatchObject({ answered: 1, started: 1 });
  expect(report.timeToAnswerSeconds.p50).toBeLessThan(120);
});
