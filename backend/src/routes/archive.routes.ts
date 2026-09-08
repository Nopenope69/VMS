import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth';
import { authorize, Permission } from '../services/rbac/permissions';
import { ObjectStorageArchiveService } from '../services/storage/objectStorageArchive.service';

const router = Router();
const prisma = new PrismaClient();
const archiveService = new ObjectStorageArchiveService(prisma);

/**
 * GET /api/v1/archive/config
 * View object storage tiering configuration
 */
router.get(
  '/config',
  requireAuth,
  authorize(Permission.OBJECT_STORAGE_MANAGE),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = req.user!.tenantId;
      const config = await prisma.objectStorageConfig.findUnique({
        where: { tenantId },
      });
      res.json({ config });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * POST /api/v1/archive/config
 * Save object storage tiering configuration
 */
router.post(
  '/config',
  requireAuth,
  authorize(Permission.OBJECT_STORAGE_MANAGE),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = req.user!.tenantId;
      const {
        provider,
        endpoint,
        bucket,
        region,
        accessKey,
        secretKey,
        offPeakStartUtc,
        offPeakEndUtc,
        bandwidthLimitKbps,
        enabled,
      } = req.body;

      if (!bucket || !accessKey || !secretKey) {
        res.status(400).json({ error: 'bucket, accessKey, and secretKey are required' });
        return;
      }

      const config = await prisma.objectStorageConfig.upsert({
        where: { tenantId },
        create: {
          tenantId,
          provider: provider || 'S3_COMPATIBLE',
          endpoint,
          bucket,
          region: region || 'us-east-1',
          accessKeyEncrypted: accessKey, // In production wrapped with encryptCredential
          secretKeyEncrypted: secretKey,
          offPeakStartUtc: offPeakStartUtc || '01:00',
          offPeakEndUtc: offPeakEndUtc || '05:00',
          bandwidthLimitKbps: bandwidthLimitKbps ? Number(bandwidthLimitKbps) : 2048,
          enabled: enabled !== undefined ? Boolean(enabled) : true,
        },
        update: {
          provider: provider || 'S3_COMPATIBLE',
          endpoint,
          bucket,
          region: region || 'us-east-1',
          accessKeyEncrypted: accessKey,
          secretKeyEncrypted: secretKey,
          offPeakStartUtc: offPeakStartUtc || '01:00',
          offPeakEndUtc: offPeakEndUtc || '05:00',
          bandwidthLimitKbps: bandwidthLimitKbps ? Number(bandwidthLimitKbps) : 2048,
          enabled: enabled !== undefined ? Boolean(enabled) : true,
        },
      });

      res.json({ config });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }
);

/**
 * GET /api/v1/archive/jobs
 * List recent archive jobs
 */
router.get(
  '/jobs',
  requireAuth,
  authorize(Permission.OBJECT_STORAGE_MANAGE),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = req.user!.tenantId;
      const jobs = await prisma.archiveJob.findMany({
        where: { tenantId },
        orderBy: { queuedAt: 'desc' },
        take: 50,
      });
      res.json({
        jobs: jobs.map((j: any) => ({
          ...j,
          sizeBytes: j.sizeBytes.toString(),
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * POST /api/v1/archive/queue
 * Queue segment for offsite archival
 */
router.post(
  '/queue',
  requireAuth,
  authorize(Permission.OBJECT_STORAGE_MANAGE),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = req.user!.tenantId;
      const { cameraId, segmentPath, sha256Checksum, sizeBytes, priority } = req.body;

      if (!cameraId || !segmentPath || !sha256Checksum || !sizeBytes) {
        res.status(400).json({ error: 'cameraId, segmentPath, sha256Checksum, and sizeBytes are required' });
        return;
      }

      const job = await archiveService.queueArchiveJob({
        tenantId,
        cameraId,
        segmentPath,
        sha256Checksum,
        sizeBytes: BigInt(sizeBytes),
        priority: Boolean(priority),
      });

      res.status(201).json({
        job: {
          ...job,
          sizeBytes: job.sizeBytes.toString(),
        },
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }
);

export default router;
