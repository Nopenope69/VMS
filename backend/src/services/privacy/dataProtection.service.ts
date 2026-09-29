/**
 * DPDP controls (P4.6).
 *  - Per-tenant switch for anything face-related, default OFF.
 *  - Purpose limitation: every plate or biometric query declares one allowed purpose (and a case
 *    reference where the purpose needs one); the query, its purpose and result size are audited.
 *  - Retention purge: plate reads and AI snapshot files older than the tenant's retention are
 *    deleted, except where an incident hold or a legal-hold manifest covers them.
 * No embeddings are produced or stored by VigilOne today; a feature that adds them must add its
 * purge target here. Object crops (ADR 0005) are purged by services/crops/cropPurge.service.ts,
 * which uses the same hold lookup (./holds) and fails closed if it cannot be read.
 */
import fs from 'fs';
import path from 'path';
import { NextFunction, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AuditChainService } from '../audit/auditChain.service';
import { MetricsService } from '../observability/metrics.service';
import { loadHoldChecker } from './holds';

export const DATA_PURPOSES = ['SECURITY_INCIDENT_INVESTIGATION', 'LAW_ENFORCEMENT_REQUEST', 'ACCESS_CONTROL', 'SAFETY_EMERGENCY', 'LEGAL_CLAIM', 'AUDIT_REVIEW'] as const;
export type DataPurpose = (typeof DATA_PURPOSES)[number];
/** Purposes that must name a case, request or claim reference. */
export const PURPOSES_NEEDING_REFERENCE: DataPurpose[] = ['LAW_ENFORCEMENT_REQUEST', 'LEGAL_CLAIM'];

export interface DataProtection {
  tenantId: string;
  faceProcessingEnabled: boolean;
  plateRetentionDays: number;
  detectionSnapshotRetentionDays: number;
  allowedPurposes: DataPurpose[];
  lastPurgeAt: Date | null;
  lastPurgeJson: unknown;
  persisted: boolean;
}

const DEFAULTS = { faceProcessingEnabled: false, plateRetentionDays: 30, detectionSnapshotRetentionDays: 30, allowedPurposes: [...DATA_PURPOSES] };

export const SettingsPatch = z
  .object({
    faceProcessingEnabled: z.boolean().optional(),
    /** Must be true to switch face processing on: the admin confirms a lawful basis exists. */
    acknowledgeBiometricProcessing: z.boolean().optional(),
    plateRetentionDays: z.number().int().min(1).max(3650).optional(),
    detectionSnapshotRetentionDays: z.number().int().min(1).max(3650).optional(),
    allowedPurposes: z.array(z.enum(DATA_PURPOSES)).min(1).optional(),
  })
  .strict();

export class DataProtectionError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(`${code}: ${message}`);
  }
}

const cache = new Map<string, { at: number; value: DataProtection }>();
const CACHE_MS = 10_000;

export async function getDataProtection(prisma: PrismaClient, tenantId: string): Promise<DataProtection> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const row = await prisma.dataProtectionSettings.findUnique({ where: { tenantId } });
  const value: DataProtection = row
    ? { ...row, allowedPurposes: row.allowedPurposes as DataPurpose[], persisted: true }
    : { tenantId, ...DEFAULTS, lastPurgeAt: null, lastPurgeJson: null, persisted: false };
  cache.set(tenantId, { at: Date.now(), value });
  return value;
}

export async function isFaceProcessingEnabled(prisma: PrismaClient, tenantId: string): Promise<boolean> {
  return (await getDataProtection(prisma, tenantId)).faceProcessingEnabled;
}

export async function updateDataProtection(prisma: PrismaClient, tenantId: string, userId: string, patch: z.infer<typeof SettingsPatch>) {
  const before = await getDataProtection(prisma, tenantId);
  if (patch.faceProcessingEnabled === true && !before.faceProcessingEnabled && patch.acknowledgeBiometricProcessing !== true) {
    throw new DataProtectionError('BIOMETRIC_ACKNOWLEDGEMENT_REQUIRED', 'switching face processing on requires acknowledgeBiometricProcessing: true', 400);
  }
  const { acknowledgeBiometricProcessing, ...data } = patch;
  const row = await prisma.dataProtectionSettings.upsert({
    where: { tenantId },
    create: { tenantId, ...DEFAULTS, ...data, updatedByUserId: userId },
    update: { ...data, updatedByUserId: userId },
  });
  cache.delete(tenantId);
  return { before, after: { ...row, persisted: true } };
}

