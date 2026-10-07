/**
 * The automation rule builder (event-action matrix) against the real backend and the seeded tenant. It used to open only
 * from the Federation console, which v1.0 never shows, so no operator could reach it. It now opens from the Alarms page.
 * Alarm grouping (ADR 0014, incident window) can be set on a TRIGGER_ALARM action, is stored on the rule exactly as entered,
 * is shown in the rule list, and an out-of-range value is refused by the form before anything is sent (the backend refuses
 * it too: ruleSchema.ts).
 */
import fs from 'fs';
import { test, expect, Page, APIRequestContext } from '@playwright/test';

const seedFile = process.env.E2E_SEED_FILE;
if (!seedFile) throw new Error('E2E_SEED_FILE is not set: run these tests through scripts/e2e/frontend-browser.sh');
const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8')) as { operatorEmail: string; password: string };

async function token(request: APIRequestContext) {
  const login = await request.post('/api/v1/auth/login', { data: { email: seed.operatorEmail, password: seed.password } });
  return (await login.json()).token as string;
}
async function rulesNamed(request: APIRequestContext, name: string) {
  const r = await request.get('/api/v1/automation/rules', { headers: { authorization: `Bearer ${await token(request)}` } });
  expect(r.status()).toBe(200);
  const body = await r.json();
  return ((body.rules ?? body) as any[]).filter((x) => x.name === name);
}

const RULE = 'E2E tamper alarm, grouped';

test.afterEach(async ({ request }) => {
  const t = await token(request);
  for (const r of await rulesNamed(request, RULE)) await request.delete(`/api/v1/automation/rules/${r.id}`, { headers: { authorization: `Bearer ${t}` } });
});

async function openBuilder(page: Page) {
  await page.goto('/');
  await page.locator('input[type="email"]').fill(seed.operatorEmail);
  await page.locator('input[type="password"]').fill(seed.password);
  await page.getByRole('button', { name: 'Sign In to Console' }).click();
  await page.getByRole('button', { name: 'Alarms' }).first().click();
  await page.getByTestId('open-automation-rules').click();
  await page.getByRole('button', { name: '+ Create Automation Rule' }).click();
  await page.getByPlaceholder('e.g. South Gate Breach Alert').fill(RULE);
  await page.locator('select').filter({ has: page.locator('option[value="SCENE_CHANGE"]') }).selectOption('SCENE_CHANGE');
  await page.locator('select').filter({ has: page.locator('option[value="TRIGGER_ALARM"]') }).first().selectOption('TRIGGER_ALARM');
}

test('an operator opens the rule builder from Alarms and saves a tamper alarm that groups repeats for 5 minutes', async ({ page, request }) => {
  await openBuilder(page);
  await page.getByLabel('Group repeats into one alarm for').fill('300');
  await page.getByRole('button', { name: 'Deploy Automation Rule' }).click();
  await expect(page.getByText(`Rule '${RULE}' created successfully.`)).toBeVisible();
  await expect(page.getByTestId('rule-incident-window').first()).toContainText('groups repeats within 300s');

  const [rule] = await rulesNamed(request, RULE);
  expect(rule.triggerType).toBe('SCENE_CHANGE');
  expect(rule.actionsJson[0]).toMatchObject({ type: 'TRIGGER_ALARM', config: { incidentWindowSeconds: 300 } });
});

test('left empty, every firing raises its own alarm (no grouping is stored)', async ({ page, request }) => {
  await openBuilder(page);
  await expect(page.getByLabel('Group repeats into one alarm for')).toHaveValue('');
  await page.getByRole('button', { name: 'Deploy Automation Rule' }).click();
  await expect(page.getByText(`Rule '${RULE}' created successfully.`)).toBeVisible();
  const [rule] = await rulesNamed(request, RULE);
  expect(rule.actionsJson[0].config.incidentWindowSeconds).toBeUndefined();
});

test('an out-of-range or fractional value is refused before sending, and nothing is saved', async ({ page, request }) => {
  await openBuilder(page);
  const field = page.getByLabel('Group repeats into one alarm for');
  for (const bad of ['90000', '1.5']) {
    await field.fill(bad);
    await page.getByRole('button', { name: 'Deploy Automation Rule' }).click();
    expect(await field.evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(false);
  }
  await expect(page.getByText(`Rule '${RULE}' created successfully.`)).toHaveCount(0);
  expect(await rulesNamed(request, RULE)).toHaveLength(0);
});
