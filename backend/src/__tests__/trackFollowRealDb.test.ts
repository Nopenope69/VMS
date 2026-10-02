/**
 * Cross-camera following on the real database and the real app, with controlled embeddings: camera neighbours,
 * appearance candidates limited to neighbouring cameras and travel times, the site fallback, plate candidates,
 * operator decisions (confirmed and rejected, with server-side evidence and no plate text), the journey through
 * confirmed links, privacy gates and audit, and links deleted with their tracks.
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
import { EMBEDDING_DIM, storeEmbedding } from '../services/search/cropEmbeddingStore';
import { gapSeconds, transitFits } from '../services/tracks/trackFollow.service';

jest.setTimeout(60000);

const { TEST_LICENSE_PRIVATE_KEY } = jest.requireMock('../config/licenseKeys');
const prisma = new PrismaClient();
const DAY = 86_400_000;
const T0 = Date.parse('2026-09-30T20:00:00Z');
const sec = (s: number) => new Date(T0 + s * 1000);

let app: { url: string; close: () => Promise<void> };
let tenantId = '';
let siteId = '';
const cam: Record<string, string> = {};
let admin = { userId: '', token: '' };
let operator = { userId: '', token: '' };
const model = { name: `siglip-follow-${crypto.randomBytes(3).toString('hex')}`, version: '1.0.0', sha256: crypto.randomBytes(32).toString('hex') };

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}
const unit = (v: number[]) => {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};
const concept = (seed: number) => unit(Array.from({ length: EMBEDDING_DIM }, rng(seed)));
const mix = (...parts: Array<[number[], number]>) => unit(Array.from({ length: EMBEDDING_DIM }, (_, i) => parts.reduce((a, [v, w]) => a + v[i] * w, 0)));
const X = concept(11); // one person
const Y = concept(12); // another person
const CAR = concept(13);
const near = (v: number[], seed: number) => mix([v, 1], [concept(seed), 0.25]); // the same look, slightly different frame

const T: Record<string, string> = {};

/** A track with one detection, crop and embedding per vector, seen from `from` to `to` seconds after T0. */
async function track(name: string, cameraId: string, objectClass: string, from: number, to: number, vectors: number[][], over: Record<string, any> = {}) {
  const trackId = `trk-${name}-${crypto.randomBytes(3).toString('hex')}`;
  const t = await prisma.objectTrack.create({
    data: { tenantId, cameraId, trackId, objectClass, classVotesJson: {}, firstSeenAt: sec(from), lastSeenAt: sec(to), dwellSeconds: to - from, pathJson: [], zonesJson: [], colourVotesJson: {}, ...over },
  });
  T[name] = t.id;
  for (const [i, v] of vectors.entries()) {
    const at = sec(from + i);
    const det = await prisma.detectionEvent.create({ data: { tenantId, cameraId, trackId, type: objectClass === 'person' ? 'PERSON_DETECTED' : 'VEHICLE_DETECTED', objectClass, timestamp: at } });
    const cropId = crypto.randomUUID();
    await prisma.objectCrop.create({
      data: { id: cropId, tenantId, cameraId, detectionEventId: det.id, cropClass: objectClass === 'person' ? 'PERSON' : 'NON_PERSON', objectClass, relativePath: `${tenantId}/${cropId}.jpg`, sha256: 'a'.repeat(64), byteLength: 10, capturedAt: at, expiresAt: new Date(at.getTime() + 365 * DAY) },
    });
    await storeEmbedding(prisma, { tenantId, cropId, model, adapterId: 'test', vector: v });
  }
  return t.id;
}

async function plateRead(cameraId: string, plate: string, from: number) {
  return prisma.vehicleObservation.create({ data: { tenantId, cameraId, plateNumber: plate, normalizedPlate: plate, firstSeenAt: sec(from), lastSeenAt: sec(from + 5) } });
}

