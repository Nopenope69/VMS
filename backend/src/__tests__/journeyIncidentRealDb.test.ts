/**
 * A confirmed journey on the floor plan and turned into an incident, on the real database and the real app: steps
 * drawn at their cameras' placements (unplaced cameras listed, other floors left out), the incident as an alarm
 * carrying the journey (never plate text), evidence holds on every journey camera over the whole journey that the
 * alarm sweeper then pins, and the person/plate gates, permissions and audit.
 */
jest.mock('../config/licenseKeys', () => {
  const c = require('crypto');
  const kp = c.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  return { VENDOR_LICENSE_PUBLIC_KEY: kp.publicKey, TEST_LICENSE_PRIVATE_KEY: kp.privateKey };
});

import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera, createUserWithToken, startApp } from './helpers/realDb';
import { signLicensePayload } from '../utils/license';
import { layoutJourney } from '../services/tracks/journeyIncident';

jest.setTimeout(60000);

const { TEST_LICENSE_PRIVATE_KEY } = jest.requireMock('../config/licenseKeys');
const prisma = new PrismaClient();
const T0 = Date.parse('2026-09-30T20:00:00Z');
const sec = (s: number) => new Date(T0 + s * 1000);
const PLATE = 'MH12JI4321';

let app: { url: string; close: () => Promise<void> };
let tenantId = '';
let siteId = '';
let otherTenantId = '';
const cam: Record<string, string> = {};
const T: Record<string, string> = {};
let admin = { userId: '', token: '' };
let operator = { userId: '', token: '' };
let viewer = { userId: '', token: '' };
let ground = '';
let upstairs = '';

