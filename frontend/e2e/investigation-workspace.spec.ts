/**
 * The investigation workspace (North Star Bucket 4), end to end against the real backend and a seeded tenant of its
 * own (backend/scripts/e2e/seed-workspace.ts): find by filters with real thumbnails, the refusal when no embedding
 * adapter is configured, following a vehicle by plate (refused without a purpose), confirming, the journey, sealing
 * it as one evidence package, the journey on the floor plan, opening an incident from it (with footage held on every
 * journey camera), and following a person by appearance. Each step checks what the backend stored.
 */
import fs from 'fs';
import { test, expect, Page, APIRequestContext } from '@playwright/test';

const seedFile = process.env.E2E_SEED_FILE;
if (!seedFile) throw new Error('E2E_SEED_FILE is not set: run these tests through scripts/e2e/frontend-browser.sh');
const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8')) as {
  password: string;
  workspace: { email: string; cameras: Record<string, string>; tracks: Record<string, string> };
};
const ws = seed.workspace;

async function openFind(page: Page) {
  await page.goto('/');
  await page.locator('input[type="email"]').fill(ws.email);
  await page.locator('input[type="password"]').fill(seed.password);
  await page.getByRole('button', { name: 'Sign In to Console' }).click();
  await page.getByRole('button', { name: 'Investigation' }).click();
  await page.getByRole('button', { name: 'Find', exact: true }).first().click();
  await expect(page.getByRole('complementary', { name: 'Find people and vehicles' })).toBeVisible();
}
const panel = (page: Page) => page.getByRole('complementary', { name: 'Find people and vehicles' });

async function apiGet(request: APIRequestContext, path: string) {
  const login = await request.post('/api/v1/auth/login', { data: { email: ws.email, password: seed.password } });
  expect(login.status()).toBe(200);
  const { token } = await login.json();
  const res = await request.get(`/api/v1${path}`, { headers: { authorization: `Bearer ${token}`, 'x-vigilone-purpose': 'SECURITY_INCIDENT_INVESTIGATION' } });
  expect(res.status()).toBe(200);
  return res.json();
}

test('finds vehicles by filters, with their pictures, and says plainly when description search is not available', async ({ page }) => {
  await openFind(page);
  const p = panel(page);
  await p.getByLabel('Object type').selectOption('car');
  await p.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(p.getByRole('button', { name: /^Open car on Gate at/ })).toBeVisible();
  await expect(p.getByRole('button', { name: /^Open car on Yard at/ })).toBeVisible();
  await expect(p.getByRole('button', { name: /^Open person/ })).toHaveCount(0);
  // The thumbnail is the real crop file, fetched with the signed-in user's token.
  await expect(p.getByRole('img', { name: 'car (white)' }).first()).toBeVisible();

  await p.getByLabel('Describe what you are looking for').fill('white SUV');
  await p.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(p.getByRole('alert')).toContainText('QUERY_EMBEDDING_NOT_AVAILABLE');
});

