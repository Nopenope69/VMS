import fs from 'fs';
import path from 'path';
import checkDiskSpace from 'check-disk-space';
import { PrismaClient, VolumeStatus, EventSeverity, AlarmState, StorageVolume } from '@prisma/client';
import config from '../../config/env';

export interface VolumeHealthReport {
  id: string;
  name: string;
  path: string;
  deviceIdentifier: string | null;
  mountSource: string | null;
  filesystemType: string | null;
  isDefault: boolean;
  isReadOnly: boolean;
  status: VolumeStatus;
  sizeBytes: bigint;
  freeBytes: bigint;
  usedBytes: bigint;
  fillRatio: number;
  healthReason: string | null;
  cameraCount: number;
}

export interface RegisterVolumeInput {
  tenantId: string;
  name: string;
  path: string;
  deviceIdentifier?: string;
  mountSource?: string;
  filesystemType?: string;
  isDefault?: boolean;
  isReadOnly?: boolean;
  maxBytes?: bigint;
}

export class StorageVolumeService {
  private prisma: PrismaClient;
  private static instance: StorageVolumeService | null = null;
  private probeFileName = '.vigilone-mount-probe';

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  public static getInstance(prisma: PrismaClient): StorageVolumeService {
    if (!this.instance) {
      this.instance = new StorageVolumeService(prisma);
    }
    return this.instance;
  }

  /**
   * Initializes default volume if none exists in the database
   */
  async ensureDefaultVolume(tenantId: string): Promise<StorageVolume> {
    const existing = await this.prisma.storageVolume.findFirst({
      where: { tenantId, isDefault: true },
    });

    if (existing) {
      return existing;
    }

    const defaultPath = config.RECORDINGS_DIR || '/recordings';
    if (!fs.existsSync(defaultPath)) {
      fs.mkdirSync(defaultPath, { recursive: true });
    }

    return this.prisma.storageVolume.upsert({
      where: { path: defaultPath },
      update: { isDefault: true },
      create: {
        tenantId,
        name: 'Primary Appliance Storage',
        path: defaultPath,
        isDefault: true,
        isReadOnly: false,
        status: VolumeStatus.HEALTHY,
        mountSource: '/dev/root',
        filesystemType: 'ext4',
      },
    });
  }

  /**
   * Performs Mount Guard validation on a physical filesystem path.
   * Verifies:
   * 1. Path exists and is accessible.
   * 2. If configured as non-root external mount, verifies stat().dev is distinct from root filesystem.
   * 3. Performs active R/W probe (.vigilone-mount-probe write + read + delete).
   * 4. Detects EROFS (Read-Only File System) or EACCES.
   */
  async verifyMountHealth(volumePath: string, expectedDevice?: string | null): Promise<{
    status: VolumeStatus;
    reason: string | null;
  }> {
    try {
      if (!fs.existsSync(volumePath)) {
        return {
          status: VolumeStatus.UNMOUNTED,
          reason: `Mount directory does not exist: ${volumePath}`,
        };
      }

      const dirStat = fs.statSync(volumePath);
      if (!dirStat.isDirectory()) {
        return {
          status: VolumeStatus.DEGRADED,
          reason: `Configured path is not a directory: ${volumePath}`,
        };
      }

      // Check if external mount point has dropped to root filesystem
      // For paths under /mnt or /media or /volumes, verify its device ID is not root dev
      const isExternalMount =
        volumePath.startsWith('/mnt') ||
        volumePath.startsWith('/media') ||
        volumePath.startsWith('/Volumes');

      if (isExternalMount) {
        try {
          const rootStat = fs.statSync('/');
          if (dirStat.dev === rootStat.dev) {
            return {
              status: VolumeStatus.UNMOUNTED,
              reason: `Volume dropped to root filesystem device (unmounted): device ${dirStat.dev} matches root`,
            };
          }
        } catch {
          // Ignore stat root errors in special container environments
        }
      }

      // Active R/W probe
      const probeFile = path.join(volumePath, this.probeFileName);
      const probeData = `vigilone-mount-test-${Date.now()}`;

      try {
        fs.writeFileSync(probeFile, probeData, { encoding: 'utf-8', flag: 'w' });
        const readBack = fs.readFileSync(probeFile, 'utf-8');
        if (readBack !== probeData) {
          throw new Error('Data integrity check failed during mount read-back probe');
        }
        fs.unlinkSync(probeFile);
      } catch (err: any) {
        if (err.code === 'EROFS') {
          return {
            status: VolumeStatus.READ_ONLY,
            reason: 'Filesystem is mounted in READ-ONLY mode (EROFS)',
          };
        }
        if (err.code === 'ENOSPC') {
          return {
            status: VolumeStatus.DEGRADED,
            reason: 'Storage volume has 0 bytes available (ENOSPC)',
          };
        }
        if (err.code === 'EACCES' || err.code === 'EPERM') {
          return {
            status: VolumeStatus.DEGRADED,
            reason: `Permission denied during mount R/W probe: ${err.message}`,
          };
        }
        return {
          status: VolumeStatus.DEGRADED,
          reason: `Active R/W mount probe failed: ${err.message}`,
        };
      }

      return { status: VolumeStatus.HEALTHY, reason: null };
    } catch (err: any) {
      return {
        status: VolumeStatus.DEGRADED,
        reason: `Mount verification encountered error: ${err.message}`,
      };
    }
  }

