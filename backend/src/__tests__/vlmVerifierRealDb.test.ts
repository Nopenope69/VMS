/**
 * Phase 5 Wave C: the VLM second-opinion worker, its API and the agreement report, on the real database with
 * a SIMULATED VLM adapter over HTTP (it validates every request against ai-adapter.v1.1 and answers from a
 * lookup table). Real-model behaviour is tested in the ai-worker (goldenVlm.test.ts).
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFileSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera, createUserWithToken, startApp } from './helpers/realDb';
import { InferenceRequestV1 } from '../contracts/aiAdapter.v1';
import { VlmAdapterClient } from '../services/vlm/vlmAdapterClient';
import { VlmVerifier } from '../services/vlm/vlmVerifier.service';
import { startVlmWorkers, vlmSettings } from '../services/vlm/vlmWorkers';
import { vlmAgreement, wilson, MIN_EVALUATED } from '../services/vlm/vlmAgreement.service';
import { CropStore } from '../services/crops/cropStore';

jest.setTimeout(120000);
const prisma = new PrismaClient();
const FLAG = 'VIGILONE_FEATURE_VLM_VERIFICATION';
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vlmverify-')));
const snapDir = path.join(tmp, 'snapshots');
const cropDir = path.join(tmp, 'crops');
fs.mkdirSync(snapDir, { recursive: true });
fs.mkdirSync(cropDir, { recursive: true });
const saved = { ...process.env };
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const CLASSES = ['person', 'car', 'truck'];

let tenantId = '';
let cameraId = '';
let otherTenantId = '';
let modelName = '';
let modelSha = '';
let stub: http.Server;
let stubUrl = '';
const stubState = { mode: 'ok' as 'ok' | 'notReady' | 'unregistered' | 'wrongModel' | 'wrongClass' | 'error', answer: 'no' as 'yes' | 'no' | 'unclear', requests: [] as Array<{ targetClass: string; imageSha: string }> };

const jpeg = (seed: number) =>
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `testsrc=size=160x120:rate=1:decimals=${seed % 3}`, '-vf', `hue=h=${seed * 37}`, '-frames:v', '1', '-f', 'mjpeg', '-']);

beforeAll(async () => {
  process.env.RECORDINGS_DIR = tmp;
  process.env.SNAPSHOTS_DIR = snapDir;
  process.env.CROPS_DIR = cropDir;
  ({ tenantId, cameraId } = await createTenantWithCamera(prisma, 'vlmv'));
  otherTenantId = (await createTenantWithCamera(prisma, 'vlmv-other')).tenantId;
  modelName = `smolvlm2-sim-${tenantId.slice(0, 8)}`;
  modelSha = sha(`vlm-${tenantId}`);
  await prisma.modelManifest.create({ data: { name: modelName, version: '1.0.0', sha256: modelSha, task: 'vlm_verification', codeLicense: 'Apache-2.0', weightLicense: 'Apache-2.0', trainingDataJson: {}, runtimeConfigJson: {}, isActive: true } });

  stub = http.createServer((req, res) => {
    const send = (o: unknown, status = 200) => {
      res.statusCode = status;
      res.end(JSON.stringify(o));
    };
    const unreg = stubState.mode === 'unregistered';
    if (req.url === '/v1/health') return send({ contract: 'ai-adapter.v1', adapterId: 'stub-vlm', status: stubState.mode === 'notReady' ? 'FAILED' : 'READY', loadedModelIds: stubState.mode === 'notReady' ? [] : ['vlm-1'], lastError: stubState.mode === 'notReady' ? 'LICENSE_REJECTED: x' : null, observedAtUtc: new Date().toISOString() }, stubState.mode === 'notReady' ? 503 : 200);
    if (req.url === '/v1/descriptor') {
      return send({ contract: 'ai-adapter.v1', adapterId: 'stub-vlm', adapterVersion: 't', tasks: ['vlm_verification'], requiresNetworkEgress: false, models: [{ modelId: 'vlm-1', name: unreg ? 'unregistered' : modelName, version: '1.0.0', sha256: unreg ? sha('x') : modelSha, task: 'vlm_verification', classes: CLASSES, codeLicense: 'Apache-2.0', weightsLicense: 'Apache-2.0', weightsSource: 'SIMULATED stub', runtime: 'llama.cpp', input: { width: 384, height: 384, colorSpace: 'RGB', letterbox: false }, evaluation: null }] });
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const p = InferenceRequestV1.safeParse(JSON.parse(body));
      if (!p.success) return send({ contract: 'ai-adapter.v1', status: 'error', requestId: 'unknown', errorCode: 'INVALID_FRAME', message: p.error.issues[0].message, retryable: false }, 400);
      const rq = p.data;
      const img = Buffer.from((rq.frame.data as any).value, 'base64');
      stubState.requests.push({ targetClass: rq.vlmQuery!.targetClass, imageSha: sha(img) });
      if (stubState.mode === 'error') return send({ contract: 'ai-adapter.v1', status: 'error', requestId: rq.requestId, errorCode: 'RUNTIME_ERROR', message: 'SIMULATED failure', retryable: true }, 500);
      const wrongModel = stubState.mode === 'wrongModel';
      return send({
        contract: 'ai-adapter.v1', status: 'ok', requestId: rq.requestId, detections: [],
        verification: { targetClass: stubState.mode === 'wrongClass' ? 'truck' : rq.vlmQuery!.targetClass, answer: stubState.answer, reason: 'SIMULATED reason', promptSha256: sha(`prompt-${rq.vlmQuery!.targetClass}`) },
        provenance: { adapterId: 'stub-vlm', adapterVersion: 't', modelId: 'vlm-1', modelName: wrongModel ? 'other' : modelName, modelVersion: '1.0.0', modelSha256: wrongModel ? sha('other') : modelSha, runtime: 'llama.cpp@b11277', inferenceId: crypto.randomUUID(), frameTimestampUtc: rq.frame.timestampUtc },
        latencyMs: 1234,
      });
    });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
  stubUrl = `http://127.0.0.1:${(stub.address() as any).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => stub.close(() => r()));
  await prisma.modelManifest.deleteMany({ where: { name: modelName } });
  await prisma.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } });
  await prisma.$disconnect();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.env = saved;
});
beforeEach(async () => {
  stubState.mode = 'ok';
  stubState.answer = 'no';
  stubState.requests.length = 0;
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  // Each test starts with no pending alarms from earlier tests.
  await prisma.alarm.deleteMany({ where: { tenantId } });
});
afterEach(() => jest.restoreAllMocks());

let n = 0;
/** An alarm raised by a detection, the way the orchestrator records it (canonical event provenance -> detection). */
async function alarmWithDetection(opts: { objectClass?: string; snapshot?: 'file' | 'missing' | 'none'; crop?: 'ok' | 'tampered' | 'none'; ageMs?: number; link?: boolean; t?: string } = {}) {
  const i = n++;
  const at = new Date(Date.now() - (opts.ageMs ?? 60_000));
  const inferenceId = crypto.randomUUID();
  const img = jpeg(i);
  let snapshotPath: string | null = null;
  if (opts.snapshot !== 'none') {
    snapshotPath = path.join(snapDir, `snap-${i}.jpg`);
    if (opts.snapshot !== 'missing') fs.writeFileSync(snapshotPath, img);
  }
  const t = opts.t ?? tenantId;
  const cam = t === tenantId ? cameraId : (await prisma.camera.findFirstOrThrow({ where: { tenantId: t } })).id;
  const d = await prisma.detectionEvent.create({ data: { tenantId: t, cameraId: cam, type: 'PERSON_DETECTED', confidence: 0.9, objectClass: opts.objectClass ?? 'person', inferenceId, snapshotPath, timestamp: at } });
  let cropBytes: Buffer | null = null;
  if (opts.crop && opts.crop !== 'none') {
    cropBytes = jpeg(i + 100);
    const rel = `${t}/${cam}/${d.id}.jpg`;
    fs.mkdirSync(path.dirname(path.join(cropDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(cropDir, rel), opts.crop === 'tampered' ? Buffer.concat([cropBytes, Buffer.from('x')]) : cropBytes);
    await prisma.objectCrop.create({ data: { tenantId: t, cameraId: cam, detectionEventId: d.id, cropClass: 'NON_PERSON', objectClass: opts.objectClass ?? 'car', relativePath: rel, sha256: sha(cropBytes), byteLength: cropBytes.length, capturedAt: at, expiresAt: new Date(at.getTime() + 86_400_000) } });
  }
  const ev = await prisma.canonicalEvent.create({
    data: { id: crypto.randomUUID(), tenantId: t, cameraId: cam, type: 'AI_OBJECT_DETECTED', source: 'VISION_AI', severity: 'INFO', timestampUtc: at, correlationId: crypto.randomUUID(), payloadJson: { payload: {} } as any, provenanceJson: opts.link === false ? ({ modelName: 'm' } as any) : ({ inferenceId } as any) },
  });
  const alarm = await prisma.alarm.create({ data: { tenantId: t, cameraId: cam, canonicalEventId: ev.id, title: 'Person in yard', severity: 'CRITICAL', triggeredAt: at } });
  return { alarm, detection: d, img, cropBytes };
}

const verifier = (age = 3_600_000) => new VlmVerifier(prisma, new VlmAdapterClient(prisma, stubUrl, 5000), age, () => new CropStore(cropDir));

describe('startup', () => {
  it('flag off starts nothing; on, a missing or bad URL or interval refuses to start', () => {
    const fake = { start: jest.fn(), stop: jest.fn() };
    expect(startVlmWorkers(prisma, {}, () => fake)).toBeNull();
    expect(() => startVlmWorkers(prisma, { [FLAG]: 'true' }, () => fake)).toThrow(/VLM_ADAPTER_URL is not set/);
    expect(() => vlmSettings({ VLM_ADAPTER_URL: 'ftp://x' })).toThrow(/http or https/);
    expect(() => vlmSettings({ VLM_ADAPTER_URL: 'http://x', VLM_VERIFY_INTERVAL_MS: '10' })).toThrow(/at least 1000/);
    expect(() => vlmSettings({ VLM_ADAPTER_URL: 'http://x', VLM_MAX_ALARM_AGE_MS: 'soon' })).toThrow(/VLM_MAX_ALARM_AGE_MS/);
    const w = startVlmWorkers(prisma, { [FLAG]: 'true', VLM_ADAPTER_URL: 'http://127.0.0.1:7014/' }, () => fake);
    expect(fake.start).toHaveBeenCalledWith(15000);
    w!.stop();
    expect(fake.stop).toHaveBeenCalled();
  });
});

describe('the second-opinion worker', () => {
  it('asks about the detected class with the snapshot, stores the answer with hashes and provenance, and leaves the alarm alone', async () => {
    const { alarm, img } = await alarmWithDetection();
    const before = await prisma.alarm.findUniqueOrThrow({ where: { id: alarm.id } });
    const r = await verifier().runOnce();
    expect(r).toMatchObject({ stored: 1, answers: { yes: 0, no: 1, unclear: 0 }, failed: 0, adapterProblem: null });
    expect(stubState.requests).toEqual([{ targetClass: 'person', imageSha: sha(img) }]);
    const row = await prisma.vlmVerification.findFirstOrThrow({ where: { alarmId: alarm.id } });
    expect(row).toMatchObject({ tenantId, cameraId, imageSource: 'SNAPSHOT', imageSha256: sha(img), targetClass: 'person', answer: 'no', reason: 'SIMULATED reason', modelName, modelSha256: modelSha, adapterId: 'stub-vlm', latencyMs: 1234 });
    expect(row.promptSha256).toBe(sha('prompt-person'));
    // Advisory only: nothing about the alarm changed.
    expect(await prisma.alarm.findUniqueOrThrow({ where: { id: alarm.id } })).toEqual(before);
    // Asked once per alarm and model.
    expect((await verifier().runOnce()).stored).toBe(0);
    expect(stubState.requests).toHaveLength(1);
  });

  it('falls back to the stored crop when the snapshot is gone, and never sends a crop that fails its hash', async () => {
    const a = await alarmWithDetection({ objectClass: 'car', snapshot: 'missing', crop: 'ok' });
    const b = await alarmWithDetection({ objectClass: 'car', snapshot: 'none', crop: 'tampered' });
    const r = await verifier().runOnce();
    expect(r.stored).toBe(1);
    expect(r.failed).toBe(1);
    expect(stubState.requests).toEqual([{ targetClass: 'car', imageSha: sha(a.cropBytes!) }]);
    expect(await prisma.vlmVerification.findFirst({ where: { alarmId: a.alarm.id } })).toMatchObject({ imageSource: 'CROP' });
    expect(await prisma.vlmVerification.count({ where: { alarmId: b.alarm.id } })).toBe(0);
  });

  it('asks nothing when there is no recorded detection link, no image, an unsupported class, or the alarm is too old', async () => {
    await alarmWithDetection({ link: false });
    await alarmWithDetection({ snapshot: 'none' });
    await alarmWithDetection({ objectClass: 'toothbrush' });
    await alarmWithDetection({ ageMs: 2 * 3_600_000 });
    const r = await verifier().runOnce();
    expect(r).toMatchObject({ stored: 0, noDetection: 1, noImage: 1, unsupportedClass: 1 });
    expect(stubState.requests).toHaveLength(0);
  });

  it.each([
    ['not ready (licence refused)', 'notReady', /FAILED/],
    ['serving an unregistered model', 'unregistered', /not a registered active vlm_verification model/],
  ])('an adapter %s: nothing is asked or stored', async (_n, mode, re) => {
    await alarmWithDetection();
    stubState.mode = mode as any;
    const r = await verifier().runOnce();
    expect(r.adapterProblem).toMatch(re);
    expect(stubState.requests).toHaveLength(0);
    expect(await prisma.vlmVerification.count({ where: { tenantId } })).toBe(0);
  });

  it.each([
    ['names another model in its provenance', 'wrongModel'],
    ['answers about another class', 'wrongClass'],
    ['reports an error', 'error'],
  ])('an answer that %s is not stored', async (_n, mode) => {
    await alarmWithDetection();
    stubState.mode = mode as any;
    const r = await verifier().runOnce();
    expect(r).toMatchObject({ stored: 0, failed: 1 });
    expect(await prisma.vlmVerification.count({ where: { tenantId } })).toBe(0);
  });

  it('the database refuses an answer outside yes/no/unclear and a malformed hash', async () => {
    const { alarm } = await alarmWithDetection();
    const base = { tenantId, alarmId: alarm.id, imageSource: 'SNAPSHOT', imageSha256: sha('i'), targetClass: 'person', answer: 'yes', reason: 'r', promptSha256: sha('p'), modelName, modelVersion: '1', modelSha256: modelSha, adapterId: 'a', inferenceId: 'i', provenanceJson: {}, latencyMs: 1 };
    await expect(prisma.vlmVerification.create({ data: { ...base, answer: 'probably' } })).rejects.toThrow();
    await expect(prisma.vlmVerification.create({ data: { ...base, imageSha256: 'abc' } })).rejects.toThrow();
    await expect(prisma.vlmVerification.create({ data: { ...base, imageSource: 'CAMERA' } })).rejects.toThrow();
  });
});

describe('agreement with operator verdicts', () => {
  it('Wilson intervals match hand-computed values', () => {
    expect(wilson(5, 10)).toEqual({ numerator: 5, denominator: 10, value: 0.5, ci95: [0.2366, 0.7634] });
    expect(wilson(0, 0)).toEqual({ numerator: 0, denominator: 0, value: null, ci95: null });
    expect(wilson(10, 10).ci95![1]).toBe(1);
  });

  it('counts answers against verdicts and says NOT EVALUATED below the minimum', async () => {
    const user = await createUserWithToken(prisma, tenantId, 'TENANT_ADMIN');
    const table: Array<['yes' | 'no' | 'unclear', 'TRUE_ALARM' | 'FALSE_ALARM']> = [['no', 'FALSE_ALARM'], ['no', 'FALSE_ALARM'], ['no', 'TRUE_ALARM'], ['yes', 'TRUE_ALARM'], ['yes', 'FALSE_ALARM'], ['unclear', 'TRUE_ALARM']];
    for (const [answer, verdict] of table) {
      const { alarm } = await alarmWithDetection();
      await prisma.alarmFeedback.create({ data: { tenantId, alarmId: alarm.id, verdict, userId: user.userId } });
      await prisma.vlmVerification.create({ data: { tenantId, alarmId: alarm.id, imageSource: 'SNAPSHOT', imageSha256: sha('i'), targetClass: 'person', answer, reason: 'r', promptSha256: sha('p'), modelName, modelVersion: '1.0.0', modelSha256: modelSha, adapterId: 'a', inferenceId: crypto.randomUUID(), provenanceJson: {}, latencyMs: 1 } });
    }
    // an alarm with a second opinion but no verdict does not count
    const { alarm: noVerdict } = await alarmWithDetection();
    await prisma.vlmVerification.create({ data: { tenantId, alarmId: noVerdict.id, imageSource: 'SNAPSHOT', imageSha256: sha('i'), targetClass: 'person', answer: 'no', reason: 'r', promptSha256: sha('p'), modelName, modelVersion: '1.0.0', modelSha256: modelSha, adapterId: 'a', inferenceId: crypto.randomUUID(), provenanceJson: {}, latencyMs: 1 } });
    const r = await vlmAgreement(prisma, tenantId, new Date(Date.now() - 86_400_000), new Date(Date.now() + 1000));
    expect(r.status).toBe('NOT EVALUATED');
    expect(r.reason).toMatch(`at least ${MIN_EVALUATED}`);
    expect(r.alarmsWithBoth).toBe(6);
    expect(r.counts).toEqual({ yes: { TRUE_ALARM: 1, FALSE_ALARM: 1 }, no: { TRUE_ALARM: 1, FALSE_ALARM: 2 }, unclear: { TRUE_ALARM: 1, FALSE_ALARM: 0 } });
    expect(r.falseAlarmsFlagged).toMatchObject({ numerator: 2, denominator: 3 });
    expect(r.noPrecision).toMatchObject({ numerator: 2, denominator: 3 });
    expect(r.trueAlarmsDoubted).toMatchObject({ numerator: 1, denominator: 3 });
    expect(r.unclearRate).toMatchObject({ numerator: 1, denominator: 6 });
    expect(r.model).toEqual({ name: modelName, version: '1.0.0', sha256: modelSha });
    // Other tenants see nothing of it.
    expect((await vlmAgreement(prisma, otherTenantId, new Date(0), new Date(Date.now() + 1000))).alarmsWithBoth).toBe(0);
  });
});

describe('API', () => {
  let app: { url: string; close: () => Promise<void> };
  let viewer = '';
  let admin = '';
  let other = '';
  beforeAll(async () => {
    viewer = (await createUserWithToken(prisma, tenantId, 'VIEWER')).token;
    admin = (await createUserWithToken(prisma, tenantId, 'TENANT_ADMIN')).token;
    other = (await createUserWithToken(prisma, otherTenantId, 'TENANT_ADMIN')).token;
    app = await startApp();
  });
  afterAll(() => app.close());
  afterEach(() => {
    delete process.env[FLAG];
  });
  const get = async (token: string, p: string) => {
    const r = await fetch(`${app.url}/api/v1/alarms${p}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: r.status, json: (await r.json()) as any };
  };

  it('flag off: 501; on: the alarm\'s second opinion, marked advisory, only for its own tenant', async () => {
    const { alarm } = await alarmWithDetection();
    await verifier().runOnce();
    expect((await get(viewer, `/${alarm.id}/second-opinion`)).status).toBe(501);
    process.env[FLAG] = 'true';
    const r = await get(viewer, `/${alarm.id}/second-opinion`);
    expect(r.status).toBe(200);
    expect(r.json.advisory).toBe(true);
    expect(r.json.secondOpinions).toHaveLength(1);
    expect(r.json.secondOpinions[0]).toMatchObject({ targetClass: 'person', answer: 'no', modelSha256: modelSha });
    expect((await get(other, `/${alarm.id}/second-opinion`)).status).toBe(404);
  });

  it('agreement report needs the feedback permission and validates its window', async () => {
    process.env[FLAG] = 'true';
    expect((await get(viewer, '/second-opinion/agreement')).status).toBe(403);
    const ok = await get(admin, '/second-opinion/agreement');
    expect(ok.status).toBe(200);
    expect(ok.json.status).toBe('NOT EVALUATED');
    expect((await get(admin, '/second-opinion/agreement?from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z')).status).toBe(400);
    expect((await get(admin, '/second-opinion/agreement?modelSha256=abc')).status).toBe(400);
  });
});
