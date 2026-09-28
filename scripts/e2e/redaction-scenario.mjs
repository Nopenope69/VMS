#!/usr/bin/env node
/**
 * P4.4 redaction end-to-end helper (driven by redaction-scenario.sh): setup / run / verify / cleanup.
 * SIMULATED recording of a SYNTHETIC scene; the report says so.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(path.resolve(process.cwd(), 'backend/package.json'));
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');

const E2E_DIR = process.env.E2E_DIR || '/tmp/vigilone-redaction-e2e';
const STATE = path.join(E2E_DIR, 'state.json');
const API = 'http://127.0.0.1:4000/api/v1';
const prisma = new PrismaClient();
const readState = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
const writeState = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shaFile = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const fixture = JSON.parse(fs.readFileSync('services/ai-worker/src/__tests__/fixtures/redaction/SYNTHETIC_redaction_manifest.json', 'utf8'));

async function setup() {
  const suffix = crypto.randomBytes(3).toString('hex');
  const tenant = await prisma.tenant.create({ data: { name: `Redaction E2E ${suffix}`, slug: `redaction-e2e-${suffix}` } });
  const site = await prisma.site.create({ data: { tenantId: tenant.id, name: 'E2E site', timezone: 'Asia/Kolkata' } });
  const camera = await prisma.camera.create({ data: { tenantId: tenant.id, siteId: site.id, name: 'E2E camera (SIMULATED recording)', streamPath: `redact_${suffix}`, ipAddress: '127.0.0.1', mainRtspUri: 'rtsp://127.0.0.1:8554/none' } });
  await prisma.dataProtectionSettings.create({ data: { tenantId: tenant.id, faceProcessingEnabled: true } }); // DPDP face switch (default off)
  const user = await prisma.user.create({ data: { tenantId: tenant.id, email: `e2e-${suffix}@test.invalid`, passwordHash: 'x', name: 'E2E admin', role: 'TENANT_ADMIN' } });
  const t0 = Date.UTC(2026, 8, 27, 10, 0, 0);
  const leaves = [];
  for (const i of [0, 1]) {
    const f = path.join(process.env.RECORDINGS_DIR, `seg${i}.mp4`);
    const seg = await prisma.recordingSegment.create({
      data: { tenantId: tenant.id, cameraId: camera.id, filePath: f, startTime: new Date(t0 + i * 4000), endTime: new Date(t0 + (i + 1) * 4000), durationMs: 4000, sizeBytes: BigInt(fs.statSync(f).size), sha256Hash: shaFile(f) },
    });
    leaves.push({ leafIndex: i, segmentId: seg.id, cameraId: camera.id, startUtc: seg.startTime.toISOString(), endUtc: seg.endTime.toISOString(), mediaSha256: seg.sha256Hash, leafHash: crypto.createHash('sha256').update(`leaf${i}${seg.sha256Hash}`).digest('hex') });
  }
  const master = crypto.createHash('sha256').update(leaves.map((l) => l.leafHash).join('')).digest('hex');
  const manifest = await prisma.evidenceManifest.create({
    data: { tenantId: tenant.id, createdByUserId: user.id, startUtc: new Date(t0), endUtc: new Date(t0 + 8000), cameraIdsJson: [camera.id], masterEvidenceHash: master, sourceMetadataJson: { note: 'SIMULATED recording for the redaction e2e scenario' }, segmentManifestJson: leaves },
  });
  const token = jwt.sign({ id: user.id, email: user.email, role: 'TENANT_ADMIN', tenantId: tenant.id, type: 'ACCESS' }, process.env.JWT_SECRET, { expiresIn: '30m' });
  writeState({ tenantId: tenant.id, cameraId: camera.id, manifestId: manifest.id, token, master, masterSegmentSha256: leaves.map((l) => l.mediaSha256) });
  console.log(JSON.stringify({ step: 'setup', tenantId: tenant.id, manifestId: manifest.id }));
}

async function run() {
  const s = readState();
  const h = { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' };
  const started = Date.now();
  const c = await fetch(`${API}/privacy/jobs`, { method: 'POST', headers: h, body: JSON.stringify({ sourceManifestId: s.manifestId, redactionMode: 'FACE', detectKinds: ['LICENSE_PLATE'], sampleFps: 4 }) });
  if (c.status !== 201) throw new Error(`create: HTTP ${c.status} ${await c.text()}`);
  const job = await c.json();
  const e = await fetch(`${API}/privacy/jobs/${job.id}/execute`, { method: 'POST', headers: h });
  if (e.status !== 202) throw new Error(`execute: HTTP ${e.status} ${await e.text()}`);
  let g;
  for (let i = 0; i < 240; i++) {
    g = await (await fetch(`${API}/privacy/jobs/${job.id}`, { headers: h })).json();
    if (g.status === 'COMPLETED' || g.status === 'FAILED') break;
    await sleep(500);
  }
  if (g.status !== 'COMPLETED') throw new Error(`job ended ${g.status}: ${g.errorCode} ${g.error}`);
  const d = await fetch(`${API}/privacy/jobs/${job.id}/download`, { headers: h });
  if (d.status !== 200) throw new Error(`download: HTTP ${d.status}`);
  fs.writeFileSync(path.join(E2E_DIR, 'downloaded.mp4'), Buffer.from(await d.arrayBuffer()));
  Object.assign(s, { jobId: job.id, outputSha256: g.outputSha256, outputBytes: g.outputBytes, jobMs: Date.now() - started, provenance: g.provenanceJson, headerSha256: d.headers.get('x-vigilone-sha256') });
  writeState(s);
  console.log(JSON.stringify({ step: 'run', jobId: job.id, status: g.status, jobMs: s.jobMs, masks: g.provenanceJson.masks }));
}

function luma(file, t, [x1, y1, x2, y2]) {
  const out = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=${x2 - x1}:${y2 - y1}:${x1}:${y1},format=gray`, '-f', 'rawvideo', '-']);
  return out.reduce((a, v) => a + v, 0) / out.length;
}

async function verify() {
  const s = readState();
  const file = path.join(E2E_DIR, 'downloaded.mp4');
  const custody = await prisma.chainOfCustodyLog.findMany({ where: { evidenceId: s.manifestId, action: 'EVIDENCE_REDACTED' } });
  // The scene pans by at most ~30 px; check the central part of the face and plate.
  const [fx1, fy1, fx2, fy2] = [150, 105, 195, 160];
  const [px1, py1, px2, py2] = fixture.plateBoxXYXY;
  const plateCore = [px1 + 60, py1 + 15, px2 - 60, py2 - 15];
  const samples = [0.5, 2, 3.9, 4.5, 6, 7.5].map((t) => ({ t, face: Number(luma(file, t, [fx1, fy1, fx2, fy2]).toFixed(1)), plate: Number(luma(file, t, plateCore).toFixed(1)), background: Number(luma(file, t, [700, 30, 900, 120]).toFixed(1)) }));
  const checks = {
    downloadShaMatchesRecord: process.env.SHA256SUM_OF_DOWNLOAD === s.outputSha256 && s.headerSha256 === s.outputSha256,
    outputNonEmpty: fs.statSync(file).size > 0 && fs.statSync(file).size === s.outputBytes,
    custodyLinksMasterToDerivative: custody.length === 1 && custody[0].sourceHash === s.master && custody[0].resultHash === s.outputSha256,
    detectorIsRegisteredPipeline: s.provenance?.detector?.modelName === 'redaction-regions' && /^[a-f0-9]{64}$/.test(s.provenance?.detector?.modelSha256 || ''),
    facesMasked: samples.every((x) => x.face < 24),
    platesMasked: samples.every((x) => x.plate < 24),
    backgroundVisible: samples.every((x) => x.background > 60),
    mastersUnchanged: [0, 1].every((i) => shaFile(path.join(process.env.RECORDINGS_DIR, `seg${i}.mp4`)) === s.masterSegmentSha256[i]),
  };
  const pass = Object.values(checks).every(Boolean);
  const report = {
    scenario: 'P4.4 redaction end to end',
    labels: ['SIMULATED-RECORDING', 'SYNTHETIC-SCENE', 'PUBLIC-DOMAIN-FACE (NASA portrait via scikit-image)', 'TEST-ONLY-LICENCE-APPROVALS'],
    result: pass ? 'PASS' : 'FAIL',
    at: new Date().toISOString(),
    job: { id: s.jobId, ms: s.jobMs, outputSha256: s.outputSha256, outputBytes: s.outputBytes },
    detector: s.provenance?.detector,
    masks: s.provenance?.masks,
    render: s.provenance?.render,
    samples,
    checks,
  };
  fs.mkdirSync(path.dirname(process.env.E2E_REPORT), { recursive: true });
  fs.writeFileSync(process.env.E2E_REPORT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ result: report.result, checks }, null, 1));
  if (!pass) process.exit(1);
}

async function cleanup() {
  try {
    const s = readState();
    await prisma.tenant.delete({ where: { id: s.tenantId } });
  } catch {}
}

const cmd = process.argv[2];
({ setup, run, verify, cleanup })[cmd]()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e.stack || String(e));
    await prisma.$disconnect();
    process.exit(1);
  });