async function call(user: { token: string }, method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${app.url}/api/v1/tracks${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${user.token}`, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
}
const purpose = { 'x-vigilone-purpose': 'SECURITY_INCIDENT_INVESTIGATION' };
const nameOf = (id: string) => Object.keys(T).find((k) => T[k] === id);
const names = (json: any) => json.candidates.map((c: any) => nameOf(c.track.id));

async function newCamera(name: string, site = siteId) {
  return (await prisma.camera.create({ data: { tenantId, siteId: site, name, streamPath: `${name}_${crypto.randomBytes(3).toString('hex')}`, ipAddress: '127.0.0.1', mainRtspUri: `rtsp://127.0.0.1:8554/${name}` } })).id;
}

beforeAll(async () => {
  process.env.VIGILONE_FEATURE_TRACK_INDEX = 'true';
  process.env.VIGILONE_FEATURE_SEMANTIC_SEARCH = 'true';
  let a: string;
  ({ tenantId, siteId, cameraId: a } = await createTenantWithCamera(prisma, 'follow'));
  cam.A = a;
  for (const n of ['B', 'C', 'D']) cam[n] = await newCamera(n);
  const otherSite = await prisma.site.create({ data: { tenantId, name: 'Other site', timezone: 'UTC' } });
  cam.E = await newCamera('E', otherSite.id);
  admin = await createUserWithToken(prisma, tenantId, 'TENANT_ADMIN');
  operator = await createUserWithToken(prisma, tenantId, 'OPERATOR');
  const claims = { licenseId: `lic_follow_${crypto.randomBytes(4).toString('hex')}`, tenantId, tier: 'ENTERPRISE', maxCameras: 16, features: ['ADVANCED_SEARCH'], issuedAt: new Date().toISOString(), expiresAt: null, kid: 'test' } as any;
  const art = signLicensePayload(claims, TEST_LICENSE_PRIVATE_KEY);
  await prisma.license.create({ data: { tenantId, licenseId: claims.licenseId, tier: 'ENTERPRISE', maxCameras: 16, features: ['ADVANCED_SEARCH'], signedPayload: art.signedPayload, signatureEd25519: art.signatureEd25519 } });
  await prisma.modelManifest.create({ data: { ...model, task: 'embedding', codeLicense: 'Apache-2.0', weightLicense: 'Apache-2.0', trainingDataJson: {}, runtimeConfigJson: {}, isActive: true } });

  // Person X walks A -> B -> C. Y passes B at the same time. X also shows up where they could not be.
  await track('X@A', cam.A, 'person', 0, 20, [X, near(X, 101)]);
  await track('X@B', cam.B, 'person', 80, 100, [near(X, 102), near(X, 103)]); // 60 s after A: fits A-B (0..120)
  await track('Y@B', cam.B, 'person', 70, 95, [Y, near(Y, 104)]);
  await track('X@C', cam.C, 'person', 200, 230, [near(X, 105)]); // 100 s after B: fits B-C (30..300); C is not A's neighbour
  await track('X@B-late', cam.B, 'person', 1000, 1010, [near(X, 106)]); // 980 s after A: outside every window
  await track('X@B-slow', cam.B, 'person', 300, 305, [near(X, 112)]); // 280 s after A: inside the search window, too slow for A-B (120 s)
  await track('X@A-again', cam.A, 'person', 300, 310, [near(X, 107)]); // back on A after 280 s: same camera, within 600 s
  await track('X@D', cam.D, 'person', 400, 410, [near(X, 108)]); // D has no neighbours
  await track('X@E', cam.E, 'person', 420, 430, [near(X, 109)]); // another site
  // A car read with plate MH12AB1234 on A, again on C two hours later, and a different car on B.
  const pA = await plateRead(cam.A, 'MH12AB1234', 0);
  const pC = await plateRead(cam.C, 'MH12AB1234', 7200);
  const pB = await plateRead(cam.B, 'KA01CD5678', 60);
  await plateRead(cam.D, 'MH12AB1234', 3600); // read, but the detector missed the vehicle: no track
  await track('car@A', cam.A, 'car', 0, 10, [CAR], { vehicleObservationId: pA.id });
  await track('car@C', cam.C, 'car', 7200, 7210, [near(CAR, 110)], { vehicleObservationId: pC.id });
  await track('car@B', cam.B, 'car', 60, 70, [near(CAR, 111)], { vehicleObservationId: pB.id });
  app = await startApp();
});

afterAll(async () => {
  delete process.env.VIGILONE_FEATURE_TRACK_INDEX;
  delete process.env.VIGILONE_FEATURE_SEMANTIC_SEARCH;
  await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await prisma.modelManifest.deleteMany({ where: { name: model.name } });
  await app.close();
  await prisma.$disconnect();
});

describe('travel-time rules', () => {
  it('measures the gap between two tracks either way round, negative when they overlap', () => {
    const a = { firstSeenAt: sec(0), lastSeenAt: sec(20) };
    expect(gapSeconds(a, { firstSeenAt: sec(80), lastSeenAt: sec(90) })).toBe(60);
    expect(gapSeconds(a, { firstSeenAt: sec(-100), lastSeenAt: sec(-30) })).toBe(30);
    expect(gapSeconds(a, { firstSeenAt: sec(10), lastSeenAt: sec(40) })).toBe(-10);
  });
  it('fits a gap to a neighbour; a minimum of 0 also allows overlap', () => {
    expect(transitFits(60, { minTransitSeconds: 0, maxTransitSeconds: 120 })).toBe(true);
    expect(transitFits(-10, { minTransitSeconds: 0, maxTransitSeconds: 120 })).toBe(true);
    expect(transitFits(-10, { minTransitSeconds: 30, maxTransitSeconds: 300 })).toBe(false);
    expect(transitFits(20, { minTransitSeconds: 30, maxTransitSeconds: 300 })).toBe(false);
    expect(transitFits(301, { minTransitSeconds: 30, maxTransitSeconds: 300 })).toBe(false);
  });
});

describe('camera neighbours', () => {
  it('only camera configurers set them; pairs are stored once, checked and audited', async () => {
    const list = [
      { cameraAId: cam.B, cameraBId: cam.A, minTransitSeconds: 0, maxTransitSeconds: 120 },
      { cameraAId: cam.B, cameraBId: cam.C, minTransitSeconds: 30, maxTransitSeconds: 300 },
    ];
    expect((await call(operator, 'PUT', '/camera-neighbours', { neighbours: list })).status).toBe(403);
    expect((await call(admin, 'PUT', '/camera-neighbours', { neighbours: [{ cameraAId: cam.A, cameraBId: cam.A }] })).json.code).toBe('INVALID_NEIGHBOURS');
    expect((await call(admin, 'PUT', '/camera-neighbours', { neighbours: [...list, { cameraAId: cam.A, cameraBId: cam.B }] })).json.code).toBe('INVALID_NEIGHBOURS');
    expect((await call(admin, 'PUT', '/camera-neighbours', { neighbours: [{ cameraAId: cam.A, cameraBId: 'nope' }] })).json.code).toBe('CAMERA_NOT_FOUND');
    expect((await call(admin, 'PUT', '/camera-neighbours', { neighbours: [{ cameraAId: cam.A, cameraBId: cam.B, minTransitSeconds: 50, maxTransitSeconds: 10 }] })).json.code).toBe('INVALID_NEIGHBOURS');
    const ok = await call(admin, 'PUT', '/camera-neighbours', { neighbours: list });
    expect(ok.status).toBe(200);
    expect(ok.json.neighbours).toHaveLength(2);
    expect(ok.json.neighbours.every((n: any) => n.cameraAId < n.cameraBId)).toBe(true);
    expect((await call(operator, 'GET', '/camera-neighbours')).json.neighbours).toHaveLength(2);
    await prisma.auditEvent.findFirstOrThrow({ where: { tenantId, action: 'CAMERA_NEIGHBOURS_SET' } });
  });
});

describe('following a person by appearance', () => {
  it('suggests look-alikes on neighbouring cameras within the travel time, best first; never itself or other sites', async () => {
    const r = await call(admin, 'GET', `/${T['X@A']}/candidates?method=appearance`, undefined, purpose);
    expect(r.status).toBe(200);
    expect(r.json.adjacency).toBe('configured');
    const got = names(r.json);
    // Both X tracks (either order: they are the same person) rank above Y.
    expect(got.slice(0, 2).sort()).toEqual(['X@A-again', 'X@B']);
    expect(got[2]).toBe('Y@B');
    for (const n of ['X@A', 'X@C', 'X@D', 'X@E']) expect(got).not.toContain(n);
    expect(got).not.toContain('X@B-late');
    expect(got).not.toContain('X@B-slow');
    expect(r.json.outsideTravelTime).toBe(1); // X@B-slow: found by appearance, dropped by the A-B travel time
    expect(r.json.candidates.find((c: any) => c.track.id === T['X@B'])).toMatchObject({ gapSeconds: 60, decision: null });
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId, action: 'TRACK_FOLLOW_QUERY' }, orderBy: { timestampUtc: 'desc' } });
    expect(audit.metadataJson as any).toMatchObject({ category: 'BIOMETRIC', purpose: 'SECURITY_INCIDENT_INVESTIGATION', method: 'appearance' });
  });

  it('person following needs the permission and a purpose', async () => {
    expect((await call(admin, 'GET', `/${T['X@A']}/candidates?method=appearance`)).json.code).toBe('PURPOSE_REQUIRED');
    expect((await call(operator, 'GET', `/${T['X@A']}/candidates?method=appearance`, undefined, purpose)).json.code).toBe('PERSON_TRACK_FORBIDDEN');
    expect((await call(admin, 'GET', `/${T['X@A']}/candidates?method=plate`, undefined, purpose)).json.code).toBe('NO_PLATE');
  });

  it('falls back to the cameras of the same site when a camera has no neighbours', async () => {
    const r = await call(admin, 'GET', `/${T['X@D']}/candidates?method=appearance`, undefined, purpose);
    expect(r.json.adjacency).toBe('site-fallback');
    const got = names(r.json);
    expect(got).toContain('X@A-again'); // 90 s before, same site
    expect(got).not.toContain('X@E'); // other site
  });

  it('confirmed links build the journey in time order; a rejected look-alike is not suggested again', async () => {
    const confirm = (from: string, to: string) => call(admin, 'POST', `/${T[from]}/links`, { toTrackId: T[to], method: 'APPEARANCE', decision: 'CONFIRMED' }, purpose);
    const ab = await confirm('X@A', 'X@B');
    expect(ab.status).toBe(200);
    expect(ab.json.link.evidenceJson.similarity).toBeGreaterThan(0.8);
    expect(ab.json.link.evidenceJson.gapSeconds).toBe(60);

    // From B, C is a neighbour within 30..300 s.
    const fromB = await call(admin, 'GET', `/${T['X@B']}/candidates?method=appearance`, undefined, purpose);
    expect(names(fromB.json)).toContain('X@C');
    expect(fromB.json.candidates.find((c: any) => c.track.id === T['X@A']).decision).toBe('CONFIRMED');
    expect((await confirm('X@C', 'X@B')).status).toBe(200); // either direction

    const rejected = await call(admin, 'POST', `/${T['X@A']}/links`, { toTrackId: T['Y@B'], method: 'APPEARANCE', decision: 'REJECTED', note: 'different jacket' }, purpose);
    expect(rejected.json.link.status).toBe('REJECTED');
    expect(names((await call(admin, 'GET', `/${T['X@A']}/candidates?method=appearance`, undefined, purpose)).json)).not.toContain('Y@B');

    const j = await call(admin, 'GET', `/${T['X@A']}/journey`, undefined, purpose);
    expect(j.status).toBe(200);
    expect(j.json.steps.map((s: any) => nameOf(s.id))).toEqual(['X@A', 'X@B', 'X@C']);
    expect(j.json.cameras).toEqual([cam.A, cam.B, cam.C]);
    expect(j.json.links).toHaveLength(2);
    // The same journey from the middle.
    expect((await call(admin, 'GET', `/${T['X@B']}/journey`, undefined, purpose)).json.steps).toHaveLength(3);
    expect((await call(admin, 'GET', `/${T['X@A']}/journey`)).json.code).toBe('PURPOSE_REQUIRED');
    for (const action of ['TRACK_LINK_CONFIRMED', 'TRACK_LINK_REJECTED', 'TRACK_JOURNEY_VIEW']) await prisma.auditEvent.findFirstOrThrow({ where: { tenantId, action } });
  });

  it('refuses links between a person and a vehicle, and to itself', async () => {
    expect((await call(admin, 'POST', `/${T['X@A']}/links`, { toTrackId: T['car@A'], method: 'APPEARANCE', decision: 'CONFIRMED' }, purpose)).json.code).toBe('INVALID_LINK');
    expect((await call(admin, 'POST', `/${T['X@A']}/links`, { toTrackId: T['X@A'], method: 'APPEARANCE', decision: 'CONFIRMED' }, purpose)).json.code).toBe('INVALID_LINK');
  });
});