declare module 'express-serve-static-core' {
  interface Request {
    dataAccess?: { category: 'PLATE' | 'BIOMETRIC'; purpose: DataPurpose; reference: string | null };
  }
}

/**
 * Express middleware: the request must declare a purpose (header X-VigilOne-Purpose or query
 * `purpose`) that the tenant allows, plus a reference (X-VigilOne-Purpose-Reference or
 * `purposeReference`) for purposes that need one.
 */
export function requirePurpose(prisma: PrismaClient, category: 'PLATE' | 'BIOMETRIC') {
  return async (req: Request, res: Response, next: NextFunction) => {
    const purpose = String(req.header('x-vigilone-purpose') || req.query.purpose || '').trim().toUpperCase();
    const reference = String(req.header('x-vigilone-purpose-reference') || req.query.purposeReference || '').trim() || null;
    if (!purpose) return res.status(400).json({ error: `a purpose is required for ${category.toLowerCase()} data (X-VigilOne-Purpose)`, code: 'PURPOSE_REQUIRED', purposes: DATA_PURPOSES });
    if (!(DATA_PURPOSES as readonly string[]).includes(purpose)) return res.status(400).json({ error: `unknown purpose '${purpose}'`, code: 'PURPOSE_UNKNOWN', purposes: DATA_PURPOSES });
    const s = await getDataProtection(prisma, req.user!.tenantId);
    if (!s.allowedPurposes.includes(purpose as DataPurpose)) return res.status(403).json({ error: `purpose ${purpose} is not permitted on this appliance`, code: 'PURPOSE_NOT_PERMITTED', allowed: s.allowedPurposes });
    if (PURPOSES_NEEDING_REFERENCE.includes(purpose as DataPurpose) && (!reference || reference.length > 200)) {
      return res.status(400).json({ error: `purpose ${purpose} needs a case/request reference (X-VigilOne-Purpose-Reference, max 200 chars)`, code: 'PURPOSE_REFERENCE_REQUIRED' });
    }
    req.dataAccess = { category, purpose: purpose as DataPurpose, reference };
    next();
  };
}

/** Audits a plate/biometric query with its declared purpose. Call before sending the result. */
export async function recordSensitiveQuery(prisma: PrismaClient, req: Request, action: string, details: Record<string, unknown>) {
  const a = req.dataAccess;
  if (!a) throw new Error('recordSensitiveQuery without requirePurpose');
  MetricsService.incCounter('vigilone_dpdp_sensitive_queries_total', 'Plate/biometric queries by category and purpose', { category: a.category, purpose: a.purpose });
  await AuditChainService.record(prisma, {
    tenantId: req.user!.tenantId,
    userId: req.user!.id,
    action,
    resourceType: a.category === 'PLATE' ? 'PlateData' : 'BiometricData',
    ipAddress: req.ip || '127.0.0.1',
    metadata: { category: a.category, purpose: a.purpose, purposeReference: a.reference, ...details },
  });
}

// ------------------------------------------------------------------ retention purge

export interface PurgeResult {
  tenantId: string;
  at: string;
  plateReadsDeleted: number;
  plateReadsHeld: number;
  plateSnapshotsDeleted: number;
  detectionSnapshotsDeleted: number;
  detectionSnapshotsHeld: number;
  snapshotFilesOutsideRoots: number;
  snapshotFilesMissing: number;
}

/** Snapshot files may be deleted only under these roots (never an arbitrary path from the DB). */
export function snapshotRoots(): string[] {
  return [process.env.RECORDINGS_DIR || '/recordings', process.env.SNAPSHOTS_DIR || '/recordings/snapshots'].map((p) => path.resolve(p) + path.sep);
}

function deleteSnapshot(file: string, r: PurgeResult): void {
  const abs = path.resolve(file);
  if (!snapshotRoots().some((root) => abs.startsWith(root))) {
    r.snapshotFilesOutsideRoots++;
    return;
  }
  if (!fs.existsSync(abs)) {
    r.snapshotFilesMissing++;
    return;
  }
  fs.rmSync(abs, { force: true });
}

