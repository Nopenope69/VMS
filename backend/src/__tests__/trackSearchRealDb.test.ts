/**
 * Track search (POST /api/v1/tracks/search) on the real database and the real app, with controlled embeddings.
 *
 * Every crop vector is a weighted mix of a few "concept" vectors (white SUV, red car, person, backpack, uniform),
 * and the test query embedder maps each text to its concept, so every expected ranking can be worked out by hand.
 * Checked: one result per track, filters applied before ranking (a narrow filter still finds its match when the
 * candidate budget is tiny), AND and NOT terms, query by stored crop and by uploaded JPEG, person and plate gates,
 * audit entries, and the refusals.
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
import { setQueryEmbedderForTests } from '../services/search/queryEmbedder';
import { groupByTrack } from '../services/search/trackSearch';

jest.setTimeout(60000);

const { TEST_LICENSE_PRIVATE_KEY } = jest.requireMock('../config/licenseKeys');
const prisma = new PrismaClient();
const DAY = 86_400_000;
const T0 = Date.parse('2026-09-30T21:00:00Z');

let app: { url: string; close: () => Promise<void> };
let tenantId = '';
let cam1 = '';
let cam2 = '';
let admin = { userId: '', token: '' };
let operator = { userId: '', token: '' };
const model = { name: `siglip-test-${crypto.randomBytes(3).toString('hex')}`, version: '1.0.0', sha256: crypto.randomBytes(32).toString('hex') };

// Deterministic, nearly orthogonal concept vectors.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}
function unit(v: number[]) {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}
const concept = (seed: number) => {
  const r = rng(seed);
  return unit(Array.from({ length: EMBEDDING_DIM }, r));
};
const C = { whiteSuv: concept(1), redCar: concept(2), person: concept(3), backpack: concept(4), uniform: concept(5) };
const mix = (...parts: Array<[number[], number]>) => unit(Array.from({ length: EMBEDDING_DIM }, (_, i) => parts.reduce((a, [v, w]) => a + v[i] * w, 0)));
const TEXT: Record<string, number[]> = { 'white SUV': C.whiteSuv, 'red car': C.redCar, person: C.person, backpack: C.backpack, uniform: C.uniform };

// A minimal JPEG header (SOI, SOF0 16x16, EOI): enough for the size check; the test embedder never decodes it.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x10, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
const embedded = (vector: number[]) => ({ vector: Float32Array.from(vector), model, adapterId: 'test-embedder', inferenceId: crypto.randomUUID() });

const tracks: Record<string, string> = {};
const cropsOf: Record<string, string[]> = {};

/** A track on a camera with one detection + crop + embedding per vector. */
async function track(name: string, cameraId: string, objectClass: string, vectors: number[][], over: Record<string, any> = {}) {
  const trackId = `trk-${name}-${crypto.randomBytes(3).toString('hex')}`;
  const t = await prisma.objectTrack.create({
    data: { tenantId, cameraId, trackId, objectClass, classVotesJson: {}, firstSeenAt: new Date(T0), lastSeenAt: new Date(T0 + 30_000), dwellSeconds: 30, pathJson: [], zonesJson: [], colourVotesJson: {}, ...over },
  });
  tracks[name] = t.id;
  cropsOf[name] = [];
  for (const [i, v] of vectors.entries()) {
    const at = new Date(T0 + i * 1000);
    const det = await prisma.detectionEvent.create({ data: { tenantId, cameraId, trackId, type: objectClass === 'person' ? 'PERSON_DETECTED' : 'VEHICLE_DETECTED', objectClass, timestamp: at } });
    const cropId = crypto.randomUUID();
    await prisma.objectCrop.create({
      data: { id: cropId, tenantId, cameraId, detectionEventId: det.id, cropClass: objectClass === 'person' ? 'PERSON' : 'NON_PERSON', objectClass, relativePath: `${tenantId}/${cropId}.jpg`, sha256: 'a'.repeat(64), byteLength: 10, capturedAt: at, expiresAt: new Date(at.getTime() + 365 * DAY) },
    });
    await storeEmbedding(prisma, { tenantId, cropId, model, adapterId: 'test', vector: v });
    cropsOf[name].push(cropId);
  }
}

