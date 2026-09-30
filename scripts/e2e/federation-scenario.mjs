// Phase 6 end-to-end multi-site scenario: two backend PROCESSES with two DATABASES (headquarters and one
// site), joined by a TCP relay this script can cut. Site activity is SIMULATED (rows written into the site's
// database, as the orchestrator would). Steps:
//   A. pair the site with a one-time token over the relay; sync events, alarms and audit entries;
//   B. cut the link, keep producing and changing alarms, confirm nothing arrives and the site backs off;
//   C. restore the link, confirm everything arrives in order with alarm changes applied;
//   D. kill -9 the site mid-sync and restart it; confirm it resumes with no gap and no duplicate;
//   E. recompute the whole chain headquarters stored.
// Writes a JSON report. Usage: node scripts/e2e/federation-scenario.mjs <report.json>
import fs from 'fs';
import net from 'net';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(path.resolve(process.cwd(), 'backend/package.json'));
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');
const { chainProblem, GENESIS_HASH } = require(path.resolve('backend/dist/services/federation/recordLog.js'));
const { AuditChainService } = require(path.resolve('backend/dist/services/audit/auditChain.service.js'));

const E2E = process.env.E2E_DIR;
const REPORT = process.argv[2] || path.join(E2E, 'report.json');
const site = new PrismaClient({ datasources: { db: { url: process.env.SITE_DATABASE_URL } } });
const hq = new PrismaClient({ datasources: { db: { url: process.env.HQ_DATABASE_URL } } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { scenario: 'federation-two-process', note: 'SIMULATED site activity; loopback relay, not a WAN', steps: [] };
const step = (name, data) => {
  report.steps.push({ name, at: new Date().toISOString(), ...data });
  console.log(JSON.stringify({ step: name, ...data }));
};

// --- relay -------------------------------------------------------------------------------------------------
let relayMode = 'up';
const relayLog = [];
const relaySockets = new Set();
const relay = net.createServer((c) => {
  relayLog.push([new Date().toISOString().slice(11, 23), relayMode]);
  if (relayMode === 'down') return c.destroy();
  relaySockets.add(c);
  const u = net.connect(4100, '127.0.0.1');
  c.on('data', (d) => u.write(d));
  u.on('data', (d) => c.write(d));
  for (const [a, b] of [[c, u], [u, c]]) {
    a.on('error', () => b.destroy());
    a.on('close', () => { b.destroy(); relaySockets.delete(c); });
  }
});
const setRelay = (m) => {
  relayMode = m;
  for (const s of relaySockets) s.destroy();
  relaySockets.clear();
};

// --- processes ---------------------------------------------------------------------------------------------
const procs = {};
function startBackend(name, port, dbUrl, extra = {}) {
  const log = fs.openSync(path.join(E2E, `${name}.log`), 'a');
  const p = spawn('node', ['dist/server.js'], {
    cwd: 'backend',
    env: { ...process.env, ...extra, DATABASE_URL: dbUrl, PORT: String(port), NODE_ENV: 'development', VIGILONE_FEATURE_FEDERATION: 'true' },
    stdio: ['ignore', log, log],
  });
  procs[name] = p;
  return p;
}
async function waitHttp(url, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${url}`);
}
async function until(what, fn, ms = 90000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(1000);
  }
  throw new Error(`timeout: ${what}`);
}

async function tenantAndAdmin(db, label) {
  const sfx = crypto.randomBytes(3).toString('hex');
  const tenant = await db.tenant.create({ data: { name: `${label} ${sfx}`, slug: `fed-${label.toLowerCase()}-${sfx}` } });
  const siteRow = await db.site.create({ data: { tenantId: tenant.id, name: `${label} site`, timezone: 'Asia/Kolkata' } });
  const camera = await db.camera.create({ data: { tenantId: tenant.id, siteId: siteRow.id, name: `${label} gate (SIMULATED)`, streamPath: `fed_${sfx}`, ipAddress: '127.0.0.1', mainRtspUri: 'rtsp://127.0.0.1:8554/none' } });
  const user = await db.user.create({ data: { tenantId: tenant.id, email: `fed-${sfx}@test.invalid`, passwordHash: 'x', name: `${label} admin`, role: 'TENANT_ADMIN' } });
  const token = jwt.sign({ id: user.id, email: user.email, role: 'TENANT_ADMIN', tenantId: tenant.id, type: 'ACCESS' }, process.env.JWT_SECRET, { expiresIn: '60m' });
  return { tenantId: tenant.id, cameraId: camera.id, token };
}

let n = 0;
async function alarms(s, count) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const at = new Date(Date.now() - 500);
    const ev = await site.canonicalEvent.create({ data: { id: crypto.randomUUID(), tenantId: s.tenantId, cameraId: s.cameraId, type: 'AI_OBJECT_DETECTED', source: 'VISION_AI', severity: 'WARNING', timestampUtc: at, correlationId: crypto.randomUUID(), payloadJson: { payload: { objectClass: 'person', n } } } });
    const a = await site.alarm.create({ data: { tenantId: s.tenantId, cameraId: s.cameraId, canonicalEventId: ev.id, title: `Person at gate #${n++}`, severity: 'CRITICAL', triggeredAt: at } });
    await AuditChainService.record(site, { tenantId: s.tenantId, userId: null, action: 'ALARM_RAISED', resourceType: 'Alarm', resourceId: a.id, ipAddress: '127.0.0.1', metadata: { e2e: true } });
    ids.push(a.id);
    mine.add(a.id);
  }
  return ids;
}
// Only the alarms this scenario created: the site backend also raises its own system alarms, which sync too.
const mine = new Set();
const hqAlarms = async (h) => (await (await fetch('http://127.0.0.1:4100/api/v1/federation/alarms', { headers: h })).json()).alarms.filter((a) => mine.has(a.alarmId));
const siteStatus = async (sh) => (await fetch('http://127.0.0.1:4000/api/v1/federation/upstream/status', { headers: sh })).json();

async function main() {
  fs.mkdirSync(E2E, { recursive: true });
  await new Promise((r) => relay.listen(4200, '127.0.0.1', r));
  // This database is the site under test: start with no uplink from an earlier run.
  await site.federationUplinkState.deleteMany({});
  await site.federationOutbox.deleteMany({});
  fs.rmSync(path.join(E2E, 'site-node.pem'), { force: true });
  const H = await tenantAndAdmin(hq, 'HQ');
  const S = await tenantAndAdmin(site, 'Site');
  const hh = { authorization: `Bearer ${H.token}`, 'content-type': 'application/json' };
  const sh = { authorization: `Bearer ${S.token}`, 'content-type': 'application/json' };
  const siteEnv = { FEDERATION_ALLOW_INSECURE_HQ: 'true', FEDERATION_NODE_KEY_PATH: path.join(E2E, 'site-node.pem'), FEDERATION_SYNC_INTERVAL_MS: '1000', RECORDINGS_DIR: E2E };
  startBackend('hq', 4100, process.env.HQ_DATABASE_URL);
  startBackend('site', 4000, process.env.SITE_DATABASE_URL, siteEnv);
  await waitHttp('http://127.0.0.1:4100/api/v1/health');
  await waitHttp('http://127.0.0.1:4000/api/v1/health');

  // A. pair and sync
  const tok = await (await fetch('http://127.0.0.1:4100/api/v1/federation/pairing-token', { method: 'POST', headers: hh, body: JSON.stringify({ ttlSeconds: 600 }) })).json();
  const reg = await fetch('http://127.0.0.1:4000/api/v1/federation/upstream/register', { method: 'POST', headers: sh, body: JSON.stringify({ hqUrl: 'http://127.0.0.1:4200', pairingToken: tok.pairingToken, name: 'Warehouse gate (SIMULATED)' }) });
  if (reg.status !== 201) throw new Error(`pairing failed: HTTP ${reg.status} ${await reg.text()}`);
  const first = await alarms(S, 5);
  const tA = Date.now();
  await until('5 alarms at HQ', async () => (await hqAlarms(hh)).length >= 5);
  step('A_paired_and_synced', { alarms: 5, secondsToArrive: Math.round((Date.now() - tA) / 1000), note: 'includes the 10 s settle delay' });

  // B. link down
  setRelay('down');
  const second = await alarms(S, 5);
  await site.alarm.updateMany({ where: { id: { in: first.slice(0, 2) } }, data: { state: 'ACKNOWLEDGED', acknowledgedAt: new Date() } });
  await sleep(15000);
  const during = await hqAlarms(hh);
  const st = await siteStatus(sh);
  if (during.length !== 5) throw new Error(`HQ changed while the link was down: ${during.length} alarms: ${JSON.stringify(during.map((a) => [a.title, a.seq, a.updatedAt]))} relayLog=${JSON.stringify(relayLog)}`);
  if (!(st.pendingRecords > 0 && st.consecutiveFailures > 0)) throw new Error(`site did not queue/back off: ${JSON.stringify(st)}`);
  step('B_link_down', { hqAlarms: during.length, sitePending: st.pendingRecords, consecutiveFailures: st.consecutiveFailures, lastError: st.lastError });

  // C. link restored
  setRelay('up');
  const tC = Date.now();
  await until('10 alarms and 2 acknowledgements at HQ', async () => {
    const a = await hqAlarms(hh);
    return a.length === 10 && a.filter((x) => first.slice(0, 2).includes(x.alarmId)).every((x) => x.state === 'ACKNOWLEDGED');
  }, 400000); // the backoff can be up to a few intervals
  step('C_link_restored', { hqAlarms: 10, acknowledgedPropagated: 2, secondsToCatchUp: Math.round((Date.now() - tC) / 1000), idsMatch: second.length === 5 });

  // D. crash the site mid-sync and restart it
  await alarms(S, 20);
  await sleep(11000); // let the outbox fill and sending start
  procs.site.kill('SIGKILL');
  await new Promise((r) => procs.site.once('exit', r));
  await alarms(S, 5);
  startBackend('site', 4000, process.env.SITE_DATABASE_URL, siteEnv);
  await waitHttp('http://127.0.0.1:4000/api/v1/health');
  await until('35 alarms at HQ after the crash', async () => (await hqAlarms(hh)).length === 35, 400000);
  const allAtHq = (await (await fetch('http://127.0.0.1:4100/api/v1/federation/alarms', { headers: hh })).json()).alarms.length;
  step('D_site_crash_resumed', { hqAlarms: 35, alsoSiteSystemAlarms: allAtHq - 35 });

  // E. verify the chain headquarters stored, from its own database
  const node = await hq.federatedNode.findFirstOrThrow({ where: { tenantId: H.tenantId } });
  const recs = await hq.federatedRecord.findMany({ where: { nodeId: node.id }, orderBy: { seq: 'asc' } });
  const wire = recs.map((r) => ({ seq: r.seq.toString(), kind: r.kind, sourceId: r.sourceId, occurredAt: r.occurredAt.toISOString(), data: r.dataJson, prevHash: r.prevHash, hash: r.hash }));
  const problem = chainProblem(wire, 0n, GENESIS_HASH);
  const contiguous = recs.every((r, i) => r.seq === BigInt(i + 1));
  const outbox = await site.federationOutbox.count();
  const byKind = recs.reduce((m, r) => ((m[r.kind] = (m[r.kind] || 0) + 1), m), {});
  // None of the site's events may appear in headquarters' own event table (they live in FederatedRecord only).
  const siteEventIds = recs.filter((r) => r.kind === 'EVENT').map((r) => r.sourceId);
  const leakedIntoHqTables = await hq.canonicalEvent.count({ where: { id: { in: siteEventIds } } });
  step('E_chain_verified', { records: recs.length, byKind, chainProblem: problem, contiguousFrom1: contiguous, siteOutboxRows: outbox, lastHashMatchesNode: recs.at(-1).hash === node.lastLogHash, siteEventsInHqOwnTables: leakedIntoHqTables });
  if (problem || !contiguous || recs.at(-1).hash !== node.lastLogHash || leakedIntoHqTables !== 0) throw new Error('chain verification failed');
  report.result = 'PASS';
}

main()
  .catch((e) => {
    report.result = 'FAIL';
    report.error = e.message;
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
    for (const p of Object.values(procs)) p.kill('SIGKILL');
    relay.close();
    await site.$disconnect();
    await hq.$disconnect();
  });
