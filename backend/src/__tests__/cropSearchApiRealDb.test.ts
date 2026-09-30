/**
 * P5.3 crop search API on the real Express app and pgvector database: flag and licence gating, RBAC,
 * tenant isolation, query by example, text queries (through a stand-in embedding adapter over HTTP, so
 * the real client checks run), the purpose-limited and audited path for
 * person crops, and the crop image endpoint (hash-checked). VECTORS ARE SYNTHETIC (see
 * cropEmbeddingStoreRealDb.test.ts); this tests the API around them, not retrieval quality.
 */
jest.mock('../config/licenseKeys', () => {
  const c = require('crypto');
  const kp = c.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  return { VENDOR_LICENSE_PUBLIC_KEY: kp.publicKey, TEST_LICENSE_PRIVATE_KEY: kp.privateKey };
});

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera, createUserWithToken, startApp } from './helpers/realDb';
import { signLicensePayload } from '../utils/license';
import { EMBEDDING_DIM, normalizeVector, storeEmbedding } from '../services/search/cropEmbeddingStore';

const { TEST_LICENSE_PRIVATE_KEY } = jest.requireMock('../config/licenseKeys');
jest.setTimeout(120000);

const prisma = new PrismaClient();
const FLAG = 'VIGILONE_FEATURE_SEMANTIC_SEARCH';
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cropsearch-')));
const saved = { ...process.env };
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
let app: { url: string; close: () => Promise<void> };
let tenantId = '';
let cameraId = '';
let otherTenantId = '';
let admin = '';
let operator = '';
let viewer = '';
let otherAdmin = '';
let modelSha = '';
let modelName = '';
const crops: Record<string, { id: string; bytes: Buffer; vec: number[] }> = {};

const vecFor = (seed: number) => {
  let a = seed >>> 0;
  const r = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: EMBEDDING_DIM }, () => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r()));
};
const near = (v: number[], seed: number, amount: number) => { const n = vecFor(seed); return v.map((x, i) => x + amount * n[i]); };

async function call(token: string, method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${app.url}/api/v1/search/crops${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const buf = Buffer.from(await r.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary body */ }
  return { status: r.status, json, buf, type: r.headers.get('content-type') };
}
const purpose = { 'x-vigilone-purpose': 'SECURITY_INCIDENT_INVESTIGATION' };

async function addCrop(key: string, cls: 'PERSON' | 'NON_PERSON', objectClass: string, vec: number[], t = tenantId, cam = cameraId) {
  const bytes = Buffer.from(`fake-jpeg-bytes-${key}-${crypto.randomUUID()}`);
  const id = crypto.randomUUID();
  const rel = `${t}/${cam}/${id}.jpg`;
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
  fs.writeFileSync(path.join(tmp, rel), bytes);
  const at = new Date(Date.now() - 3600_000);
  await prisma.objectCrop.create({ data: { id, tenantId: t, cameraId: cam, cropClass: cls, objectClass, relativePath: rel, sha256: sha(bytes), byteLength: bytes.length, capturedAt: at, expiresAt: new Date(at.getTime() + 14 * 86_400_000) } });
  await storeEmbedding(prisma, { tenantId: t, cropId: id, model: { name: modelName, version: '1.0.0', sha256: modelSha }, adapterId: 'test', vector: vec });
  crops[key] = { id, bytes, vec };
  return id;
}

beforeAll(async () => {
  process.env.CROPS_DIR = tmp;
  const a = await createTenantWithCamera(prisma, 'csearch-a');
  const b = await createTenantWithCamera(prisma, 'csearch-b');
  ({ tenantId, cameraId } = a);
  otherTenantId = b.tenantId;
  admin = (await createUserWithToken(prisma, tenantId, 'TENANT_ADMIN')).token;
  operator = (await createUserWithToken(prisma, tenantId, 'OPERATOR')).token;
  viewer = (await createUserWithToken(prisma, tenantId, 'VIEWER')).token;
  otherAdmin = (await createUserWithToken(prisma, otherTenantId, 'TENANT_ADMIN')).token;
  for (const t of [tenantId, otherTenantId]) {
    const claims = { licenseId: `lic_cs_${crypto.randomBytes(4).toString('hex')}`, tenantId: t, tier: 'ENTERPRISE', maxCameras: 16, features: ['ADVANCED_SEARCH'], issuedAt: new Date().toISOString(), expiresAt: null, kid: 'test' } as any;
    const art = signLicensePayload(claims, TEST_LICENSE_PRIVATE_KEY);
    await prisma.license.create({ data: { tenantId: t, licenseId: claims.licenseId, tier: 'ENTERPRISE', maxCameras: 16, features: ['ADVANCED_SEARCH'], signedPayload: art.signedPayload, signatureEd25519: art.signatureEd25519 } });
  }
  modelName = `siglip2-sim-${tenantId.slice(0, 8)}`;
  modelSha = sha(`csearch-${tenantId}`);
  await prisma.modelManifest.create({ data: { name: modelName, version: '1.0.0', sha256: modelSha, task: 'embedding', codeLicense: 'Apache-2.0', weightLicense: 'Apache-2.0', trainingDataJson: {}, runtimeConfigJson: {}, isActive: true } });
  const base = vecFor(1);
  await addCrop('car1', 'NON_PERSON', 'car', base);
  await addCrop('car2', 'NON_PERSON', 'car', near(base, 2, 0.2));
  await addCrop('truck', 'NON_PERSON', 'truck', vecFor(3));
  const pv = vecFor(4);
  await addCrop('person1', 'PERSON', 'person', pv);
  await addCrop('person2', 'PERSON', 'person', near(pv, 5, 0.2));
  await addCrop('foreign', 'NON_PERSON', 'car', near(base, 6, 0.05), otherTenantId, b.cameraId);
  app = await startApp();
});
afterAll(async () => {
  await app.close();
  await prisma.modelManifest.deleteMany({ where: { name: modelName } });
  await prisma.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } });
  await prisma.$disconnect();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.env = saved;
});
afterEach(() => {
  delete process.env[FLAG];
});

