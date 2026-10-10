/**
 * P4.5 on the real path: a Section 63 export and a redacted-derivative package are built from real
 * segment files, the real database and real ffmpeg, then checked by the standalone offline verifier
 * (tools/vigilone-verify, run as a separate process). Tampered copies must be rejected.
 * The AI records are inserted rows with provenance (SIMULATED detections), which is what the
 * package must carry through; the redaction detector is the stub adapter pattern of P4.4.
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { PrismaClient, RedactionMode } from '@prisma/client';
import { createTenantWithCamera, createUserWithToken } from './helpers/realDb';

jest.setTimeout(180000);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evpkg-'));
process.env.EXPORTS_DIR = path.join(tmp, 'exports');
process.env.RECORDINGS_DIR = path.join(tmp, 'recordings');
fs.mkdirSync(process.env.EXPORTS_DIR, { recursive: true });
fs.mkdirSync(process.env.RECORDINGS_DIR, { recursive: true });

const VERIFY = path.resolve(__dirname, '../../../tools/vigilone-verify/vigilone-verify.mjs');
const SCENE = path.resolve(__dirname, '../../../services/ai-worker/src/__tests__/fixtures/redaction/SYNTHETIC_face_plate_scene.png');
const prisma = new PrismaClient();
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
let tenantId = '';
let cameraId = '';
let userId = '';
let modelSha = '';
let detectorSha = '';
let detectorVersion = '';
let stub: http.Server;
let stubUrl = '';
const t0 = Date.UTC(2026, 8, 27, 9, 0, 0);

function verify(target: string, ...extra: string[]) {
  const r = spawnSync('node', [VERIFY, target, '--json', ...extra], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr };
}
const failed = (r: any) => r.out.results.filter((x: any) => x.status === 'FAIL').map((x: any) => x.id);
function unzip(zip: string): string {
  const d = fs.mkdtempSync(path.join(tmp, 'x-'));
  execFileSync('python3', ['-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, d]);
  return d;
}

beforeAll(async () => {
  ({ tenantId, cameraId } = await createTenantWithCamera(prisma, 'evpkg'));
  ({ userId } = await createUserWithToken(prisma, tenantId, 'TENANT_ADMIN'));
  // Face redaction needs the tenant's DPDP face switch (default off, P4.6).
  await prisma.dataProtectionSettings.create({ data: { tenantId, faceProcessingEnabled: true } });
  for (let i = 0; i < 2; i++) {
    const f = path.join(process.env.RECORDINGS_DIR!, `seg${i}.mp4`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-i', SCENE, '-t', '3', '-r', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '10', f]);
    // The second segment is stored without a hash, as a recorder crash could leave it; the export
    // must hash the real bytes rather than invent a value.
    await prisma.recordingSegment.create({
      data: { tenantId, cameraId, filePath: f, startTime: new Date(t0 + i * 3000), endTime: new Date(t0 + (i + 1) * 3000), durationMs: 3000, sizeBytes: BigInt(fs.statSync(f).size), sha256Hash: i === 0 ? sha(fs.readFileSync(f)) : null },
    });
  }
  modelSha = sha(`yolox-${tenantId}`);
  await prisma.modelManifest.create({
    data: { name: 'yolox-test', version: `t-${tenantId.slice(0, 8)}`, sha256: modelSha, task: 'object_detection', codeLicense: 'Apache-2.0', weightLicense: 'Apache-2.0', trainingDataJson: {}, runtimeConfigJson: {}, isActive: true },
  });
  const prov = (t: number) => ({ adapterId: 'ai-worker', adapterVersion: 't', modelId: 'm', modelName: 'yolox-test', modelVersion: `t-${tenantId.slice(0, 8)}`, modelSha256: modelSha, runtime: 'onnxruntime@1.30.0', executionProvider: 'cpu', inferenceId: crypto.randomUUID(), frameTimestampUtc: new Date(t).toISOString() });
  await prisma.detectionEvent.create({ data: { tenantId, cameraId, type: 'PERSON_DETECTED', confidence: 0.81, objectClass: 'person', modelSha256: modelSha, provenanceJson: prov(t0 + 1000), timestamp: new Date(t0 + 1000), boundingBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.4 } } });
  await prisma.detectionEvent.create({ data: { tenantId, cameraId, type: 'PERSON_DETECTED', confidence: 0.7, timestamp: new Date(t0 + 2000) } }); // legacy, no provenance
  await prisma.detectionEvent.create({ data: { tenantId, cameraId, type: 'MOTION', confidence: 1, timestamp: new Date(t0 + 2500) } }); // classical, not AI
  await prisma.vehicleObservation.create({
    data: { tenantId, cameraId, plateNumber: 'MH 12 AB 1234', normalizedPlate: 'MH12AB1234', firstSeenAt: new Date(t0 + 1500), lastSeenAt: new Date(t0 + 4000), bestConfidence: 0.93, provenanceJson: { ...prov(t0 + 1500), modelName: 'yolox-test' } },
  });

  // Redaction detector stub (as in redactionRealDb.test.ts), registered as a pipeline.
  detectorSha = sha(`redaction-${tenantId}`);
  detectorVersion = `0.0.0-pkg.${tenantId.slice(0, 8)}`;
  await prisma.modelManifest.create({
    data: { name: 'redaction-regions', version: detectorVersion, sha256: detectorSha, task: 'face_detection_for_redaction', codeLicense: 'MIT', weightLicense: 'MIT', trainingDataJson: {}, runtimeConfigJson: {}, isActive: true },
  });
  stub = http.createServer((req, res) => {
    const send = (o: unknown) => res.end(JSON.stringify(o));
    if (req.url === '/v1/health') return send({ contract: 'ai-adapter.v1', adapterId: 's', status: 'READY', loadedModelIds: ['r'], lastError: null, observedAtUtc: new Date().toISOString() });
    if (req.url === '/v1/descriptor') return send({ contract: 'ai-adapter.v1', adapterId: 's', adapterVersion: 't', tasks: ['face_detection_for_redaction', 'plate_detection_for_redaction'], requiresNetworkEgress: false, models: [{ modelId: 'r', name: 'redaction-regions', version: detectorVersion, sha256: detectorSha, task: 'face_detection_for_redaction', classes: ['face', 'license_plate'], codeLicense: 'MIT', weightsLicense: 'MIT', weightsSource: 'stub', runtime: 'onnxruntime', input: { width: 640, height: 640, colorSpace: 'BGR', letterbox: true }, evaluation: null }] });
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const r = JSON.parse(b);
      send({ contract: 'ai-adapter.v1', status: 'ok', requestId: r.requestId, latencyMs: 1, detections: [{ objectClass: 'face', classId: 0, confidence: 0.9, bbox: { x: 146 / 960, y: 100 / 540, width: 53 / 960, height: 65 / 540 } }],
        provenance: { adapterId: 's', adapterVersion: 't', modelId: 'r', modelName: 'redaction-regions', modelVersion: detectorVersion, modelSha256: detectorSha, runtime: 'onnxruntime', executionProvider: 'cpu', inferenceId: crypto.randomUUID(), frameTimestampUtc: r.frame.timestampUtc, components: [{ role: 'face_detector', modelName: 'yunet', modelVersion: '2023mar', modelSha256: 'b'.repeat(64) }] } });
    });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
  stubUrl = `http://127.0.0.1:${(stub.address() as any).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => stub.close(() => r()));
  await prisma.modelManifest.deleteMany({ where: { sha256: { in: [modelSha, detectorSha] } } });
  await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await prisma.$disconnect();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('P4.5 evidence packages verified offline', () => {
  let exportZip = '';

  it('a Section 63 export carries AI provenance and verifies with vigilone-verify', async () => {
    const { EvidenceArchive } = require('../services/evidence/archive/evidenceArchive.service');
    exportZip = await new EvidenceArchive(prisma).processExport({ tenantId, cameraId, requestedById: userId, startTime: new Date(t0), endTime: new Date(t0 + 6000) });
    const seg2 = await prisma.recordingSegment.findFirstOrThrow({ where: { cameraId, startTime: new Date(t0 + 3000) } });
    expect(seg2.sha256Hash).toBe(sha(fs.readFileSync(seg2.filePath)));

    const r = verify(exportZip, '--require-ai-provenance');
    expect(failed(r)).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.out.verdict).toBe('VALID');
    const ids = r.out.results.map((x: any) => x.id);
    expect(ids).toEqual(expect.arrayContaining(['manifest.signature', 'merkle.root', 'custody.chain', 'custody.export_event', 'ai.records_attributed', 'ai.summary_matches', 'c2pa_manifest']));
    expect(r.out.results.find((x: any) => x.id === 'ai.unattributed')?.status).toBe('WARN');

    const dir = unzip(exportZip);
    const ai = JSON.parse(fs.readFileSync(path.join(dir, 'ai_provenance.json'), 'utf8'));
    expect(ai.records.map((x: any) => x.kind).sort()).toEqual(['DETECTION', 'PLATE_READ']);
    expect(ai.records.every((x: any) => x.model.sha256 === modelSha && x.cameraId === cameraId)).toBe(true);
    expect(ai.unattributed.count).toBe(1);
    expect(ai.models).toEqual([expect.objectContaining({ name: 'yolox-test', sha256: modelSha, registered: true, evaluation: null })]);

    // C2PA 2.2 manifest assertions
    const c2pa = JSON.parse(fs.readFileSync(path.join(dir, 'c2pa_manifest.json'), 'utf8'));
    expect(c2pa.c2pa_version).toBe('2.2');
    expect(c2pa.claim_generator).toBe('VigilOne Edge VMS/1.0.0');
    expect(c2pa.assertions.find((a: any) => a.label === 'c2pa.hash.data')?.data.hash).toBeDefined();
    expect(c2pa.assertions.find((a: any) => a.label === 'in.gov.bsa.section63')?.data.evidenceMerkleRoot).toBeDefined();

    // Verify with --require-c2pa
    expect(verify(exportZip, '--require-c2pa').code).toBe(0);

    // pinning the appliance key
    expect(verify(exportZip, '--trusted-key', path.join(dir, 'appliance_public_key.pem')).code).toBe(0);
    expect(verify(exportZip, '--trusted-key-sha256', '0'.repeat(64)).code).toBe(1);
  });

  it('rejects tampered media, a re-signed manifest, removed AI provenance and edited custody', () => {
    const base = unzip(exportZip);
    const copy = () => {
      const d = fs.mkdtempSync(path.join(tmp, 't-'));
      fs.cpSync(base, d, { recursive: true });
      return d;
    };
    // 1. one byte of video
    let d = copy();
    const v = fs.readFileSync(path.join(d, 'video.mp4'));
    v[v.length >> 1] ^= 0x01;
    fs.writeFileSync(path.join(d, 'video.mp4'), v);
    expect(failed(verify(d))).toEqual(['artifact:video.mp4']);
    // 2. AI record edited (claims another model); manifest untouched
    d = copy();
    const ai = JSON.parse(fs.readFileSync(path.join(d, 'ai_provenance.json'), 'utf8'));
    ai.records[0].confidence = 0.99;
    fs.writeFileSync(path.join(d, 'ai_provenance.json'), JSON.stringify(ai));
    expect(failed(verify(d))).toContain('artifact:ai_provenance.json');
    // 3. manifest edited and re-signed with a different key
    d = copy();
    const m = JSON.parse(fs.readFileSync(path.join(d, 'manifest.json'), 'utf8'));
    m.aiProvenance.recordCount = 0;
    const { canonicalizeJson } = require('../services/evidence/archive/canonicalJson');
    const bytes = canonicalizeJson(m);
    const k = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(path.join(d, 'manifest.json'), bytes);
    fs.writeFileSync(path.join(d, 'manifest.sha256'), sha(bytes));
    fs.writeFileSync(path.join(d, 'manifest.sig'), crypto.sign(null, Buffer.from(bytes), k.privateKey).toString('base64'));
    expect(failed(verify(d))).toEqual(expect.arrayContaining(['manifest.signature', 'ai.summary_matches']));
    // 4. custody event metadata edited
    d = copy();
    const c = JSON.parse(fs.readFileSync(path.join(d, 'chain_of_custody.json'), 'utf8'));
    c[0].metadata.segmentCount = 99;
    fs.writeFileSync(path.join(d, 'chain_of_custody.json'), JSON.stringify(c, null, 2));
    expect(failed(verify(d))).toEqual(expect.arrayContaining(['artifact:chain_of_custody.json', 'custody.chain']));
    // 5. an extra file slipped in
    d = copy();
    fs.writeFileSync(path.join(d, 'note.txt'), 'x');
    expect(failed(verify(d))).toEqual(['artifacts.no_unlisted_files']);
    // 6. c2pa_manifest.json missing with --require-c2pa
    d = copy();
    fs.rmSync(path.join(d, 'c2pa_manifest.json'));
    expect(failed(verify(d, '--require-c2pa'))).toContain('c2pa_manifest');
  });

  it('a redacted derivative package links to the parent evidence and verifies', async () => {
    const { ManifestBuilder } = require('../services/evidence/archive/manifestBuilder');
    const { VideoRedactorService } = require('../services/privacy/videoRedactor.service');
    const { RedactionRegionClient } = require('../services/privacy/redactionRegionClient');
    const { buildRedactionPackage } = require('../services/evidence/archive/redactionPackage');
    const mb = new ManifestBuilder(prisma);
    const manifest = await mb.createManifest({ tenantId, createdByUserId: userId, cameraIds: [cameraId], startUtc: new Date(t0), endUtc: new Date(t0 + 6000) });
    const svc = new VideoRedactorService(prisma, undefined, { regionClient: (p: any) => new RedactionRegionClient(p, stubUrl), exportsDir: () => process.env.EXPORTS_DIR! });
    const job = await svc.createRedactionJob({ tenantId, createdByUserId: userId, sourceManifestId: manifest.id, redactionMode: RedactionMode.FACE, sampleFps: 1 });
    await svc.executeRedactionJob(job.id);
    const pkg = await buildRedactionPackage(prisma, tenantId, job.id, userId);

    const r = verify(pkg.zipPath, '--require-ai-provenance');
    expect(failed(r)).toEqual([]);
    expect(r.out.results.map((x: any) => x.id)).toEqual(expect.arrayContaining(['custody.derivation_event', 'derivation.parent', 'derivation.source_segments', 'derivation.detector_listed']));
    const dir = unzip(pkg.zipPath);
    const d = JSON.parse(fs.readFileSync(path.join(dir, 'derivation.json'), 'utf8'));
    expect(d).toMatchObject({ type: 'REDACTION', parentEvidenceId: manifest.id, parentMasterEvidenceHash: manifest.masterEvidenceHash, redactionJobId: job.id });
    expect(d.detector.modelSha256).toBe(detectorSha);

    // A derivative claiming another parent fails.
    const bad = fs.mkdtempSync(path.join(tmp, 'd-'));
    fs.cpSync(dir, bad, { recursive: true });
    const d2 = { ...d, parentMasterEvidenceHash: 'c'.repeat(64) };
    fs.writeFileSync(path.join(bad, 'derivation.json'), JSON.stringify(d2));
    expect(failed(verify(bad))).toEqual(expect.arrayContaining(['artifact:derivation.json', 'derivation.parent']));
  });
});