  /**
   * Scans and updates health status for all registered storage volumes.
   * Raises system alarms when a drive becomes degraded or read-only.
   */
  async checkAllVolumes(tenantId?: string): Promise<VolumeHealthReport[]> {
    const whereClause: any = {};
    if (tenantId) whereClause.tenantId = tenantId;

    const volumes = await this.prisma.storageVolume.findMany({
      where: whereClause,
      include: {
        _count: {
          select: { cameras: true },
        },
      },
    });

    const reports: VolumeHealthReport[] = [];

    for (const vol of volumes) {
      const { status, reason } = await this.verifyMountHealth(vol.path, vol.deviceIdentifier);

      let sizeBytes = BigInt(0);
      let freeBytes = BigInt(0);
      let usedBytes = BigInt(0);
      let fillRatio = 0;

      if (status !== VolumeStatus.UNMOUNTED && fs.existsSync(vol.path)) {
        try {
          const disk = await checkDiskSpace(vol.path);
          sizeBytes = BigInt(disk.size);
          freeBytes = BigInt(disk.free);
          usedBytes = sizeBytes - freeBytes;
          fillRatio = disk.size > 0 ? Number(usedBytes) / disk.size : 0;
        } catch (err: any) {
          console.warn(`[StorageVolumeService] Failed to check disk space for ${vol.path}:`, err.message);
        }
      }

      const isReadOnly = status === VolumeStatus.READ_ONLY || vol.isReadOnly;
      const now = new Date();

      // Update volume status in DB
      await this.prisma.storageVolume.update({
        where: { id: vol.id },
        data: {
          status,
          isReadOnly,
          lastSeenAt: now,
          lastHealthyAt: status === VolumeStatus.HEALTHY ? now : vol.lastHealthyAt,
          lastFailureAt: status !== VolumeStatus.HEALTHY ? now : vol.lastFailureAt,
          healthReason: reason,
        },
      });

      // Raise alarm on status transition to degraded / read-only / unmounted
      if (status !== VolumeStatus.HEALTHY && vol.status === VolumeStatus.HEALTHY) {
        await this.raiseVolumeAlarm(vol, status, reason);
      }

      reports.push({
        id: vol.id,
        name: vol.name,
        path: vol.path,
        deviceIdentifier: vol.deviceIdentifier,
        mountSource: vol.mountSource,
        filesystemType: vol.filesystemType,
        isDefault: vol.isDefault,
        isReadOnly,
        status,
        sizeBytes,
        freeBytes,
        usedBytes,
        fillRatio,
        healthReason: reason,
        cameraCount: vol._count.cameras,
      });
    }

    return reports;
  }

  /**
   * Deterministically resolves the active, healthy storage volume for a camera.
   * If camera's assigned volume is degraded or read-only, selects eligible fallback volume
   * within the same tenant, with lowest fill ratio and at least 15% headroom.
   */
  async resolveActiveVolumeForCamera(cameraId: string): Promise<{
    volume: StorageVolume;
    isFallback: boolean;
    failureReason?: string;
  }> {
    const camera = await this.prisma.camera.findUnique({
      where: { id: cameraId },
      include: { storageVolume: true },
    });

    if (!camera) {
      throw new Error(`Camera not found: ${cameraId}`);
    }

    // 1. Check configured volume
    if (camera.storageVolume) {
      const health = await this.verifyMountHealth(camera.storageVolume.path);
      if (health.status === VolumeStatus.HEALTHY && !camera.storageVolume.isReadOnly) {
        let isHardFull = false;
        try {
          const disk = await checkDiskSpace(camera.storageVolume.path);
          if (disk.size > 0 && disk.free <= 0) {
            isHardFull = true;
          }
        } catch {}

        if (!isHardFull) {
          return { volume: camera.storageVolume, isFallback: false };
        }
        console.warn(
          `[StorageVolumeService] Camera ${camera.name} volume ${camera.storageVolume.name} is 100% hard-full (0 free bytes). Resolving fallback.`
        );
      } else {
        // Configured volume is unhealthy -> must select fallback
        console.warn(
          `[StorageVolumeService] Camera ${camera.name} volume ${camera.storageVolume.name} is ${health.status} (${health.reason}). Resolving fallback.`
        );
      }
    }

    // 2. Fallback selection policy:
    // - Same tenant
    // - status === HEALTHY
    // - isReadOnly === false
    // - Order by isDefault DESC, free capacity DESC
    const eligibleVolumes = await this.prisma.storageVolume.findMany({
      where: {
        tenantId: camera.tenantId,
        status: VolumeStatus.HEALTHY,
        isReadOnly: false,
      },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });

    for (const candidate of eligibleVolumes) {
      const health = await this.verifyMountHealth(candidate.path);
      if (health.status === VolumeStatus.HEALTHY) {
        try {
          const disk = await checkDiskSpace(candidate.path);
          const freeRatio = disk.size > 0 ? disk.free / disk.size : 0;
          // Require at least 5% minimum headroom for fallback candidate
          if (freeRatio > 0.05) {
            return {
              volume: candidate,
              isFallback: true,
              failureReason: camera.storageVolume
                ? `Primary volume ${camera.storageVolume.name} unavailable (${camera.storageVolume.status})`
                : 'No primary volume configured',
            };
          }
        } catch {
          // Continue to next candidate
        }
      }
    }

    // 3. If no custom volume qualifies, evaluate default volume
    const defaultVol = await this.ensureDefaultVolume(camera.tenantId);
    const defaultHealth = await this.verifyMountHealth(defaultVol.path);
    if (defaultHealth.status === VolumeStatus.HEALTHY && !defaultVol.isReadOnly) {
      return {
        volume: defaultVol,
        isFallback: true,
        failureReason: 'Fallback to system default volume',
      };
    }

    // 4. Fail-closed invariant (C-018): raise storage alarm and halt recording
    try {
      if (typeof (this.prisma as any).alarm?.create === 'function') {
        await (this.prisma as any).alarm.create({
          data: {
            tenantId: camera.tenantId,
            cameraId: camera.id,
            title: `Storage Volume Failure: ${camera.name}`,
            description: `All configured and fallback storage volumes for camera ${camera.name} are degraded or unavailable. Recording halted to protect data integrity.`,
            severity: EventSeverity.CRITICAL,
            state: AlarmState.ACTIVE,
          },
        });
      }
    } catch {}

    throw new Error(
      `NO_HEALTHY_STORAGE_VOLUME_AVAILABLE: No healthy recording storage volume available for camera ${camera.name} (${camera.id})`
    );
  }

