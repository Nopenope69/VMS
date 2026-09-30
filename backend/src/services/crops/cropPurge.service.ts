/**
 * Scheduled, hold-aware retention purge for object crops (Phase 5, P5.1), started by server.ts only
 * when VIGILONE_FEATURE_OBJECT_CROPS is on.
 *
 * Fail closed: the hold lookup (incident holds and legal-hold manifests) is loaded before anything is
 * deleted. If it cannot be read the whole tenant run is aborted with nothing deleted, the failure is
 * logged, counted and audited (CROP_PURGE_FAILED), and the next run tries again. A crop is deleted only
 * when it is expired and provably not covered by a hold; a crop whose file cannot be removed keeps its
 * row. Rows are removed only after their files are gone (or proven missing), so no file is ever
 * left unlisted.
 */
import { PrismaClient } from '@prisma/client';
import { AuditChainService } from '../audit/auditChain.service';
import { MetricsService } from '../observability/metrics.service';
import { loadHoldChecker } from '../privacy/holds';
import { cropsRoot } from './cropCapture.service';
import { CropStore } from './cropStore';

const BATCH = 500;

export interface CropPurgeResult {
  tenantId: string;
  at: string;
  deleted: number;
  heldSkipped: number;
  missingRowsRemoved: number;
  failed: number;
}

/** Purges one tenant. Throws (deleting nothing) if the hold lookup cannot be read. */
export async function purgeTenantCrops(prisma: PrismaClient, tenantId: string, store: CropStore, now: Date = new Date()): Promise<CropPurgeResult> {
  const isHeld = await loadHoldChecker(prisma, tenantId, now); // throws => nothing below runs
  const r: CropPurgeResult = { tenantId, at: now.toISOString(), deleted: 0, heldSkipped: 0, missingRowsRemoved: 0, failed: 0 };
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.objectCrop.findMany({
      where: { tenantId, expiresAt: { lte: now } },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    const byId = new Map(rows.map((row) => [row.id, row]));
    const result = store.purge(
      rows.map((row) => ({ cropId: row.id, tenantId, relativePath: row.relativePath, expiresAt: row.expiresAt })),
      (c) => {
        const row = byId.get(c.cropId)!;
        return isHeld(row.cameraId, row.capturedAt, row.capturedAt);
      }
    );
    r.heldSkipped += result.heldSkipped.length;
    r.failed += result.failed.length;
    for (const f of result.failed) console.error(`[Crops] purge could not remove crop ${f.cropId}; its row is kept: ${f.error}`);
    const removable = [...result.deleted, ...result.missing];
    if (removable.length) await prisma.objectCrop.deleteMany({ where: { id: { in: removable } } });
    r.deleted += result.deleted.length;
    r.missingRowsRemoved += result.missing.length;
    if (rows.length < BATCH) break;
  }
  if (r.deleted) MetricsService.incCounter('vigilone_crops_purged_total', 'Object crops removed by the retention purge', undefined, r.deleted);
  if (r.deleted || r.heldSkipped || r.missingRowsRemoved || r.failed) {
    await AuditChainService.record(prisma, { tenantId, userId: null, action: 'CROP_RETENTION_PURGE', resourceType: 'ObjectCrop', ipAddress: '127.0.0.1', metadata: { ...r, actor: 'SYSTEM' } });
  }
  return r;
}

/** Periodic purge for every tenant that has expired crops (started by server.ts outside tests). */
export class CropPurger {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly storeFn: (now: Date) => CropStore = (now) => new CropStore(cropsRoot(), undefined, undefined, () => now)
  ) {}

  /** One pass over all tenants. Never throws; every tenant failure is logged, counted and audited. */
  async runOnce(now: Date = new Date()): Promise<CropPurgeResult[]> {
    if (this.running) return [];
    this.running = true;
    const results: CropPurgeResult[] = [];
    try {
      const tenants = await this.prisma.objectCrop.groupBy({ by: ['tenantId'], where: { expiresAt: { lte: now } } });
      for (const t of tenants) {
        try {
          results.push(await purgeTenantCrops(this.prisma, t.tenantId, this.storeFn(now), now));
        } catch (e: any) {
          MetricsService.incCounter('vigilone_crop_purge_failures_total', 'Crop retention purge runs that failed and deleted nothing');
          console.error(`[Crops] retention purge failed for tenant ${t.tenantId} (nothing further was deleted): ${e?.message || e}`);
          try {
            await AuditChainService.record(this.prisma, { tenantId: t.tenantId, userId: null, action: 'CROP_PURGE_FAILED', resourceType: 'ObjectCrop', ipAddress: '127.0.0.1', metadata: { error: String(e?.message || e).slice(0, 1000), actor: 'SYSTEM' } });
          } catch (auditErr: any) {
            console.error(`[Crops] could not audit the purge failure for tenant ${t.tenantId}: ${auditErr?.message || auditErr}`);
          }
        }
      }
    } catch (e: any) {
      MetricsService.incCounter('vigilone_crop_purge_failures_total', 'Crop retention purge runs that failed and deleted nothing');
      console.error(`[Crops] retention purge could not list tenants: ${e?.message || e}`);
    } finally {
      this.running = false;
    }
    return results;
  }

  start(intervalMs = 3_600_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), intervalMs);
    void this.runOnce();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
