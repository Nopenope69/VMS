import checkDiskSpace from 'check-disk-space';
import fs from 'fs';
import { PrismaClient } from '@prisma/client';
import config from '../config/env';

export class StorageSentinelService {
  private prisma: PrismaClient;
  private timer: NodeJS.Timeout | null = null;
  private isChecking = false;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  start(intervalMs = 60000) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.checkAndPurge().catch((err) => {
        console.error('[StorageSentinel] Error checking disk space:', err);
      });
    }, intervalMs);

    this.checkAndPurge().catch(() => {});
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async checkAndPurge(maxUsagePercent = 90, minFreeBytes = 5 * 1024 * 1024 * 1024): Promise<void> {
    if (this.isChecking) return;
    this.isChecking = true;

    try {
      const diskPath = fs.existsSync(config.RECORDINGS_DIR) ? config.RECORDINGS_DIR : '/';
      const diskInfo = await checkDiskSpace(diskPath);

      const usedBytes = diskInfo.size - diskInfo.free;
      const usagePercent = (usedBytes / diskInfo.size) * 100;

      if (usagePercent > maxUsagePercent || diskInfo.free < minFreeBytes) {
        console.warn(
          `[StorageSentinel] Disk high watermark reached: ${usagePercent.toFixed(1)}% used (${(
            diskInfo.free / (1024 * 1024 * 1024)
          ).toFixed(2)} GB free). Initiating retention purge.`
        );

        await this.prisma.event.create({
          data: {
            type: 'STORAGE_WARNING',
            severity: 'WARNING',
            title: 'Storage High Watermark Exceeded',
            description: `Disk usage at ${usagePercent.toFixed(1)}%. Oldest recordings are being automatically purged to prevent outage.`,
            metadata: {
              diskSizeGb: diskInfo.size / (1024 * 1024 * 1024),
              freeGb: diskInfo.free / (1024 * 1024 * 1024),
              usagePercent,
            },
          },
        });

        // Find oldest 50 finalized segments
        const oldestSegments = await this.prisma.recordingSegment.findMany({
          where: { status: 'FINALIZED' },
          orderBy: { startTime: 'asc' },
          take: 50,
        });

        for (const seg of oldestSegments) {
          try {
            if (fs.existsSync(seg.filePath)) {
              fs.unlinkSync(seg.filePath);
            }
          } catch (err) {
            console.error(`Failed to delete segment file ${seg.filePath}:`, err);
          }

          await this.prisma.recordingSegment.delete({
            where: { id: seg.id },
          });
        }
      }
    } catch (err) {
      console.error('[StorageSentinel] Failed to check disk space:', err);
    } finally {
      this.isChecking = false;
    }
  }
}
