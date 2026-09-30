#!/usr/bin/env node
/**
 * Phase 8 high-availability scenario with two real backend processes on one PostgreSQL database:
 *
 *   1. node A starts, then node B: A leads (runs background services), B follows; both serve the API.
 *   2. A is killed with SIGKILL (no chance to release): B takes over only after the lease expires.
 *   3. A is restarted (as a supervisor would): it comes back as a follower.
 *   4. B is stopped with SIGTERM (graceful): it releases the lease and A takes over at its next renewal.
 *
 * Run through scripts/e2e/ha-failover.sh (builds nothing: needs backend/dist and a migrated DATABASE_URL).
 * Loopback only: this does not test a network partition between nodes and the database.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.E2E_DIR || '/tmp/vigilone-ha-e2e';
const reportPath = process.argv[2] || path.join(dir, 'report.json');
const ttlMs = Number(process.env.VIGILONE_HA_LEASE_TTL_MS || 6000);
const renewMs = Math.floor(ttlMs / 3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(dir, { recursive: true });

const nodes = {};
function start(id, port) {
  const log = fs.openSync(path.join(dir, `${id}.log`), 'a');
  const p = spawn(process.execPath, ['dist/server.js'], {
    cwd: path.resolve('backend'),
    env: { ...process.env, NODE_ENV: 'development', PORT: String(port), VIGILONE_HA_NODE_ID: id, VIGILONE_HA_LEASE_TTL_MS: String(ttlMs) },
    stdio: ['ignore', log, log],
  });
  nodes[id] = { p, port, exited: null };
  p.on('exit', (code, sig) => (nodes[id].exited = { code, sig }));
  return p;
}
async function health(id) {
  try {
    const r = await fetch(`http://127.0.0.1:${nodes[id].port}/api/v1/health`, { signal: AbortSignal.timeout(2000) });
    const j = await r.json();
    return { status: r.status, role: j.cluster?.role ?? null };
  } catch {
    return { status: 0, role: null };
  }
}
async function waitFor(what, fn, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return Date.now() - t0;
    await sleep(100);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
}
const logOf = (id) => fs.readFileSync(path.join(dir, `${id}.log`), 'utf8');
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` (${JSON.stringify(detail)})` : ''}`);
}

try {
  start('node-a', 4101);
  await waitFor('node-a to lead', async () => (await health('node-a')).role === 'LEADER', 60000);
  start('node-b', 4102);
  await waitFor('node-b to answer', async () => (await health('node-b')).status === 200, 60000);
  await sleep(2 * renewMs + 500);
  const a1 = await health('node-a');
  const b1 = await health('node-b');
  check('A leads, B follows, both serve the API', a1.role === 'LEADER' && b1.role === 'FOLLOWER' && a1.status === 200 && b1.status === 200, { a: a1, b: b1 });
  check('background services started on A only', /node-a is now the leader/.test(logOf('node-a')) && !/is now the leader/.test(logOf('node-b')));

  nodes['node-a'].p.kill('SIGKILL');
  const killedAt = Date.now();
  const takeover = await waitFor('node-b to lead', async () => (await health('node-b')).role === 'LEADER', ttlMs * 3);
  // A's last renewal was up to renewMs before the kill; B polls every renewMs.
  check('B takes over only after the lease expires', takeover >= ttlMs - renewMs - 500 && takeover <= ttlMs + 2 * renewMs + 1500, { takeoverMs: takeover, ttlMs, renewMs });
  void killedAt;

  start('node-a', 4101);
  await waitFor('restarted node-a to answer', async () => (await health('node-a')).status === 200, 60000);
  await sleep(2 * renewMs + 500);
  const a2 = await health('node-a');
  const b2 = await health('node-b');
  check('restarted A comes back as a follower', a2.role === 'FOLLOWER' && b2.role === 'LEADER', { a: a2, b: b2 });

  nodes['node-b'].p.kill('SIGTERM');
  const handover = await waitFor('node-a to lead after B stops', async () => (await health('node-a')).role === 'LEADER', ttlMs * 2);
  check('graceful stop of B hands over within one renewal (no lease wait)', handover <= renewMs + 1500, { handoverMs: handover, renewMs });
  await waitFor('node-b to exit', async () => nodes['node-b'].exited !== null, 10000);
  check('B exited cleanly', nodes['node-b'].exited.code === 0, nodes['node-b'].exited);
} catch (e) {
  check('scenario ran to the end', false, e.message);
} finally {
  for (const n of Object.values(nodes)) if (n.exited === null) n.p.kill('SIGKILL');
}

const ok = checks.every((c) => c.ok);
fs.writeFileSync(reportPath, JSON.stringify({ scenario: 'ha-failover', ttlMs, renewMs, ok, checks }, null, 2));
console.log(ok ? 'HA FAILOVER SCENARIO: PASS' : 'HA FAILOVER SCENARIO: FAIL');
process.exit(ok ? 0 : 1);
