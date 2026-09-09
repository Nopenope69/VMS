import { PrismaClient } from '@prisma/client';
import { RetentionPolicyEngine, PruneReport } from './catalog/retentionPolicy';
import { SegmentRepository } from './catalog/segmentRepository';
import { EvidencePinRegistry } from './catalog/evidencePinRegistry';
import { LocalStorageAdapter } from './catalog/storageAdapter';

export class RetentionService {
  private prisma: PrismaClient;
  private timer: NodeJS.Timeout | null = null;
  private isPruning = false;
  private engine: RetentionPolicyEngine;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
    const repo = new SegmentRepository(prisma);
    const pins = new EvidencePinRegistry(prisma);
    const storage = new LocalStorageAdapter();
    this.engine = new RetentionPolicyEngine(prisma, repo, pins, storage);
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
   * Evaluates all segments against per-camera retention policies and storage quotas.
   * STRICT INVARIANT: Segments with active EvidencePin leases are NEVER deleted.
   */
  async executeRetentionPrune(now = new Date()): Promise<PruneReport> {
    if (this.isPruning) {
      return {
        purgedCount: 0,
        reclaimedBytes: BigInt(0),
        pinnedSkippedCount: 0,
        evaluatedSegmentsCount: 0,
        exhaustionCondition: false,
      };
    }
    this.isPruning = true;

    try {
      let tenants: { id: string }[] = [];
      if (typeof this.prisma.tenant?.findMany === 'function') {
        tenants = await this.prisma.tenant.findMany({ select: { id: true } });
      }

      if (tenants.length === 0) {
        if (typeof this.prisma.retentionPolicy?.findMany === 'function') {
          const policies = await this.prisma.retentionPolicy.findMany().catch(() => []);
          const tIds = new Set<string>();
          for (const p of policies) {
            if (p.tenantId) tIds.add(p.tenantId);
          }
          tenants = Array.from(tIds).map((id) => ({ id }));
        }
        if (tenants.length === 0) {
          tenants = [{ id: 'default' }];
        }
      }

      let totalPurged = 0;
      let totalReclaimed = 0n;
      let totalSkipped = 0;
      let totalEvaluated = 0;
      let hasExhaustion = false;

      for (const tenant of tenants) {
        const report = await this.engine.pruneCameraQuotasAndRetention(tenant.id, now);
        totalPurged += report.purgedCount;
        totalReclaimed += report.reclaimedBytes;
        totalSkipped += report.pinnedSkippedCount;
        totalEvaluated += report.evaluatedSegmentsCount;
        if (report.exhaustionCondition) hasExhaustion = true;
      }

      return {
        purgedCount: totalPurged,
        reclaimedBytes: totalReclaimed,
        pinnedSkippedCount: totalSkipped,
        evaluatedSegmentsCount: totalEvaluated,
        exhaustionCondition: hasExhaustion,
      };
    } finally {
      this.isPruning = false;
    }
  }
}

export default RetentionService;