test('follows a car by plate: refused without a purpose, then confirmed into a journey that is sealed as evidence', async ({ page, request }) => {
  await openFind(page);
  const p = panel(page);
  await p.getByLabel('Object type').selectOption('car');
  await p.getByRole('button', { name: 'Find', exact: true }).click();
  await p.getByRole('button', { name: /^Open car on Gate at/ }).click();

  await p.getByRole('button', { name: 'Follow by plate' }).click();
  await expect(p.getByRole('alert')).toContainText('PURPOSE_REQUIRED');

  await p.getByLabel('Purpose').selectOption('SECURITY_INCIDENT_INVESTIGATION');
  await p.getByRole('button', { name: 'Follow by plate' }).click();
  const suggestion = p.getByLabel('Suggestion on Yard');
  await expect(suggestion).toContainText('same plate');
  await suggestion.getByRole('button', { name: 'Confirm' }).click();
  await expect(suggestion).toContainText('Confirmed');

  await p.getByRole('button', { name: 'Show journey' }).click();
  const journey = p.getByLabel('Journey steps');
  await expect(journey.getByRole('button')).toHaveCount(2);
  await expect(journey.getByRole('button').nth(0)).toHaveAccessibleName(/^Step 1: Gate/);
  await expect(journey.getByRole('button').nth(1)).toHaveAccessibleName(/^Step 2: Yard/);

  await p.getByRole('button', { name: 'Seal journey as evidence' }).click();
  const notice = page.getByText(/Journey of 2 sighting\(s\) sealed as evidence package/);
  await expect(notice).toBeVisible();
  const manifestId = (await notice.textContent())!.match(/package (\S+)/)![1];
  const manifests = await apiGet(request, '/evidence/manifests');
  const sealed = (Array.isArray(manifests) ? manifests : manifests.manifests).find((m: any) => m.id === manifestId);
  expect(sealed).toBeTruthy();
  expect([...sealed.cameraIdsJson].sort()).toEqual([ws.cameras.Gate, ws.cameras.Yard].sort());

  const backendJourney = await apiGet(request, `/tracks/${ws.tracks['car@Gate']}/journey`);
  expect(backendJourney.steps.map((s: any) => s.id)).toEqual([ws.tracks['car@Gate'], ws.tracks['car@Yard']]);

  // On the floor plan: the Gate sighting is drawn; the Yard camera is on no plan and is listed, not guessed.
  await p.getByRole('button', { name: 'Show on floor plan' }).click();
  const plan = p.getByRole('figure', { name: 'Journey on floor plan Ground floor' });
  await expect(plan.getByRole('img', { name: /^Step 1 on Gate at/ })).toBeVisible();
  await expect(plan.getByRole('img', { name: /^Step \d on / })).toHaveCount(1);
  await expect(p.getByLabel('Not on a floor plan')).toContainText('step 2 (Yard)');

  // Open an incident from the journey, with the sealed package attached.
  await p.getByRole('button', { name: 'Open incident' }).click();
  const form = p.getByRole('form', { name: 'New incident' });
  await form.getByLabel('Incident title').fill('White car from the gate to the yard');
  await form.getByLabel('Severity').selectOption('CRITICAL');
  await expect(form.getByLabel('Attach the sealed evidence package')).toBeChecked();
  await form.getByRole('button', { name: 'Create incident' }).click();
  const opened = page.getByText(/^Incident \S+ opened; footage held on 2 camera\(s\)$/);
  await expect(opened).toBeVisible();
  const alarmId = (await opened.textContent())!.match(/^Incident (\S+) opened/)![1];
  const { alarms } = await apiGet(request, '/alarms');
  const alarm = alarms.find((a: any) => a.id === alarmId);
  expect(alarm).toMatchObject({ title: 'White car from the gate to the yard', severity: 'CRITICAL', cameraId: ws.cameras.Gate });
  expect(alarm.metadataJson.evidenceManifestId).toBe(manifestId);
  expect(alarm.metadataJson.steps.map((s: any) => s.trackId)).toEqual([ws.tracks['car@Gate'], ws.tracks['car@Yard']]);
  const { holds } = await apiGet(request, `/alarms/${alarmId}/holds`);
  expect(holds.map((h: any) => h.cameraId).sort()).toEqual([ws.cameras.Gate, ws.cameras.Yard].sort());
});

test('follows a person by appearance on the neighbouring camera, rejects the look-alike and plays the journey', async ({ page, request }) => {
  await openFind(page);
  const p = panel(page);
  await p.getByLabel('Include people').check();
  await p.getByLabel('Object type').selectOption('person');
  await p.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(p.getByRole('alert')).toContainText('PURPOSE_REQUIRED');

  await p.getByLabel('Purpose').selectOption('SECURITY_INCIDENT_INVESTIGATION');
  await p.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(p.getByRole('button', { name: /^Open person on/ })).toHaveCount(3);
  await p.getByRole('button', { name: /^Open person on Gate at/ }).click();

  await p.getByRole('button', { name: 'Follow by appearance' }).click();
  const suggestions = p.getByLabel('Suggestions');
  await expect(suggestions.getByLabel('Suggestion on Lobby')).toHaveCount(2); // X (the same person) and Y (someone else)
  // Best first: X in the Lobby. Reject the other one, confirm X.
  await suggestions.getByLabel('Suggestion on Lobby').nth(1).getByRole('button', { name: 'Reject' }).click();
  await expect(suggestions.getByLabel('Suggestion on Lobby')).toHaveCount(1);
  await suggestions.getByLabel('Suggestion on Lobby').getByRole('button', { name: 'Confirm' }).click();
  await expect(suggestions).toContainText('Confirmed');

  await p.getByRole('button', { name: 'Show journey' }).click();
  await expect(p.getByLabel('Journey steps').getByRole('button')).toHaveCount(2);
  await p.getByRole('button', { name: 'Show on floor plan' }).click();
  const plan = p.getByRole('figure', { name: 'Journey on floor plan Ground floor' });
  await expect(plan.getByRole('img', { name: /^Step 1 on Gate at/ })).toBeVisible();
  await expect(plan.getByRole('img', { name: /^Step 2 on Lobby at/ })).toBeVisible();
  await expect(p.getByLabel('Not on a floor plan')).toHaveCount(0);

  await p.getByRole('button', { name: 'Play journey' }).click();
  // The grid now holds the journey's cameras.
  await expect(page.getByRole('button', { name: 'Unassign camera' })).toHaveCount(2);

  const j = await apiGet(request, `/tracks/${ws.tracks['X@Gate']}/journey`);
  expect(j.steps.map((s: any) => s.id)).toEqual([ws.tracks['X@Gate'], ws.tracks['X@Lobby']]);
  const rejected = await apiGet(request, `/tracks/${ws.tracks['X@Gate']}/candidates?method=appearance`);
  expect(rejected.candidates.map((c: any) => c.track.id)).not.toContain(ws.tracks['Y@Lobby']);
});
