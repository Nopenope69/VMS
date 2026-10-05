/**
 * The transport-free core (core.ts) and the hooks the ai-worker needs: VLM answers, component provenance, a
 * liveness hook, models serving more than one task, work outside a request, and outcome reporting.
 * TEST-DOUBLE models only (their model cards are fixtures, not real models).
 */
import { AdapterModel, createAdapterCore, ModelCard, Outcome } from '../index';

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
const vlmCard = card({ modelId: 'vlm', task: 'vlm_verification', classes: ['person', 'vehicle'], runtime: 'llama.cpp' });
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]).toString('base64');
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
const vlmRequest = (targetClass = 'person') => request({ task: 'vlm_verification', modelId: 'vlm', vlmQuery: { targetClass } }, { format: 'jpeg', data: { kind: 'inline_base64', value: jpeg } });
const core = (models: AdapterModel[], extra: Record<string, unknown> = {}) => createAdapterCore({ adapterId: 'sdk-test', adapterVersion: '0.0.1', models, ...extra });
const answer = (targetClass: string) => ({ targetClass, answer: 'yes' as const, reason: 'a person is at the gate', promptSha256: 'b'.repeat(64) });

describe('SDK adapter core', () => {
  it('without a load step the adapter is READY at once', () => {
    expect(core([{ card: card(), infer: async () => ({}) }]).health()).toMatchObject({ status: 'READY', loadedModelIds: ['test-double'] });
  });

  it('an adapter whose models could not be built declares its tasks, lists no model and is FAILED', async () => {
    const c = core([], { tasks: ['embedding'], loadFailure: 'LICENSE_REJECTED: pending review' });
    expect(c.descriptor).toMatchObject({ tasks: ['embedding'], models: [] });
    expect(c.health()).toMatchObject({ status: 'FAILED', lastError: 'LICENSE_REJECTED: pending review', loadedModelIds: [] });
    const r = await c.infer(request({ task: 'embedding' }));
    expect(r).toMatchObject({ status: 'error', errorCode: 'MODEL_NOT_LOADED' });
    expect((r as any).message).toMatch(/LICENSE_REJECTED/);
  });

  it('a VLM answer is passed through for vlm_verification, with the class the request asked about', async () => {
    const c = core([{ card: vlmCard, infer: async (_f, ctx) => ({ verification: answer(ctx.vlmQuery!.targetClass) }) }]);
    const r = await c.infer(vlmRequest('vehicle'));
    expect(r).toMatchObject({ status: 'ok', detections: [], verification: { targetClass: 'vehicle', answer: 'yes' } });
  });

  it('refuses a VLM answer for another class, a missing answer, and an answer to another task', async () => {
    const wrong = core([{ card: vlmCard, infer: async () => ({ verification: answer('vehicle') }) }]);
    expect(await wrong.infer(vlmRequest('person'))).toMatchObject({ status: 'error', errorCode: 'RUNTIME_ERROR', message: expect.stringMatching(/answered for 'vehicle'/) });
    const none = core([{ card: vlmCard, infer: async () => ({}) }]);
    expect(await none.infer(vlmRequest())).toMatchObject({ status: 'error', errorCode: 'RUNTIME_ERROR', message: expect.stringMatching(/no verification/) });
    const stray = core([{ card: card(), infer: async () => ({ verification: answer('person') }) }]);
    expect(await stray.infer(request())).toMatchObject({ status: 'error', errorCode: 'RUNTIME_ERROR' });
  });

  it('checks vlmQuery: needed for vlm_verification, refused elsewhere, and its class must be in the card', async () => {
    const calls: string[] = [];
    const c = core([
      { card: vlmCard, infer: async (_f, ctx) => (calls.push(ctx.vlmQuery!.targetClass), { verification: answer(ctx.vlmQuery!.targetClass) }) },
      { card: card(), infer: async () => ({}) },
    ]);
    expect(await c.infer(vlmRequest('dragon'))).toMatchObject({ status: 'error', errorCode: 'UNSUPPORTED_TASK' });
    expect(await c.infer(request({ task: 'vlm_verification', modelId: 'vlm' }))).toMatchObject({ status: 'error', errorCode: 'INVALID_FRAME', message: expect.stringMatching(/needs vlmQuery/) });
    expect(await c.infer(request({ vlmQuery: { targetClass: 'person' } }))).toMatchObject({ status: 'error', errorCode: 'INVALID_FRAME', message: expect.stringMatching(/only allowed/) });
    expect(calls).toEqual([]);
  });

  it('provenance lists the card components and the extra ones (e.g. the runtime binary)', async () => {
    const components = [
      { role: 'detector', name: 'det', version: '1', sha256: 'c'.repeat(64), weightsLicense: 'Apache-2.0' as const },
      { role: 'ocr', name: 'ocr', version: '2', sha256: 'd'.repeat(64), weightsLicense: 'MIT' as const },
    ];
    const c = core([
      {
        card: card({ components }),
        runtime: 'onnxruntime-node@1.30.0',
        executionProvider: 'cpu',
        provenanceComponents: [{ role: 'runtime', modelName: 'llama-server', modelVersion: 'b1', modelSha256: 'e'.repeat(64) }],
        infer: async () => ({}),
      },
    ]);
    const r: any = await c.infer(request());
    expect(r.provenance).toMatchObject({ runtime: 'onnxruntime-node@1.30.0', executionProvider: 'cpu' });
    expect(r.provenance.components).toEqual([
      { role: 'detector', modelName: 'det', modelVersion: '1', modelSha256: 'c'.repeat(64) },
      { role: 'ocr', modelName: 'ocr', modelVersion: '2', modelSha256: 'd'.repeat(64) },
      { role: 'runtime', modelName: 'llama-server', modelVersion: 'b1', modelSha256: 'e'.repeat(64) },
    ]);
  });

  it('liveness: a model whose runtime died is FAILED and answers MODEL_NOT_LOADED until it is back', async () => {
    let alive = true;
    const c = core([{ card: card(), failure: () => (alive ? null : 'llama-server is not running'), infer: async () => ({}) }]);
    expect(c.health().status).toBe('READY');
    alive = false;
    expect(c.health()).toMatchObject({ status: 'FAILED', lastError: 'llama-server is not running', loadedModelIds: [] });
    expect(await c.infer(request())).toMatchObject({ status: 'error', errorCode: 'MODEL_NOT_LOADED', message: 'llama-server is not running' });
    alive = true;
    expect(c.health().status).toBe('READY');
    expect(await c.infer(request())).toMatchObject({ status: 'ok' });
  });

  it('one dead model of two leaves the adapter DEGRADED, listing the live one', () => {
    const c = core([
      { card: card({ modelId: 'a' }), failure: () => 'down', infer: async () => ({}) },
      { card: card({ modelId: 'b' }), infer: async () => ({}) },
    ]);
    expect(c.health()).toMatchObject({ status: 'DEGRADED', loadedModelIds: ['b'], lastError: 'down' });
  });

  it('a model can serve more than one task, and is told which one was asked', async () => {
    const seen: string[] = [];
    const c = core([
      {
        card: card({ task: 'face_detection_for_redaction', classes: ['face', 'license_plate'] }),
        tasks: ['plate_detection_for_redaction'],
        infer: async (_f, ctx) => (seen.push(ctx.task), {}),
      },
    ]);
    expect(c.descriptor.tasks).toEqual(['face_detection_for_redaction', 'plate_detection_for_redaction']);
    expect(await c.infer(request({ task: 'plate_detection_for_redaction' }))).toMatchObject({ status: 'ok' });
    expect(await c.infer(request({ task: 'face_detection_for_redaction' }))).toMatchObject({ status: 'ok' });
    expect(await c.infer(request({ task: 'object_detection' }))).toMatchObject({ status: 'error', errorCode: 'UNSUPPORTED_TASK' });
    expect(seen).toEqual(['plate_detection_for_redaction', 'face_detection_for_redaction']);
  });

  it('DEGRADED while every slot is busy; with no queue, one more request is OVERLOADED', async () => {
    let finish!: () => void;
    const c = core([{ card: card(), infer: () => new Promise((r) => (finish = () => r({}))) }], { maxQueued: 0 });
    const first = c.infer(request());
    await new Promise((r) => setImmediate(r));
    expect(c.health().status).toBe('DEGRADED');
    expect(await c.infer(request())).toMatchObject({ status: 'error', errorCode: 'OVERLOADED' });
    finish();
    expect(await first).toMatchObject({ status: 'ok' });
    expect(c.health().status).toBe('READY');
  });

  it('refuses frames larger than 3840x2160', async () => {
    const c = core([{ card: card(), infer: async () => ({}) }]);
    expect(await c.infer(request({}, { width: 3841, height: 2160, format: 'jpeg', data: { kind: 'inline_base64', value: jpeg } }))).toMatchObject({ status: 'error', errorCode: 'INVALID_FRAME' });
  });

  it('run(): work outside a request shares the slots and is reported once', async () => {
    const outcomes: Outcome[] = [];
    let finish!: () => void;
    const c = core([{ card: card(), infer: async () => ({}) }], { maxQueued: 0, onOutcome: (o: Outcome) => outcomes.push(o) });
    const stream = c.run('test-double', 5000, () => new Promise<number>((r) => (finish = () => r(7))));
    await new Promise((r) => setImmediate(r));
    expect(await c.infer(request())).toMatchObject({ status: 'error', errorCode: 'OVERLOADED' });
    finish();
    expect((await stream).value).toBe(7);
    await expect(c.run('test-double', 5000, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(c.run('other', 5000, async () => 1)).rejects.toMatchObject({ code: 'MODEL_NOT_LOADED' });
    expect(outcomes.map((o) => o.outcome)).toEqual(['OVERLOADED', 'ok', 'RUNTIME_ERROR', 'MODEL_NOT_LOADED']);
    expect(c.provenance('test-double', '2026-09-30T10:00:00.000Z')).toMatchObject({ modelId: 'test-double', frameTimestampUtc: '2026-09-30T10:00:00.000Z' });
  });

  it('an error thrown by another copy of AdapterError (same name and a contract code) keeps its code', async () => {
    class AdapterError extends Error {
      constructor(public readonly code: string, m: string) {
        super(m);
        this.name = 'AdapterError';
      }
    }
    const c = core([{ card: card(), infer: async () => { throw new AdapterError('INVALID_FRAME', 'bad crop'); } }]);
    expect(await c.infer(request())).toMatchObject({ status: 'error', errorCode: 'INVALID_FRAME', message: 'bad crop' });
  });

  it('text embedding: blank text is refused before the model runs', async () => {
    let calls = 0;
    const c = core([{ card: card({ task: 'embedding', classes: ['embedding'] }), infer: async () => ({ embedding: new Float32Array([1, 0]) }), embedText: async () => (calls++, new Float32Array([0, 1])) }]);
    expect(c.servesTextEmbedding).toBe(true);
    const body = { contract: 'ai-adapter.v1', requestId: 'q', tenantId: 't', modelId: 'test-double', deadlineMs: 1000 };
    expect(await c.embedText({ ...body, text: '   ' })).toMatchObject({ status: 'error', errorCode: 'INVALID_FRAME' });
    expect(await c.embedText({ ...body, text: 'red car' })).toMatchObject({ status: 'ok', embedding: { dim: 2, normalized: true } });
    expect(calls).toBe(1);
  });

  it('text rewrite (v1.2): served only by a model that rewrites, validated, vocabulary passed through', async () => {
    let seen: { text: string; vocabulary: string[] } | null = null;
    const rewriter: AdapterModel = {
      card: card({ modelId: 'qwen', task: 'query_rewrite', classes: ['text'], runtime: 'llama.cpp' }),
      infer: async () => ({}),
      rewriteText: async (text, vocabulary) => ((seen = { text, vocabulary }), { text: 'white car at Main Gate', promptSha256: 'c'.repeat(64) }),
    };
    const c = core([rewriter, { card: card(), infer: async () => ({}) }]);
    expect(c.servesTextRewrite).toBe(true);
    const body = { contract: 'ai-adapter.v1', requestId: 'q1', tenantId: 't', modelId: 'qwen', text: 'मुख्य गेट पर सफेद कार', vocabulary: ['Main Gate'], deadlineMs: 5000 };
    expect(await c.rewriteText(body)).toMatchObject({ status: 'ok', requestId: 'q1', detections: [], rewrite: { text: 'white car at Main Gate', promptSha256: 'c'.repeat(64) }, provenance: { modelId: 'qwen' } });
    expect(seen).toEqual({ text: 'मुख्य गेट पर सफेद कार', vocabulary: ['Main Gate'] });
    // The detector does not rewrite; blank text and an over-long vocabulary entry are refused.
    expect(await c.rewriteText({ ...body, modelId: 'test-double' })).toMatchObject({ status: 'error', errorCode: 'UNSUPPORTED_TASK' });
    expect(await c.rewriteText({ ...body, text: '  ' })).toMatchObject({ status: 'error', errorCode: 'INVALID_FRAME' });
    expect(await c.rewriteText({ ...body, vocabulary: ['x'.repeat(61)] })).toMatchObject({ status: 'error', errorCode: 'INVALID_FRAME' });
    // An empty or malformed answer is never a success.
    const bad = core([{ ...rewriter, rewriteText: async () => ({ text: ' ', promptSha256: 'c'.repeat(64) }) }]);
    expect(await bad.rewriteText(body)).toMatchObject({ status: 'error', errorCode: 'RUNTIME_ERROR' });
    const badHash = core([{ ...rewriter, rewriteText: async () => ({ text: 'ok', promptSha256: 'nope' }) }]);
    expect(await badHash.rewriteText(body)).toMatchObject({ status: 'error', errorCode: 'RUNTIME_ERROR' });
    expect(core([{ card: card(), infer: async () => ({}) }]).servesTextRewrite).toBe(false);
  });
});
