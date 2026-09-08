import { PrismaClient } from '@prisma/client';
import { RecordingCatalog } from '../../../recording/catalog/recordingCatalog.service';

export interface BookmarkSegmentParams {
  tenantId: string;
  cameraId?: string;
  segmentId?: string;
  timestamp?: Date;
  reason?: string;
}

export class BookmarkAdapter {
  private prisma: PrismaClient;
  private catalog: RecordingCatalog;

  constructor(prisma: PrismaClient, catalog?: RecordingCatalog) {
    this.prisma = prisma;
    this.catalog = catalog || new RecordingCatalog(prisma);
  }

  public async bookmark(params: BookmarkSegmentParams): Promise<{ success: boolean; pinId?: string; message: string }> {
    try {
      let targetSegmentId = params.segmentId;

      if (!targetSegmentId && params.cameraId && params.timestamp) {
        const seg = await this.prisma.recordingSegment.findFirst({
          where: {
            cameraId: params.cameraId,
            startTime: { lte: params.timestamp },
            endTime: { gte: params.timestamp },
          },
          select: { id: true },
        });
        targetSegmentId = seg?.id;
      }

      if (!targetSegmentId) {
        return {
          success: false,
          message: 'No recording segment identified for bookmarking at target timestamp',
        };
      }

      const pin = await this.catalog.pinSegment(
        params.tenantId,
        targetSegmentId,
        `bookmark_${Date.now()}`,
        params.reason || 'Incident Bookmark',
        30,
        'TEMPORARY_EXPORT'
      );

      return {
        success: true,
        pinId: pin.id,
        message: `Pinned segment ${targetSegmentId} for 30 days`,
      };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }
}
