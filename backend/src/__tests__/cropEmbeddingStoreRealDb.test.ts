/**
 * P5.3 crop embeddings on real PostgreSQL + pgvector. The VECTORS ARE SYNTHETIC (seeded clusters): this
 * proves the storage, the constraints, the filters, tenant/model isolation, the exact-scan fallback,
 * the cascade with crop retention and that the HNSW index is used and finds the true neighbours. It says
 * nothing about how well any real embedding model retrieves crops from a site.
 */
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera } from './helpers/realDb';
import {
  EMBEDDING_DIM,
  EmbeddingError,
  fromPgVector,
  loadEmbedding,
  normalizeVector,
  searchSimilar,
  searchSimilarToCrop,
  storeEmbedding,
  toPgVector,
} from '../services/search/cropEmbeddingStore';
import { purgeTenantCrops } from '../services/crops/cropPurge.service';
import { CropStore } from '../services/crops/cropStore';
import os from 'os';
import path from 'path';
import fs from 'fs';

jest.setTimeout(120000);

const prisma = new PrismaClient();
const DAY = 86_400_000;
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
const unit = (v: number[]) => Array.from(normalizeVector(v));
const cos = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

let tenantId = '';
let cameraA = '';
let cameraB = '';
let siteId = '';
let otherTenantId = '';
let otherCrop = '';
let modelSha = '';
let modelName = '';
let otherModelSha = '';
const centroids: number[][] = [];
const stored: Array<{ id: string; v: number[]; camera: string; cls: 'PERSON' | 'NON_PERSON'; objectClass: string; at: Date }> = [];
const T0 = Date.UTC(2026, 8, 1);

async function addCrop(t: string, camera: string, cls: 'PERSON' | 'NON_PERSON', objectClass: string, at: Date) {
  const id = crypto.randomUUID();
  await prisma.objectCrop.create({ data: { id, tenantId: t, cameraId: camera, cropClass: cls, objectClass, relativePath: `${t}/${camera}/${id}.jpg`, sha256: sha(id), byteLength: 10, capturedAt: at, expiresAt: new Date(at.getTime() + 365 * DAY) } });
  return id;
}
const embed = (t: string, cropId: string, v: number[], model = { name: modelName, version: '1.0.0', sha256: modelSha }) => storeEmbedding(prisma, { tenantId: t, cropId, model, adapterId: 'test-adapter', inferenceId: 'inf', vector: v });

beforeAll(async () => {
  const a = await createTenantWithCamera(prisma, 'emb-a');
  const b = await createTenantWithCamera(prisma, 'emb-b');
  ({ tenantId, cameraId: cameraA, siteId } = a);
  otherTenantId = b.tenantId;
  cameraB = (await prisma.camera.create({ data: { tenantId, siteId, name: 'B', streamPath: `emb_b_${tenantId.slice(0, 6)}`, ipAddress: '127.0.0.9', mainRtspUri: 'rtsp://127.0.0.9/x' } })).id;
  modelName = `siglip2-sim-${tenantId.slice(0, 8)}`;
  modelSha = sha(`model-${tenantId}`);
  otherModelSha = sha(`other-model-${tenantId}`);
  for (const [name, s] of [[modelName, modelSha], [`${modelName}-other`, otherModelSha]] as const) {
    await prisma.modelManifest.create({ data: { name, version: '1.0.0', sha256: s, task: 'embedding', codeLicense: 'Apache-2.0', weightLicense: 'Apache-2.0', trainingDataJson: {}, runtimeConfigJson: {}, isActive: true } });
  }
  const r = rng(42);
  for (let k = 0; k < 6; k++) centroids.push(unit(Array.from({ length: EMBEDDING_DIM }, () => gauss(r))));
  // 300 crops: 6 clusters, two cameras, mixed classes, spread over 30 days.
  for (let i = 0; i < 300; i++) {
    const k = i % 6;
    const v = unit(centroids[k].map((x) => x + (0.5 * gauss(r)) / Math.sqrt(EMBEDDING_DIM)));
    const cls: 'PERSON' | 'NON_PERSON' = k === 0 ? 'PERSON' : 'NON_PERSON';
    const objectClass = k === 0 ? 'person' : k % 2 ? 'car' : 'truck';
    const camera = i % 2 ? cameraA : cameraB;
    const at = new Date(T0 + (i % 30) * DAY);
    const id = await addCrop(tenantId, camera, cls, objectClass, at);
    await embed(tenantId, id, v);
    stored.push({ id, v, camera, cls, objectClass, at });
  }
  // Another tenant holds a near-duplicate of cluster 1 and another model embeds one of our crops.
  otherCrop = await addCrop(otherTenantId, b.cameraId, 'NON_PERSON', 'car', new Date(T0));
  await prisma.modelManifest.create({ data: { name: `${modelName}-t2`, version: '1.0.0', sha256: sha(`t2-${tenantId}`), task: 'embedding', codeLicense: 'Apache-2.0', weightLicense: 'Apache-2.0', trainingDataJson: {}, runtimeConfigJson: {}, isActive: true } });
  await embed(otherTenantId, otherCrop, centroids[1], { name: `${modelName}-t2`, version: '1.0.0', sha256: sha(`t2-${tenantId}`) });
  await embed(tenantId, stored[1].id, centroids[1].map((x) => -x), { name: `${modelName}-other`, version: '1.0.0', sha256: otherModelSha });
});
afterAll(async () => {
  await prisma.modelManifest.deleteMany({ where: { name: { startsWith: modelName } } });
  await prisma.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } });
  await prisma.$disconnect();
});

