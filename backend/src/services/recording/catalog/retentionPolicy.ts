import { PrismaClient, EventSeverity, AlarmState, RetentionPriority } from '@prisma/client';
import { SegmentRepository } from './segmentRepository';
import { EvidencePinRegistry } from './evidencePinRegistry';
import { StorageAdapter } from './storageAdapter';
import { setting } from '../../../config/settings';
import { MetricsService } from '../../observability/metrics.service';

export interface RetentionPolicyConfig {
  maxRetentionDays?: number;
  targetQuotaBytes?: bigint;
}

export interface CameraQuotaConfig {
  cameraId: string;
  cameraName: string;
  continuousDays: number;
  motionDays: number;
  maxStorageBytes?: bigint | null;
  priority: RetentionPriority;
}

export interface PruneReport {
  purgedCount: number;
  reclaimedBytes: bigint;
  pinnedSkippedCount: number;
  evaluatedSegmentsCount: number;
  exhaustionCondition: boolean;
  /** Segments deleted that were not confirmed in the archive store, for tenants with an enabled archive. */
  unarchivedPurgedCount: number;
  unarchivedPurgedBytes: bigint;
}

/** Archive state of a batch of segments. `enabled` is false for tenants without an archive. */
interface ArchiveState {
  enabled: boolean;
  /** File paths whose archive job is COMPLETED (verified in the store). */
  archived: Set<string>;
}

interface UnarchivedDrops {
  count: number;
  bytes: bigint;
  oldest: Date | null;
  newest: Date | null;
}

const UNARCHIVED_METRIC = 'vigilone_retention_unarchived_segments_deleted_total';
const UNARCHIVED_HELP = 'Segments deleted by retention before they were confirmed in the archive store';
const UNARCHIVED_ALARM_TITLE = 'STORAGE_UNARCHIVED_FOOTAGE_DROPPED';

const noDrops = (): UnarchivedDrops => ({ count: 0, bytes: 0n, oldest: null, newest: null });

export class RetentionPolicyEngine {
  private prisma: PrismaClient;
  private segmentRepo: SegmentRepository;
  private pinRegistry: EvidencePinRegistry;
  private storageAdapter: StorageAdapter;

  constructor(
    prisma: PrismaClient,
    segmentRepo: SegmentRepository,
    pinRegistry: EvidencePinRegistry,
    storageAdapter: StorageAdapter
  ) {
    this.prisma = prisma;
    this.segmentRepo = segmentRepo;
    this.pinRegistry = pinRegistry;
    this.storageAdapter = storageAdapter;
  }

  /**
   * Which of these segments are verified in the archive store. A tenant without an enabled archive is reported as
   * disabled and nothing changes for it. If the archive state cannot be read for an archive-enabled tenant, every
   * segment is treated as unarchived: quota is still enforced, and any deletion is reported as an unarchived drop.
   */
  private async archiveState(tenantId: string, segments: Array<{ filePath: string }>): Promise<ArchiveState> {
    const none: ArchiveState = { enabled: false, archived: new Set() };
    const prisma: any = this.prisma;
    if (typeof prisma.objectStorageConfig?.findFirst !== 'function' || typeof prisma.archiveJob?.findMany !== 'function') {
      return none;
    }
    try {
      const cfg = await prisma.objectStorageConfig.findFirst({ where: { tenantId, enabled: true }, select: { id: true } });
      if (!cfg) return none;
    } catch (err: any) {
      console.error('[RetentionPolicy] Could not read the archive configuration; retention order is unchanged:', err.message);
      return none;
    }
    if (segments.length === 0) return { enabled: true, archived: new Set() };
    try {
      const jobs = await prisma.archiveJob.findMany({
        where: { tenantId, status: 'COMPLETED', segmentPath: { in: segments.map((s) => s.filePath) } },
        select: { segmentPath: true },
      });
      return { enabled: true, archived: new Set<string>(jobs.map((j: { segmentPath: string }) => j.segmentPath)) };
    } catch (err: any) {
      console.error('[RetentionPolicy] Could not read archive jobs; treating all segments as unarchived:', err.message);
      return { enabled: true, archived: new Set() };
    }
  }

