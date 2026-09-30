/**
 * Phase 6 multi-site sync end to end on the real database and the real Express app, with a TCP relay between
 * the site and headquarters that can be cut. Headquarters and the site are two tenants of one test database:
 * the site's uplink reads only its own tenant, headquarters stores only FederatedRecord rows, so they touch no
 * common rows. The link is SIMULATED (loopback relay), not a WAN.
 */
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera, createUserWithToken, startApp } from './helpers/realDb';
import { FederationUplink, fillOutbox, registerWithHeadquarters, SETTLE_MS, uplinkStatus } from '../services/federation/uplink';
import { chainProblem, GENESIS_HASH, recordHash } from '../services/federation/recordLog';
import { AuditChainService } from '../services/audit/auditChain.service';

jest.setTimeout(180000);
const prisma = new PrismaClient();
const FLAG = 'VIGILONE_FEATURE_FEDERATION';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fed-'));
const saved = { ...process.env };
const siteEnv = { ...process.env, FEDERATION_NODE_KEY_PATH: path.join(tmp, 'site', 'node.pem'), FEDERATION_ALLOW_INSECURE_HQ: 'true', RECORDINGS_DIR: tmp };
const later = () => new Date(Date.now() + SETTLE_MS + 1000); // "now" for the filler, so fresh rows count as settled

let app: { url: string; close: () => Promise<void> };
let hqTenant = '';
let siteTenant = '';
let siteCamera = '';
let hqAdmin = '';
let siteAdmin = '';
let hqAdminId = '';

/** A loopback relay the test can cut: 'up', 'down' (connections refused), or 'dropReplies' (requests reach
 *  headquarters, the replies never reach the site: headquarters stores the batch, the site thinks it failed). */
class Relay {
  private _mode: 'up' | 'down' | 'dropReplies' = 'up';
  private sockets = new Set<net.Socket>();
  get mode() {
    return this._mode;
  }
  /** Changing the mode cuts every open connection, as a real link failure does. */
  set mode(m: 'up' | 'down' | 'dropReplies') {
    this._mode = m;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
  }
  private server = net.createServer((client) => {
    if (this._mode === 'down') return client.destroy();
    this.sockets.add(client);
    client.on('close', () => this.sockets.delete(client));
    const u = new URL(this.target);
    const upstream = net.connect(Number(u.port), u.hostname);
    client.on('data', (d) => upstream.write(d));
    upstream.on('data', (d) => {
      if (this._mode === 'dropReplies') {
        client.destroy();
        upstream.destroy();
      } else client.write(d);
    });
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  });
  url = '';
  constructor(private readonly target: string) {}
  async listen() {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as net.AddressInfo).port}`;
  }
  close() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }
}
let relay: Relay;

async function hq(token: string, method: string, p: string, body?: unknown) {
  const r = await fetch(`${app.url}/api/v1/federation${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
}

async function siteActivity(n: number) {
  const created: string[] = [];
  for (let i = 0; i < n; i++) {
    const at = new Date(Date.now() - 1000);
    const ev = await prisma.canonicalEvent.create({ data: { id: crypto.randomUUID(), tenantId: siteTenant, cameraId: siteCamera, type: 'AI_OBJECT_DETECTED', source: 'VISION_AI', severity: 'WARNING', timestampUtc: at, correlationId: crypto.randomUUID(), payloadJson: { payload: { objectClass: 'person', i } } as any } });
    const alarm = await prisma.alarm.create({ data: { tenantId: siteTenant, cameraId: siteCamera, canonicalEventId: ev.id, title: `Person at gate ${i}`, severity: 'CRITICAL', triggeredAt: at } });
    await AuditChainService.record(prisma, { tenantId: siteTenant, userId: null as any, action: 'ALARM_RAISED_TEST', resourceType: 'Alarm', resourceId: alarm.id, ipAddress: '127.0.0.1', metadata: { i } });
    created.push(alarm.id);
  }
  return created;
}

