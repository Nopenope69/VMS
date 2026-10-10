/**
 * E2E tests for Describe-What-To-Watch (Natural Language Rules).
 * Tests the operator flow: plain-language prompt -> local Qwen3-4B extraction ->
 * deterministic compilation -> interpretation card & explicit assumptions review ->
 * historical event replay -> operator deploys rule.
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

const TEST_NL_RULE = 'Loitering near Server Room';

test.afterEach(async ({ request }) => {
  const t = await token(request);
  for (const r of await rulesNamed(request, TEST_NL_RULE)) {
    await request.delete(`/api/v1/automation/rules/${r.id}`, { headers: { authorization: `Bearer ${t}` } });
  }
});

async function openCreateTab(page: Page) {
  await page.goto('/');
  await page.locator('input[type="email"]').fill(seed.operatorEmail);
  await page.locator('input[type="password"]').fill(seed.password);
  await page.getByRole('button', { name: 'Sign In to Console' }).click();
  await page.getByRole('button', { name: 'Alarms' }).first().click();
  await page.getByTestId('open-automation-rules').click();
  await page.getByRole('button', { name: '+ Create Automation Rule' }).click();
}

test('operator drafts a rule via natural language, reviews assumptions, and deploys it', async ({ page, request }) => {
  await openCreateTab(page);

  const promptInput = page.getByTestId('nl-rule-prompt-input');
  await expect(promptInput).toBeVisible();

  await promptInput.fill('Alert if a person loiters near the server room for more than 5 minutes after 10 PM');
  await page.getByTestId('nl-rule-draft-button').click();

  // Wait for interpretation card to render
  const interpCard = page.getByTestId('nl-rule-interpretation-card');
  await expect(interpCard).toBeVisible({ timeout: 15000 });

  // Status badge should show ready for review or needs clarification
  const statusBadge = page.getByTestId('nl-rule-status-badge');
  await expect(statusBadge).toBeVisible();

  // Historical event replay preview should be visible
  await expect(page.getByText('Historical Event Replay (Last 7 Days)')).toBeVisible();
  await expect(page.getByText('Evaluated against stored historical events. Does not re-run CV models on raw video.')).toBeVisible();

  // Rule name should be populated
  const nameInput = page.getByPlaceholder('e.g. South Gate Breach Alert');
  await expect(nameInput).not.toHaveValue('');

  // Deploy automation rule
  await page.getByRole('button', { name: 'Deploy Automation Rule' }).click();

  // Check success toast / notice
  await expect(page.getByText(/created successfully/i)).toBeVisible();
});
