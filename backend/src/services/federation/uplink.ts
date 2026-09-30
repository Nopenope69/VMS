/**
 * Site side of multi-site sync (Phase 6): this appliance's uplink to its headquarters.
 *
 *  - Identity: an Ed25519 key created on first pairing at FEDERATION_NODE_KEY_PATH (0600, never overwritten)
 *    and registered with the headquarters using a one-time pairing token.
 *  - Outbox: new canonical events, alarm changes and audit entries of one local tenant are appended, in order,
 *    to FederationOutbox as a hash-chained log (recordLog.ts). Rows are taken only once they are
 *    SETTLE_MS old, so a slow transaction that commits late with an earlier timestamp is not skipped.
 *  - Sender: sends unacknowledged rows in signed batches (the canonical request of middleware/federationAuth)
 *    and moves its acknowledged cursor only to what headquarters says it holds, after checking that
 *    headquarters' hash for that seq equals ours. Network failures back off exponentially (up to 5 min); the
 *    outbox keeps everything until it is acknowledged, so a link outage loses nothing.
 *
 * Audit records carry the action, resource, user id, time and the entry's chain hashes, not its metadata or
 * IP address (data minimisation; the full entry stays on the site's own tamper-evident chain).
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Prisma, PrismaClient } from '@prisma/client';
import { FeatureFlag, isFeatureEnabled } from '../../config/featureFlags';
import { buildCanonicalRequest } from '../../middleware/federationAuth';
import { GENESIS_HASH, LogRecord, recordHash, RecordKind } from './recordLog';

export const SETTLE_MS = 10_000;
const FILL_LIMIT = 500;
const SEND_LIMIT = 200;
const MAX_BATCHES_PER_RUN = 20;
const MAX_BACKOFF_MS = 300_000;

export class UplinkError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
  }
}

export function nodeKeyPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.FEDERATION_NODE_KEY_PATH || path.join(env.VIGILONE_STATE_DIR || '/var/lib/vigilone', 'federation', 'node-ed25519.pem');
}

/** Loads the node key, creating it (0600, directory 0700) only if it does not exist yet. */
export function loadOrCreateNodeKey(file = nodeKeyPath()): { privateKey: crypto.KeyObject; publicKeyDerB64: string } {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(file));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new UplinkError('NODE_KEY_INVALID', `${file} is not an Ed25519 private key`);
  const publicKeyDerB64 = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
  return { privateKey, publicKeyDerB64 };
}

function checkHqUrl(raw: unknown, env: NodeJS.ProcessEnv): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new UplinkError('HQ_URL_REQUIRED', 'hqUrl is required');
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new UplinkError('HQ_URL_INVALID', `hqUrl is not a URL: "${raw}"`);
  }
  const insecureOk = env.FEDERATION_ALLOW_INSECURE_HQ === 'true';
  if (u.protocol !== 'https:' && !(insecureOk && u.protocol === 'http:')) {
    throw new UplinkError('HQ_URL_INSECURE', 'hqUrl must be https (set FEDERATION_ALLOW_INSECURE_HQ=true only for a lab)');
  }
  return u.toString().replace(/\/+$/, '');
}

async function siteFacts(prisma: PrismaClient, tenantId: string, env: NodeJS.ProcessEnv) {
  const cameras = await prisma.camera.count({ where: { tenantId } });
  const migration = await prisma.$queryRaw<Array<{ migration_name: string }>>`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name DESC LIMIT 1`;
  let localStorageGb = 0;
  try {
    const st = fs.statfsSync(env.RECORDINGS_DIR || '/recordings');
    localStorageGb = Math.round((st.blocks * st.bsize) / 1e9);
  } catch {
    localStorageGb = 0; // not mounted here; reported as 0, not guessed
  }
  return {
    softwareVersion: require('../../../package.json').version as string,
    schemaVersion: migration[0]?.migration_name ?? 'unknown',
    capabilities: { anprEnabled: isFeatureEnabled(FeatureFlag.ANPR, env), ptzSupport: false, maxCameras: cameras, localStorageGb, hardwarePlatform: `${os.platform()}-${os.arch()}` },
  };
}

