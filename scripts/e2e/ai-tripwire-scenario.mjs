#!/usr/bin/env node
/**
 * P2.9 end-to-end scenario helper (driven by ai-tripwire-scenario.sh).
 *
 *   setup   create tenant/site/camera, operator, tripwire + automation rule; add the MediaMTX path
 *   wait    poll the operator alarm API until the tripwire alarm appears; measure latency
 *   verify  provenance on detections and alarm, audit chain entries, recording kept going while
 *           the worker was killed; write the JSON report
 *
 * State is passed between steps in $E2E_DIR/state.json. Uses the backend's Prisma client.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';

const require = createRequire(path.resolve(process.cwd(), 'backend/package.json'));
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');

const E2E_DIR = process.env.E2E_DIR || '/tmp/vigilone-e2e';
const STATE = path.join(E2E_DIR, 'state.json');
const API = process.env.BACKEND_URL || 'http://127.0.0.1:4000';
const MTX_API = process.env.MEDIAMTX_API_URL || 'http://127.0.0.1:9997';
const prisma = new PrismaClient();

const readState = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
const writeState = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  const suffix = crypto.randomBytes(3).toString('hex');
  const tenant = await prisma.tenant.create({ data: { name: `E2E ${suffix}`, slug: `e2e-${suffix}` } });
  const site = await prisma.site.create({ data: { tenantId: tenant.id, name: 'E2E site', timezone: 'Asia/Kolkata' } });
  const streamPath = `e2e_cam_${suffix}`;
  const cameraUrl = process.env.CAMERA_RTSP_URL;
  const camera = await prisma.camera.create({
    data: {
      tenantId: tenant.id, siteId: site.id, name: 'E2E gate camera (SIMULATED-CAMERA)', streamPath,
      ipAddress: '127.0.0.1', mainRtspUri: cameraUrl, monitored: true,
      recordingMode: 'CONTINUOUS', desiredRecorderState: 'RUNNING',
    },
  });
  const user = await prisma.user.create({
    data: { tenantId: tenant.id, email: `op-${suffix}@e2e.invalid`, passwordHash: 'x', name: 'E2E operator', role: 'OPERATOR' },
  });
  const token = jwt.sign({ id: user.id, email: user.email, role: 'OPERATOR', tenantId: tenant.id, type: 'ACCESS' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  // Horizontal wire across the middle of the frame; the person walks bottom -> top.
  const wire = await prisma.spatialAnalyticsRule.create({
    data: {
      tenantId: tenant.id, cameraId: camera.id, name: 'Gate line', type: 'TRIPWIRE', direction: 'BIDIRECTIONAL',
      lineCoordinatesJson: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }], cooldownSeconds: 5,
    },
  });
  await prisma.automationRule.create({
    data: {
      tenantId: tenant.id, name: 'Gate line crossed', triggerType: 'TRIPWIRE_CROSS', cooldownSeconds: 0,
      triggerConfigJson: { spatialRuleId: wire.id }, conditionsJson: [],
      actionsJson: [{ id: 'alarm', type: 'TRIGGER_ALARM', config: { severity: 'CRITICAL', title: 'E2E: person crossed the gate line' } }],
    },
  });
  // What camera onboarding does (camera.routes.ts): MediaMTX pulls from the camera and records.
  const res = await fetch(`${MTX_API}/v3/config/paths/add/${streamPath}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: cameraUrl, sourceOnDemand: false, record: true }),
  });
  if (!res.ok) throw new Error(`MediaMTX path add failed: HTTP ${res.status} ${await res.text()}`);
  writeState({ tenantId: tenant.id, cameraId: camera.id, streamPath, token, wireId: wire.id, setupAt: new Date().toISOString() });
  console.log(JSON.stringify({ step: 'setup', tenantId: tenant.id, cameraId: camera.id, streamPath }));
}

async function wait() {
  const s = readState();
  const timeoutMs = Number(process.env.E2E_TIMEOUT_MS || 120000);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const r = await fetch(`${API}/api/v1/alarms`, { headers: { authorization: `Bearer ${s.token}` } });
    if (r.ok) {
      const { alarms } = await r.json();
      const hit = alarms.find((a) => a.title === 'E2E: person crossed the gate line');
      if (hit) {
        s.alarm = hit;
        s.alarmSeenAt = new Date().toISOString();
        writeState(s);
        console.log(JSON.stringify({ step: 'wait', alarmId: hit.id, afterMs: Date.now() - started }));
        return;
      }
    }
    await sleep(1000);
  }
  throw new Error(`No tripwire alarm within ${timeoutMs} ms`);
}

async function verify() {
  const s = readState();
  const alarm = await prisma.alarm.findUnique({ where: { id: s.alarm.id }, include: { canonicalEvent: true } });
  const incident = await prisma.incident.findFirst({ where: { cameraId: s.cameraId }, orderBy: { createdAt: 'asc' } });
  const detections = await prisma.detectionEvent.findMany({ where: { cameraId: s.cameraId }, orderBy: { timestamp: 'asc' } });
  const prov = alarm?.canonicalEvent?.provenanceJson ?? null;
  const frameTs = prov?.frameTimestampUtc ? Date.parse(prov.frameTimestampUtc) : NaN;
  const latencyFrameToAlarmMs = Number.isFinite(frameTs) ? alarm.triggeredAt.getTime() - frameTs : null;
  const modelAudit = await prisma.auditEvent.findMany({
    where: { tenantId: s.tenantId, resourceType: 'ModelManifest' }, orderBy: { sequenceNumber: 'asc' }, select: { action: true, metadataJson: true },
  });
  const segmentsDir = path.join(process.env.RECORDINGS_DIR || path.join(E2E_DIR, 'recordings'), s.streamPath);
  const segs = fs.existsSync(segmentsDir) ? fs.readdirSync(segmentsDir).filter((f) => f.endsWith('.mp4')) : [];

  const checks = {
    alarmRaised: !!alarm,
    alarmLinkedToCanonicalTripwireEvent: alarm?.canonicalEvent?.type === 'TRIPWIRE_CROSS',
    incidentCreated: !!incident,
    allDetectionsCarryProvenance: detections.length > 0 && detections.every((d) => d.provenanceJson && d.modelSha256),
    alarmCarriesModelProvenance: !!prov && /^[0-9a-f]{64}$/.test(prov.modelSha256),
    detectedClassesArePersonOnly: detections.every((d) => d.objectClass === 'person'),
    modelLifecycleAudited: modelAudit.some((e) => e.action === 'MODEL_LOADED'),
    recordingContinuedWhileWorkerKilled: Number(process.env.SEGMENTS_AFTER_KILL || 0) > Number(process.env.SEGMENTS_BEFORE_KILL || 0),
  };
  const report = {
    scenario: 'P2.9 SIMULATED-CAMERA person crossing a tripwire',
    simulated: 'SIMULATED-CAMERA: public-domain photo composited onto a plain background, looped through a second MediaMTX acting as the IP camera',
    at: new Date().toISOString(),
    model: prov ? { name: prov.modelName, version: prov.modelVersion, sha256: prov.modelSha256, runtime: prov.runtime, executionProvider: prov.executionProvider } : null,
    measured: {
      latencyFrameToAlarmMs,
      latencyBudgetMs: Number(process.env.E2E_LATENCY_BUDGET_MS || 5000),
      detectionsStored: detections.length,
      firstIncidentAt: incident?.createdAt ?? null,
      alarmTriggeredAt: alarm?.triggeredAt ?? null,
      segmentsBeforeWorkerKill: Number(process.env.SEGMENTS_BEFORE_KILL || 0),
      segmentsAfterWorkerKill: Number(process.env.SEGMENTS_AFTER_KILL || 0),
      segmentFilesAtEnd: segs.length,
    },
    audit: modelAudit.map((e) => e.action),
    checks,
  };
  report.checks.latencyWithinBudget = latencyFrameToAlarmMs !== null && latencyFrameToAlarmMs <= report.measured.latencyBudgetMs;
  const pass = Object.values(report.checks).every(Boolean);
  report.result = pass ? 'PASS' : 'FAIL';
  const out = process.env.E2E_REPORT || path.join(E2E_DIR, 'report.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (!pass) process.exitCode = 1;
}

async function cleanup() {
  const s = readState();
  await prisma.tenant.delete({ where: { id: s.tenantId } }).catch(() => undefined);
}

const step = process.argv[2];
const fn = { setup, wait, verify, cleanup }[step];
if (!fn) {
  console.error('usage: ai-tripwire-scenario.mjs setup|wait|verify|cleanup');
  process.exit(2);
}
fn()
  .catch((e) => {
    console.error(`[e2e ${step}] ${e.message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