  /** Under quota pressure: archived segments first, then the rest. Each group keeps its given (oldest first) order. */
  private orderForPressure<T extends { filePath: string }>(segments: T[], state: ArchiveState): T[] {
    if (!state.enabled) return segments;
    return [...segments.filter((s) => state.archived.has(s.filePath)), ...segments.filter((s) => !state.archived.has(s.filePath))];
  }

  /** Records a deletion of a segment that was not confirmed in the archive store (no-op without an archive). */
  private noteDeleted(
    state: ArchiveState,
    drops: UnarchivedDrops,
    seg: { filePath: string; sizeBytes: bigint; startTime?: Date; endTime?: Date }
  ): void {
    if (!state.enabled || state.archived.has(seg.filePath)) return;
    drops.count++;
    drops.bytes += seg.sizeBytes;
    const start = seg.startTime ? new Date(seg.startTime) : null;
    const end = seg.endTime ? new Date(seg.endTime) : null;
    if (start && (!drops.oldest || start < drops.oldest)) drops.oldest = start;
    if (end && (!drops.newest || end > drops.newest)) drops.newest = end;
  }

  private async reportUnarchivedDrops(tenantId: string, drops: UnarchivedDrops, cameraName?: string): Promise<void> {
    if (drops.count === 0) return;
    MetricsService.incCounter(UNARCHIVED_METRIC, UNARCHIVED_HELP, undefined, drops.count);
    try {
      const prisma: any = this.prisma;
      if (typeof prisma.alarm?.findFirst === 'function') {
        const open = await prisma.alarm.findFirst({
          where: { tenantId, title: UNARCHIVED_ALARM_TITLE, state: AlarmState.ACTIVE },
          select: { id: true },
        });
        if (open) return; // one open alarm is enough; the counter above still records every drop
      }
      const target = cameraName ? `camera "${cameraName}"` : 'the tenant';
      await this.prisma.alarm.create({
        data: {
          tenantId,
          severity: EventSeverity.CRITICAL,
          state: AlarmState.ACTIVE,
          title: UNARCHIVED_ALARM_TITLE,
          description: `Retention deleted ${drops.count} segment(s) (${drops.bytes.toString()} bytes) of ${target} that were not confirmed in the archive store. Check archive connectivity and capacity.`,
          metadataJson: {
            type: UNARCHIVED_ALARM_TITLE,
            cameraName,
            segments: drops.count,
            bytes: drops.bytes.toString(),
            oldestStart: drops.oldest?.toISOString() ?? null,
            newestEnd: drops.newest?.toISOString() ?? null,
          },
        },
      });
    } catch (err: any) {
      console.error('[RetentionPolicy] Failed to raise unarchived-footage alarm:', err.message);
    }
  }

  /**
   * Atomically verifies that a segment has NO active unexpired EvidencePins,
   * deletes the database row, and unlinks the file from disk only if database delete succeeds.
   * Concurrency Safe: Eliminates the race condition where an investigator pins a segment
   * concurrently while the retention worker is evaluating candidates.
   */
  async atomicDeleteSegmentIfUnpinned(segmentId: string, filePath: string): Promise<boolean> {
    // Check if running in a full Prisma client with raw query support
    // Fail-closed invariant (C-012): database failure MUST NOT fall back to unverified deletion
    if (typeof (this.prisma as any).$executeRaw === 'function') {
      const deletedRows: number = await (this.prisma as any).$executeRaw`
        DELETE FROM "RecordingSegment"
        WHERE id = ${segmentId}
          AND NOT EXISTS (
            SELECT 1 FROM "EvidencePin"
            WHERE "segmentId" = ${segmentId}
              AND "releasedAt" IS NULL
              AND "expiresAt" > NOW()
          )
      `;

      if (deletedRows > 0) {
        await this.storageAdapter.deleteFile(filePath);
        return true;
      }
      return false;
    }

    // Non-atomic path for in-memory test doubles only. A real Prisma client always has $executeRaw;
    // anything else outside NODE_ENV=test is a wiring error and must not delete footage.
    if (setting('NODE_ENV') !== 'test') {
      throw new Error(
        'RETENTION_ATOMIC_DELETE_UNAVAILABLE: Prisma client without $executeRaw; refusing non-atomic segment deletion'
      );
    }
    const isPinned = await this.pinRegistry.isPinned(segmentId);
    if (isPinned) {
      return false;
    }

    await this.storageAdapter.deleteFile(filePath);
    await this.segmentRepo.deleteSegment(segmentId);
    return true;
  }