/** Pairs this appliance with a headquarters and stores the uplink state. One local tenant per appliance. */
export async function registerWithHeadquarters(
  prisma: PrismaClient,
  args: { hqUrl: unknown; pairingToken: unknown; name?: unknown; localTenantId: string },
  env: NodeJS.ProcessEnv = process.env
) {
  const hqUrl = checkHqUrl(args.hqUrl, env);
  if (typeof args.pairingToken !== 'string' || !args.pairingToken) throw new UplinkError('PAIRING_TOKEN_REQUIRED', 'pairingToken is required');
  const existing = await prisma.federationUplinkState.findUnique({ where: { id: 1 } });
  if (existing && existing.localTenantId !== args.localTenantId) throw new UplinkError('UPLINK_OTHER_TENANT', 'this appliance already syncs another tenant', 409);
  const { publicKeyDerB64 } = loadOrCreateNodeKey(nodeKeyPath(env));
  const nodeUuid = existing?.nodeUuid ?? crypto.randomUUID();
  const facts = await siteFacts(prisma, args.localTenantId, env);
  let r: Response;
  try {
    r = await fetch(`${hqUrl}/api/v1/federation/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingToken: args.pairingToken, nodeUuid, name: typeof args.name === 'string' && args.name ? args.name : os.hostname(), publicKeyEd25519: publicKeyDerB64, ...facts }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e: any) {
    throw new UplinkError('HQ_UNREACHABLE', `headquarters at ${hqUrl} is unreachable: ${e.message}`, 502);
  }
  const body: any = await r.json().catch(() => ({}));
  if (r.status !== 201 || body.nodeUuid !== nodeUuid) throw new UplinkError('HQ_REFUSED', `headquarters refused the registration (HTTP ${r.status}): ${body.error ?? 'no detail'}`, 502);
  await prisma.federationUplinkState.upsert({
    where: { id: 1 },
    create: { id: 1, nodeUuid, hqUrl, hqTenantId: body.tenantId, localTenantId: args.localTenantId },
    update: { hqUrl, hqTenantId: body.tenantId, lastError: null, consecutiveFailures: 0 },
  });
  return { status: 'REGISTERED', nodeUuid, hqUrl, certificateFingerprint: body.certificateFingerprint };
}

export async function uplinkStatus(prisma: PrismaClient, tenantId: string) {
  const s = await prisma.federationUplinkState.findUnique({ where: { id: 1 } });
  if (!s || s.localTenantId !== tenantId) return { configured: false };
  const last = await prisma.federationOutbox.findFirst({ orderBy: { seq: 'desc' }, select: { seq: true } });
  const pending = await prisma.federationOutbox.count({ where: { seq: { gt: s.ackedSeq } } });
  return {
    configured: true,
    nodeUuid: s.nodeUuid,
    hqUrl: s.hqUrl,
    lastRecordSeq: (last?.seq ?? 0n).toString(),
    acknowledgedSeq: s.ackedSeq.toString(),
    pendingRecords: pending,
    lastSyncAt: s.lastSyncAt,
    lastError: s.lastError,
    consecutiveFailures: s.consecutiveFailures,
  };
}

type Pending = { kind: RecordKind; sourceId: string; occurredAt: Date; data: Record<string, unknown>; order: number };

/**
 * Appends new local changes to the outbox as chained records. One writer at a time (advisory lock); the
 * watermarks move in the same transaction as the rows, so a crash repeats nothing and skips nothing.
 */
export async function fillOutbox(prisma: PrismaClient, now = new Date()): Promise<number> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('vigilone_federation_outbox'))`;
      const s = await tx.federationUplinkState.findUnique({ where: { id: 1 } });
      if (!s) return 0;
      const settled = new Date(now.getTime() - SETTLE_MS);
      const t = s.localTenantId;
      const after = (col: string, at: Date, id: string) =>
        Prisma.sql`("${Prisma.raw(col)}" > ${at} OR ("${Prisma.raw(col)}" = ${at} AND "id" > ${id}))`;

      const events = await tx.$queryRaw<Array<{ id: string; type: string; source: string; severity: string; cameraId: string | null; timestampUtc: Date; correlationId: string | null; payloadJson: unknown; provenanceJson: unknown; createdAt: Date }>>(
        Prisma.sql`SELECT "id", "type", "source", "severity"::text AS "severity", "cameraId", "timestampUtc", "correlationId", "payloadJson", "provenanceJson", "createdAt"
                   FROM "CanonicalEvent" WHERE "tenantId" = ${t} AND "createdAt" <= ${settled} AND ${after('createdAt', s.eventWatermark, s.eventWatermarkId)}
                   ORDER BY "createdAt", "id" LIMIT ${FILL_LIMIT}`
      );
      const alarms = await tx.$queryRaw<Array<{ id: string; title: string; severity: string; state: string; cameraId: string | null; canonicalEventId: string | null; triggeredAt: Date; acknowledgedAt: Date | null; resolvedAt: Date | null; resolutionNotes: string | null; updatedAt: Date }>>(
        Prisma.sql`SELECT "id", "title", "severity"::text AS "severity", "state"::text AS "state", "cameraId", "canonicalEventId", "triggeredAt", "acknowledgedAt", "resolvedAt", "resolutionNotes", "updatedAt"
                   FROM "Alarm" WHERE "tenantId" = ${t} AND "updatedAt" <= ${settled} AND ${after('updatedAt', s.alarmWatermark, s.alarmWatermarkId)}
                   ORDER BY "updatedAt", "id" LIMIT ${FILL_LIMIT}`
      );
      const auditsAll = await tx.$queryRaw<Array<{ id: string; sequenceNumber: bigint; action: string; resourceType: string; resourceId: string | null; userId: string | null; timestampUtc: Date; prevHash: string; eventHash: string }>>(
        Prisma.sql`SELECT "id", "sequenceNumber", "action", "resourceType", "resourceId", "userId", "timestampUtc", "prevHash", "eventHash"
                   FROM "AuditEvent" WHERE "tenantId" = ${t} AND "sequenceNumber" > ${s.auditWatermark}
                   ORDER BY "sequenceNumber" LIMIT ${FILL_LIMIT}`
      );
      // The audit watermark is a sequence number, so take only the settled prefix: stopping at the first entry
      // that is too recent guarantees none is skipped.
      const firstUnsettled = auditsAll.findIndex((a) => a.timestampUtc > settled);
      const audits = firstUnsettled === -1 ? auditsAll : auditsAll.slice(0, firstUnsettled);

      const pending: Pending[] = [
        ...events.map((e) => ({ kind: 'EVENT' as const, sourceId: e.id, occurredAt: e.timestampUtc, order: e.createdAt.getTime(), data: { type: e.type, source: e.source, severity: e.severity, cameraId: e.cameraId, correlationId: e.correlationId, payload: e.payloadJson, provenance: e.provenanceJson } })),
        ...alarms.map((a) => ({ kind: 'ALARM' as const, sourceId: a.id, occurredAt: a.updatedAt, order: a.updatedAt.getTime(), data: { title: a.title, severity: a.severity, state: a.state, cameraId: a.cameraId, canonicalEventId: a.canonicalEventId, triggeredAt: a.triggeredAt.toISOString(), acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null, resolvedAt: a.resolvedAt?.toISOString() ?? null, resolutionNotes: a.resolutionNotes } })),
        ...audits.map((a) => ({ kind: 'AUDIT' as const, sourceId: a.id, occurredAt: a.timestampUtc, order: a.timestampUtc.getTime(), data: { sequenceNumber: a.sequenceNumber.toString(), action: a.action, resourceType: a.resourceType, resourceId: a.resourceId, userId: a.userId, prevHash: a.prevHash, eventHash: a.eventHash } })),
      ].sort((x, y) => x.order - y.order); // interleave by time so an alarm follows the event that raised it
      if (pending.length === 0) return 0;

      const last = await tx.federationOutbox.findFirst({ orderBy: { seq: 'desc' }, select: { seq: true, hash: true } });
      let seq = last?.seq ?? 0n;
      let prevHash = last?.hash ?? GENESIS_HASH;
      const rows = pending.map((p) => {
        seq += 1n;
        const rec = { seq: seq.toString(), kind: p.kind, sourceId: p.sourceId, occurredAt: p.occurredAt.toISOString(), data: JSON.parse(JSON.stringify(p.data)) };
        const hash = recordHash(prevHash, rec);
        const row = { seq, kind: p.kind, sourceId: p.sourceId, occurredAt: p.occurredAt, dataJson: rec.data as Prisma.InputJsonValue, prevHash, hash };
        prevHash = hash;
        return row;
      });
      await tx.federationOutbox.createMany({ data: rows });
      const le = events[events.length - 1];
      const la = alarms[alarms.length - 1];
      const lu = audits[audits.length - 1];
      await tx.federationUplinkState.update({
        where: { id: 1 },
        data: {
          ...(le ? { eventWatermark: le.createdAt, eventWatermarkId: le.id } : {}),
          ...(la ? { alarmWatermark: la.updatedAt, alarmWatermarkId: la.id } : {}),
          ...(lu ? { auditWatermark: lu.sequenceNumber } : {}),
        },
      });
      return rows.length;
    },
    { timeout: 30000 }
  );
}