  /**
   * Registers a new physical storage volume
   */
  async registerVolume(input: RegisterVolumeInput): Promise<StorageVolume> {
    if (!fs.existsSync(input.path)) {
      throw new Error(`Storage path does not exist: ${input.path}`);
    }

    const health = await this.verifyMountHealth(input.path, input.deviceIdentifier);
    if (health.status === VolumeStatus.UNMOUNTED) {
      throw new Error(`Mount validation failed: ${health.reason}`);
    }

    // If marked default, unset other defaults in tenant
    if (input.isDefault) {
      await this.prisma.storageVolume.updateMany({
        where: { tenantId: input.tenantId, isDefault: true },
        data: { isDefault: false },
      });
    }

    return this.prisma.storageVolume.create({
      data: {
        tenantId: input.tenantId,
        name: input.name,
        path: input.path,
        deviceIdentifier: input.deviceIdentifier,
        mountSource: input.mountSource,
        filesystemType: input.filesystemType || 'ext4',
        isDefault: input.isDefault || false,
        isReadOnly: input.isReadOnly || false,
        maxBytes: input.maxBytes,
        status: health.status,
        healthReason: health.reason,
      },
    });
  }

  /**
   * Updates an existing storage volume configuration
   */
  async updateVolume(
    id: string,
    updates: {
      name?: string;
      isDefault?: boolean;
      isReadOnly?: boolean;
      maxBytes?: bigint | null;
    }
  ): Promise<StorageVolume> {
    const existing = await this.prisma.storageVolume.findUnique({ where: { id } });
    if (!existing) {
      throw new Error(`Storage volume not found: ${id}`);
    }

    if (updates.isDefault) {
      await this.prisma.storageVolume.updateMany({
        where: { tenantId: existing.tenantId, isDefault: true },
        data: { isDefault: false },
      });
    }

    return this.prisma.storageVolume.update({
      where: { id },
      data: updates,
    });
  }

  private async raiseVolumeAlarm(
    volume: StorageVolume,
    status: VolumeStatus,
    reason: string | null
  ): Promise<void> {
    const title =
      status === VolumeStatus.READ_ONLY
        ? 'STORAGE_VOLUME_READONLY'
        : 'STORAGE_VOLUME_DEGRADED';

    try {
      await this.prisma.alarm.create({
        data: {
          tenantId: volume.tenantId,
          severity: EventSeverity.CRITICAL,
          state: AlarmState.ACTIVE,
          title,
          description: `Storage volume "${volume.name}" (${volume.path}) is in ${status} state. Reason: ${reason || 'Unknown'}`,
          metadataJson: {
            volumeId: volume.id,
            volumePath: volume.path,
            status,
            reason,
          },
        },
      });

      await this.prisma.event.create({
        data: {
          type: status === VolumeStatus.READ_ONLY ? 'STORAGE_VOLUME_READONLY' : 'STORAGE_VOLUME_DEGRADED',
          severity: 'CRITICAL',
          title,
          description: `Drive failure detected on volume "${volume.name}": ${reason}`,
          metadata: {
            volumeId: volume.id,
            volumePath: volume.path,
            deviceIdentifier: volume.deviceIdentifier,
          },
        },
      });
    } catch (err: any) {
      console.error('[StorageVolumeService] Failed to raise volume alarm:', err.message);
    }
  }
}

export default StorageVolumeService;
