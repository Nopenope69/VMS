/**
 * P4.4 redaction on the real path: real database, real segment files, real ffmpeg, the real HTTP
 * routes. The region detector is a stub ai-adapter.v1 server (SIMULATED detector: fixed boxes
 * where the fixture's face and plate are) whose provenance names a registered pipeline; the real
 * YuNet/PP-OCRv4 adapter is exercised in services/ai-worker (redactionAdapter.test.ts) and in
 * scripts/e2e/redaction-scenario.sh.
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { PrismaClient, RedactionMode } from '@prisma/client';
import { createTenantWithCamera, createUserWithToken, startApp } from './helpers/realDb';
import { VideoRedactorService, ffmpegRenderer } from '../services/privacy/videoRedactor.service';
import { RedactionRegionClient } from '../services/privacy/redactionRegionClient';

jest.setTimeout(120000);

const prisma = new PrismaClient();
const SCENE = path.resolve(__dirname, '../../../services/ai-worker/src/__tests__/fixtures/redaction/SYNTHETIC_face_plate_scene.png');
const FACE = [146, 100, 199, 165]; // OpenCV YuNet on the fixture (yunet.reference.json)
const PLATE = [534, 410, 856, 478]; // SYNTHETIC_redaction_manifest.json
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redaction-realdb-'));
const exportsDir = path.join(tmp, 'exports');
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const shaFile = (p: string) => sha(fs.readFileSync(p));

let tenantId = '';
let cameraId = '';
let userId = '';
let token = '';
let pipelineSha = '';
let pipelineVersion = '';
let stub: http.Server;
let stubUrl = '';
let stubMode: 'ok' | 'unregistered' = 'ok';
const segFiles: string[] = [];

function lumaAt(file: string, t: number, box: number[]): number {
  const [x1, y1, x2, y2] = box.map(Math.round);
  const out = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=${x2 - x1 - 8}:${y2 - y1 - 8}:${x1 + 4}:${y1 + 4},format=gray`, '-f', 'rawvideo', '-']);
  return out.reduce((a, v) => a + v, 0) / out.length;
}

function startStub(): Promise<void> {
  const provenance = () => ({
    adapterId: 'stub-redaction',
    adapterVersion: 'test',
    modelId: 'redaction-regions@1.0.0',
    modelName: 'redaction-regions',
    modelVersion: pipelineVersion,
    modelSha256: stubMode === 'ok' ? pipelineSha : 'f'.repeat(64),
    runtime: 'onnxruntime',
    executionProvider: 'cpu',
    inferenceId: crypto.randomUUID(),
    frameTimestampUtc: new Date().toISOString(),
    components: [{ role: 'face_detector', modelName: 'yunet', modelVersion: '2023mar', modelSha256: 'a'.repeat(64) }],
  });
  stub = http.createServer((req, res) => {
    const send = (o: unknown) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(o));
    };
    if (req.url === '/v1/health') return send({ contract: 'ai-adapter.v1', adapterId: 'stub-redaction', status: 'READY', loadedModelIds: ['redaction-regions@1.0.0'], lastError: null, observedAtUtc: new Date().toISOString() });
    if (req.url === '/v1/descriptor') {
      return send({
        contract: 'ai-adapter.v1', adapterId: 'stub-redaction', adapterVersion: 'test', tasks: ['face_detection_for_redaction', 'plate_detection_for_redaction'], requiresNetworkEgress: false,
        models: [{ modelId: 'redaction-regions@1.0.0', name: 'redaction-regions', version: pipelineVersion, sha256: pipelineSha, task: 'face_detection_for_redaction', classes: ['face', 'license_plate'], codeLicense: 'MIT', weightsLicense: 'MIT', weightsSource: 'test stub', runtime: 'onnxruntime', input: { width: 640, height: 640, colorSpace: 'BGR', letterbox: true }, evaluation: null }],
      });
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const r = JSON.parse(body);
      const W = r.frame.width;
      const H = r.frame.height;
      const b = r.task === 'face_detection_for_redaction' ? FACE : PLATE;
      send({
        contract: 'ai-adapter.v1', status: 'ok', requestId: r.requestId, latencyMs: 1, provenance: provenance(),
        detections: [{ objectClass: r.task === 'face_detection_for_redaction' ? 'face' : 'license_plate', classId: 0, confidence: 0.9, bbox: { x: b[0] / W, y: b[1] / H, width: (b[2] - b[0]) / W, height: (b[3] - b[1]) / H } }],
      });
    });
  });
  return new Promise((r) => stub.listen(0, '127.0.0.1', () => {
    stubUrl = `http://127.0.0.1:${(stub.address() as any).port}`;
    r();
  }));
}

async function newManifest(): Promise<string> {
  const leaves = segFiles.map((f, i) => ({
    leafIndex: i, segmentId: path.basename(f, '.mp4').split('__')[1], cameraId,
    startUtc: new Date(Date.UTC(2026, 8, 27, 10, 0, 3 * i)).toISOString(), endUtc: new Date(Date.UTC(2026, 8, 27, 10, 0, 3 * i + 3)).toISOString(),
    mediaSha256: shaFile(f), leafHash: sha(Buffer.from(`leaf${i}`)),
  }));
  const m = await prisma.evidenceManifest.create({
    data: {
      tenantId, createdByUserId: userId, startUtc: new Date(leaves[0].startUtc), endUtc: new Date(leaves[leaves.length - 1].endUtc), cameraIdsJson: [cameraId],
      masterEvidenceHash: sha(Buffer.from(leaves.map((l) => l.mediaSha256).join(''))), sourceMetadataJson: {}, segmentManifestJson: leaves as any,
    },
  });
  return m.id;
}

const custodyFor = (manifestId: string) => prisma.chainOfCustodyLog.findMany({ where: { evidenceId: manifestId, action: 'EVIDENCE_REDACTED' } });

beforeAll(async () => {
  process.env.EXPORTS_DIR = exportsDir;
  ({ tenantId, cameraId } = await createTenantWithCamera(prisma, 'redact'));
  ({ userId, token } = await createUserWithToken(prisma, tenantId, 'TENANT_ADMIN'));
  // Face redaction needs the tenant's DPDP face switch (default off, P4.6).
  await prisma.dataProtectionSettings.create({ data: { tenantId, faceProcessingEnabled: true } });
  pipelineSha = sha(Buffer.from(`redaction-pipeline-${tenantId}`));
  pipelineVersion = `0.0.0-test.${tenantId.slice(0, 8)}`;
  await prisma.modelManifest.create({
    data: {
      name: 'redaction-regions', version: pipelineVersion, sha256: pipelineSha, task: 'face_detection_for_redaction', codeLicense: 'MIT', weightLicense: 'MIT',
      trainingDataJson: { source: 'test', license: 'test', provenance: 'test', commercialUse: true }, runtimeConfigJson: { runtime: 'onnxruntime' }, isActive: true,
    },
  });
  await startStub();
  // Two 3-second SYNTHETIC segments of the fixture scene (face + plate), as the recorder would store them.
  const segDir = path.join(tmp, 'recordings');
  fs.mkdirSync(segDir, { recursive: true });
  for (let i = 0; i < 2; i++) {
    const seg = await prisma.recordingSegment.create({
      data: { tenantId, cameraId, filePath: path.join(segDir, `pending-${i}-${crypto.randomUUID()}`), startTime: new Date(Date.UTC(2026, 8, 27, 10, 0, 3 * i)), endTime: new Date(Date.UTC(2026, 8, 27, 10, 0, 3 * i + 3)), durationMs: 3000, sizeBytes: BigInt(1) },
    });
    const f = path.join(segDir, `seg${i}__${seg.id}.mp4`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-i', SCENE, '-t', '3', '-r', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '10', f]);
    await prisma.recordingSegment.update({ where: { id: seg.id }, data: { filePath: f, sizeBytes: BigInt(fs.statSync(f).size), sha256Hash: shaFile(f) } });
    segFiles.push(f);
  }
});

afterAll(async () => {
  await new Promise<void>((r) => stub.close(() => r()));
  await prisma.modelManifest.deleteMany({ where: { sha256: pipelineSha } });
  await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await prisma.$disconnect();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const redactor = (opts: ConstructorParameters<typeof VideoRedactorService>[2] = {}) =>
  new VideoRedactorService(prisma, undefined, { regionClient: (p) => new RedactionRegionClient(p, stubUrl), exportsDir: () => exportsDir, ...opts });

describe('P4.4 redaction on the real path', () => {
  it('produces a real derivative with faces and plates masked, hashed and linked to the master in custody', async () => {
    const masterBefore = segFiles.map(shaFile);
    const manifestId = await newManifest();
    const svc = redactor();
    const job = await svc.createRedactionJob({ tenantId, createdByUserId: userId, sourceManifestId: manifestId, redactionMode: RedactionMode.FACE, detectKinds: ['LICENSE_PLATE'], sampleFps: 2 });
    const done = await svc.executeRedactionJob(job.id);

    const file = path.join(exportsDir, done.outputObjectKey!);
    expect(fs.existsSync(file)).toBe(true);
    const bytes = fs.readFileSync(file);
    expect(bytes.length).toBeGreaterThan(0);
    expect(done.status).toBe('COMPLETED');
    expect(done.outputSha256).toBe(sha(bytes));
    expect(Number(done.outputBytes)).toBe(bytes.length);
    expect(done.modelVersion).toBe(`redaction-regions@${pipelineVersion}`);

    // Masks are in the pixels: face and plate regions black, the rest of the scene is not.
    for (const t of [0.5, 2.9, 5.5]) {
      expect(lumaAt(file, t, FACE)).toBeLessThan(24);
      expect(lumaAt(file, t, PLATE)).toBeLessThan(24);
    }
    expect(lumaAt(file, 3, [700, 20, 900, 120])).toBeGreaterThan(60);

    const prov = done.provenanceJson as any;
    expect(prov.detector.modelSha256).toBe(pipelineSha);
    expect(prov.masks.face).toBeGreaterThan(0);
    expect(prov.masks.licensePlate).toBeGreaterThan(0);
    expect(prov.source.segments.map((s: any) => s.sha256)).toEqual(masterBefore);
    expect(prov.render.tool).toMatch(/^ffmpeg version/);
    expect(prov.render.audio).toBe('removed');

    const custody = await custodyFor(manifestId);
    expect(custody).toHaveLength(1);
    const m = await prisma.evidenceManifest.findUniqueOrThrow({ where: { id: manifestId } });
    expect(custody[0]).toMatchObject({ sourceHash: m.masterEvidenceHash, resultHash: sha(bytes) });

    // Master evidence untouched.
    expect(segFiles.map(shaFile)).toEqual(masterBefore);
  });

  it('fails and marks job FAILED if output file was not produced', async () => {
    const manifestId = await newManifest();
    const svc = redactor({ renderer: async () => undefined });
    const job = await svc.createRedactionJob({ tenantId, createdByUserId: userId, sourceManifestId: manifestId, redactionMode: RedactionMode.FACE, sampleFps: 1 });
    await expect(svc.executeRedactionJob(job.id)).rejects.toThrow(/REDACTION_OUTPUT_MISSING: Redaction output file was not produced/);
    const row = await prisma.redactionJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row).toMatchObject({ status: 'FAILED', errorCode: 'REDACTION_OUTPUT_MISSING', outputSha256: null, outputObjectKey: null });
    expect(fs.existsSync(path.join(exportsDir, 'derivatives', tenantId, `${job.id}.mp4`))).toBe(false);
    expect(await custodyFor(manifestId)).toHaveLength(0);
  });

  it('fails when the renderer ignores the masks (checked in the decoded output)', async () => {
    const manifestId = await newManifest();
    const svc = redactor({ renderer: (r) => ffmpegRenderer({ ...r, filterScriptPath: (() => { const f = r.filterScriptPath + '.none'; fs.writeFileSync(f, 'null'); return f; })() }) });
    const job = await svc.createRedactionJob({ tenantId, createdByUserId: userId, sourceManifestId: manifestId, redactionMode: RedactionMode.FACE, sampleFps: 1 });
    await expect(svc.executeRedactionJob(job.id)).rejects.toThrow(/REDACTION_MASK_NOT_APPLIED/);
    expect(await custodyFor(manifestId)).toHaveLength(0);
  });

  it('fails closed when the detector is unreachable or not a registered pipeline', async () => {
    const manifestId = await newManifest();
    const down = new VideoRedactorService(prisma, undefined, { regionClient: (p) => new RedactionRegionClient(p, 'http://127.0.0.1:9', 2000), exportsDir: () => exportsDir });
    const j1 = await down.createRedactionJob({ tenantId, createdByUserId: userId, sourceManifestId: manifestId, redactionMode: RedactionMode.LICENSE_PLATE });
    await expect(down.executeRedactionJob(j1.id)).rejects.toThrow(/REDACTION_DETECTOR_UNAVAILABLE/);

    stubMode = 'unregistered';
    try {
      const svc = redactor();
      const j2 = await svc.createRedactionJob({ tenantId, createdByUserId: userId, sourceManifestId: manifestId, redactionMode: RedactionMode.FACE, sampleFps: 1 });
      await expect(svc.executeRedactionJob(j2.id)).rejects.toThrow(/REDACTION_PROVENANCE_INVALID/);
    } finally {
      stubMode = 'ok';
    }
    expect(await custodyFor(manifestId)).toHaveLength(0);
    expect(fs.existsSync(path.join(exportsDir, 'derivatives', tenantId, `${j1.id}.mp4`))).toBe(false);
  });

  it('refuses a source segment whose bytes no longer match the manifest', async () => {
    const manifestId = await newManifest();
    const f = segFiles[1];
    const orig = fs.readFileSync(f);
    try {
      const b = Buffer.from(orig);
      b[b.length - 10] ^= 0xff;
      fs.writeFileSync(f, b);
      const svc = redactor();
      const job = await svc.createRedactionJob({ tenantId, createdByUserId: userId, sourceManifestId: manifestId, redactionMode: RedactionMode.FACE });
      await expect(svc.executeRedactionJob(job.id)).rejects.toThrow(/REDACTION_SOURCE_INTEGRITY_FAILED/);
    } finally {
      fs.writeFileSync(f, orig);
    }
  });

  it('the database refuses a COMPLETED job without a hashed output', async () => {
    const manifestId = await newManifest();
    const job = await redactor().createRedactionJob({ tenantId, createdByUserId: userId, sourceManifestId: manifestId, redactionMode: RedactionMode.FACE });
    await expect(prisma.redactionJob.update({ where: { id: job.id }, data: { status: 'COMPLETED' } })).rejects.toThrow();
    await expect(prisma.redactionJob.update({ where: { id: job.id }, data: { detectKinds: ['PERSON'] } })).rejects.toThrow();
  });

  it('HTTP: create, execute, poll, download with verified SHA-256, all audited', async () => {
    process.env.REDACTION_ADAPTER_URL = stubUrl;
    process.env.VIGILONE_FEATURE_REDACTION = 'true';
    const app = await startApp();
    try {
      const manifestId = await newManifest();
      const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      const bad = await fetch(`${app.url}/api/v1/privacy/jobs`, { method: 'POST', headers: h, body: JSON.stringify({ sourceManifestId: manifestId, redactionMode: 'BYSTANDER' }) });
      expect(bad.status).toBe(400);
      const c = await fetch(`${app.url}/api/v1/privacy/jobs`, { method: 'POST', headers: h, body: JSON.stringify({ sourceManifestId: manifestId, redactionMode: 'LICENSE_PLATE', sampleFps: 1 }) });
      expect(c.status).toBe(201);
      const job = (await c.json()) as any;
      const e = await fetch(`${app.url}/api/v1/privacy/jobs/${job.id}/execute`, { method: 'POST', headers: h });
      expect(e.status).toBe(202);
      const { redactionQueue } = require('../composition');
      await redactionQueue.idle();
      const g = (await (await fetch(`${app.url}/api/v1/privacy/jobs/${job.id}`, { headers: h })).json()) as any;
      expect(g.status).toBe('COMPLETED');
      const d = await fetch(`${app.url}/api/v1/privacy/jobs/${job.id}/download`, { headers: h });
      expect(d.status).toBe(200);
      const body = Buffer.from(await d.arrayBuffer());
      expect(sha(body)).toBe(g.outputSha256);
      expect(d.headers.get('x-vigilone-sha256')).toBe(g.outputSha256);
      const again = await fetch(`${app.url}/api/v1/privacy/jobs/${job.id}/execute`, { method: 'POST', headers: h });
      expect(again.status).toBe(409);
      const audits = await prisma.auditEvent.findMany({ where: { tenantId, resourceId: job.id }, select: { action: true } });
      expect(audits.map((a) => a.action).sort()).toEqual(['REDACTION_DERIVATIVE_DOWNLOAD', 'REDACTION_JOB_CREATE', 'REDACTION_JOB_EXECUTE']);
    } finally {
      await app.close();
      delete process.env.REDACTION_ADAPTER_URL;
      delete process.env.VIGILONE_FEATURE_REDACTION;
    }
  });
});
