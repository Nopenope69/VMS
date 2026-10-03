/**
 * Embedding adapter (Phase 5): contract behaviour with a stand-in pipeline (no model files needed),
 * and, when the SigLIP 2 files are present, real HTTP inference. Approvals in the real section are a
 * temporary TEST-ONLY file, not a licence decision.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFileSync } from 'child_process';
import { EmbeddingAdapterCore } from '../embedding/embeddingAdapterCore';
import { EMBEDDING_DIM, LoadedEmbeddingPipeline, loadEmbeddingPipeline, resolveEmbeddingPipelinePath } from '../embedding/embeddingPipeline';
import { createAdapterServer } from '../adapter/httpServer';
import { artifactPathFor, findCandidateEntry } from '../modelCatalog';

const FIX = path.join(__dirname, 'fixtures', 'embedding');
const ref = JSON.parse(fs.readFileSync(path.join(FIX, 'siglip2.reference.json'), 'utf8'));
const def = JSON.parse(fs.readFileSync(resolveEmbeddingPipelinePath(), 'utf8'));
const entry = (k: string) => findCandidateEntry(k);

/** Stand-in pipeline: SYNTHETIC vectors, no model. */
function fake(over: Partial<LoadedEmbeddingPipeline> = {}): LoadedEmbeddingPipeline {
  const vec = (seed: number) => Float32Array.from({ length: EMBEDDING_DIM }, (_, i) => Math.sin(seed + i));
  return {
    definition: def,
    definitionSha256: 'a'.repeat(64),
    components: def.components.map((c: any) => ({ role: c.role, entry: entry(c.key), approval: null })),
    embedImage: async () => vec(1),
    embedText: async (t: string) => vec(t.length),
    tokenize: () => [],
    ...over,
  };
}

const frame = (extra: Record<string, unknown> = {}) => ({
  cameraId: 'c', streamSessionId: 's', sequenceNumber: 1, timestampUtc: '2026-09-30T10:00:00.000Z', width: 37, height: 91, format: 'rgb24',
  data: { kind: 'inline_base64', value: Buffer.alloc(37 * 91 * 3, 7).toString('base64') }, ...extra,
});
const inferBody = (over: Record<string, unknown> = {}) => ({ contract: 'ai-adapter.v1', requestId: 'r1', tenantId: 't', task: 'embedding', modelId: 'siglip2-base-p16-224@1.0.0', deadlineMs: 10000, frame: frame(), ...over });
const textBody = (over: Record<string, unknown> = {}) => ({ contract: 'ai-adapter.v1', requestId: 'r2', tenantId: 't', modelId: 'siglip2-base-p16-224@1.0.0', text: 'a white van', deadlineMs: 10000, ...over });
const decode = (r: any) => new Float32Array(new Uint8Array(Buffer.from(r.embedding.vector, 'base64')).buffer);