export async function purgeTenant(prisma: PrismaClient, tenantId: string, now = new Date(), actorUserId: string | null = null): Promise<PurgeResult> {
  const s = await getDataProtection(prisma, tenantId);
  const r: PurgeResult = { tenantId, at: now.toISOString(), plateReadsDeleted: 0, plateReadsHeld: 0, plateSnapshotsDeleted: 0, detectionSnapshotsDeleted: 0, detectionSnapshotsHeld: 0, snapshotFilesOutsideRoots: 0, snapshotFilesMissing: 0 };

  const held = await loadHoldChecker(prisma, tenantId, now);

  const plateCutoff = new Date(now.getTime() - s.plateRetentionDays * 86_400_000);
  for (;;) {
    const batch = await prisma.vehicleObservation.findMany({
      where: { tenantId, lastSeenAt: { lt: plateCutoff } },
      select: { id: true, cameraId: true, firstSeenAt: true, lastSeenAt: true, bestSnapshotPath: true },
      take: 500,
      skip: r.plateReadsHeld,
      orderBy: { lastSeenAt: 'asc' },
    });
    if (batch.length === 0) break;
    const del: string[] = [];
    for (const o of batch) {
      if (held(o.cameraId, o.firstSeenAt, o.lastSeenAt)) {
        r.plateReadsHeld++;
        continue;
      }
      if (o.bestSnapshotPath) {
        deleteSnapshot(o.bestSnapshotPath, r);
        r.plateSnapshotsDeleted++;
      }
      del.push(o.id);
    }
    if (del.length) r.plateReadsDeleted += (await prisma.vehicleObservation.deleteMany({ where: { id: { in: del } } })).count;
    if (batch.length < 500) break;
  }

  const snapCutoff = new Date(now.getTime() - s.detectionSnapshotRetentionDays * 86_400_000);
  const dets = await prisma.detectionEvent.findMany({ where: { tenantId, snapshotPath: { not: null }, timestamp: { lt: snapCutoff } }, select: { id: true, cameraId: true, timestamp: true, snapshotPath: true } });
  const clear: string[] = [];
  for (const d of dets) {
    if (held(d.cameraId, d.timestamp, d.timestamp)) {
      r.detectionSnapshotsHeld++;
      continue;
    }
    deleteSnapshot(d.snapshotPath!, r);
    clear.push(d.id);
  }
  if (clear.length) r.detectionSnapshotsDeleted = (await prisma.detectionEvent.updateMany({ where: { id: { in: clear } }, data: { snapshotPath: null } })).count;

  await prisma.dataProtectionSettings.upsert({
    where: { tenantId },
    create: { tenantId, ...DEFAULTS, lastPurgeAt: now, lastPurgeJson: r as any },
    update: { lastPurgeAt: now, lastPurgeJson: r as any },
  });
  cache.delete(tenantId);
  for (const [kind, n] of [['plate_read', r.plateReadsDeleted], ['plate_snapshot', r.plateSnapshotsDeleted], ['detection_snapshot', r.detectionSnapshotsDeleted]] as const) {
    if (n) MetricsService.incCounter('vigilone_dpdp_purged_total', 'Personal data removed by the retention purge', { kind }, n);
  }
  await AuditChainService.record(prisma, { tenantId, userId: actorUserId ?? undefined, action: 'DPDP_RETENTION_PURGE', resourceType: 'DataProtection', ipAddress: '127.0.0.1', metadata: { ...r, plateRetentionDays: s.plateRetentionDays, detectionSnapshotRetentionDays: s.detectionSnapshotRetentionDays } } as any);
  return r;
}

/** Periodic purge for every tenant (started by server.ts outside tests). */
export class RetentionPurger {
  private timer: NodeJS.Timeout | null = null;
  constructor(private prisma: PrismaClient) {}

  start(intervalMs = 3_600_000) {
    if (this.timer) return;
    const run = async () => {
      const tenants = await this.prisma.tenant.findMany({ select: { id: true } });
      for (const t of tenants) {
        try {
          await purgeTenant(this.prisma, t.id);
        } catch (e: any) {
          MetricsService.incCounter('vigilone_dpdp_purge_failures_total', 'Retention purge failures', undefined);
          console.error(`[DPDP] retention purge failed for tenant ${t.id}: ${e.message}`);
        }
      }
    };
    this.timer = setInterval(() => void run(), intervalMs);
    void run();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
