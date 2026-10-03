/**
 * Core operator screens against the real backend and the seeded tenant (backend/scripts/e2e/seed-frontend-e2e.ts):
 * sign-in and what each role is shown, the live grid's camera directory (a camera the stream watchdog has never
 * seen is offline, never shown online by default), alarm triage (filter, acknowledge, resolve with a verdict, each
 * checked in the backend; a viewer is refused by the backend too), and the storage screen showing the backend's
 * own figures. The evidence screen is covered by redaction-dpdp.spec.ts.
 */
import fs from 'fs';
import { test, expect, Page, APIRequestContext } from '@playwright/test';

const seedFile = process.env.E2E_SEED_FILE;
if (!seedFile) throw new Error('E2E_SEED_FILE is not set: run these tests through scripts/e2e/frontend-browser.sh');
const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8')) as {
  email: string;
  viewerEmail: string;
  operatorEmail: string;
  password: string;
  cameraId: string;
  alarms: { critical: string; warning: string };
};

async function signIn(page: Page, email: string, password = seed.password) {
  await page.goto('/');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: 'Sign In to Console' }).click();
}

async function token(request: APIRequestContext, email: string) {
  const r = await request.post('/api/v1/auth/login', { data: { email, password: seed.password } });
  expect(r.status()).toBe(200);
  return (await r.json()).token as string;
}

async function alarm(request: APIRequestContext, id: string) {
  const r = await request.get('/api/v1/alarms', { headers: { authorization: `Bearer ${await token(request, seed.email)}` } });
  expect(r.status()).toBe(200);
  return (await r.json()).alarms.find((a: any) => a.id === id);
}

test('sign-in refuses a wrong password and shows each role only its screens', async ({ page }) => {
  await signIn(page, seed.email, 'not-the-password');
  await expect(page.getByText(/invalid|incorrect|failed/i).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign In to Console' })).toBeVisible();

  await signIn(page, seed.viewerEmail);
  await expect(page.getByRole('button', { name: 'Live Grid' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Investigation' })).toBeVisible();
  for (const hidden of ['Alarms', 'Evidence (Sec. 63)', 'Storage', 'Staff']) await expect(page.getByRole('button', { name: hidden })).toHaveCount(0);

  // Signing out ends the session: a reload does not bring it back.
  await page.getByTitle('Sign Out of Appliance').click();
  await expect(page.getByRole('button', { name: 'Sign In to Console' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign In to Console' })).toBeVisible();

  await signIn(page, seed.email);
  for (const shown of ['Live Grid', 'Alarms', 'Evidence (Sec. 63)', 'Storage', 'Staff']) await expect(page.getByRole('button', { name: shown })).toBeVisible();
});

test('the camera directory shows a camera the stream watchdog has never seen as offline', async ({ page }) => {
  await signIn(page, seed.email);
  await page.getByRole('button', { name: 'Live Grid' }).click();
  // The directory is open by default.
  await expect(page.getByText('0 Online / 1 Total')).toBeVisible();
  await expect(page.getByTitle('Camera Offline')).toHaveCount(1);
  await expect(page.getByTitle('Camera Online')).toHaveCount(0);
});

test('alarm triage: filter by severity, acknowledge, resolve with a verdict; a viewer is refused by the backend', async ({ page, request }) => {
  // The backend refuses a viewer, whatever the screen shows.
  const viewerAck = await request.post(`/api/v1/alarms/${seed.alarms.critical}/acknowledge`, { headers: { authorization: `Bearer ${await token(request, seed.viewerEmail)}` } });
  expect(viewerAck.status()).toBe(403);
  expect((await alarm(request, seed.alarms.critical)).state).toBe('ACTIVE');

  await signIn(page, seed.operatorEmail);
  await page.getByRole('button', { name: 'Alarms' }).click();
  await expect(page.getByRole('row', { name: /E2E perimeter breach/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /E2E camera tamper/ })).toBeVisible();

  await page.getByLabel('Alarm severity').selectOption('CRITICAL');
  await expect(page.getByRole('row', { name: /E2E camera tamper/ })).toHaveCount(0);
  const breach = page.getByRole('row', { name: /E2E perimeter breach/ });
  await breach.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(breach.getByRole('button', { name: 'Acknowledge' })).toHaveCount(0);
  await expect.poll(async () => (await alarm(request, seed.alarms.critical)).state).toBe('ACKNOWLEDGED');

  // Acknowledged alarms are listed under "In Review" (the list opens on active ones).
  await page.getByRole('button', { name: 'In Review' }).click();
  await breach.getByRole('button', { name: 'Resolve' }).click();
  await page.getByLabel('Resolution notes').fill('Guard checked the fence; a fox set off the beam.');
  await page.getByLabel('Verdict').selectOption('FALSE_ALARM');
  await page.getByRole('button', { name: 'Confirm Resolution' }).click();
  await expect.poll(async () => (await alarm(request, seed.alarms.critical)).state).toBe('RESOLVED');
  const resolved = await alarm(request, seed.alarms.critical);
  expect(resolved.resolutionNotes).toBe('Guard checked the fence; a fox set off the beam.');
  const fb = await request.get('/api/v1/alarms/feedback/stats', { headers: { authorization: `Bearer ${await token(request, seed.email)}` } });
  expect(fb.status()).toBe(200);
  // The verdict counts: the two seeded alarms have no rule, one is reviewed, as a false alarm.
  expect((await fb.json()).byRule.find((r: any) => r.ruleId === null)).toMatchObject({ alarms: 2, reviewed: 1, falseAlarms: 1, falseAlarmRate: 1 });

  // The other alarm was not touched.
  expect((await alarm(request, seed.alarms.warning)).state).toBe('ACTIVE');
});

test("the storage screen shows the backend's own figures", async ({ page, request }) => {
  const r = await request.get('/api/v1/system/storage/status', { headers: { authorization: `Bearer ${await token(request, seed.email)}` } });
  expect(r.status()).toBe(200);
  const status = await r.json();
  await signIn(page, seed.email);
  await page.getByRole('button', { name: 'Storage' }).click();
  await expect(page.getByText('STATE:')).toBeVisible();
  await expect(page.getByText(new RegExp(`Total:\\s*${status.cameraStats.total}\\b`))).toBeVisible();
});