beforeAll(async () => {
  process.env[FLAG] = 'true';
  hqTenant = (await createTenantWithCamera(prisma, 'fed-hq')).tenantId;
  ({ tenantId: siteTenant, cameraId: siteCamera } = await createTenantWithCamera(prisma, 'fed-site'));
  const a = await createUserWithToken(prisma, hqTenant, 'TENANT_ADMIN');
  hqAdmin = a.token;
  hqAdminId = a.userId;
  siteAdmin = (await createUserWithToken(prisma, siteTenant, 'TENANT_ADMIN')).token;
  await prisma.federationUplinkState.deleteMany({});
  await prisma.federationOutbox.deleteMany({});
  app = await startApp();
  relay = new Relay(app.url);
  await relay.listen();
});
afterAll(async () => {
  await relay.close();
  await app.close();
  await prisma.federationUplinkState.deleteMany({});
  await prisma.federationOutbox.deleteMany({});
  await prisma.tenant.deleteMany({ where: { id: { in: [hqTenant, siteTenant] } } });
  await prisma.$disconnect();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.env = saved;
});

describe('record chain', () => {
  it('detects a changed, dropped, reordered or re-chained record', () => {
    const mk = (seq: number, prev: string, data: unknown) => {
      const r = { seq: String(seq), kind: 'EVENT' as const, sourceId: `s${seq}`, occurredAt: '2026-09-30T10:00:00.000Z', data, prevHash: prev, hash: '' };
      r.hash = recordHash(prev, r);
      return r;
    };
    const a = mk(1, GENESIS_HASH, { x: 1, y: [1, { b: 2, a: 1 }] });
    const b = mk(2, a.hash, { z: 'ü' });
    const c = mk(3, b.hash, null);
    expect(chainProblem([a, b, c], 0n, GENESIS_HASH)).toBeNull();
    // key order does not matter; content does
    expect(recordHash(GENESIS_HASH, { ...a, data: { y: [1, { a: 1, b: 2 }], x: 1 } })).toBe(a.hash);
    expect(chainProblem([a, { ...b, data: { z: 'u' } }, c], 0n, GENESIS_HASH)).toMatch(/hash does not match/);
    expect(chainProblem([a, c], 0n, GENESIS_HASH)).toMatch(/prevHash does not continue/);
    expect(chainProblem([b, a], 0n, GENESIS_HASH)).toMatch(/does not follow|prevHash/);
    expect(chainProblem([b, c], 1n, 'f'.repeat(64))).toMatch(/prevHash does not continue/);
  });
});