async function search(user: { token: string }, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${app.url}/api/v1/tracks/search`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${user.token}`, ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
}
const purpose = { 'x-vigilone-purpose': 'SECURITY_INCIDENT_INVESTIGATION' };
const names = (json: any) => json.results.map((r: any) => Object.keys(tracks).find((k) => tracks[k] === r.track.id));

beforeAll(async () => {
  process.env.VIGILONE_FEATURE_TRACK_INDEX = 'true';
  process.env.VIGILONE_FEATURE_SEMANTIC_SEARCH = 'true';
  ({ tenantId, cameraId: cam1 } = await createTenantWithCamera(prisma, 'tsearch'));
  const site = await prisma.site.findFirstOrThrow({ where: { tenantId } });
  cam2 = (await prisma.camera.create({ data: { tenantId, siteId: site.id, name: 'Yard', streamPath: `yard_${crypto.randomBytes(3).toString('hex')}`, ipAddress: '127.0.0.2', mainRtspUri: 'rtsp://127.0.0.1:8554/yard' } })).id;
  admin = await createUserWithToken(prisma, tenantId, 'TENANT_ADMIN');
  operator = await createUserWithToken(prisma, tenantId, 'OPERATOR');
  const claims = { licenseId: `lic_ts_${crypto.randomBytes(4).toString('hex')}`, tenantId, tier: 'ENTERPRISE', maxCameras: 16, features: ['ADVANCED_SEARCH'], issuedAt: new Date().toISOString(), expiresAt: null, kid: 'test' } as any;
  const art = signLicensePayload(claims, TEST_LICENSE_PRIVATE_KEY);
  await prisma.license.create({ data: { tenantId, licenseId: claims.licenseId, tier: 'ENTERPRISE', maxCameras: 16, features: ['ADVANCED_SEARCH'], signedPayload: art.signedPayload, signatureEd25519: art.signatureEd25519 } });
  await prisma.modelManifest.create({ data: { ...model, task: 'embedding', codeLicense: 'Apache-2.0', weightLicense: 'Apache-2.0', trainingDataJson: {}, runtimeConfigJson: {}, isActive: true } });

  // Vehicles. A: a clear white SUV seen three times on camera 1. C: a slightly less clear white SUV on camera 2,
  // parked 10 minutes. B: a red car.
  await track('A', cam1, 'car', [C.whiteSuv, mix([C.whiteSuv, 1], [C.redCar, 0.1]), mix([C.whiteSuv, 1], [C.redCar, 0.15])]);
  await track('C', cam2, 'car', [mix([C.whiteSuv, 0.9], [C.redCar, 0.35])], { dwellSeconds: 600, bodyColour: 'white' });
  await track('B', cam1, 'car', [C.redCar, C.redCar]);
  // People. P1 carries a backpack; P2 does not; P3 is in uniform in every frame; P4 is in uniform in one frame of three.
  await track('P1', cam1, 'person', [mix([C.person, 1], [C.backpack, 0.8])]);
  await track('P2', cam1, 'person', [C.person]);
  await track('P3', cam1, 'person', [mix([C.person, 0.6], [C.uniform, 1]), mix([C.person, 0.6], [C.uniform, 1])]);
  await track('P4', cam1, 'person', [C.person, C.person, mix([C.person, 0.6], [C.uniform, 1])]);

  setQueryEmbedderForTests({
    text: async (t) => {
      if (!TEXT[t]) throw new Error(`no test vector for '${t}'`);
      return embedded(TEXT[t]);
    },
    image: async () => embedded(C.whiteSuv),
  });
  app = await startApp();
});

afterAll(async () => {
  setQueryEmbedderForTests(undefined);
  delete process.env.VIGILONE_FEATURE_TRACK_INDEX;
  delete process.env.VIGILONE_FEATURE_SEMANTIC_SEARCH;
  await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await prisma.modelManifest.deleteMany({ where: { name: model.name } });
  await app.close();
  await prisma.$disconnect();
});