export interface UplinkRunResult {
  appended: number;
  sent: number;
  acknowledgedSeq: string;
  skippedForBackoff: boolean;
  error: string | null;
}

export class FederationUplink {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private nextAttemptAt = 0;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly intervalMs = 10_000,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private async signed(s: { nodeUuid: string; hqUrl: string }, key: crypto.KeyObject, method: string, pathName: string, body: unknown): Promise<{ status: number; json: any }> {
    const raw = Buffer.from(JSON.stringify(body));
    const timestamp = String(Date.now());
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = buildCanonicalRequest({ version: 'v1', nodeUuid: s.nodeUuid, timestamp, nonce, method, path: pathName, bodyHashHex: crypto.createHash('sha256').update(raw).digest('hex') });
    const signature = crypto.sign(null, Buffer.from(canonical), key).toString('base64');
    const r = await this.fetchImpl(`${s.hqUrl}${pathName}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-node-signature': signature, 'x-node-timestamp': timestamp, 'x-node-nonce': nonce, 'x-node-version': 'v1' },
      body: raw,
      signal: AbortSignal.timeout(30_000),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  }

  /** One round: append, send until caught up (bounded), heartbeat, prune. Never throws. */
  async runOnce(now = new Date()): Promise<UplinkRunResult> {
    const result: UplinkRunResult = { appended: 0, sent: 0, acknowledgedSeq: '0', skippedForBackoff: false, error: null };
    if (this.running) return result;
    this.running = true;
    try {
      const s = await this.prisma.federationUplinkState.findUnique({ where: { id: 1 } });
      if (!s) {
        result.error = 'not paired with a headquarters';
        return result;
      }
      result.acknowledgedSeq = s.ackedSeq.toString();
      // The outbox fills even while the link is down, so nothing is lost and the order is fixed at the site.
      result.appended = await fillOutbox(this.prisma, now);
      if (Date.now() < this.nextAttemptAt) {
        result.skippedForBackoff = true;
        return result;
      }
      const { privateKey } = loadOrCreateNodeKey(nodeKeyPath(this.env));
      const syncPath = `/api/v1/federation/nodes/${s.nodeUuid}/sync-batch`;
      let acked = s.ackedSeq;
      try {
        for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
          const rows = await this.prisma.federationOutbox.findMany({ where: { seq: { gt: acked } }, orderBy: { seq: 'asc' }, take: SEND_LIMIT });
          if (rows.length === 0) break;
          const afterHash = acked === 0n ? GENESIS_HASH : (await this.prisma.federationOutbox.findUnique({ where: { seq: acked }, select: { hash: true } }))?.hash;
          if (!afterHash) throw new UplinkError('OUTBOX_PRUNED', `the outbox no longer holds seq ${acked}`);
          const records: LogRecord[] = rows.map((r) => ({ seq: r.seq.toString(), kind: r.kind as RecordKind, sourceId: r.sourceId, occurredAt: r.occurredAt.toISOString(), data: r.dataJson, prevHash: r.prevHash, hash: r.hash }));
          const res = await this.signed(s, privateKey, 'POST', syncPath, { streamType: 'LOG', afterSeq: acked.toString(), afterHash, records });
          if (res.status !== 200) throw new UplinkError('HQ_REFUSED', `headquarters answered HTTP ${res.status}: ${res.json?.error ?? 'no detail'}`);
          const hqSeq = BigInt(res.json.acknowledgedCursor);
          // Move only to what headquarters holds, and only if its hash for that seq is ours.
          if (hqSeq > 0n) {
            const ours = await this.prisma.federationOutbox.findUnique({ where: { seq: hqSeq }, select: { hash: true } });
            if (!ours) throw new UplinkError('HQ_AHEAD', `headquarters holds seq ${hqSeq}, which this site never wrote (was the site database restored?)`);
            if (ours.hash !== res.json.acknowledgedHash) throw new UplinkError('HQ_CHAIN_DIFFERS', `headquarters' record ${hqSeq} differs from this site's`);
          }
          if (res.json.status === 'ACCEPTED') result.sent += res.json.accepted;
          else if (hqSeq === acked) throw new UplinkError('HQ_SEQUENCE', `headquarters refused the batch after seq ${acked}: ${res.json.error ?? res.json.status}`);
          // Otherwise (a duplicate after a lost acknowledgement, or headquarters behind us) resend from its cursor.
          acked = hqSeq;
          await this.prisma.federationUplinkState.update({ where: { id: 1 }, data: { ackedSeq: acked } });
        }
        const queueDepth = await this.prisma.federationOutbox.count({ where: { seq: { gt: acked } } });
        const activeCameras = await this.prisma.camera.count({ where: { tenantId: s.localTenantId } });
        let diskUsagePercent = 0;
        try {
          const st = fs.statfsSync(this.env.RECORDINGS_DIR || '/recordings');
          diskUsagePercent = Math.round((1 - st.bavail / st.blocks) * 100);
        } catch {
          diskUsagePercent = 0;
        }
        await this.signed(s, privateKey, 'POST', `/api/v1/federation/nodes/${s.nodeUuid}/heartbeat`, { activeCameras, diskUsagePercent, queueDepth });
        const retentionDays = Number(this.env.FEDERATION_OUTBOX_RETENTION_DAYS || 7);
        await this.prisma.federationOutbox.deleteMany({ where: { seq: { lt: acked }, createdAt: { lt: new Date(now.getTime() - retentionDays * 86_400_000) } } });
        await this.prisma.federationUplinkState.update({ where: { id: 1 }, data: { lastSyncAt: new Date(), lastError: null, consecutiveFailures: 0 } });
        this.nextAttemptAt = 0;
        result.acknowledgedSeq = acked.toString();
      } catch (e: any) {
        const failures = s.consecutiveFailures + 1;
        const backoff = Math.min(MAX_BACKOFF_MS, this.intervalMs * 2 ** Math.min(failures - 1, 10));
        this.nextAttemptAt = Date.now() + backoff;
        result.error = e.message;
        result.acknowledgedSeq = acked.toString();
        await this.prisma.federationUplinkState.update({ where: { id: 1 }, data: { lastError: String(e.message).slice(0, 500), consecutiveFailures: failures } });
        console.error(`[FederationUplink] sync failed (${failures} in a row), next try in ${Math.round(backoff / 1000)} s: ${e.message}`);
      }
      return result;
    } finally {
      this.running = false;
    }
  }

  /** Test hook: allow an attempt now regardless of backoff. */
  resetBackoff() {
    this.nextAttemptAt = 0;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce().catch((e) => console.error(`[FederationUplink] ${e.message}`)), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Starts the uplink when federation is on and this appliance is paired. A bad interval stops startup. */
export async function startFederationUplink(prisma: PrismaClient, env: NodeJS.ProcessEnv = process.env): Promise<FederationUplink | null> {
  if (!isFeatureEnabled(FeatureFlag.FEDERATION, env)) return null;
  const raw = env.FEDERATION_SYNC_INTERVAL_MS;
  const interval = raw === undefined || raw.trim() === '' ? 10_000 : Number(raw);
  if (!Number.isInteger(interval) || interval < 1000) throw new Error(`FEDERATION_SYNC_INTERVAL_MS must be a whole number of at least 1000 milliseconds, got "${raw}"`);
  const paired = await prisma.federationUplinkState.findUnique({ where: { id: 1 }, select: { id: true } });
  if (!paired) return null;
  const u = new FederationUplink(prisma, env, interval);
  u.start();
  return u;
}
