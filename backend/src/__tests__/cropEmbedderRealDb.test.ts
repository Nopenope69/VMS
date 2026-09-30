/**
 * P5.3 crop embedder on the real database, real crop files and a stub ai-adapter.v1.1 server.
 * THE STUB'S VECTORS ARE SIMULATED (seeded from the crop bytes): they prove the plumbing, the
 * verification of the adapter and its answers, the person-crop gate at embed time and the failure
 * handling. They say nothing about a real embedding model.
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera } from './helpers/realDb';
import { InferenceRequestV1 } from '../contracts/aiAdapter.v1';
import { CropStore } from '../services/crops/cropStore';
import { CropEmbedder, MAX_ATTEMPTS } from '../services/search/cropEmbedder.service';
import { EmbeddingAdapterClient, jpegSize } from '../services/search/embeddingAdapterClient';
import { embedIntervalMs, embeddingAdapterUrl, startEmbeddingWorkers } from '../services/search/embeddingWorkers';
import { EMBEDDING_DIM, loadEmbedding } from '../services/search/cropEmbeddingStore';
import { MetricsService } from '../services/observability/metrics.service';

jest.setTimeout(120000);

const prisma = new PrismaClient();
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'embedder-')));
const store = () => new CropStore(tmp, undefined, undefined, () => new Date());
const DAY = 86_400_000;

let tenantId = '';
let siteId = '';
let cameraId = '';
let modelName = '';
let modelSha = '';
let stub: http.Server;
let stubUrl = '';
let jpegBase: Buffer;
/** What the stub does next; tests flip this. */
const mode = { kind: 'ok' as 'ok' | 'wrongDim' | 'wrongModel' | 'nan' | 'zero' | 'errorStatus' | 'notReady' | 'unregistered' | 'badContract', requests: 0, seen: [] as string[] };

function simulatedVector(seedBytes: Buffer, dim: number): Float32Array {
  const seed = crypto.createHash('sha256').update(seedBytes).digest().readUInt32LE(0);
  let a = seed >>> 0;
  const r = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Float32Array.from({ length: dim }, () => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r()));
}
const b64 = (f: Float32Array) => Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64');

