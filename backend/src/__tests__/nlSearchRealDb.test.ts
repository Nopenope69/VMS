/**
 * Plain-language search (feature NL_SEARCH) on the real database and the real Express app: POST /tracks/parse-query
 * reads a request with this tenant's camera and zone names and the site's time zone, never another tenant's; a
 * request the word list cannot read goes to the query-rewrite model (a STAND-IN here; the real Qwen3-4B is tested in
 * the worker) and what the rules read in the original stands; without the model, or when it fails, the answer is
 * the rules' own reading with the reason.
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
import { QueryRewriteError, QueryRewriter, setQueryRewriterForTests } from '../services/search/queryRewriteClient';

jest.setTimeout(60000);

const { TEST_LICENSE_PRIVATE_KEY } = jest.requireMock('../config/licenseKeys');
const prisma = new PrismaClient();

let app: { url: string; close: () => Promise<void> };
let tenantId = '';
let mainGateId = '';
let lobbyId = '';
let visitorBayId = '';
let otherCameraId = '';
let operator = { userId: '', token: '' };
let viewerOther = { userId: '', token: '' };

async function license(forTenant: string) {
  const claims = { licenseId: `lic_nl_${crypto.randomBytes(4).toString('hex')}`, tenantId: forTenant, tier: 'ENTERPRISE', maxCameras: 16, features: ['ADVANCED_SEARCH'], issuedAt: new Date().toISOString(), expiresAt: null, kid: 'test' } as any;
  const art = signLicensePayload(claims, TEST_LICENSE_PRIVATE_KEY);
  await prisma.license.create({ data: { tenantId: forTenant, licenseId: claims.licenseId, tier: 'ENTERPRISE', maxCameras: 16, features: ['ADVANCED_SEARCH'], signedPayload: art.signedPayload, signatureEd25519: art.signatureEd25519 } });
}

async function parse(user: { token: string }, body: unknown) {
  const r = await fetch(`${app.url}/api/v1/tracks/parse-query`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${user.token}` }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
}

/** SYNTHETIC rewriter: a fixed English answer, recording what it was asked. */
function standIn(answer: string | Error) {
  const calls: Array<{ tenantId: string; text: string; vocabulary: string[] }> = [];
  const r: QueryRewriter = {
    rewrite: async (t, text, vocabulary) => {
      calls.push({ tenantId: t, text, vocabulary });
      if (answer instanceof Error) throw answer;
      return { english: answer, promptSha256: 'c'.repeat(64), model: { name: 'qwen3-4b-query-rewrite', version: '1.0.0', sha256: 'd'.repeat(64) }, inferenceId: 'inf-1', latencyMs: 2400 };
    },
  };
  return { r, calls };
}

beforeAll(async () => {
  process.env.VIGILONE_FEATURE_TRACK_INDEX = 'true';
  process.env.VIGILONE_FEATURE_NL_SEARCH = 'true';
  const a = await createTenantWithCamera(prisma, 'nlsearch', { timezone: 'Asia/Kolkata' });
  tenantId = a.tenantId;
  mainGateId = a.cameraId;
  await prisma.camera.update({ where: { id: mainGateId }, data: { name: 'Main Gate' } });
  lobbyId = (await prisma.camera.create({ data: { tenantId, siteId: a.siteId, name: 'Lobby', streamPath: `lobby_${a.suffix}`, ipAddress: '127.0.0.1', mainRtspUri: `rtsp://127.0.0.1:8554/lobby_${a.suffix}` } })).id;
  const square = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  visitorBayId = (await prisma.detectionZone.create({ data: { tenantId, cameraId: lobbyId, name: 'Visitor Bay', type: 'INCLUSION', polygonCoordinates: square } })).id;
  await prisma.detectionZone.create({ data: { tenantId, cameraId: lobbyId, name: 'Privacy Mask', type: 'EXCLUSION', polygonCoordinates: square } });
  const b = await createTenantWithCamera(prisma, 'nlsearch-other');
  otherCameraId = b.cameraId;
  await prisma.camera.update({ where: { id: otherCameraId }, data: { name: 'Loading Dock' } });
  for (const id of [tenantId, b.tenantId]) await license(id);
  operator = await createUserWithToken(prisma, tenantId, 'OPERATOR');
  viewerOther = await createUserWithToken(prisma, b.tenantId, 'OPERATOR');
  app = await startApp();
});

afterAll(async () => {
  setQueryRewriterForTests(undefined);
  delete process.env.VIGILONE_FEATURE_TRACK_INDEX;
  delete process.env.VIGILONE_FEATURE_NL_SEARCH;
  await app?.close();
  await prisma.$disconnect();
});

afterEach(() => setQueryRewriterForTests(undefined));