describe('following a vehicle by plate', () => {
  it('finds other reads of the same plate on any camera, including reads with no vehicle track', async () => {
    const r = await call(operator, 'GET', `/${T['car@A']}/candidates?method=plate`, undefined, purpose);
    expect(r.status).toBe(200);
    expect(names(r.json)).toEqual(['car@C']);
    expect(r.json.candidates[0].gapSeconds).toBe(7190);
    expect(r.json.readsWithoutTrack.map((x: any) => x.cameraId)).toEqual([cam.D]);
    expect(JSON.stringify(r.json)).not.toContain('MH12AB1234'); // plate text only with includePlates
    expect((await call(operator, 'GET', `/${T['car@A']}/candidates?method=plate&includePlates=true`, undefined, purpose)).json.candidates[0].track.plate.plate).toBe('MH12AB1234');
    expect((await call(operator, 'GET', `/${T['car@A']}/candidates?method=plate`)).json.code).toBe('PURPOSE_REQUIRED');
    expect((await call(operator, 'GET', `/${T['car@A']}/candidates?method=plate&windowSeconds=3600`, undefined, purpose)).json.candidates).toHaveLength(0);
  });

  it('a PLATE link needs the same plate, and its evidence never stores the plate text', async () => {
    expect((await call(operator, 'POST', `/${T['car@A']}/links`, { toTrackId: T['car@B'], method: 'PLATE', decision: 'CONFIRMED' }, purpose)).json.code).toBe('PLATE_MISMATCH');
    const ok = await call(operator, 'POST', `/${T['car@A']}/links`, { toTrackId: T['car@C'], method: 'PLATE', decision: 'CONFIRMED' }, purpose);
    expect(ok.status).toBe(200);
    expect(ok.json.link.evidenceJson.samePlate).toBe(true);
    const stored = await prisma.trackLink.findUniqueOrThrow({ where: { id: ok.json.link.id } });
    expect(JSON.stringify(stored)).not.toContain('MH12AB1234');
    expect((await call(operator, 'GET', `/${T['car@C']}/journey`)).json.steps.map((s: any) => nameOf(s.id))).toEqual(['car@A', 'car@C']);
  });

  it('plate following works without the semantic search feature; appearance answers 501', async () => {
    process.env.VIGILONE_FEATURE_SEMANTIC_SEARCH = 'false';
    try {
      expect((await call(operator, 'GET', `/${T['car@A']}/candidates?method=plate`, undefined, purpose)).status).toBe(200);
      expect((await call(operator, 'GET', `/${T['car@A']}/candidates?method=appearance`)).json.code).toBe('FEATURE_DISABLED');
    } finally {
      process.env.VIGILONE_FEATURE_SEMANTIC_SEARCH = 'true';
    }
  });
});

describe('retention', () => {
  it('a link is deleted with either of its tracks', async () => {
    const before = await prisma.trackLink.count({ where: { tenantId } });
    await prisma.objectTrack.delete({ where: { id: T['X@C'] } });
    expect(await prisma.trackLink.count({ where: { tenantId } })).toBe(before - 1);
  });
});