beforeAll(async () => {
  ({ tenantId, siteId, cameraId } = await createTenantWithCamera(prisma, 'embedder'));
  modelName = `siglip2-sim-${tenantId.slice(0, 8)}`;
  modelSha = sha(`embedder-${tenantId}`);
  await prisma.modelManifest.create({ data: { name: modelName, version: '1.0.0', sha256: modelSha, task: 'embedding', codeLicense: 'Apache-2.0', weightLicense: 'Apache-2.0', trainingDataJson: {}, runtimeConfigJson: {}, isActive: true } });
  const f = path.join(tmp, 'base.jpg');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=96x64:rate=1', '-frames:v', '1', f]);
  jpegBase = fs.readFileSync(f);

  stub = http.createServer((req, res) => {
    const send = (o: unknown, status = 200) => {
      res.statusCode = status;
      res.end(JSON.stringify(o));
    };
    const card = (name: string, s: string) => ({ modelId: 'emb-1', name, version: '1.0.0', sha256: s, task: 'embedding', classes: ['embedding'], codeLicense: 'Apache-2.0', weightsLicense: 'Apache-2.0', weightsSource: 'SIMULATED stub', runtime: 'onnxruntime', input: { width: 224, height: 224, colorSpace: 'RGB', letterbox: false }, evaluation: null });
    if (req.url === '/v1/health') {
      return send({ contract: 'ai-adapter.v1', adapterId: 'stub-embed', status: mode.kind === 'notReady' ? 'LOADING' : 'READY', loadedModelIds: mode.kind === 'notReady' ? [] : ['emb-1'], lastError: null, observedAtUtc: new Date().toISOString() });
    }
    if (req.url === '/v1/descriptor') {
      const unregistered = mode.kind === 'unregistered';
      return send({ contract: 'ai-adapter.v1', adapterId: 'stub-embed', adapterVersion: 't', tasks: ['embedding'], requiresNetworkEgress: false, models: [card(unregistered ? 'unregistered-model' : modelName, unregistered ? sha('unregistered') : modelSha)] });
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      mode.requests++;
      const parsed = InferenceRequestV1.safeParse(JSON.parse(body));
      if (!parsed.success) return send({ contract: 'ai-adapter.v1', status: 'error', requestId: 'unknown', errorCode: 'INVALID_FRAME', message: `request does not match the contract: ${parsed.error.issues[0].message}`, retryable: false });
      const rq = parsed.data;
      const jpeg = Buffer.from((rq.frame.data as any).value, 'base64');
      mode.seen.push(sha(jpeg));
      if (rq.task !== 'embedding' || rq.frame.format !== 'jpeg') return send({ contract: 'ai-adapter.v1', status: 'error', requestId: rq.requestId, errorCode: 'UNSUPPORTED_TASK', message: 'embedding of a jpeg only', retryable: false });
      if (mode.kind === 'errorStatus') return send({ contract: 'ai-adapter.v1', status: 'error', requestId: rq.requestId, errorCode: 'OVERLOADED', message: 'busy', retryable: true });
      if (mode.kind === 'badContract') return send({ nonsense: true });
      let v = simulatedVector(jpeg, mode.kind === 'wrongDim' ? 512 : EMBEDDING_DIM);
      if (mode.kind === 'nan') v[5] = NaN;
      if (mode.kind === 'zero') v = new Float32Array(EMBEDDING_DIM);
      const wrongModel = mode.kind === 'wrongModel';
      return send({
        contract: 'ai-adapter.v1',
        status: 'ok',
        requestId: rq.requestId,
        detections: [],
        embedding: { dim: v.length, encoding: 'float32_base64', vector: b64(v), normalized: false },
        provenance: { adapterId: 'stub-embed', adapterVersion: 't', modelId: 'emb-1', modelName: wrongModel ? 'some-other-model' : modelName, modelVersion: '1.0.0', modelSha256: wrongModel ? sha('other') : modelSha, runtime: 'onnxruntime', inferenceId: crypto.randomUUID(), frameTimestampUtc: rq.frame.timestampUtc },
        latencyMs: 1,
      });
    });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
  stubUrl = `http://127.0.0.1:${(stub.address() as any).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => stub.close(() => r()));
  await prisma.modelManifest.deleteMany({ where: { name: { in: [modelName, 'unregistered-model'] } } });
  await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await prisma.$disconnect();
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  mode.kind = 'ok';
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

let n = 0;
/** A stored crop with a real, distinct JPEG on disk. */
async function makeCrop(opts: { cls?: 'PERSON' | 'NON_PERSON'; ttlDays?: number; ageDays?: number; corruptFile?: boolean; noFile?: boolean } = {}) {
  const bytes = Buffer.concat([jpegBase.subarray(0, jpegBase.length - 2), Buffer.from(`unique-${n++}-${crypto.randomUUID()}`), jpegBase.subarray(jpegBase.length - 2)]);
  // A comment-like tail before EOI keeps it a well-formed enough JPEG for sizing while making every crop distinct.
  const capturedAt = new Date(Date.now() - (opts.ageDays ?? 0) * DAY);
  const id = crypto.randomUUID();
  const rel = `${tenantId}/${cameraId}/${id}.jpg`;
  if (!opts.noFile) {
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    fs.writeFileSync(path.join(tmp, rel), opts.corruptFile ? Buffer.concat([bytes, Buffer.from('tamper')]) : bytes);
  }
  await prisma.objectCrop.create({ data: { id, tenantId, cameraId, cropClass: opts.cls ?? 'NON_PERSON', objectClass: opts.cls === 'PERSON' ? 'person' : 'car', relativePath: rel, sha256: sha(bytes), byteLength: bytes.length, capturedAt, expiresAt: new Date(Date.now() + (opts.ttlDays ?? 10) * DAY) } });
  return { id, bytes };
}
const embedder = (url = stubUrl, batch = 20) => new CropEmbedder(prisma, new EmbeddingAdapterClient(prisma, url, 3000), store, batch);
const has = async (id: string) => (await loadEmbedding(prisma, tenantId, id, modelSha)) !== null;
const counter = (o: string) => MetricsService.getValue('vigilone_crop_embeddings_total', { outcome: o }) ?? 0;
const clearCrops = () => prisma.objectCrop.deleteMany({ where: { tenantId } });

describe('P5.3 embedder against a verified adapter', () => {
  it('embeds unexpired crops with the registered model, verifies bytes first, and is idempotent', async () => {
    await clearCrops();
    const a = await makeCrop();
    const b = await makeCrop();
    const expired = await makeCrop({ ageDays: 5, ttlDays: -1 });
    const before = counter('stored');
    const e = embedder();
    const r = await e.runOnce();
    expect(r).toMatchObject({ stored: 2, failed: 0, adapterProblem: null });
    expect(await has(a.id) && (await has(b.id))).toBe(true);
    expect(await has(expired.id)).toBe(false); // expired crops are not embedded
    expect(counter('stored')).toBe(before + 2);
    const row = await prisma.cropEmbedding.findFirstOrThrow({ where: { cropId: a.id } });
    expect(row).toMatchObject({ modelName, modelVersion: '1.0.0', modelSha256: modelSha, adapterId: 'stub-embed', dim: 768 });
    expect(mode.seen).toEqual(expect.arrayContaining([sha(a.bytes), sha(b.bytes)]));
    expect((await e.runOnce()).stored).toBe(0); // nothing left to do, nothing re-embedded
  });

  it('a missing file and a file that fails its hash are reported, never embedded, and not retried', async () => {
    await clearCrops();
    const gone = await makeCrop({ noFile: true });
    const bad = await makeCrop({ corruptFile: true });
    const ok = await makeCrop();
    const e = embedder();
    const r = await e.runOnce();
    expect(r).toMatchObject({ stored: 1, missingFile: 1, corrupt: 1 });
    expect(await has(gone.id) || (await has(bad.id))).toBe(false);
    expect(await has(ok.id)).toBe(true);
    const requestsBefore = mode.requests;
    const again = await e.runOnce();
    expect(again).toMatchObject({ stored: 0, missingFile: 0, corrupt: 0 });
    expect(mode.requests).toBe(requestsBefore);
  });

  it('a person crop is embedded only while its site has person crops enabled; switching it off later stops it', async () => {
    await clearCrops();
    const person = await makeCrop({ cls: 'PERSON' });
    const other = await makeCrop();
    let r = await embedder().runOnce();
    expect(r).toMatchObject({ stored: 1, skippedPersonPolicy: 1 });
    expect(await has(person.id)).toBe(false);
    expect(await has(other.id)).toBe(true);

    await prisma.siteCropPolicy.create({ data: { siteId, personCropsEnabled: true, acknowledgedPurpose: 'SECURITY_INCIDENT_INVESTIGATION', acknowledgedByUserId: 'u1', acknowledgedAt: new Date() } });
    try {
      const e = embedder();
      r = await e.runOnce();
      expect(r.stored).toBe(1);
      expect(await has(person.id)).toBe(true);
      // now a second person crop, and the site switches person crops off before it is embedded
      const late = await makeCrop({ cls: 'PERSON' });
      await prisma.siteCropPolicy.update({ where: { siteId }, data: { personCropsEnabled: false, acknowledgedPurpose: null, acknowledgedByUserId: null, acknowledgedAt: null } });
      r = await e.runOnce();
      expect(r).toMatchObject({ stored: 0, skippedPersonPolicy: 1 });
      expect(await has(late.id)).toBe(false);
    } finally {
      await prisma.siteCropPolicy.deleteMany({ where: { siteId } });
    }
  });
});

describe('P5.3 embedder failure handling (nothing is stored, nothing throws)', () => {
  it.each([
    ['an adapter that is unreachable', () => embedder('http://127.0.0.1:1'), /unreachable/],
  ])('%s', async (_n, make, re) => {
    await clearCrops();
    const c = await makeCrop();
    const r = await make().runOnce();
    expect(r.stored).toBe(0);
    expect(r.adapterProblem).toMatch(re);
    expect(await has(c.id)).toBe(false);
  });

  it.each<[typeof mode.kind, RegExp]>([
    ['notReady', /LOADING/],
    ['unregistered', /not a registered active embedding model/],
  ])('an adapter that is %s stops the run before any crop is sent', async (kind, re) => {
    await clearCrops();
    const c = await makeCrop();
    mode.kind = kind;
    const before = mode.requests;
    const r = await embedder().runOnce();
    expect(r.adapterProblem).toMatch(re);
    expect(r.stored).toBe(0);
    expect(mode.requests).toBe(before);
    expect(await has(c.id)).toBe(false);
  });

  it.each<[typeof mode.kind, RegExp]>([
    ['wrongDim', /512 dimensions/],
    ['wrongModel', /not the verified/],
    ['nan', /finite/],
    ['zero', /zero length/],
    ['badContract', /does not match ai-adapter/],
  ])('an answer that is %s is refused and counted; the crop stays unembedded', async (kind, re) => {
    await clearCrops();
    const c = await makeCrop();
    mode.kind = kind;
    const before = counter('failed');
    const client = new EmbeddingAdapterClient(prisma, stubUrl, 3000);
    await client.connect();
    await expect(client.embed(c.bytes, new Date().toISOString())).rejects.toThrow(re);
    const r = await embedder().runOnce();
    expect(r).toMatchObject({ stored: 0, failed: 1 });
    expect(counter('failed')).toBe(before + 1);
    expect(await has(c.id)).toBe(false);
  });

  it('an adapter that reports an error mid-run stops the run and is reported as an adapter problem', async () => {
    await clearCrops();
    const c1 = await makeCrop();
    await makeCrop();
    mode.kind = 'errorStatus';
    const before = mode.requests;
    const r = await embedder().runOnce();
    expect(r.adapterProblem).toMatch(/OVERLOADED/);
    expect(mode.requests).toBe(before + 1); // stopped after the first failure
    expect(await has(c1.id)).toBe(false);
  });

  it(`a crop that keeps failing is set aside after ${MAX_ATTEMPTS} tries so it cannot block the queue`, async () => {
    await clearCrops();
    const bad = await makeCrop({ ageDays: 5 }); // oldest, so first in line
    const e = embedder(stubUrl, 1); // batch of one: a stuck head would block everything behind it
    mode.kind = 'wrongDim';
    for (let i = 0; i < MAX_ATTEMPTS; i++) expect((await e.runOnce()).failed).toBe(1);
    const good = await makeCrop();
    mode.kind = 'ok';
    const r = await e.runOnce();
    expect(r.stored).toBe(1);
    expect(await has(good.id)).toBe(true);
    expect(await has(bad.id)).toBe(false);
  });

  it('two overlapping runs do not both work', async () => {
    await clearCrops();
    await makeCrop();
    const e = embedder();
    const [a, b] = await Promise.all([e.runOnce(), e.runOnce()]);
    expect(a.stored + b.stored).toBe(1);
  });
});

describe('P5.3 helpers and startup', () => {
  it('reads the size of a real JPEG and refuses anything else', () => {
    expect(jpegSize(jpegBase)).toEqual({ width: 96, height: 64 });
    expect(() => jpegSize(Buffer.from('not a jpeg'))).toThrow();
    expect(() => jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toThrow();
  });

  it('flag OFF starts nothing; ON needs a valid EMBEDDING_ADAPTER_URL and interval, else it refuses to start', () => {
    const w = { start: jest.fn(), stop: jest.fn() };
    const make = jest.fn(() => w);
    const on = { VIGILONE_FEATURE_SEMANTIC_SEARCH: 'true' } as NodeJS.ProcessEnv;
    expect(startEmbeddingWorkers(prisma, { EMBEDDING_ADAPTER_URL: 'http://x' }, make)).toBeNull();
    expect(make).not.toHaveBeenCalled();
    expect(() => startEmbeddingWorkers(prisma, on, make)).toThrow(/EMBEDDING_ADAPTER_URL is not set/);
    expect(() => startEmbeddingWorkers(prisma, { ...on, EMBEDDING_ADAPTER_URL: 'not a url' }, make)).toThrow(/not a URL/);
    expect(() => startEmbeddingWorkers(prisma, { ...on, EMBEDDING_ADAPTER_URL: 'ftp://x' }, make)).toThrow(/http or https/);
    for (const bad of ['abc', '0', '999', '1.5']) expect(() => startEmbeddingWorkers(prisma, { ...on, EMBEDDING_ADAPTER_URL: 'http://x', CROP_EMBED_INTERVAL_MS: bad }, make)).toThrow(/CROP_EMBED_INTERVAL_MS/);
    expect(make).not.toHaveBeenCalled();
    const h = startEmbeddingWorkers(prisma, { ...on, EMBEDDING_ADAPTER_URL: 'http://adapter:7020/', CROP_EMBED_INTERVAL_MS: '5000' }, make)!;
    expect(make).toHaveBeenCalledWith('http://adapter:7020');
    expect(w.start).toHaveBeenCalledWith(5000);
    h.stop();
    expect(w.stop).toHaveBeenCalled();
    expect(embedIntervalMs({})).toBe(30_000);
    expect(embeddingAdapterUrl({ EMBEDDING_ADAPTER_URL: ' https://a/b// ' })).toBe('https://a/b');
  });

  it('server.ts starts the embedder only through startEmbeddingWorkers (static check)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');
    expect(src).toContain('startEmbeddingWorkers(prisma)');
    expect(src).toMatch(/embeddingWorkers\?\.stop\(\)/);
  });
});
