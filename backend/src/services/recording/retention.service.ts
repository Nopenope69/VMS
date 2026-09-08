import fs from 'fs';
import { PrismaClient } from '@prisma/client';

export interface RetentionReport {
  purgedCount: number;
  reclaimedBytes: bigint;
  pinnedSkippedCount: number;
  evaluatedSegmentsCount: number;
}

export class RetentionService {
  private prisma: PrismaClient;
  private timer: NodeJS.Timeout | null = null;
  private isPruning = false;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  start(intervalMs = 3600000): void { // Hourly retention prune
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.executeRetentionPrune().catch((err) => {
        console.error('[RetentionService] Scheduled prune error:', err.message);
      });
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Evaluates all segments against camera / tenant retention policies.
   * STRICT INVARIANT: Segments with active EvidencePin leases are NEVER deleted.
   */
  async executeRetentionPrune(now = new Date()): Promise<RetentionReport> {
    if (this.isPruning) {
      return { purgedCount: 0, reclaimedBytes: BigInt(0), pinnedSkippedCount: 0, evaluatedSegmentsCount: 0 };
    }
    this.isPruning = true;

    let purgedCount = 0;
    let reclaimedBytes = BigInt(0);
    let pinnedSkippedCount = 0;
    let evaluatedSegmentsCount = 0;

    try {
      // 1. Load all active policies
      const policies = await this.prisma.retentionPolicy.findMany();
      const policyMap = new Map<string, { continuousDays: number; motionDays: number }>();

      for (const p of policies) {
        if (p.cameraId) {
          policyMap.set(`cam:${p.cameraId}`, { continuousDays: p.continuousDays, motionDays: p.motionDays });
        } else {
          policyMap.set(`tenant:${p.tenantId}`, { continuousDays: p.continuousDays, motionDays: p.motionDays });
        }
      }

      // Default fallback: 30 days continuous, 90 days motion
      const defaultPolicy = { continuousDays: 30, motionDays: 90 };

      // 2. Fetch all candidate segments
      const segments = await this.prisma.recordingSegment.findMany({
        where: { status: 'FINALIZED' },
        include: {
          evidencePins: {
            where: {
              releasedAt: null,
              expiresAt: { gt: now },
            },
          },
        },
      });

      evaluatedSegmentsCount = segments.length;

      for (const seg of segments) {
        // Strict Invariant: If segment has unexpired active pins, skip!
        if (seg.evidencePins.length > 0) {
          pinnedSkippedCount++;
          continue;
        }

        const cameraPolicy =
          policyMap.get(`cam:${seg.cameraId}`) ||
          (seg.tenantId ? policyMap.get(`tenant:${seg.tenantId}`) : null) ||
          defaultPolicy;

        const retentionDays = cameraPolicy.continuousDays;
        const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;

        if (seg.endTime.getTime() < cutoffMs) {
          // Candidate for deletion
          try {
            if (fs.existsSync(seg.filePath)) {
              fs.unlinkSync(seg.filePath);
            }
          } catch (err: any) {
            console.warn(`[RetentionService] Failed to unlink file ${seg.filePath}:`, err.message);
          }

          await this.prisma.recordingSegment.delete({
            where: { id: seg.id },
          });

          purgedCount++;
          reclaimedBytes += seg.sizeBytes;
        }
      }
    } finally {
      this.isPruning = false;
    }

    return {
      purgedCount,
      reclaimedBytes,
      pinnedSkippedCount,
      evaluatedSegmentsCount,
    };
  }
}

export default RetentionService;