describe('POST /tracks/parse-query', () => {
  it('is 501 while NL_SEARCH is off, and 400 for a blank or over-long request', async () => {
    process.env.VIGILONE_FEATURE_NL_SEARCH = 'false';
    try {
      expect(await parse(operator, { text: 'red car' })).toMatchObject({ status: 501, json: { code: 'FEATURE_DISABLED', feature: 'NL_SEARCH' } });
    } finally {
      process.env.VIGILONE_FEATURE_NL_SEARCH = 'true';
    }
    for (const body of [{}, { text: '   ' }, { text: 'x'.repeat(513) }, { text: 42 }]) {
      expect(await parse(operator, body)).toMatchObject({ status: 400, json: { code: 'INVALID_QUERY' } });
    }
  });

  it('reads cameras, zones, colours and the site time zone with the rules alone', async () => {
    setQueryRewriterForTests(null);
    const before = Date.now();
    const r = await parse(operator, { text: 'man in a blue shirt at Main Gate in the last 2 hours, not a guard' });
    expect(r.status).toBe(200);
    expect(r.json.filters).toMatchObject({ cameraIds: [mainGateId], objectClasses: ['person'], upperColour: 'blue' });
    const span = Date.parse(r.json.filters.to) - Date.parse(r.json.filters.from);
    expect(span).toBe(2 * 3_600_000);
    expect(Date.parse(r.json.filters.to)).toBeGreaterThanOrEqual(before - 1000);
    expect(r.json.not).toEqual(['guard']);
    expect(r.json.text).not.toMatch(/main gate|hours/i);
    expect(r.json).toMatchObject({ unread: false, rewrite: { used: false } });
    expect(r.json.understood.map((u: any) => u.field)).toEqual(expect.arrayContaining(['camera', 'class', 'upperColour', 'time', 'not']));

    const z = await parse(operator, { text: 'people in visitor bay yesterday' });
    expect(z.json.filters.zoneId).toBe(visitorBayId);
    // "yesterday" is a calendar day at the site (+05:30): it starts at 18:30 UTC.
    expect(z.json.filters.from).toMatch(/T18:30:00\.000Z$/);
    // An EXCLUSION zone is a mask, not a place.
    expect((await parse(operator, { text: 'car in privacy mask' })).json.filters.zoneId).toBeUndefined();
  });

  it('never matches another tenant\'s camera names', async () => {
    setQueryRewriterForTests(null);
    const mine = await parse(operator, { text: 'truck at Loading Dock camera' });
    expect(mine.status).toBe(200);
    expect(mine.json.filters.cameraIds).toBeUndefined();
    expect(mine.json.unknownPlaces).toEqual(['loading dock']);
    expect(JSON.stringify(mine.json)).not.toContain(otherCameraId);
    const theirs = await parse(viewerOther, { text: 'truck at Main Gate' });
    expect(theirs.json.filters.cameraIds).toBeUndefined();
    expect(JSON.stringify(theirs.json)).not.toContain(mainGateId);
  });

  it('sends only what the word list cannot read to the rewrite model, with this tenant\'s place names, and keeps the original reading', async () => {
    // The model says "black car"; the request says white (सफेद), and the request wins.
    const { r, calls } = standIn('black car at Main Gate');
    setQueryRewriterForTests(r);
    const res = await parse(operator, { text: 'मुख्य गेट पर सफेद कार' });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].tenantId).toBe(tenantId);
    expect(calls[0].vocabulary.sort()).toEqual(['Lobby', 'Main Gate', 'Visitor Bay']);
    expect(res.json.filters).toMatchObject({ cameraIds: [mainGateId], objectClasses: ['car'], bodyColour: 'white' });
    expect(res.json).toMatchObject({ unread: false, rewrite: { used: true, english: 'black car at Main Gate', model: { name: 'qwen3-4b-query-rewrite' }, latencyMs: 2400 } });

    // A request the rules read in full is never sent.
    await parse(operator, { text: 'laal gaadi main gate par' });
    expect(calls).toHaveLength(1);
  });

  it('falls back to the rules\' own reading, with the reason, when the model fails or is not configured', async () => {
    setQueryRewriterForTests(standIn(new QueryRewriteError('QUERY_REWRITE_UNAVAILABLE', 'adapter down')).r);
    const failed = await parse(operator, { text: 'मुख्य गेट पर सफेद कार' });
    expect(failed.status).toBe(200);
    expect(failed.json.filters).toMatchObject({ objectClasses: ['car'], bodyColour: 'white' });
    expect(failed.json.filters.cameraIds).toBeUndefined();
    expect(failed.json).toMatchObject({ unread: true, rewrite: { used: false, reason: 'QUERY_REWRITE_UNAVAILABLE', message: 'adapter down' } });

    setQueryRewriterForTests(null);
    expect((await parse(operator, { text: 'मुख्य गेट पर सफेद कार' })).json).toMatchObject({ unread: true, rewrite: { used: false, reason: 'REWRITE_NOT_CONFIGURED' } });
  });
});
