import {
  PrismaClient,
  RecordingMode,
  DegradationReason,
  EventSeverity,
  AlarmState,
} from '@prisma/client';
import checkDiskSpace from 'check-disk-space';
import fs from 'fs';
import config from '../../config/env';

export type AdaptiveStorageState =
  | 'AVAILABLE'
  | 'WARNING'
  | 'CRITICAL'
  | 'EMERGENCY_PRESERVE_EVIDENCE';

export interface StorageRateAnalysis {
  sizeBytes: bigint;
  freeBytes: bigint;
  usedBytes: bigint;
  pinnedBytes: bigint;
  fillRatio: number;
  writeRateBytesPerHour: number;
  projectedExhaustionHours: number | null;
  state: AdaptiveStorageState;
  activeDegradedCamerasCount: number;
  totalCamerasCount: number;
}

export class StorageDegradeManagerService {
  private prisma: PrismaClient;
  private currentState: AdaptiveStorageState = 'AVAILABLE';
  private lastAnalysis: StorageRateAnalysis | null = null;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  public getState(): AdaptiveStorageState {
    return this.currentState;
  }

  public getLastAnalysis(): StorageRateAnalysis | null {
    return this.lastAnalysis;
  }

  /**
   * Calculates rolling write rate by looking at finalized segments created in the last N hours.
   */
  async calculateRollingWriteRate(hours = 6): Promise<number> {
    const windowStart = new Date(Date.now() - hours * 3600 * 1000);

    const result = await this.prisma.recordingSegment.aggregate({
      where: {
        createdAt: { gte: windowStart },
        status: 'FINALIZED',
      },
      _sum: { sizeBytes: true },
    });

    const totalBytesInWindow = Number(result._sum.sizeBytes || 0n);
    if (totalBytesInWindow <= 0) {
      // Default baseline estimate: ~1.5 MB/s per camera if no historical segments
      const activeCameras = await this.prisma.camera.count({
        where: { recorderState: 'RUNNING' },
      });
      return activeCameras * 1.5 * 1024 * 1024 * 3600; // bytes per hour
    }

    return totalBytesInWindow / hours;
  }

  /**
   * Evaluates multi-signal storage thresholds including free percentage, absolute headroom,
   * and projected time-to-full (rate of exhaustion).
   */
  async evaluateStorageVitals(diskPath = config.RECORDINGS_DIR || '/recordings'): Promise<StorageRateAnalysis> {
    const resolvedPath = fs.existsSync(diskPath) ? diskPath : '/';
    const disk = await checkDiskSpace(resolvedPath);

    const sizeBytes = BigInt(disk.size);
    const freeBytes = BigInt(disk.free);
    const usedBytes = sizeBytes - freeBytes;
    const fillRatio = disk.size > 0 ? Number(usedBytes) / disk.size : 0;
    const freeRatio = 1 - fillRatio;

    // Calculate active unexpired evidence pinned storage size
    const now = new Date();
    const pinnedSegments = await this.prisma.recordingSegment.findMany({
      where: {
        evidencePins: {
          some: {
            releasedAt: null,
            expiresAt: { gt: now },
          },
        },
      },
      select: { sizeBytes: true },
    });

    const pinnedBytes = pinnedSegments.reduce((sum, s) => sum + s.sizeBytes, 0n);

    // Write rate & time-to-full
    const writeRateBytesPerHour = await this.calculateRollingWriteRate(6);
    let projectedExhaustionHours: number | null = null;

    if (writeRateBytesPerHour > 0) {
      projectedExhaustionHours = Number(freeBytes) / writeRateBytesPerHour;
    }

    // Classify state using multi-signal logic:
    // WARNING: Free < 20% OR Projected < 48h
    // CRITICAL: Free < 10% OR Projected < 12h
    // EMERGENCY_PRESERVE_EVIDENCE: Free < 5% OR Projected < 2h OR (freeBytes < 10GB && pinnedBytes > usedBytes * 80%)
    let newState: AdaptiveStorageState = 'AVAILABLE';

    if (
      freeRatio < 0.05 ||
      (projectedExhaustionHours !== null && projectedExhaustionHours < 2) ||
      (freeBytes < 10n * 1024n * 1024n * 1024n && pinnedBytes > (usedBytes * 8n) / 10n)
    ) {
      newState = 'EMERGENCY_PRESERVE_EVIDENCE';
    } else if (
      freeRatio < 0.1 ||
      (projectedExhaustionHours !== null && projectedExhaustionHours < 12)
    ) {
      newState = 'CRITICAL';
    } else if (
      freeRatio < 0.2 ||
      (projectedExhaustionHours !== null && projectedExhaustionHours < 48)
    ) {
      newState = 'WARNING';
    } else {
      newState = 'AVAILABLE';
    }

    // Apply adaptive camera ingestion changes if state transitioned
    await this.applyAdaptiveIngestion(newState);

    const camerasCount = await this.prisma.camera.count();
    const degradedCount = await this.prisma.camera.count({
      where: { degradationReason: { not: 'NONE' } },
    });

    this.currentState = newState;
    this.lastAnalysis = {
      sizeBytes,
      freeBytes,
      usedBytes,
      pinnedBytes,
      fillRatio,
      writeRateBytesPerHour,
      projectedExhaustionHours,
      state: newState,
      activeDegradedCamerasCount: degradedCount,
      totalCamerasCount: camerasCount,
    };

    return this.lastAnalysis;
  }