  /**
   * Prunes segments exceeding per-camera retention policies and per-camera storage quotas.
   * Priority ladder: Low-priority cameras pruned first, then Normal, then High.
   * STRICT INVARIANT: Actively pinned segments are NEVER purged.
   */
  async pruneCameraQuotasAndRetention(tenantId: string, now = new Date()): Promise<PruneReport> {
    let purgedCount = 0;
    let reclaimedBytes = 0n;
    let pinnedSkippedCount = 0;
    let evaluatedSegmentsCount = 0;
    let exhaustionCondition = false;
    let unarchivedPurgedCount = 0;
    let unarchivedPurgedBytes = 0n;

    // 1. Fetch all cameras with their retention priority and policies
    let cameras: any[] = [];
    if (typeof this.prisma.camera?.findMany === 'function') {
      try {
        cameras = await this.prisma.camera.findMany({
          where: { tenantId },
          include: {
            retentionPolicy: true,
          },
        });
      } catch {}
    }

    // Default tenant policy
    let defaultTenantPolicy: any = null;
    if (typeof this.prisma.retentionPolicy?.findFirst === 'function') {
      defaultTenantPolicy = await this.prisma.retentionPolicy.findFirst({
        where: { tenantId, cameraId: null },
      });
    }

    const defaultContinuousDays = defaultTenantPolicy?.continuousDays ?? 30;
    const defaultMaxGb = defaultTenantPolicy?.maxStorageGigabytes ?? null;

    if (cameras.length === 0) {
      let segments: any[] = [];
      if (typeof this.prisma.recordingSegment?.findMany === 'function') {
        segments = await this.prisma.recordingSegment.findMany({
          where: { tenantId },
        });
      }

      evaluatedSegmentsCount += segments.length;
      const cutoffDate = new Date(now.getTime() - defaultContinuousDays * 24 * 60 * 60 * 1000);
      const tenantState = await this.archiveState(tenantId, segments);
      const tenantDrops = noDrops();

      for (const seg of segments) {
        if (seg.evidencePins && seg.evidencePins.length > 0) {
          pinnedSkippedCount++;
          continue;
        }

        const segEndTime = seg.endTime instanceof Date ? seg.endTime.getTime() : new Date(seg.endTime).getTime();
        if (segEndTime < cutoffDate.getTime()) {
          const deleted = await this.atomicDeleteSegmentIfUnpinned(seg.id, seg.filePath);
          if (deleted) {
            purgedCount++;
            reclaimedBytes += seg.sizeBytes;
            this.noteDeleted(tenantState, tenantDrops, seg);
          } else {
            pinnedSkippedCount++;
          }
        }
      }
      await this.reportUnarchivedDrops(tenantId, tenantDrops);

      return {
        purgedCount,
        reclaimedBytes,
        pinnedSkippedCount,
        evaluatedSegmentsCount,
        exhaustionCondition,
        unarchivedPurgedCount: tenantDrops.count,
        unarchivedPurgedBytes: tenantDrops.bytes,
      };
    }

    // Group cameras by priority ladder: LOW first, then NORMAL, then HIGH
    const priorityWeight: Record<RetentionPriority, number> = {
      LOW: 1,
      NORMAL: 2,
      HIGH: 3,
    };

    const sortedCameras = [...cameras].sort((a, b) => {
      const pA = priorityWeight[a.retentionPriority as RetentionPriority] || 2;
      const pB = priorityWeight[b.retentionPriority as RetentionPriority] || 2;
      return pA - pB;
    });

    for (const camera of sortedCameras) {
      const pol = camera.retentionPolicy;
      const retentionDays = pol?.continuousDays ?? defaultContinuousDays;
      const maxGb = pol?.maxStorageGigabytes ?? defaultMaxGb;
      const maxBytes = maxGb ? BigInt(maxGb) * 1024n * 1024n * 1024n : null;

      const cutoffDate = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

      // Fetch finalized segments for camera
      const segments = await this.prisma.recordingSegment.findMany({
        where: {
          cameraId: camera.id,
          status: 'FINALIZED',
        },
        orderBy: { startTime: 'asc' },
      });

      evaluatedSegmentsCount += segments.length;
      const state = await this.archiveState(tenantId, segments);
      const camDrops = noDrops();

      // Pass A: Age-based pruning
      let currentTotalBytes = 0n;
      const unexpiredSegments: typeof segments = [];

      for (const seg of segments) {
        currentTotalBytes += seg.sizeBytes;

        if (seg.endTime < cutoffDate) {
          const deleted = await this.atomicDeleteSegmentIfUnpinned(seg.id, seg.filePath);
          if (deleted) {
            purgedCount++;
            reclaimedBytes += seg.sizeBytes;
            currentTotalBytes -= seg.sizeBytes;
            this.noteDeleted(state, camDrops, seg);
          } else {
            pinnedSkippedCount++;
            unexpiredSegments.push(seg);
          }
        } else {
          unexpiredSegments.push(seg);
        }
      }

      // Pass B: Camera Quota-based pruning (if maxBytes is configured). With an enabled archive, segments already
      // verified in the archive store go first; a segment that exists nowhere else is deleted only when nothing
      // archived is left to free, and that is reported.
      if (maxBytes && currentTotalBytes > maxBytes) {
        for (const seg of this.orderForPressure(unexpiredSegments, state)) {
          if (currentTotalBytes <= maxBytes) break;

          const deleted = await this.atomicDeleteSegmentIfUnpinned(seg.id, seg.filePath);
          if (deleted) {
            purgedCount++;
            reclaimedBytes += seg.sizeBytes;
            currentTotalBytes -= seg.sizeBytes;
            this.noteDeleted(state, camDrops, seg);
          } else {
            pinnedSkippedCount++;
          }
        }

        // Check if camera is still over quota due to pinned evidence
        if (currentTotalBytes > maxBytes) {
          exhaustionCondition = true;
          await this.raisePinnedExhaustionAlarm(
            tenantId,
            currentTotalBytes - maxBytes,
            currentTotalBytes,
            camera.name
          );
        }
      }

      unarchivedPurgedCount += camDrops.count;
      unarchivedPurgedBytes += camDrops.bytes;
      await this.reportUnarchivedDrops(tenantId, camDrops, camera.name);
    }

    return {
      purgedCount,
      reclaimedBytes,
      pinnedSkippedCount,
      evaluatedSegmentsCount,
      exhaustionCondition,
      unarchivedPurgedCount,
      unarchivedPurgedBytes,
    };
  }