describe('pairing', () => {
  it('pairing tokens are stored hashed, single use, and expire; registration refuses bad input', async () => {
    const t = await hq(hqAdmin, 'POST', '/pairing-token', { ttlSeconds: 120 });
    expect(t.status).toBe(201);
    const row = await prisma.federationPairingToken.findFirstOrThrow({ where: { tenantId: hqTenant }, orderBy: { createdAt: 'desc' } });
    expect(row.tokenSha256).toBe(crypto.createHash('sha256').update(t.json.pairingToken).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(t.json.pairingToken);
    expect((await hq(hqAdmin, 'POST', '/pairing-token', { ttlSeconds: 5 })).status).toBe(400);
    // an insecure headquarters URL is refused unless explicitly allowed
    await expect(registerWithHeadquarters(prisma, { hqUrl: relay.url, pairingToken: t.json.pairingToken, localTenantId: siteTenant }, { ...siteEnv, FEDERATION_ALLOW_INSECURE_HQ: 'false' })).rejects.toThrow(/must be https/);
    await expect(registerWithHeadquarters(prisma, { hqUrl: relay.url, pairingToken: 'vigilone_pair_wrong', localTenantId: siteTenant }, siteEnv)).rejects.toThrow(/refused the registration/);
    expect(await prisma.federationUplinkState.count()).toBe(0);
  });

  it('a site pairs with a one-time token; the token cannot be used twice; the key file is private', async () => {
    const t = await hq(hqAdmin, 'POST', '/pairing-token', { ttlSeconds: 600 });
    const out = await registerWithHeadquarters(prisma, { hqUrl: relay.url, pairingToken: t.json.pairingToken, name: 'Site A', localTenantId: siteTenant }, siteEnv);
    expect(out.status).toBe('REGISTERED');
    const node = await prisma.federatedNode.findUniqueOrThrow({ where: { nodeUuid: out.nodeUuid } });
    expect(node).toMatchObject({ tenantId: hqTenant, name: 'Site A', state: 'ONLINE', softwareVersion: '1.0.0' });
    expect(fs.statSync(siteEnv.FEDERATION_NODE_KEY_PATH).mode & 0o777).toBe(0o600);
    const again = await fetch(`${relay.url}/api/v1/federation/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pairingToken: t.json.pairingToken, nodeUuid: crypto.randomUUID(), publicKeyEd25519: node.publicKeyEd25519, softwareVersion: '1', schemaVersion: 'x', capabilities: {} }) });
    expect(again.status).toBe(400);
    expect(((await again.json()) as any).code).toBe('PAIRING_TOKEN_USED');
  });

  it('another tenant cannot take over the node id with its own pairing token', async () => {
    const s = await prisma.federationUplinkState.findUniqueOrThrow({ where: { id: 1 } });
    const otherAdmin = (await createUserWithToken(prisma, siteTenant, 'TENANT_ADMIN')).token; // siteTenant as "another HQ tenant"
    const t = await hq(otherAdmin, 'POST', '/pairing-token', { ttlSeconds: 600 });
    const key = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const r = await fetch(`${app.url}/api/v1/federation/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pairingToken: t.json.pairingToken, nodeUuid: s.nodeUuid, publicKeyEd25519: key, softwareVersion: '1', schemaVersion: 'x', capabilities: {} }) });
    expect(r.status).toBe(409);
    const node = await prisma.federatedNode.findUniqueOrThrow({ where: { nodeUuid: s.nodeUuid } });
    expect(node.tenantId).toBe(hqTenant);
  });
});