describe('P5.3 crop search API', () => {
  it('flag OFF: 501 FEATURE_DISABLED', async () => {
    const r = await call(admin, 'POST', '', { cropId: crops.car1.id });
    expect(r.status).toBe(501);
    expect(r.json.code).toBe('FEATURE_DISABLED');
  });

  it('query by example returns similar non-person crops, best first, never the query crop or another tenant, with an image link; the query is audited', async () => {
    process.env[FLAG] = 'true';
    const before = await prisma.auditEvent.count({ where: { tenantId, action: 'CROP_SEARCH_QUERY' } });
    const r = await call(viewer, 'POST', '', { cropId: crops.car1.id, limit: 10 });
    expect(r.status).toBe(200);
    expect(r.json.model).toEqual({ name: modelName, version: '1.0.0', sha256: modelSha });
    const ids = r.json.hits.map((h: any) => h.cropId);
    expect(ids[0]).toBe(crops.car2.id); // the near-duplicate first
    expect(ids).toContain(crops.truck.id);
    expect(ids).not.toContain(crops.car1.id);
    expect(ids).not.toContain(crops.foreign.id);
    expect(ids).not.toContain(crops.person1.id);
    expect(r.json.hits[0]).toMatchObject({ cropClass: 'NON_PERSON', objectClass: 'car', imageUrl: `/api/v1/search/crops/${crops.car2.id}/image` });
    expect(r.json.hits[0].score).toBeGreaterThan(r.json.hits[1].score);
    const audit = await prisma.auditEvent.findMany({ where: { tenantId, action: 'CROP_SEARCH_QUERY' }, orderBy: { sequenceNumber: 'desc' }, take: 1 });
    expect(await prisma.auditEvent.count({ where: { tenantId, action: 'CROP_SEARCH_QUERY' } })).toBe(before + 1);
    expect(audit[0].metadataJson).toMatchObject({ queryKind: 'crop', queryCropId: crops.car1.id, resultCount: r.json.hits.length, modelSha256: modelSha });
  });

  it('a raw vector works, filters apply, and the other tenant sees only its own crops', async () => {
    process.env[FLAG] = 'true';
    const byVec = await call(operator, 'POST', '', { embedding: crops.truck.vec, objectClasses: ['truck'] });
    expect(byVec.status).toBe(200);
    expect(byVec.json.hits.map((h: any) => h.cropId)).toEqual([crops.truck.id]);
    const theirs = await call(otherAdmin, 'POST', '', { embedding: crops.car1.vec });
    expect(theirs.json.hits.map((h: any) => h.cropId)).toEqual([crops.foreign.id]);
    expect((await call(otherAdmin, 'POST', '', { cropId: crops.car1.id })).status).toBe(404); // not their crop
  });

  it('a text query without a configured embedding adapter is 501 TEXT_QUERY_NOT_AVAILABLE; malformed bodies are 400', async () => {
    process.env[FLAG] = 'true';
    delete process.env.EMBEDDING_ADAPTER_URL;
    const t = await call(admin, 'POST', '', { text: 'red car near the gate' });
    expect([t.status, t.json.code]).toEqual([501, 'TEXT_QUERY_NOT_AVAILABLE']);
    for (const body of [{}, { cropId: crops.car1.id, embedding: crops.car1.vec }, { embedding: [1, 2, 3] }, { cropId: crops.car1.id, limit: 1000 }, { cropId: crops.car1.id, junk: 1 }, { cropId: crops.car1.id, minScore: 5 }]) {
      const r = await call(admin, 'POST', '', body);
      expect([r.status, r.json.code]).toEqual([400, 'INVALID_SEARCH']);
    }
    expect((await call(admin, 'POST', '', { cropId: crypto.randomUUID() })).status).toBe(404);
    const bare = await prisma.objectCrop.create({ data: { tenantId, cameraId, cropClass: 'NON_PERSON', objectClass: 'car', relativePath: `x/${crypto.randomUUID()}.jpg`, sha256: sha('bare'), byteLength: 1, capturedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) } });
    expect((await call(admin, 'POST', '', { cropId: bare.id })).json.code).toBe('EMBEDDING_NOT_FOUND');
  });

  it('person crops: viewers are forbidden; others need a declared, allowed purpose; the query is audited with it', async () => {
    process.env[FLAG] = 'true';
    const body = { cropId: crops.person1.id, includePersons: true, personsOnly: true };
    expect((await call(viewer, 'POST', '', body, purpose)).json.code).toBe('PERSON_CROP_FORBIDDEN');
    // Appearance search over people is limited to administrators; operators can search other crops but not people.
    expect((await call(operator, 'POST', '', body, purpose)).json.code).toBe('PERSON_CROP_FORBIDDEN');
    expect((await call(operator, 'GET', `/${crops.person1.id}/image`, undefined, purpose)).json.code).toBe('PERSON_CROP_FORBIDDEN');
    const noPurpose = await call(admin, 'POST', '', body);
    expect([noPurpose.status, noPurpose.json.code]).toEqual([400, 'PURPOSE_REQUIRED']);
    const badPurpose = await call(admin, 'POST', '', body, { 'x-vigilone-purpose': 'MARKETING' });
    expect(badPurpose.json.code).toBe('PURPOSE_UNKNOWN');
    const needsRef = await call(admin, 'POST', '', body, { 'x-vigilone-purpose': 'LAW_ENFORCEMENT_REQUEST' });
    expect(needsRef.json.code).toBe('PURPOSE_REFERENCE_REQUIRED');
    // the example being a person crop without asking for persons is refused, not silently widened
    expect((await call(admin, 'POST', '', { cropId: crops.person1.id }, purpose)).json.code).toBe('PERSON_QUERY_REQUIRES_INCLUDE');

    const before = await prisma.auditEvent.count({ where: { tenantId, action: 'CROP_PERSON_SEARCH_QUERY' } });
    const ok = await call(admin, 'POST', '', body, { ...purpose, 'x-vigilone-purpose-reference': 'FIR 12/2026' });
    expect(ok.status).toBe(200);
    expect(ok.json.hits.map((h: any) => h.cropId)).toEqual([crops.person2.id]);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId, action: 'CROP_PERSON_SEARCH_QUERY' }, orderBy: { sequenceNumber: 'desc' } });
    expect(await prisma.auditEvent.count({ where: { tenantId, action: 'CROP_PERSON_SEARCH_QUERY' } })).toBe(before + 1);
    expect(audit).toMatchObject({ resourceType: 'BiometricData' });
    expect(audit.metadataJson).toMatchObject({ category: 'BIOMETRIC', purpose: 'SECURITY_INCIDENT_INVESTIGATION', purposeReference: 'FIR 12/2026', queryCropId: crops.person1.id, resultCount: 1 });

    // asking for persons with a vector needs the same gate
    expect((await call(admin, 'POST', '', { embedding: crops.person1.vec, includePersons: true })).json.code).toBe('PURPOSE_REQUIRED');
  });

  it('the image endpoint returns the exact bytes; a person image needs the permission and a purpose and is audited', async () => {
    process.env[FLAG] = 'true';
    const img = await call(viewer, 'GET', `/${crops.car1.id}/image`);
    expect([img.status, img.type]).toEqual([200, 'image/jpeg']);
    expect(img.buf.equals(crops.car1.bytes)).toBe(true);
    expect((await call(otherAdmin, 'GET', `/${crops.car1.id}/image`)).status).toBe(404);

    expect((await call(viewer, 'GET', `/${crops.person1.id}/image`, undefined, purpose)).json.code).toBe('PERSON_CROP_FORBIDDEN');
    expect((await call(admin, 'GET', `/${crops.person1.id}/image`)).json.code).toBe('PURPOSE_REQUIRED');
    const before = await prisma.auditEvent.count({ where: { tenantId, action: 'CROP_PERSON_IMAGE_VIEW' } });
    const ok = await call(admin, 'GET', `/${crops.person1.id}/image`, undefined, purpose);
    expect(ok.status).toBe(200);
    expect(ok.buf.equals(crops.person1.bytes)).toBe(true);
    expect(await prisma.auditEvent.count({ where: { tenantId, action: 'CROP_PERSON_IMAGE_VIEW' } })).toBe(before + 1);
  });

  it('a tampered crop file is a loud 500 CROP_INTEGRITY_FAILED, a removed one a 404, never the wrong bytes', async () => {
    process.env[FLAG] = 'true';
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const row = await prisma.objectCrop.findUniqueOrThrow({ where: { id: crops.truck.id } });
    const file = path.join(tmp, row.relativePath);
    const original = fs.readFileSync(file);
    fs.writeFileSync(file, Buffer.concat([original, Buffer.from('x')]));
    const bad = await call(admin, 'GET', `/${crops.truck.id}/image`);
    expect([bad.status, bad.json.code]).toEqual([500, 'CROP_INTEGRITY_FAILED']);
    fs.rmSync(file);
    const gone = await call(admin, 'GET', `/${crops.truck.id}/image`);
    expect([gone.status, gone.json.code]).toEqual([404, 'CROP_FILE_MISSING']);
    fs.writeFileSync(file, original);
    jest.restoreAllMocks();
  });

  it('a tenant whose signed licence lacks ADVANCED_SEARCH is refused', async () => {
    process.env[FLAG] = 'true';
    const c = await createTenantWithCamera(prisma, 'csearch-nolic');
    try {
      const token = (await createUserWithToken(prisma, c.tenantId, 'TENANT_ADMIN')).token;
      const claims = { licenseId: `lic_nl_${crypto.randomBytes(4).toString('hex')}`, tenantId: c.tenantId, tier: 'ENTERPRISE', maxCameras: 4, features: ['ANPR'], issuedAt: new Date().toISOString(), expiresAt: null, kid: 'test' } as any;
      const art = signLicensePayload(claims, TEST_LICENSE_PRIVATE_KEY);
      await prisma.license.create({ data: { tenantId: c.tenantId, licenseId: claims.licenseId, tier: 'ENTERPRISE', maxCameras: 4, features: ['ANPR'], signedPayload: art.signedPayload, signatureEd25519: art.signatureEd25519 } });
      const r = await call(token, 'POST', '', { embedding: crops.car1.vec });
      expect(r.status).toBe(403);
      expect(JSON.stringify(r.json)).toMatch(/ADVANCED_SEARCH/);
    } finally {
      await prisma.tenant.delete({ where: { id: c.tenantId } }).catch(() => undefined);
    }
  });
});