describe('ranking and grouping', () => {
  it('returns one result per track, best match first, people left out by default; audits the query', async () => {
    const r = await search(admin, { text: 'white SUV' });
    expect(r.status).toBe(200);
    expect(names(r.json)).toEqual(['A', 'C', 'B']);
    expect(r.json.results[0]).toMatchObject({ matchedCrops: 3, excludedCrops: 0, matchedCropId: cropsOf.A[0] });
    expect(r.json.results[0].score).toBeCloseTo(1, 3);
    expect(r.json.results[0].track.plate).toEqual({ linked: false });
    expect(r.json.modelSha256).toBe(model.sha256);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId, action: 'TRACK_SEARCH_QUERY' }, orderBy: { timestampUtc: 'desc' } });
    expect(audit.metadataJson as any).toMatchObject({ queryKind: 'text', queryText: 'white SUV', resultCount: 3 });
  });

  it('applies filters before ranking: a narrow filter finds its match even with a candidate budget of one', async () => {
    // Ranking all crops first and filtering after would spend the single candidate on track A and return nothing.
    const r = await search(admin, { text: 'white SUV', filters: { cameraIds: [cam2] }, limit: 1, candidates: 1 });
    expect(names(r.json)).toEqual(['C']);
    expect(names((await search(admin, { text: 'white SUV', filters: { minDwellSeconds: 300 } })).json)).toEqual(['C']);
    expect(names((await search(admin, { text: 'white SUV', filters: { bodyColour: 'white' } })).json)).toEqual(['C']);
  });

  it('finds tracks like a stored crop (never the crop itself) and like an uploaded JPEG photo', async () => {
    const byCrop = await search(admin, { cropId: cropsOf.A[0] });
    expect(names(byCrop.json)[0]).toBe('A');
    expect(byCrop.json.results[0].matchedCrops).toBe(2);
    expect(byCrop.json.results.flatMap((x: any) => [x.matchedCropId])).not.toContain(cropsOf.A[0]);

    const byPhoto = await search(admin, { imageJpegBase64: JPEG.toString('base64') });
    expect(names(byPhoto.json)).toEqual(['A', 'C', 'B']);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId, action: 'TRACK_SEARCH_QUERY', metadataJson: { path: ['queryKind'], equals: 'image' } } });
    expect(audit.metadataJson as any).toMatchObject({ imageSha256: crypto.createHash('sha256').update(JPEG).digest('hex'), imageBytes: JPEG.length });
    expect(JSON.stringify(audit.metadataJson)).not.toContain(JPEG.toString('base64'));
  });

  it('AND ranks tracks that look like every term first; NOT drops tracks that mostly look like the excluded term', async () => {
    const and = await search(admin, { text: 'person', and: ['backpack'], includePersons: true }, purpose);
    expect(names(and.json)[0]).toBe('P1');

    const not = await search(admin, { text: 'person', not: ['uniform'], includePersons: true, filters: { objectClasses: ['person'] } }, purpose);
    expect(names(not.json)).not.toContain('P3');
    expect(names(not.json)).toEqual(expect.arrayContaining(['P1', 'P2', 'P4']));
    // P4 is in uniform in one frame of three: kept, with that frame counted as excluded.
    expect(not.json.results.find((x: any) => x.track.id === tracks.P4)).toMatchObject({ matchedCrops: 2, excludedCrops: 1 });
    expect(not.json.tracksExcludedByNot).toBe(1);
  });
});