const brute = (q: number[], filter: (s: (typeof stored)[number]) => boolean, k: number) =>
  stored
    .filter(filter)
    .map((s) => ({ id: s.id, score: cos(q, Array.from(normalizeVector(s.v))) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
const noisyQuery = (cluster: number, seed: number) => {
  const r = rng(seed);
  return unit(centroids[cluster].map((x) => x + (0.5 * gauss(r)) / Math.sqrt(EMBEDDING_DIM)));
};

describe('P5.3 vectors and constraints', () => {
  it('accepts only 768 finite, non-zero components and stores them L2-normalised; the pgvector text form round-trips', () => {
    expect(() => normalizeVector(new Array(767).fill(1))).toThrow(/expected 768/);
    expect(() => normalizeVector(new Array(769).fill(1))).toThrow(EmbeddingError);
    expect(() => normalizeVector([...new Array(767).fill(1), NaN])).toThrow(/finite/);
    expect(() => normalizeVector([...new Array(767).fill(1), Infinity])).toThrow(/finite/);
    expect(() => normalizeVector(new Array(768).fill(0))).toThrow(/zero length/);
    const v = normalizeVector(Array.from({ length: 768 }, (_, i) => (i % 7) - 3));
    expect(Math.abs(cos(v, v) - 1)).toBeLessThan(1e-5);
    const back = fromPgVector(toPgVector(v));
    expect(Array.from(back)).toEqual(Array.from(v));
  });

  it('the database refuses a wrong dimension, a wrong recorded size and a malformed model hash; rows follow their crop', async () => {
    const crop = await addCrop(tenantId, cameraA, 'NON_PERSON', 'car', new Date(T0));
    const good = toPgVector(normalizeVector(Array.from({ length: 768 }, (_, i) => i + 1)));
    const ins = (vec: string, dim: number, s: string) =>
      prisma.$executeRaw`INSERT INTO "CropEmbedding" ("id","tenantId","cropId","modelName","modelVersion","modelSha256","adapterId","dim","embedding") VALUES (${crypto.randomUUID()}, ${tenantId}, ${crop}, 'm', '1', ${s}, 'a', ${dim}, ${vec}::vector)`;
    await expect(ins(`[${new Array(767).fill(0.1).join(',')}]`, 768, sha('x'))).rejects.toThrow();
    await expect(ins(good, 512, sha('x'))).rejects.toThrow();
    await expect(ins(good, 768, 'NOT-HEX')).rejects.toThrow();
    await ins(good, 768, sha('x'));
    expect(await prisma.cropEmbedding.count({ where: { cropId: crop } })).toBe(1);
    await prisma.objectCrop.delete({ where: { id: crop } });
    expect(await prisma.cropEmbedding.count({ where: { cropId: crop } })).toBe(0);
  });
});

describe('P5.3 storing embeddings', () => {
  it('refuses a model that is not a registered, active embedding model with the same name, version and hash', async () => {
    const crop = await addCrop(tenantId, cameraA, 'NON_PERSON', 'car', new Date(T0));
    const v = centroids[2];
    const bad = [
      { name: 'nobody', version: '1.0.0', sha256: sha('nobody') },
      { name: modelName, version: '9.9.9', sha256: modelSha }, // wrong version
      { name: modelName, version: '1.0.0', sha256: sha('forged') }, // wrong hash
    ];
    for (const m of bad) await expect(embed(tenantId, crop, v, m)).rejects.toMatchObject({ code: 'EMBEDDING_MODEL_NOT_REGISTERED' });
    // a detector is not an embedding model, and an inactive model is refused too
    const det = await prisma.modelManifest.create({ data: { name: `${modelName}-det`, version: '1', sha256: sha('det'), task: 'object_detection', codeLicense: 'MIT', weightLicense: 'MIT', trainingDataJson: {}, runtimeConfigJson: {}, isActive: true } });
    await expect(embed(tenantId, crop, v, { name: det.name, version: '1', sha256: det.sha256 })).rejects.toMatchObject({ code: 'EMBEDDING_MODEL_NOT_REGISTERED' });
    await prisma.modelManifest.updateMany({ where: { sha256: modelSha }, data: { isActive: false } });
    await expect(embed(tenantId, crop, v)).rejects.toMatchObject({ code: 'EMBEDDING_MODEL_NOT_REGISTERED' });
    await prisma.modelManifest.updateMany({ where: { sha256: modelSha }, data: { isActive: true } });
    expect(await prisma.cropEmbedding.count({ where: { cropId: crop } })).toBe(0);
  });

  it("refuses another tenant's crop and a missing crop; a repeat write keeps the first embedding", async () => {
    await expect(embed(tenantId, otherCrop, centroids[3])).rejects.toMatchObject({ code: 'EMBEDDING_CROP_NOT_FOUND' });
    await expect(embed(tenantId, crypto.randomUUID(), centroids[3])).rejects.toMatchObject({ code: 'EMBEDDING_CROP_NOT_FOUND' });
    const crop = await addCrop(tenantId, cameraA, 'NON_PERSON', 'car', new Date(T0));
    expect((await embed(tenantId, crop, centroids[3])).created).toBe(true);
    expect((await embed(tenantId, crop, centroids[4])).created).toBe(false);
    const kept = await loadEmbedding(prisma, tenantId, crop, modelSha);
    expect(cos(kept!, centroids[3])).toBeGreaterThan(0.999);
    expect(await loadEmbedding(prisma, otherTenantId, crop, modelSha)).toBeNull();
  });
});

describe('P5.3 similarity search', () => {
  it('returns the true nearest neighbours (equal to a brute-force cosine ranking), best first', async () => {
    const q = noisyQuery(1, 7);
    const r = await searchSimilar(prisma, q, { tenantId, modelSha256: modelSha, limit: 10, exact: true });
    expect(r.mode).toBe('exact');
    const want = brute(q, (s) => s.cls === 'NON_PERSON', 10);
    expect(r.hits.map((h) => h.cropId)).toEqual(want.map((w) => w.id));
    r.hits.forEach((h, i) => expect(Math.abs(h.score - want[i].score)).toBeLessThan(1e-4));
    for (let i = 1; i < r.hits.length; i++) expect(r.hits[i - 1].score).toBeGreaterThanOrEqual(r.hits[i].score);
  });

  it('the HNSW index is the plan when the planner is made to use it, and its recall@10 against the exact answer is at least 0.9', async () => {
    await prisma.$executeRaw`ANALYZE "CropEmbedding"`;
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      const q = toPgVector(normalizeVector(centroids[2]));
      return tx.$queryRaw<Array<{ 'QUERY PLAN': string }>>`EXPLAIN SELECT "cropId" FROM "CropEmbedding" ORDER BY "embedding" <=> ${q}::vector LIMIT 10`;
    });
    expect(plan.map((p) => p['QUERY PLAN']).join('\n')).toContain('CropEmbedding_embedding_hnsw');

    let hit = 0;
    let total = 0;
    for (let i = 0; i < 20; i++) {
      const q = toPgVector(normalizeVector(noisyQuery(i % 6, 100 + i)));
      const [ann, exact] = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
        await tx.$executeRaw`SELECT set_config('hnsw.ef_search', '100', true)`;
        const a = await tx.$queryRaw<Array<{ id: string }>>`SELECT "cropId" AS id FROM "CropEmbedding" ORDER BY "embedding" <=> ${q}::vector LIMIT 10`;
        await tx.$executeRaw`SET LOCAL enable_indexscan = off`;
        await tx.$executeRaw`SET LOCAL enable_bitmapscan = off`;
        await tx.$executeRaw`SET LOCAL enable_seqscan = on`;
        const e = await tx.$queryRaw<Array<{ id: string }>>`SELECT "cropId" AS id FROM "CropEmbedding" ORDER BY "embedding" <=> ${q}::vector LIMIT 10`;
        return [a, e];
      });
      const truth = new Set(exact.map((x) => x.id));
      hit += ann.filter((x) => truth.has(x.id)).length;
      total += 10;
    }
    expect(hit / total).toBeGreaterThanOrEqual(0.9);
  });

  it('person crops are excluded unless asked for; personsOnly returns only them', async () => {
    const q = noisyQuery(0, 9); // the cluster made of person crops
    const def = await searchSimilar(prisma, q, { tenantId, modelSha256: modelSha, limit: 20 });
    expect(def.hits.every((h) => h.cropClass === 'NON_PERSON')).toBe(true);
    const inc = await searchSimilar(prisma, q, { tenantId, modelSha256: modelSha, limit: 20, includePersons: true });
    expect(inc.hits.filter((h) => h.cropClass === 'PERSON').length).toBeGreaterThan(10);
    const only = await searchSimilar(prisma, q, { tenantId, modelSha256: modelSha, limit: 20, includePersons: true, personsOnly: true });
    expect(only.hits.length).toBe(20);
    expect(only.hits.every((h) => h.cropClass === 'PERSON')).toBe(true);
    await expect(searchSimilar(prisma, q, { tenantId, modelSha256: modelSha, personsOnly: true })).rejects.toMatchObject({ code: 'SEARCH_INVALID' });
  });

  it('filters by camera, time window, class and score; a selective filter still returns every match (exact fallback) and says so', async () => {
    const q = noisyQuery(3, 11);
    const cam = await searchSimilar(prisma, q, { tenantId, modelSha256: modelSha, limit: 50, cameraIds: [cameraA] });
    expect(cam.hits.length).toBe(50);
    expect(cam.hits.every((h) => h.cameraId === cameraA)).toBe(true);

    // Day d holds cluster d mod 6, so day 2 is the trucks' cluster: exactly 10 crops match, fewer than the 20 asked for.
    const from = new Date(T0 + 2 * DAY);
    const to = new Date(T0 + 2 * DAY);
    const filt = (s: (typeof stored)[number]) => s.cls === 'NON_PERSON' && s.at >= from && s.at <= to && s.objectClass === 'truck';
    const want = brute(q, filt, 100);
    expect(want.length).toBeGreaterThan(0);
    expect(want.length).toBe(10);
    const sel = await searchSimilar(prisma, q, { tenantId, modelSha256: modelSha, limit: 20, from, to, objectClasses: ['truck'] });
    expect(sel.mode).toBe('exact'); // fewer matches than asked for: confirmed by an exact scan
    expect(sel.hits.map((h) => h.cropId)).toEqual(want.map((w) => w.id));

    const scored = await searchSimilar(prisma, q, { tenantId, modelSha256: modelSha, limit: 50, minScore: 0.5 });
    expect(scored.hits.length).toBeGreaterThan(0);
    expect(scored.hits.every((h) => h.score >= 0.5)).toBe(true);
    for (const bad of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { minScore: 2 }]) {
      await expect(searchSimilar(prisma, q, { tenantId, modelSha256: modelSha, ...bad })).rejects.toMatchObject({ code: 'SEARCH_INVALID' });
    }
  });

  it("never returns another tenant's crops or another model's vectors", async () => {
    const q = centroids[1];
    const r = await searchSimilar(prisma, q, { tenantId, modelSha256: modelSha, limit: 100, includePersons: true });
    expect(r.hits.map((h) => h.cropId)).not.toContain(otherCrop);
    expect(new Set(r.hits.map((h) => h.cropId)).size).toBe(r.hits.length); // one row per crop: the other model's vector for stored[1] is not mixed in
    const other = await searchSimilar(prisma, q, { tenantId: otherTenantId, modelSha256: modelSha, limit: 10 });
    expect(other.hits).toEqual([]); // the other tenant has nothing from this model
    const theirs = await searchSimilar(prisma, q, { tenantId: otherTenantId, modelSha256: sha(`t2-${tenantId}`), limit: 10 });
    expect(theirs.hits.map((h) => h.cropId)).toEqual([otherCrop]);
    // the same crop embedded by the other model is only visible under that model's hash, with its own vector
    const viaOther = await searchSimilar(prisma, centroids[1].map((x) => -x), { tenantId, modelSha256: otherModelSha, limit: 5 });
    expect(viaOther.hits.map((h) => h.cropId)).toEqual([stored[1].id]);
    expect(viaOther.hits[0].score).toBeGreaterThan(0.999);
  });

  it('query by example finds similar crops, never returns the query crop, and refuses a crop with no embedding', async () => {
    const probe = stored[7];
    const r = await searchSimilarToCrop(prisma, probe.id, { tenantId, modelSha256: modelSha, limit: 10, includePersons: true });
    expect(r.hits.map((h) => h.cropId)).not.toContain(probe.id);
    const want = brute(probe.v, (s) => s.id !== probe.id, 10);
    expect(r.hits.map((h) => h.cropId)).toEqual(want.map((w) => w.id));
    const bare = await addCrop(tenantId, cameraA, 'NON_PERSON', 'car', new Date(T0));
    await expect(searchSimilarToCrop(prisma, bare, { tenantId, modelSha256: modelSha })).rejects.toMatchObject({ code: 'EMBEDDING_NOT_FOUND' });
    await expect(searchSimilarToCrop(prisma, probe.id, { tenantId: otherTenantId, modelSha256: modelSha })).rejects.toMatchObject({ code: 'EMBEDDING_NOT_FOUND' });
  });
});

