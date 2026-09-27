#!/usr/bin/env node
/**
 * P4.1 ANPR end-to-end helper (driven by anpr-lpr-scenario.sh): setup / wait / verify / cleanup.
 * SIMULATED camera, SYNTHETIC plate; the report says so.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';

const require = createRequire(path.resolve(process.cwd(), 'backend/package.json'));
const { PrismaClient } = require('@prisma/client');

const E2E_DIR = process.env.E2E_DIR || '/tmp/vigilone-anpr-e2e';
const STATE = path.join(E2E_DIR, 'state.json');
const MTX_API = process.env.MEDIAMTX_API_URL || 'http://127.0.0.1:9997';
const prisma = new PrismaClient();
const readState = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
const writeState = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PLATE = 'MH12AB1234';

async function setup() {
  const suffix = crypto.randomBytes(3).toString('hex');
  const tenant = await prisma.tenant.create({ data: { name: `ANPR E2E ${suffix}`, slug: `anpr-e2e-${suffix}` } });
  const site = await prisma.site.create({ data: { tenantId: tenant.id, name: 'E2E gate', timezone: 'Asia/Kolkata' } });
  const streamPath = `anpr_lane_${suffix}`;
  const camera = await prisma.camera.create({
    data: {
      tenantId: tenant.id, siteId: site.id, name: 'E2E LPR lane (SIMULATED-CAMERA)', streamPath, ipAddress: '127.0.0.1',
      mainRtspUri: process.env.CAMERA_RTSP_URL, isOnline: true, recordingMode: 'CONTINUOUS', desiredRecorderState: 'RUNNING',
      lprMode: true, lprConfigJson: { fps: 2, maxWidth: 1280, minConfidence: 0.5 },
    },
  });
  await prisma.vehicleWatchlist.create({
    data: { tenantId: tenant.id, plateNumber: 'MH 12 AB 1234', normalizedPlate: PLATE, matchType: 'EXACT', category: 'BLACKLIST', alertOnMatch: true, severity: 'CRITICAL', notes: 'E2E known plate' },
  });
  const res = await fetch(`${MTX_API}/v3/config/paths/add/${streamPath}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: process.env.CAMERA_RTSP_URL, sourceOnDemand: false, record: true }),
  });
  if (!res.ok) throw new Error(`MediaMTX path add failed: HTTP ${res.status} ${await res.text()}`);
  writeState({ tenantId: tenant.id, cameraId: camera.id, streamPath, setupAt: new Date().toISOString() });
  console.log(JSON.stringify({ step: 'setup', tenantId: tenant.id, cameraId: camera.id, streamPath }));
}

async function wait() {
  const s = readState();
  const timeoutMs = Number(process.env.E2E_TIMEOUT_MS || 180000);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const alarm = await prisma.alarm.findFirst({ where: { tenantId: s.tenantId, title: `Known plate ${PLATE} (BLACKLIST)` } });
    if (alarm) {
      s.alarmId = alarm.id;
      writeState(s);
      console.log(JSON.stringify({ step: 'wait', alarmId: alarm.id, afterMs: Date.now() - started }));
      return;
    }
    await sleep(1000);
  }
  throw new Error(`No known-plate alarm within ${timeoutMs} ms`);
}

async function verify() {
  const s = readState();
  const alarm = await prisma.alarm.findUnique({ where: { id: s.alarmId }, include: { canonicalEvent: true } });
  const obs = await prisma.vehicleObservation.findMany({ where: { cameraId: s.cameraId }, orderBy: { firstSeenAt: 'asc' } });
  const prov = obs[0]?.provenanceJson ?? null;
  const frameTs = alarm?.canonicalEvent?.provenanceJson?.frameTimestampUtc ? Date.parse(alarm.canonicalEvent.provenanceJson.frameTimestampUtc) : NaN;
  const segmentsDir = path.join(process.env.RECORDINGS_DIR || path.join(E2E_DIR, 'recordings'), s.streamPath);
  const segs = fs.existsSync(segmentsDir) ? fs.readdirSync(segmentsDir).filter((f) => f.endsWith('.mp4')) : [];
  const pipeline = JSON.parse(fs.readFileSync('scripts/models/pipelines/anpr-india-v1.json', 'utf8'));
  const checks = {
    plateReadExactly: obs.length > 0 && obs.every((o) => o.normalizedPlate === PLATE),
    observationCarriesPipelineProvenance: !!prov && prov.components?.length === 2 && prov.components.every((c, i) => c.modelSha256 === pipeline.components[i].sha256),
    alarmFromKnownPlateList: alarm?.severity === 'CRITICAL' && alarm?.canonicalEvent?.type === 'ANPR_MATCH',
    alarmEventCarriesProvenance: !!alarm?.canonicalEvent?.provenanceJson?.modelSha256,
    recordingContinuedWhileWorkerKilled: Number(process.env.SEGMENTS_AFTER_KILL) > Number(process.env.SEGMENTS_BEFORE_KILL),
  };
  const report = {
    scenario: 'P4.1 ANPR LPR lane: synthetic plate -> MediaMTX -> ai-worker (anpr) -> backend -> known-plate alarm',
    simulated: 'SIMULATED-CAMERA with a SYNTHETIC plate (tools/anpr/synth_plates.py); candidate models run under a TEST-ONLY approval',
    at: new Date().toISOString(),
    measured: {
      observations: obs.map((o) => ({ plate: o.normalizedPlate, display: o.plateNumber, reads: o.observationCount, bestConfidence: o.bestConfidence })),
      latencyFrameToAlarmMs: Number.isFinite(frameTs) ? alarm.triggeredAt.getTime() - frameTs : null,
      segmentsBeforeWorkerKill: Number(process.env.SEGMENTS_BEFORE_KILL),
      segmentsAfterWorkerKill: Number(process.env.SEGMENTS_AFTER_KILL),
      segmentFilesAtEnd: segs.length,
    },
    checks,
    result: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
  };
  fs.writeFileSync(process.env.E2E_REPORT, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  await prisma.tenant.delete({ where: { id: s.tenantId } }).catch(() => undefined);
  if (report.result !== 'PASS') process.exit(1);
}

async function cleanup() {
  if (!fs.existsSync(STATE)) return;
  await prisma.tenant.delete({ where: { id: readState().tenantId } }).catch(() => undefined);
}

const step = process.argv[2];
({ setup, wait, verify, cleanup })[step]?.().then(() => prisma.$disconnect()).catch(async (e) => {
  console.error(e.message);
  await prisma.$disconnect();
  process.exit(1);
});
