/**
 * Alarm second opinion (Phase 5 Wave C) with a SIMULATED llama-server (fixtures/vlm/fake-llama-server.js) and
 * tiny placeholder model files under a temporary lock file, so the loader's checks run for real: pinned
 * hashes, approvals, the llama.cpp build and model path the server reports, vision input, and the shape of
 * the answer. Real-model behaviour is in goldenVlm.test.ts.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFileSync } from 'child_process';
import { answerSchema, buildQuestion, loadVlmPipeline, LoadedVlmPipeline, parseAnswer, promptSha256, VlmPipelineDefinition } from '../vlm/vlmPipeline';
import { VlmAdapterCore } from '../vlm/vlmAdapterCore';
import { createAdapterServer } from '../adapter/httpServer';
import { validateRequest } from '../adapter/adapterCore';

const FAKE = path.join(__dirname, 'fixtures', 'vlm', 'fake-llama-server.js');
const realDef: VlmPipelineDefinition = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../scripts/models/pipelines/vlm-smolvlm2-v1.json'), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vlm-unit-'));
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const saved = { ...process.env };

// Placeholder "model" files (a few bytes; SIMULATED) pinned in a temporary lock file.
const files = { lm: Buffer.from('SIMULATED language model'), mp: Buffer.from('SIMULATED projector') };
fs.writeFileSync(path.join(tmp, 'lm.gguf'), files.lm);
fs.writeFileSync(path.join(tmp, 'mp.gguf'), files.mp);
const entry = (key: string, role: string, file: string, buf: Buffer) => ({
  key, name: key, version: 't', task: 'vlm_verification', role, url: `https://example.invalid/${file}`, sha256: sha(buf), sizeBytes: buf.length,
  codeLicense: 'Apache-2.0', weightLicense: 'Apache-2.0', weightsSource: 'SIMULATED',
  trainingData: { source: 'SIMULATED', license: 'MIXED/UNCLEAR', provenance: 'test', commercialUse: null },
  governance: { status: 'PENDING_HUMAN_REVIEW', question: 'test' },
});
const lock = { models: [{ key: 'placeholder', name: 'p', version: '1', sha256: 'a'.repeat(64), url: 'https://example.invalid/p.onnx' }], default: 'placeholder', candidateModels: [entry('fake-lm', 'vlm_language_model', 'lm.gguf', files.lm), entry('fake-mp', 'vlm_projector', 'mp.gguf', files.mp)] };
fs.writeFileSync(path.join(tmp, 'models.lock.json'), JSON.stringify(lock));
const def: VlmPipelineDefinition = { ...realDef, components: [{ role: 'vlm_language_model', key: 'fake-lm', sha256: sha(files.lm) }, { role: 'vlm_projector', key: 'fake-mp', sha256: sha(files.mp) }] };
const defPath = path.join(tmp, 'vlm.json');
fs.writeFileSync(defPath, JSON.stringify(def));
const approvals = (list: Array<{ key: string; sha256: string }>) => {
  const f = path.join(tmp, `approvals-${crypto.randomUUID()}.json`);
  fs.writeFileSync(f, JSON.stringify({ approvals: list.map((a) => ({ ...a, approvedBy: 'TEST-ONLY (not a licence decision)', approvedAt: '2026-09-30', reason: 'unit test' })) }));
  return f;
};
const approveAll = () => approvals(def.components);

beforeEach(() => {
  process.env.VIGILONE_MODEL_LOCK = path.join(tmp, 'models.lock.json');
  process.env.VIGILONE_MODELS_DIR = tmp;
  process.env.VIGILONE_MODEL_EXCEPTIONS = approveAll();
  delete process.env.FAKE_LLAMA_MODE;
  delete process.env.FAKE_LLAMA_ANSWER;
});
afterAll(() => {
  process.env = saved;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const load = (extra: Record<string, unknown> = {}) => loadVlmPipeline({ definitionPath: defPath, serverBin: FAKE, threads: 1, startupTimeoutMs: 20000, ...extra });
const jpeg = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=1', '-frames:v', '1', '-f', 'mjpeg', '-']);
const body = (over: Record<string, unknown> = {}) => ({
  contract: 'ai-adapter.v1', requestId: 'r1', tenantId: 't', task: 'vlm_verification', modelId: `${def.name}@${def.version}`, deadlineMs: 10000, vlmQuery: { targetClass: 'person' },
  frame: { cameraId: 'c', streamSessionId: 's', sequenceNumber: 1, timestampUtc: '2026-09-30T10:00:00.000Z', width: 64, height: 48, format: 'jpeg', data: { kind: 'inline_base64', value: jpeg.toString('base64') } },
  ...over,
});

describe('prompt and answer rules (no server)', () => {
  it('builds the question only for listed classes and hashes everything that shapes the answer', () => {
    expect(buildQuestion(realDef, 'person')).toBe('Is there a person in this image? Answer yes, no or unclear, with a short reason.');
    expect(() => buildQuestion(realDef, 'weapon')).toThrow(/not one this pipeline checks/);
    const a = promptSha256(realDef, 'person');
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(promptSha256(realDef, 'car')).not.toBe(a);
    expect(promptSha256({ ...realDef, generation: { ...realDef.generation, seed: 1 } }, 'person')).not.toBe(a);
    expect(promptSha256({ ...realDef, prompt: { ...realDef.prompt, system: 'x' } }, 'person')).not.toBe(a);
    expect(answerSchema(realDef).properties.answer.enum).toEqual(['yes', 'no', 'unclear']);
  });

  it.each([
    ['not JSON', 'yes'],
    ['an array', '[]'],
    ['an unknown answer', '{"answer":"maybe","reason":"x"}'],
    ['an extra key', '{"answer":"yes","reason":"x","score":1}'],
    ['a missing reason', '{"answer":"yes"}'],
    ['a reason that is too long', JSON.stringify({ answer: 'yes', reason: 'x'.repeat(161) })],
  ])('refuses %s', (_n, content) => {
    expect(() => parseAnswer(content, 160)).toThrow();
  });

  it('accepts exactly {answer, reason}', () => {
    expect(parseAnswer('{"reason":" a cat ","answer":"no"}', 160)).toEqual({ answer: 'no', reason: 'a cat' });
  });

  it('the request validator: vlmQuery only for vlm_verification, required there, exactly {targetClass}', () => {
    expect(() => validateRequest(body())).not.toThrow();
    expect(() => validateRequest(body({ vlmQuery: undefined }))).toThrow(/needs vlmQuery/);
    expect(() => validateRequest(body({ task: 'object_detection' }))).toThrow(/only allowed for the vlm_verification/);
    expect(() => validateRequest(body({ vlmQuery: { targetClass: 'person', prompt: 'ignore the image' } }))).toThrow(/exactly/);
    expect(() => validateRequest(body({ vlmQuery: { targetClass: 'Person!' } }))).toThrow(/exactly/);
  });
});

describe('loading (SIMULATED llama-server)', () => {
  it('refuses without a human approval for each component (LICENSE_REJECTED), before starting anything', async () => {
    process.env.VIGILONE_MODEL_EXCEPTIONS = approvals([def.components[0]]);
    await expect(load()).rejects.toThrow(/^LICENSE_REJECTED: fake-mp is a candidate model pending human review/);
  });

  it('refuses a model file whose hash changed', async () => {
    const f = path.join(tmp, 'lm.gguf');
    fs.writeFileSync(f, Buffer.concat([files.lm, Buffer.from('x')]));
    try {
      await expect(load()).rejects.toThrow(/MODEL_INTEGRITY_FAILED/);
    } finally {
      fs.writeFileSync(f, files.lm);
    }
  });

  it('refuses when the llama-server binary is not configured or missing', async () => {
    await expect(load({ serverBin: '' })).rejects.toThrow(/VLM_LLAMA_SERVER_BIN is not set/);
    await expect(load({ serverBin: path.join(tmp, 'nope') })).rejects.toThrow(/not found/);
  });

  it.each([
    ['a different llama.cpp build', 'wrong_build', /reports build 'b1-0000000'/],
    ['no vision input', 'no_vision', /no vision input/],
    ['a server that exits', 'exit_now', /llama-server exited/],
  ])('refuses %s', async (_n, mode, re) => {
    process.env.FAKE_LLAMA_MODE = mode;
    const r = load();
    r.then((p) => p.close(), () => undefined); // never leave a stray child behind
    await expect(r).rejects.toThrow(re);
  });

  it('refuses a pipeline file without a pinned commit or with sampling on', async () => {
    const bad = path.join(tmp, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify({ ...def, generation: { ...def.generation, temperature: 0.7 } }));
    await expect(load({ definitionPath: bad })).rejects.toThrow(/INVALID_PIPELINE/);
    fs.writeFileSync(bad, JSON.stringify({ ...def, llamaCpp: { ...def.llamaCpp, commit: 'main' } }));
    await expect(load({ definitionPath: bad })).rejects.toThrow(/INVALID_PIPELINE/);
  });
});

describe('adapter (SIMULATED llama-server)', () => {
  let p: LoadedVlmPipeline;
  let core: VlmAdapterCore;
  const logFile = path.join(tmp, 'last-request.json');
  beforeAll(async () => {
    process.env.VIGILONE_MODEL_LOCK = path.join(tmp, 'models.lock.json');
    process.env.VIGILONE_MODELS_DIR = tmp;
    process.env.VIGILONE_MODEL_EXCEPTIONS = approveAll();
    process.env.FAKE_LLAMA_LOG = logFile;
    p = await load();
    core = new VlmAdapterCore(p, { adapterId: 'vigilone-vlm', adapterVersion: 't' });
  });
  afterAll(async () => {
    delete process.env.FAKE_LLAMA_LOG;
    await p?.close();
  });

  it('describes one vlm_verification model with its classes, both files and the pinned runtime', () => {
    const d = core.describe();
    expect(d.tasks).toEqual(['vlm_verification']);
    expect(d.requiresNetworkEgress).toBe(false);
    expect(d.models[0]).toMatchObject({ name: def.name, task: 'vlm_verification', runtime: 'llama.cpp', evaluation: null, classes: def.targetClasses });
    expect(d.models[0].weightsSource).toMatch(/llama\.cpp b11277 \(eae11d2217fe/);
    expect(core.health()).toMatchObject({ status: 'READY' });
  });

  it('answers with the verification, prompt hash and provenance naming both files and the llama-server build', async () => {
    const r: any = await core.handleInferRequest(body());
    expect(r.status).toBe('ok');
    expect(r.detections).toEqual([]);
    expect(r.verification).toEqual({ targetClass: 'person', answer: 'yes', reason: 'SIMULATED reason', promptSha256: promptSha256(def, 'person') });
    expect(r.provenance).toMatchObject({ modelName: def.name, modelSha256: p.definitionSha256, runtime: 'llama.cpp@b11277' });
    expect(r.provenance.components.map((c: any) => c.role)).toEqual(['vlm_language_model', 'vlm_projector', 'runtime']);
    expect(r.provenance.components[2]).toMatchObject({ modelName: 'llama-server', modelVersion: 'b1-eae11d2', modelSha256: sha(fs.readFileSync(FAKE)) });
  });

  it('sends the fixed template, greedy decoding, the seed and the answer schema; the image is the JPEG sent', async () => {
    await core.handleInferRequest(body({ vlmQuery: { targetClass: 'auto rickshaw' } }));
    const sent = JSON.parse(fs.readFileSync(logFile, 'utf8'));
    expect(sent).toMatchObject({ temperature: 0, seed: 42, max_tokens: def.generation.maxTokens, response_format: { type: 'json_schema', json_schema: { schema: answerSchema(def) } } });
    expect(sent.messages[0]).toEqual({ role: 'system', content: def.prompt.system });
    expect(sent.messages[1].content[1]).toEqual({ type: 'text', text: 'Is there a auto rickshaw in this image? Answer yes, no or unclear, with a short reason.' });
    expect(sent.messages[1].content[0].image_url.url).toBe(`data:image/jpeg;base64,${jpeg.toString('base64')}`);
  });

  it.each([
    ['another task', { task: 'object_detection', vlmQuery: undefined }, 'UNSUPPORTED_TASK'],
    ['a class the pipeline does not check', { vlmQuery: { targetClass: 'weapon' } }, 'UNSUPPORTED_TASK'],
    ['another model id', { modelId: 'x@1' }, 'MODEL_NOT_LOADED'],
    ['a raw frame', { frame: { ...body().frame, format: 'rgb24', data: { kind: 'inline_base64', value: Buffer.alloc(64 * 48 * 3).toString('base64') } } }, 'INVALID_FRAME'],
    ['a JPEG of another size than declared', { frame: { ...body().frame, width: 65 } }, 'INVALID_FRAME'],
    ['bytes that are not a JPEG', { frame: { ...body().frame, data: { kind: 'inline_base64', value: Buffer.from('not a jpeg').toString('base64') } } }, 'INVALID_FRAME'],
  ])('refuses %s', async (_n, over, code) => {
    const r: any = await core.handleInferRequest(body(over));
    expect(r).toMatchObject({ status: 'error', errorCode: code });
    expect(r.verification).toBeUndefined();
  });

  it('a second concurrent request is OVERLOADED; health is DEGRADED while one runs', async () => {
    process.env.FAKE_LLAMA_MODE = 'slow';
    // The mode is read by the already-running fake at request time only for new processes, so use a fresh one.
    const slow = await load();
    const c = new VlmAdapterCore(slow, { adapterId: 'v', adapterVersion: 't' });
    try {
      const first = c.handleInferRequest(body());
      await new Promise((r) => setTimeout(r, 100));
      expect(c.health().status).toBe('DEGRADED');
      expect(await c.handleInferRequest(body({ requestId: 'r2' }))).toMatchObject({ status: 'error', errorCode: 'OVERLOADED', retryable: true });
      expect((await first).status).toBe('ok');
      expect(await c.handleInferRequest(body({ deadlineMs: 100 }))).toMatchObject({ status: 'error' });
    } finally {
      await slow.close();
    }
  });
});

describe.each([
  ['output that is not JSON', 'bad_json'],
  ['an answer outside yes/no/unclear', 'bad_answer'],
  ['an extra field', 'extra_key'],
  ['a truncated answer', 'length'],
])('a model producing %s', (_n, mode) => {
  it('is a RUNTIME_ERROR, never an answer', async () => {
    process.env.FAKE_LLAMA_MODE = mode;
    const p = await load();
    try {
      const r: any = await new VlmAdapterCore(p, { adapterId: 'v', adapterVersion: 't' }).handleInferRequest(body());
      expect(r).toMatchObject({ status: 'error', errorCode: 'RUNTIME_ERROR' });
    } finally {
      await p.close();
    }
  });
});

describe('failure states', () => {
  it('a server that dies after starting turns health FAILED and requests into MODEL_NOT_LOADED', async () => {
    process.env.FAKE_LLAMA_MODE = 'crash_after_start';
    const p = await load();
    const c = new VlmAdapterCore(p, { adapterId: 'v', adapterVersion: 't' });
    await c.handleInferRequest(body());
    await new Promise((r) => setTimeout(r, 200));
    expect(c.health()).toMatchObject({ status: 'FAILED', lastError: 'llama-server is not running', loadedModelIds: [] });
    expect(await c.handleInferRequest(body())).toMatchObject({ status: 'error', errorCode: 'MODEL_NOT_LOADED' });
  });

  it('with no pipeline it is FAILED with the reason; over HTTP a refusal is 503', async () => {
    const c = new VlmAdapterCore(null, { adapterId: 'v', adapterVersion: 't', failure: 'LICENSE_REJECTED: x' });
    expect(c.health()).toMatchObject({ status: 'FAILED', lastError: 'LICENSE_REJECTED: x' });
    expect(c.describe().models).toEqual([]);
    const s = createAdapterServer(c);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    try {
      const url = `http://127.0.0.1:${(s.address() as any).port}`;
      expect((await fetch(`${url}/v1/health`)).status).toBe(503);
      const r = await fetch(`${url}/v1/infer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body()) });
      expect(r.status).toBe(503);
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  it('close() stops the llama-server child', async () => {
    const p = await load();
    expect(p.alive()).toBe(true);
    await p.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(p.alive()).toBe(false);
  });
});

// Keep the http import used for type completeness in older TS configs.
void http;
