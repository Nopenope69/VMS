import checkDiskSpace from 'check-disk-space';
import fs from 'fs';
import { PrismaClient } from '@prisma/client';
import config from '../config/env';
import EvidencePinManager from './storage/evidencePinManager.service';

export type StorageHealthState =
  | 'AVAILABLE'
  | 'WARNING'
  | 'CRITICAL'
  | 'EMERGENCY_PURGE'
  | 'PINNED_STORAGE_EXHAUSTION';

export class StorageSentinelService {
  private prisma: PrismaClient;
  private timer: NodeJS.Timeout | null = null;
  private isChecking = false;
  private currentState: StorageHealthState = 'AVAILABLE';

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

  public getState(): StorageHealthState {
    return this.currentState;
  }

  /**
   * 5-tier storage health check with low-watermark hysteresis
   * and evidence lease protection.
   */
  async checkAndPurge(
    emergencyThresholdPercent = 92,
    targetHysteresisPercent = 80,
    minFreeBytes = 30 * 1024 * 1024 * 1024 // 30 GB minimum reserve
  ): Promise<void> {
    if (this.isChecking) return;
    this.isChecking = true;

    try {
      // 1. Clean up any expired evidence pin leases first
      await EvidencePinManager.reapExpiredLeases();

      const diskPath = fs.existsSync(config.RECORDINGS_DIR) ? config.RECORDINGS_DIR : '/';
      const diskInfo = await checkDiskSpace(diskPath);

      const usedBytes = diskInfo.size - diskInfo.free;
      const usagePercent = (usedBytes / diskInfo.size) * 100;
      const freeGb = Math.round(diskInfo.free / (1024 * 1024 * 1024));

      // 2. Classify Health State
      if (usagePercent > emergencyThresholdPercent || diskInfo.free < minFreeBytes) {
        this.currentState = 'EMERGENCY_PURGE';
      } else if (usagePercent > 85 || freeGb < 50) {
        this.currentState = 'CRITICAL';
      } else if (usagePercent > 75 || freeGb < 100) {
        this.currentState = 'WARNING';
      } else {
        this.currentState = 'AVAILABLE';
      }

      // 3. Execute Emergency Retention Purge with Hysteresis
      if (this.currentState === 'EMERGENCY_PURGE') {
        console.warn(
          `[StorageSentinel] EMERGENCY: Disk at ${usagePercent.toFixed(1)}% used (${freeGb} GB free). Purging to ${targetHysteresisPercent}% target.`
        );

        let currentUsagePercent = usagePercent;
        let purgedCount = 0;

        while (currentUsagePercent > targetHysteresisPercent) {
          // Find batch of oldest unpinned finalized segments
          // Strict Invariant: Segments with active, unexpired pins are NEVER purged!
          const candidates = await this.prisma.recordingSegment.findMany({
            where: {
              status: 'FINALIZED',
              evidencePins: {
                none: {
                  releasedAt: null,
                  expiresAt: { gt: new Date() },
                },
              },
            },
            orderBy: { startTime: 'asc' },
            take: 25,
          });

          if (candidates.length === 0) {
            // No more unpinned segments exist, but disk is still above threshold!
            this.currentState = 'PINNED_STORAGE_EXHAUSTION';
            console.error(
              `[StorageSentinel] PINNED_STORAGE_EXHAUSTION: All remaining video is locked under active evidence leases. Cannot free disk space!`
            );

            await this.prisma.event.create({
              data: {
                type: 'STORAGE_WARNING',
                severity: 'CRITICAL',
                title: 'Pinned Storage Exhaustion',
                description: `Disk capacity is critical (${freeGb} GB free), but all candidate recordings are pinned under active Section 63 evidence exports.`,
                metadata: { usagePercent: currentUsagePercent, freeGb },
              },
            });
            break;
          }

          for (const seg of candidates) {
            try {
              if (fs.existsSync(seg.filePath)) {
                fs.unlinkSync(seg.filePath);
              }
            } catch (err) {
              console.error(`Failed to delete segment ${seg.filePath}:`, err);
            }

            await this.prisma.recordingSegment.delete({
              where: { id: seg.id },
            });

            purgedCount++;
          }

          // Re-check current space
          const currentDisk = await checkDiskSpace(diskPath);
          currentUsagePercent = ((currentDisk.size - currentDisk.free) / currentDisk.size) * 100;
        }

        if (purgedCount > 0) {
          console.info(`[StorageSentinel] Retention purge completed. Purged ${purgedCount} unpinned segments.`);
        }
      }
    } catch (err) {
      console.error('[StorageSentinel] Failed to check disk space:', err);
    } finally {
      this.isChecking = false;
    }
  }
}

export default StorageSentinelService;