  /**
   * Legacy compatible pruneRetention method for tenant-wide age/quota pruning.
   */
  async pruneRetention(
    tenantId: string,
    policy: RetentionPolicyConfig,
    now = new Date()
  ): Promise<PruneReport> {
    const maxDays = policy.maxRetentionDays ?? 30;
    const cutoffDate = new Date(now.getTime() - maxDays * 24 * 60 * 60 * 1000);

    // 1. Fetch age candidates
    const ageCandidates = await this.segmentRepo.findRetentionCandidates(tenantId, cutoffDate, 500);
    const candidateIds = ageCandidates.map((s) => s.id);

    // 2. Identify actively pinned segments
    const pinnedSet = await this.pinRegistry.getPinnedSegmentIds(candidateIds);

    let purgedCount = 0;
    let reclaimedBytes = 0n;
    let pinnedSkippedCount = 0;
    const drops = noDrops();
    const ageState = await this.archiveState(tenantId, ageCandidates);

    // 3. Purge eligible unpinned segments using atomic delete
    for (const segment of ageCandidates) {
      if (pinnedSet.has(segment.id)) {
        pinnedSkippedCount++;
        continue;
      }

      const deleted = await this.atomicDeleteSegmentIfUnpinned(segment.id, segment.filePath);
      if (deleted) {
        purgedCount++;
        reclaimedBytes += segment.sizeBytes;
        this.noteDeleted(ageState, drops, segment);
      } else {
        pinnedSkippedCount++;
      }
    }

    // 4. Quota-based evaluation if targetQuotaBytes specified
    let exhaustionCondition = false;

    if (policy.targetQuotaBytes !== undefined && reclaimedBytes < policy.targetQuotaBytes) {
      const remainingNeeded = policy.targetQuotaBytes - reclaimedBytes;
      const quotaCandidates = await this.segmentRepo.findSegmentsForQuota(tenantId, 500);
      const quotaState = await this.archiveState(tenantId, quotaCandidates);
      // Archived segments first within this batch (the batch is the oldest 500 segments of the tenant).
      const additionalCandidates = this.orderForPressure(quotaCandidates, quotaState);
      const additionalIds = additionalCandidates.map((s) => s.id);
      const additionalPinned = await this.pinRegistry.getPinnedSegmentIds(additionalIds);

      let additionalEligiblePinnedBytes = 0n;

      for (const segment of additionalCandidates) {
        if (additionalPinned.has(segment.id)) {
          pinnedSkippedCount++;
          additionalEligiblePinnedBytes += segment.sizeBytes;
          continue;
        }

        const deleted = await this.atomicDeleteSegmentIfUnpinned(segment.id, segment.filePath);
        if (deleted) {
          purgedCount++;
          reclaimedBytes += segment.sizeBytes;
          this.noteDeleted(quotaState, drops, segment);
        } else {
          pinnedSkippedCount++;
          additionalEligiblePinnedBytes += segment.sizeBytes;
        }

        if (reclaimedBytes >= policy.targetQuotaBytes) {
          break;
        }
      }

      if (reclaimedBytes < policy.targetQuotaBytes && additionalEligiblePinnedBytes > 0n) {
        exhaustionCondition = true;
        await this.raisePinnedExhaustionAlarm(tenantId, remainingNeeded, additionalEligiblePinnedBytes);
      }
    }

    await this.reportUnarchivedDrops(tenantId, drops);

    return {
      purgedCount,
      reclaimedBytes,
      pinnedSkippedCount,
      evaluatedSegmentsCount: ageCandidates.length,
      exhaustionCondition,
      unarchivedPurgedCount: drops.count,
      unarchivedPurgedBytes: drops.bytes,
    };
  }

  private async raisePinnedExhaustionAlarm(
    tenantId: string,
    deficitBytes: bigint,
    protectedBytes: bigint,
    cameraName?: string
  ): Promise<void> {
    try {
      const target = cameraName ? `for camera "${cameraName}"` : 'at tenant level';
      await this.prisma.alarm.create({
        data: {
          tenantId,
          severity: EventSeverity.CRITICAL,
          state: AlarmState.ACTIVE,
          title: 'STORAGE_QUOTA_PINNED_EXHAUSTION',
          description: `Retention engine cannot satisfy required quota ${target}. Deficit: ${deficitBytes.toString()} bytes. Protected pinned storage: ${protectedBytes.toString()} bytes. Operator action required.`,
          metadataJson: {
            type: 'STORAGE_QUOTA_PINNED_EXHAUSTION',
            cameraName,
            deficitBytes: deficitBytes.toString(),
            protectedBytes: protectedBytes.toString(),
          },
        },
      });
    } catch (err: any) {
      console.error('[RetentionPolicy] Failed to raise exhaustion alarm:', err.message);
    }
  }
}

export default RetentionPolicyEngine;
