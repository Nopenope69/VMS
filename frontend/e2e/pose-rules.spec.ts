/**
 * The spatial rule screen for the two body-pose rules, against the real backend and the seeded tenant: a person-down
 * area and a fence (area, base line, top line, protected side) are drawn and saved, and the backend stores them in
 * normalised image coordinates (0..1), which is what the detection pipeline compares tracks with. A fence without its
 * top line is refused on the screen before anything is sent.
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

async function clickAt(canvas: Locator, points: Array<[number, number]>) {
  const box = (await canvas.boundingBox())!;
  for (const [fx, fy] of points) await canvas.click({ position: { x: box.width * fx, y: box.height * fy } });
}

/** The seeded camera is shared with the other rule specs, which count the rules on it: leave none behind. */
test.afterEach(async ({ request }) => {
  const login = await request.post('/api/v1/auth/login', { data: { email: seed.email, password: seed.password } });
  const token = (await login.json()).token as string;
  for (const r of (await rules(request)).filter((x) => ['PERSON_DOWN', 'FENCE_CLIMB'].includes(x.type))) {
    await request.delete(`/api/v1/spatial-rules/${r.id}`, { headers: { authorization: `Bearer ${token}` } });
  }
});

const ZONE: Array<[number, number]> = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.9], [0.2, 0.9]];

test('person-down and fence-climbing rules are drawn, saved in 0..1 coordinates and listed', async ({ page, request }) => {
  await signIn(page);
  await page.getByTitle('Cameras [Alt+6]').click();
  await page.getByTitle('Camera configuration menu').first().click();
  await page.getByRole('button', { name: 'Vector Tripwire Analytics' }).click();
  const canvas = page.getByTestId('rule-canvas');

  // Person down: needs an area, then the time down and the optional "found lying" warning.
  await page.getByRole('button', { name: 'Person down' }).click();
  await page.getByLabel('Rule name').fill('Platform 2 falls');
  await page.getByRole('button', { name: 'Save rule' }).click();
  await expect(page.getByRole('alert')).toContainText('at least 3 points');
  await clickAt(canvas, ZONE);
  await page.getByLabel('Down for (seconds)').fill('12');
  await page.getByLabel('Also warn when found lying still (seconds, 0 = off)').fill('90');
  await page.getByRole('button', { name: 'Save rule' }).click();
  await expect(page.getByRole('status')).toContainText('Rule saved');

  // Fence climbing: area, fence base, fence top; each missing piece is named.
  await page.getByRole('button', { name: 'Fence climbing' }).click();
  await page.getByLabel('Rule name').fill('North fence');
  await clickAt(canvas, ZONE);
  await page.getByRole('button', { name: 'Save rule' }).click();
  await expect(page.getByRole('alert')).toContainText('Fence base');
  await page.getByRole('button', { name: /Fence base/ }).click();
  await clickAt(canvas, [[0.1, 0.7], [0.9, 0.7]]);
  await page.getByRole('button', { name: 'Save rule' }).click();
  await expect(page.getByRole('alert')).toContainText('Fence top');
  await page.getByRole('button', { name: /Fence top/ }).click();
  await clickAt(canvas, [[0.1, 0.4], [0.9, 0.4]]);
  await page.getByLabel('Protected side (looking from point A to point B)').selectOption('RIGHT');
  await page.getByRole('button', { name: 'Save rule' }).click();
  await expect(page.getByRole('status')).toContainText('Rule saved');

  await expect(page.getByTestId('spatial-rule')).toHaveCount(2);
  await expect(page.getByTestId('spatial-rule').filter({ hasText: 'North fence' })).toContainText('protected side right');

  const stored = await rules(request);
  const down = stored.find((r) => r.type === 'PERSON_DOWN');
  const fence = stored.find((r) => r.type === 'FENCE_CLIMB');
  expect(down).toMatchObject({ name: 'Platform 2 falls', dwellThresholdSeconds: 12, cooldownSeconds: 120 });
  expect(down.paramsJson).toEqual({ lyingStillSeconds: 90 });
  down.polygonCoordinatesJson.forEach((p: { x: number; y: number }, i: number) => {
    expect(p.x).toBeCloseTo(ZONE[i][0], 1);
    expect(p.y).toBeCloseTo(ZONE[i][1], 1);
  });
  expect(fence.paramsJson.protectedSide).toBe('RIGHT');
  expect(fence.paramsJson.climbSeconds).toBe(1.5);
  expect(fence.lineCoordinatesJson[0].y).toBeCloseTo(0.7, 1);
  expect(fence.paramsJson.topLine[0].y).toBeCloseTo(0.4, 1);
  for (const p of [...fence.polygonCoordinatesJson, ...fence.lineCoordinatesJson, ...fence.paramsJson.topLine]) {
    expect(p.x).toBeLessThanOrEqual(1);
    expect(p.y).toBeLessThanOrEqual(1);
  }
});