describe('privacy and refusals', () => {
  it('people need the permission and a purpose; the query is audited with the purpose', async () => {
    expect(names((await search(admin, { text: 'person' })).json).some((n: string) => n.startsWith('P'))).toBe(false);
    expect((await search(admin, { text: 'person', includePersons: true })).json.code).toBe('PURPOSE_REQUIRED');
    expect((await search(operator, { text: 'person', includePersons: true }, purpose)).json.code).toBe('PERSON_TRACK_FORBIDDEN');
    expect((await search(admin, { cropId: cropsOf.P1[0] })).json.code).toBe('PERSON_QUERY_REQUIRES_INCLUDE');
    expect((await search(admin, { text: 'person', filters: { upperColour: 'blue' } })).json.code).toBe('PERSON_QUERY_REQUIRES_INCLUDE');
    expect((await search(admin, { text: 'person', includePersons: true, includePlates: true }, purpose)).json.code).toBe('SENSITIVE_CATEGORIES_SEPARATE');
    const ok = await search(admin, { text: 'person', includePersons: true }, purpose);
    expect(ok.status).toBe(200);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId, action: 'TRACK_PERSON_SEARCH_QUERY' }, orderBy: { timestampUtc: 'desc' } });
    expect(audit.metadataJson as any).toMatchObject({ category: 'BIOMETRIC', purpose: 'SECURITY_INCIDENT_INVESTIGATION' });
  });

  it('refuses malformed queries, non-JPEG photos and a model the adapter does not serve', async () => {
    expect((await search(admin, {})).json.code).toBe('INVALID_TRACK_SEARCH');
    expect((await search(admin, { text: 'white SUV', cropId: cropsOf.A[0] })).json.code).toBe('INVALID_TRACK_SEARCH');
    expect((await search(admin, { text: '   ' })).json.code).toBe('INVALID_TRACK_SEARCH');
    expect((await search(admin, { text: 'person', and: ['a', 'b', 'c', 'd', 'e'] })).json.code).toBe('INVALID_TRACK_SEARCH');
    expect((await search(admin, { imageJpegBase64: Buffer.from('not a jpeg').toString('base64') })).json.code).toBe('IMAGE_NOT_JPEG');
    expect((await search(admin, { text: 'white SUV', modelSha256: 'b'.repeat(64) })).json.code).toBe('TEXT_MODEL_MISMATCH');
    expect((await search(admin, { cropId: 'no-such-crop' })).status).toBe(404);
  });

  it('answers 501 without the semantic search feature or without an embedding adapter', async () => {
    process.env.VIGILONE_FEATURE_SEMANTIC_SEARCH = 'false';
    try {
      expect((await search(admin, { text: 'white SUV' })).json.code).toBe('FEATURE_DISABLED');
    } finally {
      process.env.VIGILONE_FEATURE_SEMANTIC_SEARCH = 'true';
    }
    setQueryEmbedderForTests(null);
    try {
      expect((await search(admin, { text: 'white SUV' })).json.code).toBe('QUERY_EMBEDDING_NOT_AVAILABLE');
      // A stored-crop query needs no adapter.
      expect((await search(admin, { cropId: cropsOf.A[0] })).status).toBe(200);
    } finally {
      setQueryEmbedderForTests({ text: async (t) => embedded(TEXT[t]), image: async () => embedded(C.whiteSuv) });
    }
  });
});

describe('groupByTrack', () => {
  const row = (trackDbId: string, cropId: string, pos: number[], neg: number[] = []) => ({ trackDbId, cropId, pos, neg });
  it('scores a crop by its weakest AND term and a track by its best crop', () => {
    const g = groupByTrack([row('t1', 'a', [0.9, 0.2]), row('t1', 'b', [0.5, 0.5]), row('t2', 'c', [0.4, 0.4])], 10);
    expect(g.hits.map((h) => [h.trackDbId, h.bestCropId, h.score])).toEqual([
      ['t1', 'b', 0.5],
      ['t2', 'c', 0.4],
    ]);
  });
  it('drops a track when more than half its crops look more like a NOT term; keeps it at exactly half', () => {
    const g = groupByTrack([row('t1', 'a', [0.5], [0.6]), row('t1', 'b', [0.5], [0.1]), row('t2', 'c', [0.5], [0.6]), row('t2', 'd', [0.5], [0.7]), row('t2', 'e', [0.5], [0.1])], 10);
    expect(g.hits.map((h) => h.trackDbId)).toEqual(['t1']);
    expect(g.tracksExcludedByNot).toBe(1);
  });
  it('respects the limit', () => {
    expect(groupByTrack([row('t1', 'a', [0.9]), row('t2', 'b', [0.8]), row('t3', 'c', [0.7])], 2).hits).toHaveLength(2);
  });
});
