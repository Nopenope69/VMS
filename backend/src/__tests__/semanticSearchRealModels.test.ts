/**
 * @jest-environment ../services/ai-worker/jest.environment.js
 */
/**
 * Semantic search end to end with the REAL SigLIP 2 model (needs the model files; skipped without them
 * unless VIGILONE_REQUIRE_MODEL_TESTS=1): real embedding adapter over HTTP, real crop embedder, real
 * pgvector database, real Express app, text queries and query by example.
 *
 * The four pictures are public-domain scikit-image samples. This shows the pipeline works with the
 * model and that obvious queries find obvious pictures; it says nothing about retrieval quality on
 * site footage, which still needs labelled site queries (docs/operations/RETRIEVAL_LABELLING.md).
 * Approvals are bypassed with evaluationOnly (a test-only path), so this is not a licence decision.
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
import { execFileSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera, createUserWithToken, startApp } from './helpers/realDb';
import { signLicensePayload } from '../utils/license';
import { CropEmbedder } from '../services/search/cropEmbedder.service';
import { EmbeddingAdapterClient } from '../services/search/embeddingAdapterClient';
import { EmbeddingAdapterCore } from '../../../services/ai-worker/src/embedding/embeddingAdapterCore';
import { loadEmbeddingPipeline, resolveEmbeddingPipelinePath } from '../../../services/ai-worker/src/embedding/embeddingPipeline';
import { createAdapterServer } from '../../../services/ai-worker/src/adapter/httpServer';
import { artifactPathFor, findCandidateEntry } from '../../../services/ai-worker/src/modelCatalog';

const { TEST_LICENSE_PRIVATE_KEY } = jest.requireMock('../config/licenseKeys');
jest.setTimeout(300000);

const def = JSON.parse(fs.readFileSync(resolveEmbeddingPipelinePath(), 'utf8'));
const present = def.components.every((c: any) => fs.existsSync(artifactPathFor(findCandidateEntry(c.key))));
const required = process.env.VIGILONE_REQUIRE_MODEL_TESTS === '1';
describe('SigLIP 2 model files for the end-to-end test', () => {
  it('are present, or this run does not require them (VIGILONE_REQUIRE_MODEL_TESTS)', () => {
    if (!present && required) throw new Error('fetch siglip2-base-p16-224-vision and siglip2-base-p16-224-text');
    expect(present || !required).toBe(true);
  });
});

const SRC = path.resolve(__dirname, '../../../services/ai-worker/src/__tests__/fixtures/golden/source');
const PICS = ['astronaut', 'camera', 'chelsea', 'coffee'] as const;

(present ? describe : describe.skip)('semantic search with the real SigLIP 2 model', () => {
  const prisma = new PrismaClient();
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'semreal-')));
  const saved = { ...process.env };
  let adapter: http.Server;
  let app: { url: string; close: () => Promise<void> };
  let tenantId = '';
  let token = '';
  let modelSha = '';
  let modelName = '';
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    process.env.CROPS_DIR = tmp;
    const pipeline = await loadEmbeddingPipeline({ evaluationOnly: true });
    modelName = pipeline.definition.name;
    modelSha = pipeline.definitionSha256;
    adapter = createAdapterServer(new EmbeddingAdapterCore(pipeline, { adapterId: 'vigilone-embedding', adapterVersion: 'test' }));
    await new Promise<void>((r) => adapter.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(adapter.address() as any).port}`;

    const c = await createTenantWithCamera(prisma, 'semreal');
    tenantId = c.tenantId;
    token = (await createUserWithToken(prisma, tenantId, 'TENANT_ADMIN')).token;
    const claims = { licenseId: `lic_sr_${crypto.randomBytes(4).toString('hex')}`, tenantId, tier: 'ENTERPRISE', maxCameras: 4, features: ['ADVANCED_SEARCH'], issuedAt: new Date().toISOString(), expiresAt: null, kid: 'test' } as any;
    const art = signLicensePayload(claims, TEST_LICENSE_PRIVATE_KEY);
    await prisma.license.create({ data: { tenantId, licenseId: claims.licenseId, tier: 'ENTERPRISE', maxCameras: 4, features: ['ADVANCED_SEARCH'], signedPayload: art.signedPayload, signatureEd25519: art.signatureEd25519 } });
    await prisma.modelManifest.create({ data: { name: modelName, version: pipeline.definition.version, sha256: modelSha, task: 'embedding', codeLicense: 'Apache-2.0', weightLicense: 'Apache-2.0', trainingDataJson: {}, runtimeConfigJson: {}, isActive: true } });

    for (const name of PICS) {
      const jpeg = execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(SRC, `${name}.png`), '-q:v', '2', '-f', 'mjpeg', '-'], { maxBuffer: 32 << 20 });
      const id = crypto.randomUUID();
      const rel = `${tenantId}/${c.cameraId}/${id}.jpg`;
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      fs.writeFileSync(path.join(tmp, rel), jpeg);
      const at = new Date(Date.now() - 3600_000);
      await prisma.objectCrop.create({ data: { id, tenantId, cameraId: c.cameraId, cropClass: 'NON_PERSON', objectClass: 'other', relativePath: rel, sha256: crypto.createHash('sha256').update(jpeg).digest('hex'), byteLength: jpeg.length, capturedAt: at, expiresAt: new Date(at.getTime() + 14 * 86_400_000) } });
      ids[name] = id;
    }
    const embedder = new CropEmbedder(prisma, new EmbeddingAdapterClient(prisma, url));
    const run = await embedder.runOnce();
    expect(run).toMatchObject({ stored: 4, failed: 0, adapterProblem: null });
    process.env.EMBEDDING_ADAPTER_URL = url;
    app = await startApp();
  });
  afterAll(async () => {
    await app?.close();
    await new Promise<void>((r) => adapter.close(() => r()));
    await prisma.modelManifest.deleteMany({ where: { sha256: modelSha } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = saved;
  });

  const search = async (body: unknown) => {
    process.env.VIGILONE_FEATURE_SEMANTIC_SEARCH = 'true';
    const r = await fetch(`${app.url}/api/v1/search/crops`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    delete process.env.VIGILONE_FEATURE_SEMANTIC_SEARCH;
    return { status: r.status, json: (await r.json()) as any };
  };

  it('stored one real 768-dim embedding per crop under the pipeline identity', async () => {
    const rows = await prisma.$queryRaw<Array<{ n: number; dim: number; sha: string }>>`SELECT count(*)::int AS n, max(vector_dims(embedding))::int AS dim, min("modelSha256") AS sha FROM "CropEmbedding" WHERE "tenantId" = ${tenantId}`;
    expect(rows[0]).toEqual({ n: 4, dim: 768, sha: modelSha });
  });

  it.each([
    ['a photo of an astronaut in a spacesuit', 'astronaut'],
    ['a photo of a cat', 'chelsea'],
    ['a cup of coffee', 'coffee'],
    ['a man taking a photo with a camera on a tripod', 'camera'],
  ])('text query %j ranks the %s picture first', async (text, expected) => {
    const r = await search({ text });
    expect(r.status).toBe(200);
    expect(r.json.hits[0].cropId).toBe(ids[expected]);
    expect(r.json.hits).toHaveLength(4);
  });

  it('a by-example search excludes the query crop and returns the other pictures', async () => {
    const r = await search({ cropId: ids.chelsea });
    expect(r.status).toBe(200);
    expect(r.json.hits.map((h: any) => h.cropId)).not.toContain(ids.chelsea);
    expect(r.json.hits).toHaveLength(3);
  });
});
