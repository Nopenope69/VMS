import { Router, Request, Response } from 'express';
import { PrismaClient, RecordingMode, RetentionPriority } from '@prisma/client';
import { requireAuth } from '../middleware/auth';
import { loadTenantLicense } from '../middleware/license';
import { authorize, Permission } from '../services/rbac/permissions';
import StorageVolumeService from '../services/storage/storageVolume.service';
import StorageDegradeManagerService from '../services/storage/storageDegradeManager.service';
import StorageEpochService from '../services/storage/storageEpoch.service';
import CrashRecoveryService from '../services/reconciliation/crashRecovery.service';
import config from '../config/env';

const router = Router();
const prisma = new PrismaClient();

const volumeService = StorageVolumeService.getInstance(prisma);
const degradeManager = new StorageDegradeManagerService(prisma);
const epochService = new StorageEpochService(prisma);
const crashRecovery = new CrashRecoveryService(prisma);

router.use(requireAuth);
router.use(loadTenantLicense);

/**
 * GET /api/v1/system/storage/status
 * Comprehensive NVR storage operations overview
 */
router.get(
  '/status',
  authorize(Permission.RECORDING_MANAGE),
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.user!.tenantId;

      // 1. Storage rate & vitals evaluation
      const vitals = await degradeManager.evaluateStorageVitals(config.RECORDINGS_DIR);

      // 2. Camera stats
      const allCameras = await prisma.camera.findMany({
        where: { tenantId },
        include: {
          retentionPolicy: true,
          _count: {
            select: { segments: true },
          },
        },
      });

      let healthyCount = 0;
      let degradedCount = 0;
      let stoppedCount = 0;

      const cameraBreakdown = [];

      for (const cam of allCameras) {
        if (cam.effectiveRecordingMode === RecordingMode.OFF || cam.recorderState === 'STOPPED') {
          stoppedCount++;
        } else if (cam.degradationReason !== 'NONE') {
          degradedCount++;
        } else {
          healthyCount++;
        }

        // Sum segment size for this camera
        const segSum = await prisma.recordingSegment.aggregate({
          where: { cameraId: cam.id, status: 'FINALIZED' },
          _sum: { sizeBytes: true },
        });

        cameraBreakdown.push({
          id: cam.id,
          name: cam.name,
          streamPath: cam.streamPath,
          recordingMode: cam.recordingMode,
          effectiveRecordingMode: cam.effectiveRecordingMode,
          degradationReason: cam.degradationReason,
          retentionPriority: cam.retentionPriority,
          segmentCount: cam._count.segments,
          usedBytes: segSum._sum.sizeBytes ? segSum._sum.sizeBytes.toString() : '0',
          retentionDays: cam.retentionPolicy?.continuousDays ?? 30,
          motionDays: cam.retentionPolicy?.motionDays ?? 90,
          maxStorageGigabytes: cam.retentionPolicy?.maxStorageGigabytes ?? null,
        });
      }

      const lastRecovery = CrashRecoveryService.getLastReport();

      return res.json({
        state: vitals.state,
        sizeBytes: vitals.sizeBytes.toString(),
        freeBytes: vitals.freeBytes.toString(),
        usedBytes: vitals.usedBytes.toString(),
        pinnedBytes: vitals.pinnedBytes.toString(),
        fillRatio: vitals.fillRatio,
        writeRateBytesPerHour: vitals.writeRateBytesPerHour,
        projectedExhaustionHours: vitals.projectedExhaustionHours,
        cameraStats: {
          total: allCameras.length,
          healthy: healthyCount,
          degraded: degradedCount,
          stopped: stoppedCount,
        },
        cameraBreakdown,
        lastRecovery,
      });
    } catch (err: any) {
      console.error('[StorageRoutes] Failed to get storage status:', err);
      return res.status(500).json({ error: err.message });
    }
  }
);

/**
 * GET /api/v1/system/storage/volumes
 * List registered storage volumes with live Mount Guard health
 */
router.get(
  '/volumes',
  authorize(Permission.RECORDING_MANAGE),
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.user!.tenantId;
      await volumeService.ensureDefaultVolume(tenantId);
      const reports = await volumeService.checkAllVolumes(tenantId);

      const serialized = reports.map((r) => ({
        ...r,
        sizeBytes: r.sizeBytes.toString(),
        freeBytes: r.freeBytes.toString(),
        usedBytes: r.usedBytes.toString(),
      }));

      return res.json(serialized);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }
);

/**
 * POST /api/v1/system/storage/volumes
 * Register a new physical storage mount path
 */
