/**
 * The SDK server's guarantees, with TEST-DOUBLE models (no ML; their model cards are fixtures, not real models).
 * The real-model example is tested in yoloxExample.test.ts.
 */
import { execFileSync } from 'child_process';
import http from 'http';
import path from 'path';
import { AdapterError, AdapterModel, createAdapter, ModelCard, runAiAdapterConformance, greyFrame } from '../index';

const card = (over: Partial<ModelCard> = {}): ModelCard => ({
  modelId: 'test-double',
  name: 'TEST DOUBLE (not a model)',
  version: '1',
  sha256: 'a'.repeat(64),
  task: 'object_detection',
  classes: ['person', 'car'],
  codeLicense: 'MIT',
  weightsLicense: 'MIT',
  weightsSource: 'test fixture',
  runtime: 'onnxruntime',
  input: { width: 64, height: 48, colorSpace: 'RGB', letterbox: false },
  evaluation: null,
  ...over,
});
const person = { objectClass: 'person', classId: 0, confidence: 0.9, bbox: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function serve(models: AdapterModel[], extra: Record<string, unknown> = {}) {
  const a = createAdapter({ adapterId: 'sdk-test', adapterVersion: '0.0.1', models, ...extra });
  const server = await a.listen(0);
  await a.load();
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  return { a, server, url };
}
const request = (over: Record<string, any> = {}, frame: Record<string, any> = {}) => ({
  contract: 'ai-adapter.v1',
  requestId: `r-${Math.random()}`,
  tenantId: 't',
  task: 'object_detection',
  modelId: 'test-double',
  deadlineMs: 5000,
  frame: { cameraId: 'c', streamSessionId: 's', sequenceNumber: 1, timestampUtc: '2026-09-30T10:00:00.000Z', width: 4, height: 2, format: 'rgb24', data: { kind: 'inline_base64', value: Buffer.alloc(24).toString('base64') }, ...frame },
  ...over,
});
const infer = async (url: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${url}/v1/infer`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: r.status, headers: r.headers, json: (await r.json()) as any };
};

describe('SDK adapter server', () => {
  const servers: http.Server[] = [];
  afterAll(() => servers.forEach((s) => s.close()));
  const up = async (models: AdapterModel[], extra: Record<string, unknown> = {}) => {
    const s = await serve(models, extra);
    servers.push(s.server);
    return s;
  };

  it('refuses an invalid model card at start-up (e.g. a non-permissive licence)', () => {
    expect(() => createAdapter({ adapterId: 'x', adapterVersion: '1', models: [{ card: card({ weightsLicense: 'AGPL-3.0' as any }), infer: async () => ({}) }] })).toThrow();
  });

  it('a success carries provenance from the card, the frame timestamp and a fresh inference id', async () => {
    const { url } = await up([{ card: card(), infer: async () => ({ detections: [person] }) }]);
    const r1 = await infer(url, request(), { 'x-correlation-id': 'abc-1' });
    const r2 = await infer(url, request());
    expect(r1.status).toBe(200);
    expect(r1.headers.get('x-correlation-id')).toBe('abc-1');
    expect(r1.json.provenance).toMatchObject({ adapterId: 'sdk-test', modelId: 'test-double', modelSha256: 'a'.repeat(64), frameTimestampUtc: '2026-09-30T10:00:00.000Z', runtime: 'onnxruntime' });
    expect(r1.json.provenance.inferenceId).not.toBe(r2.json.provenance.inferenceId);
  });

  it('model output that breaks the contract becomes RUNTIME_ERROR, never a success', async () => {
    const { url } = await up([
      { card: card({ modelId: 'stray' }), infer: async () => ({ detections: [{ ...person, objectClass: 'dragon' }] }) },
      { card: card({ modelId: 'outside' }), infer: async () => ({ detections: [{ ...person, bbox: { x: 0.8, y: 0, width: 0.5, height: 0.5 } }] }) },
      { card: card({ modelId: 'nan' }), infer: async () => ({ detections: [{ ...person, confidence: NaN }] }) },
      { card: card({ modelId: 'throws' }), infer: async () => { throw new Error('CUDA exploded'); } },
    ]);
    for (const [id, why] of [['stray', /dragon/], ['outside', /inside the frame/], ['nan', /confidence/], ['throws', /CUDA exploded/]] as const) {
      const r = await infer(url, request({ modelId: id }));
      expect({ id, status: r.status, code: r.json.errorCode }).toEqual({ id, status: 500, code: 'RUNTIME_ERROR' });
      expect(r.json.message).toMatch(why);
      expect(r.json.detections).toBeUndefined();
    }
  });

  it('checks frames: byte length, JPEG signature, shared memory, malformed JSON', async () => {
    const { url } = await up([{ card: card(), infer: async () => ({ detections: [] }) }]);
    expect((await infer(url, request({}, { width: 5 }))).json).toMatchObject({ errorCode: 'INVALID_FRAME', message: expect.stringMatching(/24 bytes, expected 30/) });
    expect((await infer(url, request({}, { format: 'jpeg', data: { kind: 'inline_base64', value: Buffer.from('GIF89a').toString('base64') } }))).json.errorCode).toBe('INVALID_FRAME');
    expect((await infer(url, request({}, { data: { kind: 'shared_memory', key: 'k', byteLength: 24 } }))).json.message).toMatch(/shared-memory/);
    const bad = await infer(url, '{nope');
    expect([bad.status, bad.json.errorCode]).toEqual([400, 'INVALID_FRAME']);
  });

  it('unknown model 503, unserved task 400, still loading 503, load failure FAILED', async () => {
    const { url } = await up([{ card: card(), infer: async () => ({ detections: [] }) }]);
    expect((await infer(url, request({ modelId: 'nope' }))).status).toBe(503);
    expect((await infer(url, request({ task: 'embedding' }))).json.errorCode).toBe('UNSUPPORTED_TASK');
    let finish: () => void = () => undefined;
    const slow = createAdapter({ adapterId: 'slow', adapterVersion: '1', models: [{ card: card(), load: () => new Promise<void>((r) => (finish = r)), infer: async () => ({}) }] });
    const s1 = await slow.listen(0);
    servers.push(s1);
    const u1 = `http://127.0.0.1:${(s1.address() as any).port}`;
    const h = await fetch(`${u1}/v1/health`);
    expect([h.status, ((await h.json()) as any).status]).toEqual([503, 'LOADING']);
    expect((await infer(u1, request())).json.errorCode).toBe('MODEL_NOT_LOADED');
    finish();
    await slow.load();
    expect((await fetch(`${u1}/v1/health`)).status).toBe(200);
    const broken = createAdapter({ adapterId: 'broken', adapterVersion: '1', models: [{ card: card(), load: async () => { throw new AdapterError('MODEL_INTEGRITY_FAILED', 'bad hash'); }, infer: async () => ({}) }] });
    const s2 = await broken.listen(0);
    servers.push(s2);
    await broken.load();
    const hb = (await (await fetch(`http://127.0.0.1:${(s2.address() as any).port}/v1/health`)).json()) as any;
    expect(hb).toMatchObject({ status: 'FAILED', lastError: 'bad hash', loadedModelIds: [] });
  });

  it('enforces the deadline and aborts the model; the slot stays taken until the model really stops', async () => {
    let aborted = false;
    let running = 0;
    let maxRunning = 0;
    const { url } = await up(
      [{ card: card(), infer: async (_f, ctx) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        ctx.signal.addEventListener('abort', () => (aborted = true));
        await sleep(300); // ignores the signal on purpose
        running--;
        return { detections: [] };
      } }],
      { maxInFlight: 1, maxQueued: 4 }
    );
    const r = await infer(url, request({ deadlineMs: 50 }));
    expect([r.status, r.json.errorCode, aborted]).toEqual([504, 'DEADLINE_EXCEEDED', true]);
    const next = await infer(url, request({ deadlineMs: 5000 }));
    expect(next.status).toBe(200);
    expect(maxRunning).toBe(1);
  });

  it('a model that blocks the event loop past the deadline still gets DEADLINE_EXCEEDED, not a late success', async () => {
    const { url } = await up([{ card: card(), infer: async () => {
      const until = Date.now() + 150;
      while (Date.now() < until); // synchronous compute, as onnxruntime-node does on the main thread
      return { detections: [] };
    } }]);
    const r = await infer(url, request({ deadlineMs: 20 }));
    expect([r.status, r.json.errorCode]).toEqual([504, 'DEADLINE_EXCEEDED']);
  });

  it('beyond maxInFlight + maxQueued: OVERLOADED with 429 and Retry-After', async () => {
    const { url } = await up([{ card: card(), infer: async () => (await sleep(200), { detections: [] }) }], { maxInFlight: 1, maxQueued: 1 });
    const all = await Promise.all(Array.from({ length: 5 }, () => infer(url, request())));
    const over = all.filter((r) => r.status === 429);
    expect(all.filter((r) => r.status === 200)).toHaveLength(2);
    expect(over).toHaveLength(3);
    expect(over.every((r) => r.json.errorCode === 'OVERLOADED' && r.headers.get('retry-after') === '1')).toBe(true);
  });

  it('embeddings: encoded as little-endian float32; zero or NaN vectors refused; /v1/embed-text only when offered', async () => {
    const emb = card({ modelId: 'emb', task: 'embedding', classes: ['embedding'] });
    const { url } = await up([
      { card: emb, infer: async () => ({ embedding: new Float32Array([0.6, 0.8]) }), embedText: async (t) => (t === 'zero' ? new Float32Array(2) : new Float32Array([1, 0])) },
    ]);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]).toString('base64');
    const r = await infer(url, request({ task: 'embedding', modelId: 'emb' }, { format: 'jpeg', data: { kind: 'inline_base64', value: jpeg } }));
    expect(r.json.embedding).toMatchObject({ dim: 2, normalized: true });
    const v = Buffer.from(r.json.embedding.vector, 'base64');
    expect([v.readFloatLE(0), v.readFloatLE(4)].map((x) => +x.toFixed(4))).toEqual([0.6, 0.8]);
    const t = async (text: string) => (await fetch(`${url}/v1/embed-text`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contract: 'ai-adapter.v1', requestId: 'x', tenantId: 't', modelId: 'emb', text, deadlineMs: 1000 }) })).json() as Promise<any>;
    expect((await t('hello')).embedding.dim).toBe(2);
    expect((await t('zero')).message).toMatch(/zero vector/);
    const { url: u2 } = await up([{ card: card(), infer: async () => ({}) }]);
    expect((await fetch(`${u2}/v1/embed-text`, { method: 'POST', body: '{}' })).status).toBe(404);
  });

  it('a test-double adapter built with the SDK passes the full ai-adapter.v1 conformance kit', async () => {
    const { url } = await up([{ card: card(), infer: async (f) => ({ detections: f.width >= 64 ? [person] : [] }) }], { maxInFlight: 2, maxQueued: 2 });
    const checks = await runAiAdapterConformance({ baseUrl: url });
    expect(checks.filter((c) => !c.passed)).toEqual([]);
    expect(checks.length).toBeGreaterThanOrEqual(15);
    void greyFrame;
  });

  it('the SDK copy of the contract matches the backend (no drift)', () => {
    expect(() => execFileSync(process.execPath, [path.join(__dirname, '../../scripts/sync-contract.mjs'), '--check'], { stdio: 'pipe' })).not.toThrow();
  });
});