  /**
   * Adjusts effectiveRecordingMode without modifying the operator's configured recordingMode.
   */
  private async applyAdaptiveIngestion(targetState: AdaptiveStorageState): Promise<void> {
    const now = new Date();

    if (targetState === 'CRITICAL' && this.currentState !== 'CRITICAL') {
      console.warn(
        `[StorageDegradeManager] Storage CRITICAL: Activating adaptive degradation for non-critical cameras.`
      );

      // Low-priority cameras -> MOTION or SUBSTREAM_ONLY
      await this.prisma.camera.updateMany({
        where: {
          retentionPriority: 'LOW',
          recordingMode: RecordingMode.CONTINUOUS,
        },
        data: {
          effectiveRecordingMode: RecordingMode.MOTION,
          degradationReason: DegradationReason.STORAGE_PRESSURE_CRITICAL,
          degradationSince: now,
        },
      });

      // Normal-priority cameras -> MOTION
      await this.prisma.camera.updateMany({
        where: {
          retentionPriority: 'NORMAL',
          recordingMode: RecordingMode.CONTINUOUS,
        },
        data: {
          effectiveRecordingMode: RecordingMode.MOTION,
          degradationReason: DegradationReason.STORAGE_PRESSURE_CRITICAL,
          degradationSince: now,
        },
      });

      // Emit event
      await this.recordDegradationEvent(
        'STORAGE_DEGRADED_MODE_ACTIVE',
        'Storage Degradation Mode Active',
        'Storage capacity reached CRITICAL threshold. Non-critical cameras dynamically downgraded to MOTION recording to preserve evidentiary continuity.',
        EventSeverity.WARNING
      );
    } else if (
      targetState === 'EMERGENCY_PRESERVE_EVIDENCE' &&
      this.currentState !== 'EMERGENCY_PRESERVE_EVIDENCE'
    ) {
      console.error(
        `[StorageDegradeManager] EMERGENCY_PRESERVE_EVIDENCE: Halting low-priority recording to prevent disk deadlock and preserve Section 63 evidence.`
      );

      // Halt low-priority cameras entirely to protect OS drive from hard crashing
      await this.prisma.camera.updateMany({
        where: { retentionPriority: 'LOW' },
        data: {
          effectiveRecordingMode: RecordingMode.OFF,
          degradationReason: DegradationReason.EVIDENCE_PRESERVATION,
          degradationSince: now,
        },
      });

      // Downgrade normal cameras to MOTION
      await this.prisma.camera.updateMany({
        where: {
          retentionPriority: 'NORMAL',
          recordingMode: RecordingMode.CONTINUOUS,
        },
        data: {
          effectiveRecordingMode: RecordingMode.MOTION,
          degradationReason: DegradationReason.EVIDENCE_PRESERVATION,
          degradationSince: now,
        },
      });

      await this.recordDegradationEvent(
        'STORAGE_EVIDENCE_DEADLOCK_PREVENTION',
        'Evidence Preservation Priority Mode Active',
        'Disk capacity is nearing full exhaustion with heavy pinned evidence load. Low-priority streams halted to protect appliance filesystem.',
        EventSeverity.CRITICAL
      );
    } else if (targetState === 'AVAILABLE' && this.currentState !== 'AVAILABLE') {
      console.info(
        `[StorageDegradeManager] Storage pressure cleared. Restoring configured recording modes across all cameras.`
      );

      const cameras = await this.prisma.camera.findMany({
        where: { degradationReason: { not: 'NONE' } },
      });

      for (const cam of cameras) {
        await this.prisma.camera.update({
          where: { id: cam.id },
          data: {
            effectiveRecordingMode: cam.recordingMode,
            degradationReason: DegradationReason.NONE,
            degradationSince: null,
          },
        });
      }

      await this.recordDegradationEvent(
        'STORAGE_DEGRADED_MODE_CLEARED',
        'Storage Degradation Resolved',
        'Storage pressure resolved. All cameras returned to their configured continuous recording policies.',
        EventSeverity.INFO
      );
    }
  }

  private async recordDegradationEvent(
    type: any,
    title: string,
    description: string,
    severity: EventSeverity
  ): Promise<void> {
    try {
      await this.prisma.event.create({
        data: {
          type,
          severity: severity as any,
          title,
          description,
        },
      });

      const tenants = await this.prisma.tenant.findMany({ select: { id: true } });
      for (const t of tenants) {
        if (severity === EventSeverity.CRITICAL) {
          await this.prisma.alarm.create({
            data: {
              tenantId: t.id,
              severity,
              state: AlarmState.ACTIVE,
              title,
              description,
              metadataJson: { type },
            },
          });
        }
      }
    } catch (err: any) {
      console.error('[StorageDegradeManager] Failed to record degradation event:', err.message);
    }
  }
}

export default StorageDegradeManagerService;