describe('embedding adapter (stand-in pipeline)', () => {
  it('describes one embedding model whose sha is the pipeline definition and lists both towers', () => {
    const d = new EmbeddingAdapterCore(fake(), { adapterId: 'e', adapterVersion: 't' }).describe();
    expect(d.tasks).toEqual(['embedding']);
    expect(d.requiresNetworkEgress).toBe(false);
    expect(d.models[0]).toMatchObject({ name: 'siglip2-base-p16-224', version: '1.0.0', sha256: 'a'.repeat(64), task: 'embedding' });
    expect(d.models[0].components!.map((c) => c.role)).toEqual(['image_encoder', 'text_encoder']);
    expect(d.models[0].evaluation).toBeNull();
  });

  it('embeds an image: ok result, 768 float32 components, provenance names the model and both towers', async () => {
    const r: any = await new EmbeddingAdapterCore(fake(), { adapterId: 'e', adapterVersion: 't' }).handleInferRequest(inferBody());
    expect(r.status).toBe('ok');
    expect(r.detections).toEqual([]);
    expect(r.embedding).toMatchObject({ dim: EMBEDDING_DIM, encoding: 'float32_base64', normalized: false });
    expect(decode(r)).toHaveLength(EMBEDDING_DIM);
    expect(r.provenance).toMatchObject({ modelName: 'siglip2-base-p16-224', modelVersion: '1.0.0', modelSha256: 'a'.repeat(64) });
    expect(r.provenance.components.map((c: any) => c.role)).toEqual(['image_encoder', 'text_encoder']);
  });

  it('embeds text into a vector of the same size with the same model identity', async () => {
    const core = new EmbeddingAdapterCore(fake(), { adapterId: 'e', adapterVersion: 't' });
    const a: any = await core.handleInferRequest(inferBody());
    const t: any = await core.handleTextEmbedRequest(textBody());
    expect(t.status).toBe('ok');
    expect(decode(t)).toHaveLength(EMBEDDING_DIM);
    expect(t.provenance.modelSha256).toBe(a.provenance.modelSha256);
    expect(t.provenance.modelName).toBe(a.provenance.modelName);
  });

  it.each([
    ['another task', inferBody({ task: 'object_detection' }), 'UNSUPPORTED_TASK'],
    ['another model id', inferBody({ modelId: 'other@1' }), 'MODEL_NOT_LOADED'],
    ['a malformed frame', inferBody({ frame: frame({ width: 0 }) }), 'INVALID_FRAME'],
    ['a frame with the wrong byte length', inferBody({ frame: frame({ width: 40 }) }), 'INVALID_FRAME'],
  ])('refuses %s', async (_n, body, code) => {
    const r: any = await new EmbeddingAdapterCore(fake(), { adapterId: 'e', adapterVersion: 't' }).handleInferRequest(body);
    expect(r).toMatchObject({ status: 'error', errorCode: code });
    expect(r.embedding).toBeUndefined();
  });

  it.each([
    ['blank text', textBody({ text: '   ' }), 'INVALID_FRAME'],
    ['text over 512 characters', textBody({ text: 'x'.repeat(513) }), 'INVALID_FRAME'],
    ['a non-string text', textBody({ text: 5 }), 'INVALID_FRAME'],
    ['a wrong contract', textBody({ contract: 'ai-adapter.v2' }), 'INVALID_FRAME'],
    ['a bad deadline', textBody({ deadlineMs: 0 }), 'INVALID_FRAME'],
    ['another model id', textBody({ modelId: 'other@1' }), 'MODEL_NOT_LOADED'],
  ])('text request: refuses %s', async (_n, body, code) => {
    const r: any = await new EmbeddingAdapterCore(fake(), { adapterId: 'e', adapterVersion: 't' }).handleTextEmbedRequest(body);
    expect(r).toMatchObject({ status: 'error', errorCode: code });
  });

  it('a runtime failure is RUNTIME_ERROR, never an empty success', async () => {
    const core = new EmbeddingAdapterCore(fake({ embedImage: async () => { throw new Error('boom'); } }), { adapterId: 'e', adapterVersion: 't' });
    expect(await core.handleInferRequest(inferBody())).toMatchObject({ status: 'error', errorCode: 'RUNTIME_ERROR', message: 'boom' });
  });

  it('a wrong-sized vector is refused', async () => {
    const core = new EmbeddingAdapterCore(fake({ embedText: async () => new Float32Array(10) }), { adapterId: 'e', adapterVersion: 't' });
    expect(await core.handleTextEmbedRequest(textBody())).toMatchObject({ status: 'error', errorCode: 'RUNTIME_ERROR' });
  });

  it('a zero vector is refused (the SDK core checks every embedding)', async () => {
    const core = new EmbeddingAdapterCore(fake({ embedText: async () => new Float32Array(EMBEDDING_DIM) }), { adapterId: 'e', adapterVersion: 't' });
    expect(await core.handleTextEmbedRequest(textBody())).toMatchObject({ status: 'error', errorCode: 'RUNTIME_ERROR', message: expect.stringMatching(/zero vector/) });
  });

  it('a late answer is DEADLINE_EXCEEDED', async () => {
    const core = new EmbeddingAdapterCore(fake({ embedText: () => new Promise((r) => setTimeout(() => r(new Float32Array(EMBEDDING_DIM)), 30)) }), { adapterId: 'e', adapterVersion: 't' });
    expect(await core.handleTextEmbedRequest(textBody({ deadlineMs: 1 }))).toMatchObject({ status: 'error', errorCode: 'DEADLINE_EXCEEDED' });
  });

  it('a second request while one runs is OVERLOADED and health says DEGRADED', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const core = new EmbeddingAdapterCore(fake({ embedText: async () => { await gate; return new Float32Array(EMBEDDING_DIM).fill(0.5); } }), { adapterId: 'e', adapterVersion: 't' });
    const first = core.handleTextEmbedRequest(textBody());
    expect(core.health().status).toBe('DEGRADED');
    expect(await core.handleTextEmbedRequest(textBody({ requestId: 'r3' }))).toMatchObject({ status: 'error', errorCode: 'OVERLOADED', retryable: true });
    release();
    expect((await first).status).toBe('ok');
    expect(core.health().status).toBe('READY');
  });

  it('with no pipeline it is FAILED with the reason and refuses everything', async () => {
    const core = new EmbeddingAdapterCore(null, { adapterId: 'e', adapterVersion: 't', failure: 'LICENSE_REJECTED: x' });
    expect(core.health()).toMatchObject({ status: 'FAILED', lastError: 'LICENSE_REJECTED: x', loadedModelIds: [] });
    expect(core.describe().models).toEqual([]);
    expect(await core.handleInferRequest(inferBody())).toMatchObject({ status: 'error', errorCode: 'MODEL_NOT_LOADED' });
    expect(await core.handleTextEmbedRequest(textBody())).toMatchObject({ status: 'error', errorCode: 'MODEL_NOT_LOADED' });
  });

  describe('over HTTP', () => {
    let server: http.Server;
    let base = '';
    beforeAll(async () => {
      server = createAdapterServer(new EmbeddingAdapterCore(fake(), { adapterId: 'e', adapterVersion: 't' }));
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      base = `http://127.0.0.1:${(server.address() as any).port}`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));
    const post = (p: string, body: unknown) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    it('serves /v1/embed-text and maps errors to HTTP statuses', async () => {
      const ok = await post('/v1/embed-text', textBody());
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as any).embedding.dim).toBe(EMBEDDING_DIM);
      expect((await post('/v1/embed-text', textBody({ text: '' }))).status).toBe(400);
      expect((await post('/v1/embed-text', textBody({ modelId: 'x' }))).status).toBe(503);
    });

    it('the object-detection adapter has no /v1/embed-text (404)', async () => {
      const s = createAdapterServer({ metrics: new EmbeddingAdapterCore(null, { adapterId: 'x', adapterVersion: 't' }).metrics, describe: () => ({} as any), health: () => ({} as any), handleInferRequest: async () => ({} as any) });
      await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
      try {
        const r = await fetch(`http://127.0.0.1:${(s.address() as any).port}/v1/embed-text`, { method: 'POST', body: '{}' });
        expect(r.status).toBe(404);
      } finally {
        await new Promise<void>((r) => s.close(() => r()));
      }
    });
  });
});

