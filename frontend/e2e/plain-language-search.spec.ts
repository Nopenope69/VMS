/**
 * Plain-language search (NL_SEARCH), end to end against the real backend and the workspace tenant
 * (backend/scripts/e2e/seed-workspace.ts): a request fills the Find form and lists what was understood, the operator
 * removes a part and the search changes with it, and a request in words the rules cannot read says so plainly when
 * no local language model is set up (none is in this run). Nothing is searched until the operator presses Find.
 */
import fs from 'fs';
import { test, expect, Page } from '@playwright/test';

const seedFile = process.env.E2E_SEED_FILE;
if (!seedFile) throw new Error('E2E_SEED_FILE is not set: run these tests through scripts/e2e/frontend-browser.sh');
const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8')) as { password: string; workspace: { email: string } };
const ws = seed.workspace;

async function openFind(page: Page) {
  await page.goto('/');
  await page.locator('input[type="email"]').fill(ws.email);
  await page.locator('input[type="password"]').fill(seed.password);
  await page.getByRole('button', { name: 'Sign In to Console' }).click();
  await page.getByRole('button', { name: 'Investigation' }).click();
  await page.getByRole('button', { name: 'Find', exact: true }).first().click();
  const p = page.getByRole('complementary', { name: 'Find people and vehicles' });
  await expect(p).toBeVisible();
  return p;
}

test('a plain request fills the form; removing a part widens the search', async ({ page }) => {
  const p = await openFind(page);
  await p.getByLabel('Ask in plain words').fill('white car at Gate');
  await p.getByRole('button', { name: 'Read', exact: true }).click();

  const understood = p.getByLabel('Understood');
  await expect(understood).toContainText('camera: Gate');
  await expect(understood).toContainText('car');
  await expect(understood).toContainText('colour: white');
  // The form holds the same values, for the operator to check.
  await expect(p.getByLabel('Object type')).toHaveValue('car');
  await expect(p.getByLabel('Vehicle colour')).toHaveValue('white');
  await expect(p.getByRole('button', { name: 'Gate', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // Nothing searched yet.
  await expect(p.getByRole('button', { name: /^Open car/ })).toHaveCount(0);

  // The words left over ("white car") go to description search, which has no embedding adapter in this run.
  await expect(p.getByLabel('Describe what you are looking for')).toHaveValue('white car');
  await p.getByRole('button', { name: 'Remove description' }).click();
  await expect(p.getByLabel('Describe what you are looking for')).toHaveValue('');

  await p.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(p.getByRole('button', { name: /^Open car on Gate at/ })).toBeVisible();
  await expect(p.getByRole('button', { name: /^Open car on Yard at/ })).toHaveCount(0);

  await p.getByRole('button', { name: 'Remove Gate' }).click();
  await expect(p.getByRole('button', { name: 'Gate', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await p.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(p.getByRole('button', { name: /^Open car on Yard at/ })).toBeVisible();
});

test('says plainly when part of a request could not be read and no local language model is set up', async ({ page }) => {
  const p = await openFind(page);
  await p.getByLabel('Ask in plain words').fill('यार्ड पर सफेद कार');
  await p.getByRole('button', { name: 'Read', exact: true }).click();
  const understood = p.getByLabel('Understood');
  // The word list still reads the colour and the vehicle; the place name needs the model.
  await expect(understood).toContainText('colour: white');
  await expect(understood).toContainText('no local language model is set up');
  await expect(p.getByLabel('Object type')).toHaveValue('car');
});
