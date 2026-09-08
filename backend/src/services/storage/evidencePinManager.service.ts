import fs from 'fs';
import { PrismaClient } from '@prisma/client';

export interface AdmissionStatus {
  admitted: boolean;
  reason?: string;
  freeBytes: number;
  freeGb: number;
  totalSegments: number;
  activePinnedSegments: number;
  pinnedRatio: number;
}

export class EvidencePinManager {
  private static prisma = new PrismaClient();

  /**
   * Acquire a time-bounded lease for a set of recording segments.
   * Multiple export jobs can concurrently hold leases on the same segment.
   */
  public static async acquireLease(
    tenantId: string,
    segmentIds: string[],
    exportJobId: string,
    reason: string = 'EVIDENCE_EXPORT',
    durationHours: number = 2
  ) {
    if (segmentIds.length === 0) return [];

    const expiresAt = new Date(Date.now() + durationHours * 3600 * 1000);

    const pinRecords = segmentIds.map((segmentId) => ({
      tenantId,
      segmentId,
      exportJobId,
      reason,
      expiresAt,
      pinType: 'TEMPORARY_EXPORT',
    }));

    // Create all pins in a batch
    await this.prisma.evidencePin.createMany({
      data: pinRecords,
    });

    return await this.prisma.evidencePin.findMany({
      where: { exportJobId, releasedAt: null },
    });
  }

  /**
   * Explicitly release temporary export pins held by an export job.
   * INVARIANT: Never releases LEGAL_HOLD pins!
   */
  public static async releaseLease(exportJobId: string): Promise<number> {
    const result = await this.prisma.evidencePin.updateMany({
      where: {
        exportJobId,
        pinType: 'TEMPORARY_EXPORT',
        releasedAt: null,
      },
      data: {
        releasedAt: new Date(),
      },
    });

    return result.count;
  }

  /**
   * Background sweeper to mark expired pins as released,
   * enabling crash recovery if an export job terminates abruptly.
   */
  public static async reapExpiredLeases(): Promise<number> {
    const result = await this.prisma.evidencePin.updateMany({
      where: {
        releasedAt: null,
        expiresAt: { lt: new Date() },
      },
      data: {
        releasedAt: new Date(),
      },
    });

    return result.count;
  }

  /**
   * Check if a specific segment has any active, unexpired pins.
   */
  public static async isSegmentPinned(segmentId: string): Promise<boolean> {
    const activePin = await this.prisma.evidencePin.findFirst({
      where: {
        segmentId,
        releasedAt: null,
        expiresAt: { gt: new Date() },
      },
    });

    return !!activePin;
  }

  /**
   * Admission control check before starting an evidence export.
   * Prevents pinned storage exhaustion when disk capacity is constrained.
   */
  public static async checkAdmissionControl(recordingsDir: string): Promise<AdmissionStatus> {
    let freeBytes = 100 * 1024 * 1024 * 1024; // Default 100GB if fs.statfs not supported

    try {
      if (fs.statfsSync) {
        const stat = fs.statfsSync(recordingsDir);
        freeBytes = stat.bavail * stat.bsize;
      }
    } catch {}

    const freeGb = Math.round(freeBytes / (1024 * 1024 * 1024));

    const totalSegments = await this.prisma.recordingSegment.count();

    // Count distinct segments with active unexpired pins
    const activePins = await this.prisma.evidencePin.findMany({
      where: {
        releasedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { segmentId: true },
      distinct: ['segmentId'],
    });

    const activePinnedSegments = activePins.length;
    const pinnedRatio = totalSegments > 0 ? activePinnedSegments / totalSegments : 0;

    // Reject new exports if free space is under 50GB and more than 85% of segments are already pinned
    if (freeGb < 50 && pinnedRatio > 0.85) {
      return {
        admitted: false,
        reason: `PINNED_STORAGE_EXHAUSTION: Disk free space (${freeGb} GB) is critical and ${(pinnedRatio * 100).toFixed(1)}% of footage is pinned under active export locks.`,
        freeBytes,
        freeGb,
        totalSegments,
        activePinnedSegments,
        pinnedRatio,
      };
    }

    return {
      admitted: true,
      freeBytes,
      freeGb,
      totalSegments,
      activePinnedSegments,
      pinnedRatio,
    };
  }
}

export default EvidencePinManager;
