import checkDiskSpace from 'check-disk-space';
import fs from 'fs';
import { PrismaClient, EventSeverity } from '@prisma/client';
import config from '../config/env';
import EvidencePinManager from './storage/evidencePinManager.service';
import StorageDegradeManagerService, {
  AdaptiveStorageState,
  StorageRateAnalysis,
} from './storage/storageDegradeManager.service';
import StorageVolumeService from './storage/storageVolume.service';

export type StorageHealthState =
  | 'AVAILABLE'
  | 'WARNING'
  | 'CRITICAL'
  | 'EMERGENCY_PURGE'
  | 'EMERGENCY_PRESERVE_EVIDENCE'
  | 'PINNED_STORAGE_EXHAUSTION';

export class StorageSentinelService {
  private prisma: PrismaClient;
  private timer: NodeJS.Timeout | null = null;
  private isChecking = false;
  private currentState: StorageHealthState = 'AVAILABLE';
  private degradeManager: StorageDegradeManagerService;
  private volumeService: StorageVolumeService;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
    this.degradeManager = new StorageDegradeManagerService(prisma);
    this.volumeService = StorageVolumeService.getInstance(prisma);
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

  public getDegradeManager(): StorageDegradeManagerService {
    return this.degradeManager;
  }

  /**
   * Evaluates storage vitals, runs Mount Guard on all volumes,
   * performs dynamic ingestion adaptation, and triggers hysteresis emergency purge if required.
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

      // 2. Perform Mount Guard checks across all registered volumes
      await this.volumeService.checkAllVolumes();

      // 3. Multi-signal analysis & adaptive ingestion evaluation
      const diskPath = fs.existsSync(config.RECORDINGS_DIR) ? config.RECORDINGS_DIR : '/';
      const analysis: StorageRateAnalysis = await this.degradeManager.evaluateStorageVitals(diskPath);

      const diskInfo = await checkDiskSpace(diskPath);
      const usedBytes = diskInfo.size - diskInfo.free;
      const usagePercent = (usedBytes / diskInfo.size) * 100;
      const freeGb = Math.round(diskInfo.free / (1024 * 1024 * 1024));

      // Classify sentinel health state
      if (analysis.state === 'EMERGENCY_PRESERVE_EVIDENCE') {
        this.currentState = 'EMERGENCY_PRESERVE_EVIDENCE';
      } else if (usagePercent > emergencyThresholdPercent || diskInfo.free < minFreeBytes) {
        this.currentState = 'EMERGENCY_PURGE';
      } else if (analysis.state === 'CRITICAL' || usagePercent > 85 || freeGb < 50) {
        this.currentState = 'CRITICAL';
      } else if (analysis.state === 'WARNING' || usagePercent > 75 || freeGb < 100) {
        this.currentState = 'WARNING';
      } else {
        this.currentState = 'AVAILABLE';
      }

      // 4. Execute Emergency Retention Purge with Hysteresis if in EMERGENCY_PURGE
      if (this.currentState === 'EMERGENCY_PURGE') {
        console.warn(
          `[StorageSentinel] EMERGENCY: Disk at ${usagePercent.toFixed(1)}% used (${freeGb} GB free). Purging to ${targetHysteresisPercent}% target.`
        );

        let currentUsagePercent = usagePercent;
        let purgedCount = 0;

        while (currentUsagePercent > targetHysteresisPercent) {
          // Find batch of oldest unpinned finalized segments
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
            // No unpinned segments exist; enter PINNED_STORAGE_EXHAUSTION
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

            // Ingest into authoritative IncidentOrchestrator pipeline
            try {
              const { incidentOrchestrator } = await import('./incident/orchestrator/incidentOrchestrator.service');
              const alertId = `storage-${Date.now()}`;
              await incidentOrchestrator.ingestEvent({
                id: alertId,
                correlationId: alertId,
                source: 'SYSTEM',
                type: 'SYSTEM_ALERT',
                severity: EventSeverity.CRITICAL,
                timestampUtc: new Date(),
                tenantId: 'system-appliance',
                payload: {
                  kind: 'SYSTEM_ALERT',
                  subsystem: 'STORAGE',
                  alertCode: 'PINNED_STORAGE_EXHAUSTION',
                  message: `Disk capacity critical (${freeGb} GB free), all candidate recordings are pinned under active Section 63 evidence exports.`,
                  details: { usagePercent: currentUsagePercent, freeGb },
                },
              });
            } catch (err: any) {
              console.warn(`[StorageSentinel] Ingest into IncidentOrchestrator warning: ${err.message}`);
            }
            break;
          }

          for (const seg of candidates) {
            // Atomic conditional delete to eliminate race condition with simultaneous evidence pinning
            let deleted = false;
            if (typeof (this.prisma as any).$executeRaw === 'function') {
              try {
                const deletedRows: number = await (this.prisma as any).$executeRaw`
                  DELETE FROM "RecordingSegment"
                  WHERE id = ${seg.id}
                    AND NOT EXISTS (
                      SELECT 1 FROM "EvidencePin"
                      WHERE "segmentId" = ${seg.id}
                        AND "releasedAt" IS NULL
                        AND "expiresAt" > NOW()
                    )
                `;
                deleted = deletedRows > 0;
              } catch {
                deleted = false;
              }
            } else {
              await this.prisma.recordingSegment.delete({ where: { id: seg.id } });
              deleted = true;
            }

            if (deleted) {
              try {
                if (fs.existsSync(seg.filePath)) {
                  fs.unlinkSync(seg.filePath);
                }
              } catch (err) {
                console.error(`Failed to delete segment file ${seg.filePath}:`, err);
              }
              purgedCount++;
            }
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