async function newCamera(name: string) {
  return (await prisma.camera.create({ data: { tenantId, siteId, name, streamPath: `${name}_${crypto.randomBytes(3).toString('hex')}`, ipAddress: '127.0.0.1', mainRtspUri: `rtsp://127.0.0.1:8554/${name}` } })).id;
}
async function track(name: string, cameraId: string, objectClass: string, from: number, to: number, over: Record<string, any> = {}) {
  const t = await prisma.objectTrack.create({
    data: { tenantId, cameraId, trackId: `trk-${name}-${crypto.randomBytes(3).toString('hex')}`, objectClass, classVotesJson: {}, firstSeenAt: sec(from), lastSeenAt: sec(to), dwellSeconds: to - from, pathJson: [], zonesJson: [], colourVotesJson: {}, ...over },
  });
  T[name] = t.id;
}
async function link(from: string, to: string, method: 'PLATE' | 'APPEARANCE') {
  // Links are stored once per pair, in id order (a database CHECK).
  const [a, b] = [T[from], T[to]].sort();
  await prisma.trackLink.create({ data: { tenantId, fromTrackId: a, toTrackId: b, method, status: 'CONFIRMED', evidenceJson: {}, decidedByUserId: admin.userId } });
}
async function call(user: { token: string }, method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${app.url}/api/v1/tracks${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${user.token}`, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
}
const purpose = { 'x-vigilone-purpose': 'SECURITY_INCIDENT_INVESTIGATION' };

beforeAll(async () => {
  process.env.VIGILONE_FEATURE_TRACK_INDEX = 'true';
  let a: string;
  ({ tenantId, siteId, cameraId: a } = await createTenantWithCamera(prisma, 'jinc'));
  cam.Gate = a;
  for (const n of ['Lobby', 'Yard', 'Stairs']) cam[n] = await newCamera(n);
  admin = await createUserWithToken(prisma, tenantId, 'TENANT_ADMIN');
  operator = await createUserWithToken(prisma, tenantId, 'OPERATOR');
  viewer = await createUserWithToken(prisma, tenantId, 'VIEWER');
  const claims = { licenseId: `lic_jinc_${crypto.randomBytes(4).toString('hex')}`, tenantId, tier: 'ENTERPRISE', maxCameras: 16, features: ['ADVANCED_SEARCH'], issuedAt: new Date().toISOString(), expiresAt: null, kid: 'test' } as any;
  const art = signLicensePayload(claims, TEST_LICENSE_PRIVATE_KEY);
  await prisma.license.create({ data: { tenantId, licenseId: claims.licenseId, tier: 'ENTERPRISE', maxCameras: 16, features: ['ADVANCED_SEARCH'], signedPayload: art.signedPayload, signatureEd25519: art.signatureEd25519 } });

  // Ground floor: Gate and Lobby placed, plus Stairs (not on the journey). Yard is on no floor plan.
  ground = (await prisma.floorplan.create({ data: { tenantId, siteId, name: 'Ground floor', imageObjectKey: 'plans/ground.png' } })).id;
  upstairs = (await prisma.floorplan.create({ data: { tenantId, siteId, name: 'First floor', imageObjectKey: 'plans/first.png', floorLevel: 2 } })).id;
  await prisma.cameraSpatialPlacement.create({ data: { cameraId: cam.Gate, floorplanId: ground, x: 150, y: 600 } });
  await prisma.cameraSpatialPlacement.create({ data: { cameraId: cam.Lobby, floorplanId: ground, x: 500, y: 300 } });
  await prisma.cameraSpatialPlacement.create({ data: { cameraId: cam.Stairs, floorplanId: upstairs, x: 800, y: 100 } });

  // A person: Gate -> Lobby. A car with a plate: Gate -> Yard (two plate reads).
  await track('X@Gate', cam.Gate, 'person', 0, 20);
  await track('X@Lobby', cam.Lobby, 'person', 80, 100);
  await link('X@Gate', 'X@Lobby', 'APPEARANCE');
  const pG = await prisma.vehicleObservation.create({ data: { tenantId, cameraId: cam.Gate, plateNumber: PLATE, normalizedPlate: PLATE, firstSeenAt: sec(0), lastSeenAt: sec(5) } });
  const pY = await prisma.vehicleObservation.create({ data: { tenantId, cameraId: cam.Yard, plateNumber: PLATE, normalizedPlate: PLATE, firstSeenAt: sec(300), lastSeenAt: sec(305) } });
  await track('car@Gate', cam.Gate, 'car', 0, 10, { vehicleObservationId: pG.id });
  await track('car@Yard', cam.Yard, 'car', 300, 330, { vehicleObservationId: pY.id });
  await link('car@Gate', 'car@Yard', 'PLATE');

  otherTenantId = (await createTenantWithCamera(prisma, 'jinc-other')).tenantId;
  app = await startApp();
});

afterAll(async () => {
  delete process.env.VIGILONE_FEATURE_TRACK_INDEX;
  for (const id of [tenantId, otherTenantId]) await prisma.tenant.delete({ where: { id } }).catch(() => undefined);
  await app.close();
  await prisma.$disconnect();
});

describe('journey on the floor plan', () => {
  it('numbers the steps over the whole journey and lists cameras without a placement', () => {
    const step = (id: string, cameraId: string) => ({ id, cameraId, objectClass: 'car', firstSeenAt: sec(0), lastSeenAt: sec(1) });
    const map = layoutJourney(
      [step('t1', 'a'), step('t2', 'z'), step('t3', 'b'), step('t4', 'a')],
      [
        { cameraId: 'a', cameraName: 'A', floorplanId: 'f1', floorplanName: 'Ground', floorLevel: 1, x: 10, y: 20 },
        { cameraId: 'b', cameraName: 'B', floorplanId: 'f1', floorplanName: 'Ground', floorLevel: 1, x: 30, y: 40 },
      ],
      new Map([['z', 'Z']])
    );
    expect(map.floorplans).toHaveLength(1);
    expect(map.floorplans[0].points.map((p) => [p.step, p.cameraId, p.x, p.y])).toEqual([[1, 'a', 10, 20], [3, 'b', 30, 40], [4, 'a', 10, 20]]);
    expect(map.floorplans[0].cameras.map((c) => c.name)).toEqual(['A', 'B']);
    expect(map.unplaced).toEqual([{ step: 2, trackId: 't2', cameraId: 'z', cameraName: 'Z' }]);
  });

  it('draws a vehicle journey at its cameras, leaves out other floors and lists the unplaced camera', async () => {
    const r = await call(operator, 'GET', `/${T['car@Gate']}/journey/floorplan`);
    expect(r.status).toBe(200);
    expect(r.json.floorplans).toHaveLength(1);
    const plan = r.json.floorplans[0];
    expect(plan.id).toBe(ground);
    expect(plan.points.map((p: any) => [p.step, p.cameraId, p.x, p.y])).toEqual([[1, cam.Gate, 150, 600]]);
    expect(plan.cameras.map((c: any) => c.cameraId).sort()).toEqual([cam.Gate, cam.Lobby].sort());
    expect(r.json.unplaced).toEqual([{ step: 2, trackId: T['car@Yard'], cameraId: cam.Yard, cameraName: 'Yard' }]);
    expect(JSON.stringify(r.json)).not.toContain(PLATE);
    const audit = await prisma.auditEvent.findFirst({ where: { tenantId, action: 'TRACK_JOURNEY_MAP_VIEW' }, orderBy: { sequenceNumber: 'desc' } });
    expect((audit!.metadataJson as any).trackId).toBe(T['car@Gate']);
  });

  it('needs the person permission and a purpose for a person journey', async () => {
    expect((await call(operator, 'GET', `/${T['X@Gate']}/journey/floorplan`, undefined, purpose)).status).toBe(403);
    const refused = await call(admin, 'GET', `/${T['X@Gate']}/journey/floorplan`);
    expect(refused.status).toBe(400);
    expect(refused.json.code).toBe('PURPOSE_REQUIRED');
    const r = await call(admin, 'GET', `/${T['X@Lobby']}/journey/floorplan`, undefined, purpose);
    expect(r.status).toBe(200);
    expect(r.json.floorplans[0].points.map((p: any) => p.cameraId)).toEqual([cam.Gate, cam.Lobby]);
    expect(r.json.unplaced).toEqual([]);
  });
});

describe('journey to incident', () => {
  it('opens an alarm with the journey and holds footage on every journey camera over the whole journey', async () => {
    const manifest = await prisma.evidenceManifest.create({
      data: { tenantId, createdByUserId: admin.userId, startUtc: sec(-30), endUtc: sec(360), cameraIdsJson: [cam.Gate, cam.Yard], masterEvidenceHash: 'h', sourceMetadataJson: {}, segmentManifestJson: [] },
    });
    // The footage exists before the incident is opened, as on a real site. (Created afterwards, any alarm sweeper
    // running in between, such as another test file's, would rightly close the past window as having no footage.)
    const inWindow = await prisma.recordingSegment.create({
      data: { tenantId, cameraId: cam.Yard, filePath: `/recordings/${cam.Yard}/in.mp4`, startTime: sec(290), endTime: sec(350), durationMs: 60_000, sizeBytes: BigInt(1000), sha256Hash: 'b'.repeat(64) },
    });
    const outside = await prisma.recordingSegment.create({
      data: { tenantId, cameraId: cam.Yard, filePath: `/recordings/${cam.Yard}/out.mp4`, startTime: sec(900), endTime: sec(960), durationMs: 60_000, sizeBytes: BigInt(1000), sha256Hash: 'c'.repeat(64) },
    });
    const r = await call(operator, 'POST', `/${T['car@Yard']}/journey/incident`, { title: 'White car through the yard', severity: 'CRITICAL', evidenceManifestId: manifest.id });
    expect(r.status).toBe(201);
    expect(r.json.holds).toBe(2);
    const alarm = await prisma.alarm.findUniqueOrThrow({ where: { id: r.json.alarm.id } });
    expect(alarm).toMatchObject({ tenantId, cameraId: cam.Gate, title: 'White car through the yard', severity: 'CRITICAL', state: 'ACTIVE' });
    const meta = alarm.metadataJson as any;
    expect(meta.source).toBe('JOURNEY');
    expect(meta.startTrackId).toBe(T['car@Yard']);
    expect(meta.steps.map((s: any) => s.trackId)).toEqual([T['car@Gate'], T['car@Yard']]);
    expect(meta.cameraIds).toEqual([cam.Gate, cam.Yard]);
    expect(meta.evidenceManifestId).toBe(manifest.id);
    expect(JSON.stringify(meta)).not.toContain(PLATE);

    // Default window: 60 s before the first sighting to 120 s after the last.
    const holds = await prisma.incidentEvidenceHold.findMany({ where: { alarmId: alarm.id }, orderBy: { cameraId: 'asc' } });
    expect(holds.map((h) => h.cameraId)).toEqual([cam.Gate, cam.Yard].sort());
    for (const h of holds) {
      expect(h.windowStart.toISOString()).toBe(sec(-60).toISOString());
      expect(h.windowEnd.toISOString()).toBe(sec(450).toISOString());
    }
    const actions = (await prisma.auditEvent.findMany({ where: { tenantId, resourceId: alarm.id }, select: { action: true } })).map((a) => a.action);
    expect(actions).toContain('ALARM_CREATE');
    const opened = await prisma.auditEvent.findFirst({ where: { tenantId, action: 'TRACK_JOURNEY_INCIDENT' }, orderBy: { sequenceNumber: 'desc' } });
    expect((opened!.metadataJson as any).alarmId).toBe(alarm.id);

    // The alarm sweeper pins the Yard footage over the journey window, says plainly that Gate recorded nothing, and
    // does not replace the journey-wide hold with its own short one around the alarm time.
    // sweep() works across all tenants, like the alarm workflow test's; `npm test` runs files in band, so no other
    // file's alarms are in flight while it runs.
    const { AlarmWorkflowService } = require('../services/incident/workflow/alarmWorkflow.service');
    const { NotificationAdapter } = require('../services/incident/orchestrator/adapters/notificationAdapter');
    const workflow = new AlarmWorkflowService(prisma, new NotificationAdapter(prisma), undefined, {
      holdPreSeconds: 60, holdPostSeconds: 120, holdDays: 30, holdFinalizeGraceSeconds: 10, holdLookbackHours: 24,
    });
    await workflow.sweep(new Date());
    const after = await prisma.incidentEvidenceHold.findMany({ where: { alarmId: alarm.id } });
    expect(after).toHaveLength(2);
    const yard = after.find((h) => h.cameraId === cam.Yard)!;
    expect(yard).toMatchObject({ status: 'COMPLETE', segmentsPinned: 1 });
    expect(after.find((h) => h.cameraId === cam.Gate)!.status).toBe('FAILED');
    const pins = await prisma.evidencePin.findMany({ where: { exportJobId: `incident-hold:${yard.id}` }, select: { segmentId: true } });
    expect(pins.map((p) => p.segmentId)).toEqual([inWindow.id]);
    expect(pins.map((p) => p.segmentId)).not.toContain(outside.id);
  });

  it('refuses bad requests, a package from another tenant, and users who cannot manage alarms', async () => {
    const otherUser = await createUserWithToken(prisma, otherTenantId, 'TENANT_ADMIN');
    const foreign = await prisma.evidenceManifest.create({
      data: { tenantId: otherTenantId, createdByUserId: otherUser.userId, startUtc: sec(0), endUtc: sec(10), cameraIdsJson: [], masterEvidenceHash: 'h', sourceMetadataJson: {}, segmentManifestJson: [] },
    });
    const before = await prisma.alarm.count({ where: { tenantId } });
    const p = `/${T['car@Gate']}/journey/incident`;
    expect((await call(operator, 'POST', p, { title: '' })).status).toBe(400);
    expect((await call(operator, 'POST', p, { title: 'x', severity: 'LOUD' })).status).toBe(400);
    expect((await call(operator, 'POST', p, { title: 'x', steps: [] })).status).toBe(400); // the journey is never taken from the client
    const notFound = await call(operator, 'POST', p, { title: 'x', evidenceManifestId: foreign.id });
    expect(notFound.status).toBe(404);
    expect(notFound.json.code).toBe('EVIDENCE_MANIFEST_NOT_FOUND');
    expect((await call(viewer, 'POST', p, { title: 'x' })).status).toBe(403);
    expect(await prisma.alarm.count({ where: { tenantId } })).toBe(before);
  });

  it('needs the person permission and a purpose to open an incident from a person journey', async () => {
    const p = `/${T['X@Gate']}/journey/incident`;
    expect((await call(operator, 'POST', p, { title: 'Person' }, purpose)).status).toBe(403);
    const refused = await call(admin, 'POST', p, { title: 'Person' });
    expect(refused.status).toBe(400);
    expect(refused.json.code).toBe('PURPOSE_REQUIRED');
    const r = await call(admin, 'POST', p, { title: 'Person in the lobby' }, purpose);
    expect(r.status).toBe(201);
    expect(r.json.holds).toBe(2);
    expect((r.json.alarm.metadataJson as any).steps.map((s: any) => s.cameraId)).toEqual([cam.Gate, cam.Lobby]);
    const opened = await prisma.auditEvent.findFirst({ where: { tenantId, action: 'TRACK_JOURNEY_INCIDENT' }, orderBy: { sequenceNumber: 'desc' } });
    expect((opened!.metadataJson as any).alarmId).toBe(r.json.alarm.id);
  });
});