describe('sync', () => {
  let uplink: FederationUplink;
  beforeAll(() => {
    uplink = new FederationUplink(prisma, siteEnv, 1000);
  });

  it('events, alarms and audit entries reach headquarters in order, chained, and nothing of the site touches HQ tables', async () => {
    const hqEventsBefore = await prisma.canonicalEvent.count({ where: { tenantId: hqTenant } });
    const alarmIds = await siteActivity(3);
    const r = await uplink.runOnce(later());
    expect(r.error).toBeNull();
    expect(r.appended).toBeGreaterThanOrEqual(9);
    const node = await prisma.federatedNode.findFirstOrThrow({ where: { tenantId: hqTenant } });
    const recs = await prisma.federatedRecord.findMany({ where: { nodeId: node.id }, orderBy: { seq: 'asc' } });
    expect(recs.length).toBe(r.appended);
    expect(node.syncCursorLog.toString()).toBe(r.acknowledgedSeq);
    expect(node.lastLogHash).toBe(recs[recs.length - 1].hash);
    const kinds = new Set(recs.map((x) => x.kind));
    expect([...kinds].sort()).toEqual(['ALARM', 'AUDIT', 'EVENT']);
    for (const id of alarmIds) expect(recs.some((x) => x.kind === 'ALARM' && x.sourceId === id)).toBe(true);
    // stored exactly as the site chained it
    const asWire = recs.map((x) => ({ seq: x.seq.toString(), kind: x.kind as any, sourceId: x.sourceId, occurredAt: x.occurredAt.toISOString(), data: x.dataJson, prevHash: x.prevHash, hash: x.hash }));
    expect(chainProblem(asWire, 0n, GENESIS_HASH)).toBeNull();
    expect(await prisma.canonicalEvent.count({ where: { tenantId: hqTenant } })).toBe(hqEventsBefore);
    // audit records carry no metadata or IP address
    const audit = recs.find((x) => x.kind === 'AUDIT')!.dataJson as any;
    expect(audit).not.toHaveProperty('metadataJson');
    expect(audit).not.toHaveProperty('ipAddress');
    expect(audit.eventHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('alarm changes follow; headquarters shows the current state of every site alarm', async () => {
    const [id] = await siteActivity(1);
    await uplink.runOnce(later());
    await prisma.alarm.update({ where: { id }, data: { state: 'ACKNOWLEDGED', acknowledgedAt: new Date() } });
    await uplink.runOnce(later());
    const view = await hq(hqAdmin, 'GET', '/alarms');
    expect(view.status).toBe(200);
    const mine = view.json.alarms.find((a: any) => a.alarmId === id);
    expect(mine).toMatchObject({ state: 'ACKNOWLEDGED', nodeName: 'Site A', title: 'Person at gate 0' });
    const active = await hq(hqAdmin, 'GET', '/alarms?state=ACTIVE');
    expect(active.json.alarms.some((a: any) => a.alarmId === id)).toBe(false);
    // other tenants see none of it
    expect((await hq(siteAdmin, 'GET', '/alarms')).json.alarms).toEqual([]);
  });

  it('a cut link loses nothing: the outbox fills, the uplink backs off, and catches up when the link returns', async () => {
    relay.mode = 'down';
    await siteActivity(2);
    const r1 = await uplink.runOnce(later());
    expect(r1.error).toMatch(/fetch failed|ECONN|socket|other side closed/i);
    const st = await prisma.federationUplinkState.findUniqueOrThrow({ where: { id: 1 } });
    expect(st.consecutiveFailures).toBe(1);
    const r2 = await uplink.runOnce(later());
    expect(r2.skippedForBackoff).toBe(true);
    const status = await uplinkStatus(prisma, siteTenant);
    expect(status.pendingRecords).toBeGreaterThanOrEqual(6);
    relay.mode = 'up';
    uplink.resetBackoff();
    const r3 = await uplink.runOnce(later());
    expect(r3.error).toBeNull();
    const after = await uplinkStatus(prisma, siteTenant);
    expect(after).toMatchObject({ pendingRecords: 0, consecutiveFailures: 0, lastError: null });
    const node = await prisma.federatedNode.findFirstOrThrow({ where: { tenantId: hqTenant } });
    expect(node.syncCursorLog.toString()).toBe(after.lastRecordSeq);
  });

  it('a reply lost after headquarters stored the batch: the resend is recognised, nothing is stored twice', async () => {
    await siteActivity(2);
    relay.mode = 'dropReplies';
    const r1 = await uplink.runOnce(later());
    expect(r1.error).not.toBeNull();
    const node = await prisma.federatedNode.findFirstOrThrow({ where: { tenantId: hqTenant } });
    const before = await prisma.federatedRecord.count({ where: { nodeId: node.id } });
    relay.mode = 'up';
    uplink.resetBackoff();
    const r2 = await uplink.runOnce(later());
    expect(r2.error).toBeNull();
    expect(await prisma.federatedRecord.count({ where: { nodeId: node.id } })).toBe(before);
    const seqs = (await prisma.federatedRecord.findMany({ where: { nodeId: node.id }, select: { seq: true }, orderBy: { seq: 'asc' } })).map((x) => Number(x.seq));
    expect(seqs).toEqual(seqs.map((_, i) => i + 1)); // 1..n with no gap and no repeat
    expect((await uplinkStatus(prisma, siteTenant)).pendingRecords).toBe(0);
  });

  it('headquarters refuses a batch with an altered record, an unsigned or replayed request, and retired streams', async () => {
    const s = await prisma.federationUplinkState.findUniqueOrThrow({ where: { id: 1 } });
    const node = await prisma.federatedNode.findUniqueOrThrow({ where: { nodeUuid: s.nodeUuid } });
    await siteActivity(1);
    await fillOutbox(prisma, later());
    const rows = await prisma.federationOutbox.findMany({ where: { seq: { gt: s.ackedSeq } }, orderBy: { seq: 'asc' } });
    const key = crypto.createPrivateKey(fs.readFileSync(siteEnv.FEDERATION_NODE_KEY_PATH));
    const send = async (body: any, opts: { sign?: boolean; nonce?: string } = {}) => {
      const raw = Buffer.from(JSON.stringify(body));
      const p = `/api/v1/federation/nodes/${s.nodeUuid}/sync-batch`;
      const ts = String(Date.now());
      const nonce = opts.nonce ?? crypto.randomBytes(8).toString('hex');
      const { buildCanonicalRequest } = require('../middleware/federationAuth');
      const canonical = buildCanonicalRequest({ version: 'v1', nodeUuid: s.nodeUuid, timestamp: ts, nonce, method: 'POST', path: p, bodyHashHex: crypto.createHash('sha256').update(raw).digest('hex') });
      const sig = opts.sign === false ? crypto.sign(null, Buffer.from('other'), key).toString('base64') : crypto.sign(null, Buffer.from(canonical), key).toString('base64');
      const r = await fetch(`${app.url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-node-signature': sig, 'x-node-timestamp': ts, 'x-node-nonce': nonce }, body: raw });
      return { status: r.status, json: (await r.json()) as any };
    };
    const records = rows.map((r) => ({ seq: r.seq.toString(), kind: r.kind, sourceId: r.sourceId, occurredAt: r.occurredAt.toISOString(), data: r.dataJson, prevHash: r.prevHash, hash: r.hash }));
    const base = { streamType: 'LOG', afterSeq: node.syncCursorLog.toString(), afterHash: node.lastLogHash };
    const tampered = await send({ ...base, records: [{ ...records[0], data: { ...(records[0].data as any), severity: 'INFO' } }, ...records.slice(1)] });
    expect([tampered.status, tampered.json.code]).toEqual([400, 'CHAIN_BROKEN']);
    expect((await send({ ...base, records }, { sign: false })).status).toBe(401);
    const ok = await send({ ...base, records }, { nonce: 'fixed-nonce-1' });
    expect(ok.json.status).toBe('ACCEPTED');
    expect((await send({ ...base, records }, { nonce: 'fixed-nonce-1' })).status).toBe(401); // replay
    expect((await send({ streamType: 'EVENT', fromSeq: '1', toSeq: '1', items: [] })).json.code).toBe('STREAM_RETIRED');
    const gap = await send({ streamType: 'LOG', afterSeq: '999999', afterHash: 'a'.repeat(64), records: [{ ...records[0], seq: '1000000' }] });
    expect(gap.json.status).toBe('OUT_OF_SEQUENCE');
    await prisma.federationUplinkState.update({ where: { id: 1 }, data: { ackedSeq: BigInt(ok.json.acknowledgedCursor) } });
  });

  it('a deprovisioned node is refused and cannot be re-paired under the same id', async () => {
    const s = await prisma.federationUplinkState.findUniqueOrThrow({ where: { id: 1 } });
    await siteActivity(1);
    expect((await hq(hqAdmin, 'POST', `/nodes/${s.nodeUuid}/deprovision`)).status).toBe(200);
    uplink.resetBackoff();
    const r = await uplink.runOnce(later());
    expect(r.error).toMatch(/HTTP 401/);
    const t = await hq(hqAdmin, 'POST', '/pairing-token', { ttlSeconds: 600 });
    await expect(registerWithHeadquarters(prisma, { hqUrl: relay.url, pairingToken: t.json.pairingToken, localTenantId: siteTenant }, siteEnv)).rejects.toThrow(/deprovisioned/);
    void hqAdminId;
  });
});

describe('startup', () => {
  it('a bad interval refuses to start; not paired or flag off starts nothing', async () => {
    const { startFederationUplink } = require('../services/federation/uplink');
    expect(await startFederationUplink(prisma, {})).toBeNull();
    await expect(startFederationUplink(prisma, { [FLAG]: 'true', FEDERATION_SYNC_INTERVAL_MS: '10' })).rejects.toThrow(/at least 1000/);
  });
});