router.post(
  '/volumes',
  authorize(Permission.RECORDING_MANAGE),
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.user!.tenantId;
      const { name, path, deviceIdentifier, mountSource, filesystemType, isDefault, isReadOnly, maxBytes } = req.body;

      if (!name || !path) {
        return res.status(400).json({ error: 'Volume name and path are required' });
      }

      const volume = await volumeService.registerVolume({
        tenantId,
        name,
        path,
        deviceIdentifier,
        mountSource,
        filesystemType,
        isDefault: Boolean(isDefault),
        isReadOnly: Boolean(isReadOnly),
        maxBytes: maxBytes ? BigInt(maxBytes) : undefined,
      });

      return res.status(201).json({
        ...volume,
        maxBytes: volume.maxBytes ? volume.maxBytes.toString() : null,
      });
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
  }
);

/**
 * PUT /api/v1/system/storage/volumes/:id
 * Update volume configuration
 */
router.put(
  '/volumes/:id',
  authorize(Permission.RECORDING_MANAGE),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { name, isDefault, isReadOnly, maxBytes } = req.body;

      const updated = await volumeService.updateVolume(id, {
        name,
        isDefault,
        isReadOnly,
        maxBytes: maxBytes !== undefined ? (maxBytes ? BigInt(maxBytes) : null) : undefined,
      });

      return res.json({
        ...updated,
        maxBytes: updated.maxBytes ? updated.maxBytes.toString() : null,
      });
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
  }
);

/**
 * GET /api/v1/system/storage/retention
 * List retention policies and quotas
 */
router.get(
  '/retention',
  authorize(Permission.RECORDING_MANAGE),
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.user!.tenantId;
      const policies = await prisma.retentionPolicy.findMany({
        where: { tenantId },
      });
      return res.json(policies);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }
);

/**
 * PUT /api/v1/system/storage/retention
 * Update per-camera or tenant-wide retention policy and quota
 */
router.put(
  '/retention',
  authorize(Permission.RECORDING_MANAGE),
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.user!.tenantId;
      const { cameraId, continuousDays, motionDays, maxStorageGigabytes, retentionPriority } = req.body;

      if (continuousDays !== undefined && (typeof continuousDays !== 'number' || continuousDays < 1)) {
        return res.status(400).json({ error: 'continuousDays must be a positive integer' });
      }

      if (cameraId) {
        // Upsert per-camera policy
        const policy = await prisma.retentionPolicy.upsert({
          where: { cameraId },
          update: {
            continuousDays: continuousDays ?? undefined,
            motionDays: motionDays ?? undefined,
            maxStorageGigabytes: maxStorageGigabytes ?? undefined,
          },
          create: {
            tenantId,
            cameraId,
            continuousDays: continuousDays ?? 30,
            motionDays: motionDays ?? 90,
            maxStorageGigabytes: maxStorageGigabytes ?? null,
          },
        });

        // If priority provided, update Camera model
        if (retentionPriority && ['HIGH', 'NORMAL', 'LOW'].includes(retentionPriority)) {
          await prisma.camera.update({
            where: { id: cameraId },
            data: { retentionPriority: retentionPriority as RetentionPriority },
          });
        }

        return res.json(policy);
      } else {
        // Tenant-wide default policy
        const existing = await prisma.retentionPolicy.findFirst({
          where: { tenantId, cameraId: null },
        });

        let policy;
        if (existing) {
          policy = await prisma.retentionPolicy.update({
            where: { id: existing.id },
            data: {
              continuousDays: continuousDays ?? undefined,
              motionDays: motionDays ?? undefined,
              maxStorageGigabytes: maxStorageGigabytes ?? undefined,
            },
          });
        } else {
          policy = await prisma.retentionPolicy.create({
            data: {
              tenantId,
              cameraId: null,
              continuousDays: continuousDays ?? 30,
              motionDays: motionDays ?? 90,
              maxStorageGigabytes: maxStorageGigabytes ?? null,
            },
          });
        }
        return res.json(policy);
      }
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
  }
);

/**
 * POST /api/v1/system/storage/reconcile
 * Trigger crash recovery & storage integrity reconciliation
 */
router.post(
  '/reconcile',
  authorize(Permission.RECORDING_MANAGE),
  async (_req: Request, res: Response) => {
    try {
      const report = await crashRecovery.recoverStorage();
      return res.json(report);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }
);

/**
 * POST /api/v1/system/storage/failover
 * Execute manual or automated storage failover for a camera
 */
router.post(
  '/failover',
  authorize(Permission.RECORDING_MANAGE),
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.user!.tenantId;
      const { cameraId, toVolumeId, reason } = req.body;

      if (!cameraId || !toVolumeId) {
        return res.status(400).json({ error: 'cameraId and toVolumeId are required' });
      }

      const epoch = await epochService.transitionEpoch({
        tenantId,
        cameraId,
        toVolumeId,
        reason: reason || 'OPERATOR_MANUAL_FAILOVER',
      });

      // Update camera storageVolumeId
      await prisma.camera.update({
        where: { id: cameraId },
        data: { storageVolumeId: toVolumeId },
      });

      return res.json({ success: true, epoch });
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
  }
);

export default router;
