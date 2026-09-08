import { PrismaClient, EventSeverity, AlarmState } from '@prisma/client';
import { SegmentRepository } from './segmentRepository';
import { EvidencePinRegistry } from './evidencePinRegistry';
import { StorageAdapter } from './storageAdapter';

export interface RetentionPolicyConfig {
  maxRetentionDays?: number;
  targetQuotaBytes?: bigint;
}

export interface PruneReport {
  purgedCount: number;
  reclaimedBytes: bigint;
  pinnedSkippedCount: number;
  evaluatedSegmentsCount: number;
  exhaustionCondition: boolean;
}

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
   * Executes retention pruning based on age or storage quota limits.
   * STRICT INVARIANT: Actively pinned segments are NEVER automatically purged.
   * If required quota cannot be satisfied after deleting all eligible unpinned candidates
   * and the remaining deficit is held by active pins, triggers STORAGE_QUOTA_PINNED_EXHAUSTION.
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

    // 3. Purge eligible unpinned segments
    for (const segment of ageCandidates) {
      if (pinnedSet.has(segment.id)) {
        pinnedSkippedCount++;
        continue;
      }

      await this.storageAdapter.deleteFile(segment.filePath);
      await this.segmentRepo.deleteSegment(segment.id);
      purgedCount++;
      reclaimedBytes += segment.sizeBytes;
    }

    // 4. Quota-based evaluation if targetQuotaBytes specified
    let exhaustionCondition = false;

    if (policy.targetQuotaBytes !== undefined && reclaimedBytes < policy.targetQuotaBytes) {
      const remainingNeeded = policy.targetQuotaBytes - reclaimedBytes;
      const additionalCandidates = await this.segmentRepo.findSegmentsForQuota(tenantId, 500);
      const additionalIds = additionalCandidates.map((s) => s.id);
      const additionalPinned = await this.pinRegistry.getPinnedSegmentIds(additionalIds);

      let additionalPurged = 0n;
      let additionalEligiblePinnedBytes = 0n;

      for (const segment of additionalCandidates) {
        if (additionalPinned.has(segment.id)) {
          pinnedSkippedCount++;
          additionalEligiblePinnedBytes += segment.sizeBytes;
          continue;
        }

        await this.storageAdapter.deleteFile(segment.filePath);
        await this.segmentRepo.deleteSegment(segment.id);
        purgedCount++;
        reclaimedBytes += segment.sizeBytes;
        additionalPurged += segment.sizeBytes;

        if (reclaimedBytes >= policy.targetQuotaBytes) {
          break;
        }
      }

      // If quota is still unsatisfied AND the deficit is protected by active pins:
      if (reclaimedBytes < policy.targetQuotaBytes && additionalEligiblePinnedBytes > 0n) {
        exhaustionCondition = true;
        await this.raisePinnedExhaustionAlarm(tenantId, remainingNeeded, additionalEligiblePinnedBytes);
      }
    }

    return {
      purgedCount,
      reclaimedBytes,
      pinnedSkippedCount,
      evaluatedSegmentsCount: ageCandidates.length,
      exhaustionCondition,
    };
  }

  private async raisePinnedExhaustionAlarm(
    tenantId: string,
    deficitBytes: bigint,
    protectedBytes: bigint
  ): Promise<void> {
    try {
      await this.prisma.alarm.create({
        data: {
          tenantId,
          severity: EventSeverity.CRITICAL,
          state: AlarmState.ACTIVE,
          title: 'STORAGE_QUOTA_PINNED_EXHAUSTION',
          description: `Retention engine cannot satisfy required quota. Deficit: ${deficitBytes.toString()} bytes. Protected pinned storage: ${protectedBytes.toString()} bytes. Operator action required.`,
          metadataJson: {
            type: 'STORAGE_QUOTA_PINNED_EXHAUSTION',
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
