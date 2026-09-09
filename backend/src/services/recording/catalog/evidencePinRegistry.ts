import { PrismaClient, EvidencePin } from '@prisma/client';

export class EvidencePinRegistry {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Creates an immutable hold on a recorded segment
   */
  async pinSegment(
    tenantId: string,
    segmentId: string,
    exportJobId: string,
    reason: string,
    durationDays = 365,
    pinType = 'TEMPORARY_EXPORT'
  ): Promise<EvidencePin> {
    const expiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);

    return this.prisma.evidencePin.create({
      data: {
        tenantId,
        segmentId,
        exportJobId,
        reason,
        expiresAt,
        pinType,
      },
    });
  }

  /**
   * Checks whether a specific segment is currently protected by an active pin
   */
  async isPinned(segmentId: string): Promise<boolean> {
    if (typeof this.prisma?.evidencePin?.count !== 'function') {
      return false;
    }
    const now = new Date();
    const count = await this.prisma.evidencePin.count({
      where: {
        segmentId,
        releasedAt: null,
        expiresAt: { gt: now },
      },
    });
    return count > 0;
  }

  /**
   * Returns a set of segment IDs that are actively pinned among the given candidates
   */
  async getPinnedSegmentIds(segmentIds: string[]): Promise<Set<string>> {
    if (!segmentIds || segmentIds.length === 0) return new Set();
    if (typeof this.prisma?.evidencePin?.findMany !== 'function') {
      return new Set();
    }

    const now = new Date();
    const activePins = await this.prisma.evidencePin.findMany({
      where: {
        segmentId: { in: segmentIds },
        releasedAt: null,
        expiresAt: { gt: now },
      },
      select: { segmentId: true },
    });

    return new Set(activePins.map((p) => p.segmentId));
  }

  /**
   * Releases a pin explicitly (e.g. after export lifecycle completion or administrator action)
   */
  async releasePin(pinId: string): Promise<void> {
    await this.prisma.evidencePin.update({
      where: { id: pinId },
      data: { releasedAt: new Date() },
    });
  }

  /**
   * Releases temporary export pins associated with an export job.
   * INVARIANT: Never touches or releases LEGAL_HOLD pins!
   */
  async releaseExportPins(exportJobId: string): Promise<number> {
    const result = await this.prisma.evidencePin.updateMany({
      where: {
        exportJobId,
        pinType: 'TEMPORARY_EXPORT',
        releasedAt: null,
      },
      data: { releasedAt: new Date() },
    });
    return result.count;
  }

  /**
   * Releases legal hold pins for a manifest/case upon explicit authorized release.
   */
  async releaseLegalHoldPins(tenantId: string, manifestId: string): Promise<number> {
    const result = await this.prisma.evidencePin.updateMany({
      where: {
        tenantId,
        exportJobId: manifestId,
        pinType: 'LEGAL_HOLD',
        releasedAt: null,
      },
      data: { releasedAt: new Date() },
    });
    return result.count;
  }
}