describe('P5.3 embeddings follow the crop retention purge', () => {
  it('an expired unheld crop is purged together with its embedding; a held one keeps both', async () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'embpurge-')));
    try {
      const now = new Date();
      const mk = async (capturedDaysAgo: number) => {
        const at = new Date(now.getTime() - capturedDaysAgo * DAY);
        const id = crypto.randomUUID();
        const rel = `${tenantId}/${cameraB}/${id}.jpg`;
        fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
        fs.writeFileSync(path.join(tmp, rel), 'x');
        await prisma.objectCrop.create({ data: { id, tenantId, cameraId: cameraB, cropClass: 'NON_PERSON', objectClass: 'car', relativePath: rel, sha256: sha(id), byteLength: 1, capturedAt: at, expiresAt: new Date(at.getTime() + DAY) } });
        await embed(tenantId, id, centroids[5]);
        return id;
      };
      const gone = await mk(100);
      const held = await mk(60);
      const alarm = await prisma.alarm.create({ data: { tenantId, cameraId: cameraB, title: 'hold' } });
      await prisma.incidentEvidenceHold.create({ data: { tenantId, alarmId: alarm.id, cameraId: cameraB, windowStart: new Date(now.getTime() - 61 * DAY), windowEnd: new Date(now.getTime() - 59 * DAY), expiresAt: new Date(now.getTime() + DAY) } });
      await purgeTenantCrops(prisma, tenantId, new CropStore(tmp, undefined, undefined, () => now), now);
      expect(await prisma.cropEmbedding.count({ where: { cropId: gone } })).toBe(0);
      expect(await prisma.cropEmbedding.count({ where: { cropId: held } })).toBe(1);
      expect(await prisma.objectCrop.count({ where: { id: held } })).toBe(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
