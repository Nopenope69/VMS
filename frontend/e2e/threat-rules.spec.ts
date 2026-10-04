/**
 * The spatial rule screen (Cameras → camera menu → spatial rules) against the real backend and the seeded tenant:
 * an unattended-bag zone and a wrong-way zone with its arrow are drawn and saved, and the backend stores them in
 * normalised image coordinates (0..1), which is what the detection pipeline compares tracks with. Before this
 * screen was rewritten it saved canvas pixels, which no track can ever match.
 */
import fs from 'fs';
import { test, expect, Page, APIRequestContext, Locator } from '@playwright/test';

const seedFile = process.env.E2E_SEED_FILE;
if (!seedFile) throw new Error('E2E_SEED_FILE is not set: run these tests through scripts/e2e/frontend-browser.sh');
const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8')) as { email: string; password: string; cameraId: string };

async function signIn(page: Page) {
  await page.goto('/');
  await page.locator('input[type="email"]').fill(seed.email);
  await page.locator('input[type="password"]').fill(seed.password);
  await page.getByRole('button', { name: 'Sign In to Console' }).click();
}

async function rules(request: APIRequestContext) {
  const login = await request.post('/api/v1/auth/login', { data: { email: seed.email, password: seed.password } });
  const token = (await login.json()).token as string;
  const r = await request.get(`/api/v1/spatial-rules/${seed.cameraId}`, { headers: { authorization: `Bearer ${token}` } });
  expect(r.status()).toBe(200);
  return (await r.json()).rules as any[];
}

/** Clicks the canvas at fractions of its size. */
async function clickAt(canvas: Locator, points: Array<[number, number]>) {
  const box = (await canvas.boundingBox())!;
  for (const [fx, fy] of points) await canvas.click({ position: { x: box.width * fx, y: box.height * fy } });
}

const ZONE: Array<[number, number]> = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.9], [0.2, 0.9]];

test('unattended bag and wrong-way rules are drawn, saved in 0..1 coordinates and listed', async ({ page, request }) => {
  await signIn(page);
  await page.getByTitle('Cameras [Alt+6]').click();
  await page.getByTitle('Camera configuration menu').first().click();
  await page.getByRole('button', { name: 'Vector Tripwire Analytics' }).click();
  const canvas = page.getByTestId('rule-canvas');

  // Unattended bag.
  await page.getByRole('button', { name: 'Unattended bag' }).click();
  await page.getByLabel('Rule name').fill('Platform 1 bags');
  await page.getByLabel('Left with nobody near (seconds)').fill('90');
  await page.getByRole('button', { name: 'Save rule' }).click();
  await expect(page.getByRole('alert')).toContainText('at least 3 points');
  await clickAt(canvas, ZONE);
  await page.getByRole('button', { name: 'Save rule' }).click();
  await expect(page.getByRole('status')).toContainText('Rule saved');

  // Wrong way: zone, then the arrow (left to right), cars only.
  await page.getByRole('button', { name: 'Wrong way' }).click();
  await page.getByLabel('Rule name').fill('One-way lane');
  await clickAt(canvas, ZONE);
  await page.getByRole('button', { name: 'Save rule' }).click();
  await expect(page.getByRole('alert')).toContainText('allowed direction');
  await page.getByRole('button', { name: /Arrow/ }).click();
  await clickAt(canvas, [[0.3, 0.5], [0.7, 0.5]]);
  for (const c of ['motorcycle', 'bus', 'truck', 'bicycle']) await page.getByLabel(c, { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Save rule' }).click();
  await expect(page.getByRole('status')).toContainText('Rule saved');

  await expect(page.getByTestId('spatial-rule')).toHaveCount(2);
  await expect(page.getByTestId('spatial-rule').filter({ hasText: 'One-way lane' })).toContainText('car');

  const stored = await rules(request);
  const bag = stored.find((r) => r.type === 'UNATTENDED_OBJECT');
  const way = stored.find((r) => r.type === 'WRONG_WAY');
  expect(bag).toMatchObject({ name: 'Platform 1 bags', dwellThresholdSeconds: 90 });
  bag.polygonCoordinatesJson.forEach((p: { x: number; y: number }, i: number) => {
    expect(p.x).toBeCloseTo(ZONE[i][0], 1);
    expect(p.y).toBeCloseTo(ZONE[i][1], 1);
  });
  expect(way.paramsJson).toEqual({ objectClasses: ['car'] });
  expect(way.lineCoordinatesJson[0].x).toBeCloseTo(0.3, 1);
  expect(way.lineCoordinatesJson[1].x).toBeCloseTo(0.7, 1);
  for (const p of [...way.polygonCoordinatesJson, ...way.lineCoordinatesJson]) {
    expect(p.x).toBeLessThanOrEqual(1);
    expect(p.y).toBeLessThanOrEqual(1);
  }
});