// ---- real models -------------------------------------------------------------------------------
const present = def.components.every((c: any) => fs.existsSync(artifactPathFor(entry(c.key))));
const required = process.env.VIGILONE_REQUIRE_MODEL_TESTS === '1';
if (!present && required) test('SigLIP 2 models required', () => { throw new Error('fetch siglip2-base-p16-224-vision and siglip2-base-p16-224-text'); });

(present ? describe : describe.skip)('embedding service with the real SigLIP 2 files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'embedding-worker-'));
  const approvals = path.join(tmp, 'approvals.json');
  afterEach(() => { delete process.env.VIGILONE_MODEL_EXCEPTIONS; });

  it('refuses to load without a human approval for each tower (LICENSE_REJECTED)', async () => {
    fs.writeFileSync(approvals, JSON.stringify({ approvals: [] }));
    process.env.VIGILONE_MODEL_EXCEPTIONS = approvals;
    await expect(loadEmbeddingPipeline()).rejects.toThrow(/^LICENSE_REJECTED: siglip2-base-p16-224-vision is a candidate model pending human review/);
  });

  it('refuses an approval that names a different hash', async () => {
    fs.writeFileSync(approvals, JSON.stringify({ approvals: def.components.map((c: any) => ({ key: c.key, sha256: '0'.repeat(64), approvedBy: 'TEST-ONLY', approvedAt: '2026-09-30', reason: 'unit test' })) }));
    process.env.VIGILONE_MODEL_EXCEPTIONS = approvals;
    await expect(loadEmbeddingPipeline()).rejects.toThrow(/LICENSE_REJECTED/);
  });

  describe('over HTTP', () => {
    let server: http.Server;
    let base = '';
    beforeAll(async () => {
      fs.writeFileSync(approvals, JSON.stringify({ approvals: def.components.map((c: any) => ({ key: c.key, sha256: c.sha256, approvedBy: 'TEST-ONLY (not a licence decision)', approvedAt: '2026-09-30', reason: 'unit test' })) }));
      process.env.VIGILONE_MODEL_EXCEPTIONS = approvals;
      server = createAdapterServer(new EmbeddingAdapterCore(await loadEmbeddingPipeline(), { adapterId: 'vigilone-embedding', adapterVersion: 'test' }));
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      base = `http://127.0.0.1:${(server.address() as any).port}`;
    }, 120000);
    afterAll(() => new Promise<void>((r) => server.close(() => r())));
    const post = async (p: string, body: unknown) => (await (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()) as any;
    const cos = (a: Float32Array, b: Float32Array) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / Math.sqrt(x * y); };
    const f32 = (b64: string) => new Float32Array(new Uint8Array(Buffer.from(b64, 'base64')).buffer);

    it('a JPEG crop over HTTP is close to the official PyTorch embedding of the source image', async () => {
      const im = ref.images.find((i: any) => i.file === 'SYNTHETIC_640x480.png');
      const jpeg = execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(FIX, im.file), '-q:v', '1', '-f', 'mjpeg', '-'], { maxBuffer: 16 << 20 });
      const desc = await (await fetch(base + '/v1/descriptor')).json() as any;
      const r = await post('/v1/infer', inferBody({ modelId: desc.models[0].modelId, frame: frame({ width: 640, height: 480, format: 'jpeg', data: { kind: 'inline_base64', value: jpeg.toString('base64') } }) }));
      expect(r.status).toBe('ok');
      // The JPEG re-encode changes pixels slightly, so this is a similarity check, not bit-equality.
      expect(cos(f32(r.embedding.vector), f32(im.pytorchEmbeddingF32b64))).toBeGreaterThan(0.99);
      expect(r.provenance.modelSha256).toBe(desc.models[0].sha256);
    }, 60000);

    it('a text query over HTTP gives the official PyTorch text embedding', async () => {
      const t = ref.prompts[1];
      const desc = await (await fetch(base + '/v1/descriptor')).json() as any;
      const r = await post('/v1/embed-text', textBody({ modelId: desc.models[0].modelId, text: t.text }));
      expect(r.status).toBe('ok');
      expect(cos(f32(r.embedding.vector), f32(t.pytorchEmbeddingF32b64))).toBeGreaterThan(0.99999);
    }, 60000);
  });
});
