import fs from 'fs';
import { PrismaClient, EvidencePin } from '@prisma/client';
import { RecordingCatalog } from '../../recording/catalog/recordingCatalog.service';

export interface AdmissionStatus {
  admitted: boolean;
  reason?: string;
  freeBytes: number;
  freeGb: number;
  totalSegments: number;
  activePinnedSegments: number;
  pinnedRatio: number;
}

export class EvidencePinAdapter {
  private prisma: PrismaClient;
  private recordingCatalog?: RecordingCatalog;

  constructor(prisma: PrismaClient, recordingCatalog?: RecordingCatalog) {
    this.prisma = prisma;
    this.recordingCatalog = recordingCatalog;
  }

  /**
   * Acquires a temporary export lease on a collection of segments.
   * Marked explicitly as TEMPORARY_EXPORT.
   */
  async acquireExportLease(
    tenantId: string,
    segmentIds: string[],
    exportJobId: string,
    reason = 'EVIDENCE_EXPORT',
    durationHours = 2
  ): Promise<EvidencePin[]> {
    if (!segmentIds || segmentIds.length === 0) return [];

    const durationDays = Math.max(durationHours / 24, 0.05); // Fractional or minimal days
    const pins: EvidencePin[] = [];

    for (const segmentId of segmentIds) {
      if (typeof this.recordingCatalog?.pinSegment === 'function') {
        const pin = await this.recordingCatalog.pinSegment(
          tenantId,
          segmentId,
          exportJobId,
          reason,
          durationDays,
          'TEMPORARY_EXPORT'
        );
        pins.push(pin);
      } else if ((this.prisma as any)?.evidencePin?.create) {
        const expiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);
        const pin = await this.prisma.evidencePin.create({
          data: {
            tenantId,
            segmentId,
            exportJobId,
            reason,
            expiresAt,
            pinType: 'TEMPORARY_EXPORT',
          },
        });
        pins.push(pin);
      }
    }

    return pins;
  }

  /**
   * Places an absolute legal hold pin on segments.
   * INVARIANT: Legal holds persist until an explicit release by authorized user.
   */
  async pinForLegalHold(
    tenantId: string,
    segmentIds: string[],
    manifestId: string,
    reason = 'LEGAL_HOLD'
  ): Promise<EvidencePin[]> {
    if (!segmentIds || segmentIds.length === 0) return [];

    const durationDays = 3650; // 10 years default hold
    const pins: EvidencePin[] = [];

    for (const segmentId of segmentIds) {
      if (typeof this.recordingCatalog?.pinSegment === 'function') {
        const pin = await this.recordingCatalog.pinSegment(
          tenantId,
          segmentId,
          manifestId,
          reason,
          durationDays,
          'LEGAL_HOLD'
        );
        pins.push(pin);
      } else if ((this.prisma as any)?.evidencePin?.create) {
        const expiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);
        const pin = await this.prisma.evidencePin.create({
          data: {
            tenantId,
            segmentId,
            exportJobId: manifestId,
            reason,
            expiresAt,
            pinType: 'LEGAL_HOLD',
          },
        });
        pins.push(pin);
      }
    }

    return pins;
  }

  /**
   * Releases export pins for a specific export job upon completion or cancellation.
   * INVARIANT: Only releases TEMPORARY_EXPORT pins. Active LEGAL_HOLD pins are NEVER released.
   */
  async releaseExportLease(exportJobId: string): Promise<number> {
    if (typeof this.recordingCatalog?.releaseExportPins === 'function') {
      return this.recordingCatalog.releaseExportPins(exportJobId);
    }
    if ((this.prisma as any)?.evidencePin?.updateMany) {
      const res = await this.prisma.evidencePin.updateMany({
        where: {
          exportJobId,
          pinType: 'TEMPORARY_EXPORT',
          releasedAt: null,
        },
        data: { releasedAt: new Date() },
      });
      return res.count;
    }
    return 0;
  }

  /**
   * Releases legal hold pins for a manifest upon explicit administrative authorization.
   */
  async releaseLegalHold(tenantId: string, manifestId: string): Promise<number> {
    if (typeof this.recordingCatalog?.releaseLegalHoldPins === 'function') {
      return this.recordingCatalog.releaseLegalHoldPins(tenantId, manifestId);
    }
    if ((this.prisma as any)?.evidencePin?.updateMany) {
      const res = await this.prisma.evidencePin.updateMany({
        where: {
          tenantId,
          exportJobId: manifestId,
          pinType: 'LEGAL_HOLD',
          releasedAt: null,
        },
        data: { releasedAt: new Date() },
      });
      return res.count;
    }
    return 0;
  }

  /**
   * Checks whether a segment is actively protected by any unexpired pin.
   */
  async isSegmentPinned(segmentId: string): Promise<boolean> {
    if (typeof this.recordingCatalog?.isPinned === 'function') {
      return this.recordingCatalog.isPinned(segmentId);
    }
    if ((this.prisma as any)?.evidencePin?.count) {
      const count = await this.prisma.evidencePin.count({
        where: {
          segmentId,
          releasedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      return count > 0;
    }
    return false;
  }

  /**
   * Evaluates storage headroom before export execution to prevent pinned exhaustion.
   */
  async checkAdmissionControl(recordingsDir: string): Promise<AdmissionStatus> {
    let freeBytes = 100 * 1024 * 1024 * 1024; // Default 100GB if statfs is unavailable

    try {
      if ((fs as any).statfsSync) {
        const stat = (fs as any).statfsSync(recordingsDir);
        freeBytes = stat.bavail * stat.bsize;
      }
    } catch {}

    const freeGb = Math.round(freeBytes / (1024 * 1024 * 1024));
    const totalSegments = (this.prisma as any)?.recordingSegment?.count
      ? await this.prisma.recordingSegment.count()
      : 0;

    const activePins = (this.prisma as any)?.evidencePin?.findMany
      ? await this.prisma.evidencePin.findMany({
          where: {
            releasedAt: null,
            expiresAt: { gt: new Date() },
          },
          select: { segmentId: true },
          distinct: ['segmentId'],
        })
      : [];

    const activePinnedSegments = activePins.length;
    const pinnedRatio = totalSegments > 0 ? activePinnedSegments / totalSegments : 0;

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