describe('P5.3 text queries (stand-in embedding adapter over HTTP; vectors are SYNTHETIC)', () => {
  let stub: http.Server;
  let url = '';
  const stubMode = { kind: 'ok' as 'ok' | 'wrongModel' | 'unregistered' | 'errorStatus', seenText: [] as string[] };
  // What each query text "means": the vector of a stored crop, so the expected best hit is known.
  const meaning = (t: string): number[] => (t.includes('person') ? crops.person1.vec : t.includes('truck') ? crops.truck.vec : crops.car1.vec);
  const b64 = (v: number[]) => Buffer.from(Float32Array.from(v).buffer).toString('base64');

  beforeAll(async () => {
    stub = http.createServer((req, res) => {
      const send = (o: unknown, status = 200) => { res.statusCode = status; res.end(JSON.stringify(o)); };
      const card = () => ({ modelId: 'emb-1', name: stubMode.kind === 'unregistered' ? 'unregistered-model' : modelName, version: '1.0.0', sha256: stubMode.kind === 'unregistered' ? sha('unregistered') : modelSha, task: 'embedding', classes: ['embedding'], codeLicense: 'Apache-2.0', weightsLicense: 'Apache-2.0', weightsSource: 'SIMULATED stub', runtime: 'onnxruntime', input: { width: 224, height: 224, colorSpace: 'RGB', letterbox: false }, evaluation: null });
      if (req.url === '/v1/health') return send({ contract: 'ai-adapter.v1', adapterId: 'stub', status: 'READY', loadedModelIds: ['emb-1'], lastError: null, observedAtUtc: new Date().toISOString() });
      if (req.url === '/v1/descriptor') return send({ contract: 'ai-adapter.v1', adapterId: 'stub', adapterVersion: 't', tasks: ['embedding'], requiresNetworkEgress: false, models: [card()] });
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const rq = JSON.parse(body);
        if (req.url !== '/v1/embed-text') return send({ error: 'not found' }, 404);
        stubMode.seenText.push(rq.text);
        if (stubMode.kind === 'errorStatus') return send({ contract: 'ai-adapter.v1', status: 'error', requestId: rq.requestId, errorCode: 'OVERLOADED', message: 'busy', retryable: true }, 429);
        const wrong = stubMode.kind === 'wrongModel';
        return send({
          contract: 'ai-adapter.v1', status: 'ok', requestId: rq.requestId, detections: [],
          embedding: { dim: EMBEDDING_DIM, encoding: 'float32_base64', vector: b64(meaning(rq.text)), normalized: false },
          provenance: { adapterId: 'stub', adapterVersion: 't', modelId: 'emb-1', modelName: wrong ? 'some-other-model' : modelName, modelVersion: '1.0.0', modelSha256: wrong ? sha('other') : modelSha, runtime: 'onnxruntime', inferenceId: crypto.randomUUID(), frameTimestampUtc: new Date().toISOString() },
          latencyMs: 1,
        });
      });
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(stub.address() as any).port}`;
  });
  afterAll(() => new Promise<void>((r) => stub.close(() => r())));
  beforeEach(() => {
    process.env[FLAG] = 'true';
    process.env.EMBEDDING_ADAPTER_URL = url;
    stubMode.kind = 'ok';
    stubMode.seenText.length = 0;
  });
  afterEach(() => {
    delete process.env.EMBEDDING_ADAPTER_URL;
  });

  it('embeds the text through the adapter and returns the nearest non-person crops; the query text is audited', async () => {
    const r = await call(viewer, 'POST', '', { text: '  a red truck  ', limit: 5 });
    expect(r.status).toBe(200);
    expect(stubMode.seenText).toEqual(['a red truck']);
    expect(r.json.hits[0].cropId).toBe(crops.truck.id);
    expect(r.json.hits.map((h: any) => h.cropId)).not.toContain(crops.person1.id);
    expect(r.json.hits.map((h: any) => h.cropId)).not.toContain(crops.foreign.id);
    expect(r.json.model.sha256).toBe(modelSha);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId, action: 'CROP_SEARCH_QUERY' }, orderBy: { sequenceNumber: 'desc' } });
    expect(audit.metadataJson).toMatchObject({ queryKind: 'text', queryText: 'a red truck', queryCropId: null, modelSha256: modelSha });
  });

  it('naming the model that the text encoder serves is fine; naming another is 409', async () => {
    expect((await call(admin, 'POST', '', { text: 'car', modelSha256: modelSha })).status).toBe(200);
    const other = await call(admin, 'POST', '', { text: 'car', modelSha256: sha('another-model') });
    expect([other.status, other.json.code]).toEqual([409, 'TEXT_MODEL_MISMATCH']);
  });

  it('text that matches people is person access: permission, purpose, audit with the text', async () => {
    const body = { text: 'a person in a red jacket', includePersons: true, personsOnly: true };
    expect((await call(viewer, 'POST', '', body, purpose)).json.code).toBe('PERSON_CROP_FORBIDDEN');
    expect((await call(operator, 'POST', '', body, purpose)).json.code).toBe('PERSON_CROP_FORBIDDEN'); // administrators only
    expect((await call(admin, 'POST', '', body)).json.code).toBe('PURPOSE_REQUIRED');
    const before = await prisma.auditEvent.count({ where: { tenantId, action: 'CROP_PERSON_SEARCH_QUERY' } });
    const ok = await call(admin, 'POST', '', body, purpose);
    expect(ok.status).toBe(200);
    expect(ok.json.hits.map((h: any) => h.cropId)).toEqual([crops.person1.id, crops.person2.id]); // the text is not a stored crop, so nothing is excluded
    expect(await prisma.auditEvent.count({ where: { tenantId, action: 'CROP_PERSON_SEARCH_QUERY' } })).toBe(before + 1);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId, action: 'CROP_PERSON_SEARCH_QUERY' }, orderBy: { sequenceNumber: 'desc' } });
    expect(audit.metadataJson).toMatchObject({ purpose: 'SECURITY_INCIDENT_INVESTIGATION', queryKind: 'text', queryText: 'a person in a red jacket' });
  });

  it('person text without asking for persons never returns person crops', async () => {
    const r = await call(admin, 'POST', '', { text: 'a person walking' });
    expect(r.status).toBe(200);
    expect(r.json.hits.every((h: any) => h.cropClass === 'NON_PERSON')).toBe(true);
  });

  it('the other tenant only ever sees its own crops', async () => {
    const r = await call(otherAdmin, 'POST', '', { text: 'a car' });
    expect(r.json.hits.map((h: any) => h.cropId)).toEqual([crops.foreign.id]);
  });

  it.each([
    ['blank text', { text: '   ' }],
    ['text longer than 512 characters', { text: 'x'.repeat(513) }],
    ['text together with a crop id', { text: 'car', cropId: 'use-car1' }],
  ])('refuses %s (400 INVALID_SEARCH)', async (_n, body: { text: string; cropId?: string }) => {
    const r = await call(admin, 'POST', '', body.cropId ? { ...body, cropId: crops.car1.id } : body);
    expect([r.status, r.json.code]).toEqual([400, 'INVALID_SEARCH']);
    expect(stubMode.seenText).toEqual([]); // nothing was sent to the adapter
  });

  it('an adapter that is down, errors, serves another model or an unregistered model gives 503, never a result', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    stubMode.kind = 'errorStatus';
    let r = await call(admin, 'POST', '', { text: 'car' });
    expect([r.status, r.json.code]).toEqual([503, 'EMBEDDING_ADAPTER_UNAVAILABLE']);
    stubMode.kind = 'wrongModel';
    r = await call(admin, 'POST', '', { text: 'car' });
    expect([r.status, r.json.code]).toEqual([503, 'EMBEDDING_ADAPTER_INVALID']);
    stubMode.kind = 'unregistered';
    r = await call(admin, 'POST', '', { text: 'car' });
    expect([r.status, r.json.code]).toEqual([503, 'EMBEDDING_MODEL_NOT_REGISTERED']);
    process.env.EMBEDDING_ADAPTER_URL = 'http://127.0.0.1:1'; // nothing listens
    stubMode.kind = 'ok';
    r = await call(admin, 'POST', '', { text: 'car' });
    expect([r.status, r.json.code]).toEqual([503, 'EMBEDDING_ADAPTER_UNAVAILABLE']);
    jest.restoreAllMocks();
  });
});
