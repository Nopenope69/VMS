import { Router, Request, Response } from 'express';
import prisma from '../config/database';
import { requireAuth } from '../middleware/auth';
import { authorize, Permission } from '../services/rbac/permissions';
import { ObjectStorageArchiveService } from '../services/storage/objectStorageArchive.service';
import { encryptCredential } from '../utils/crypto';
import { setting } from '../config/settings';

/** The stored configuration without its credentials: they are write-only. */
function publicConfig(c: any) {
  if (!c) return null;
  const { accessKeyEncrypted, secretKeyEncrypted, ...rest } = c;
  return { ...rest, credentialsSet: Boolean(accessKeyEncrypted && secretKeyEncrypted) };
}
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const router = Router();
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
      res.json({ config: publicConfig(config) });
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
      if ((offPeakStartUtc && !HHMM.test(offPeakStartUtc)) || (offPeakEndUtc && !HHMM.test(offPeakEndUtc))) {
        res.status(400).json({ error: 'offPeakStartUtc and offPeakEndUtc must be HH:MM (UTC)' });
        return;
      }
      if (endpoint) {
        try {
          const u = new URL(endpoint);
          if (u.protocol !== 'https:' && !(u.protocol === 'http:' && setting('ARCHIVE_ALLOW_INSECURE_ENDPOINT'))) throw new Error();
        } catch {
          res.status(400).json({ error: 'endpoint must be an https URL (http only with ARCHIVE_ALLOW_INSECURE_ENDPOINT=true, for a lab)' });
          return;
        }
      }

      const config = await prisma.objectStorageConfig.upsert({
        where: { tenantId },
        create: {
          tenantId,
          provider: provider || 'S3_COMPATIBLE',
          endpoint,
          bucket,
          region: region || 'us-east-1',
          accessKeyEncrypted: encryptCredential(String(accessKey)),
          secretKeyEncrypted: encryptCredential(String(secretKey)),
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
          accessKeyEncrypted: encryptCredential(String(accessKey)),
          secretKeyEncrypted: encryptCredential(String(secretKey)),
          offPeakStartUtc: offPeakStartUtc || '01:00',
          offPeakEndUtc: offPeakEndUtc || '05:00',
          bandwidthLimitKbps: bandwidthLimitKbps ? Number(bandwidthLimitKbps) : 2048,
          enabled: enabled !== undefined ? Boolean(enabled) : true,
        },
      });

      res.json({ config: publicConfig(config) });
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
 * Queue one indexed segment of this tenant for off-site archival (by segment id; the path comes from the index).
 */
router.post(
  '/queue',
  requireAuth,
  authorize(Permission.OBJECT_STORAGE_MANAGE),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { segmentId, priority } = req.body || {};
      if (typeof segmentId !== 'string' || !segmentId) {
        res.status(400).json({ error: 'segmentId is required (file paths are not accepted)' });
        return;
      }
      const job = await archiveService.queueSegment(req.user!.tenantId, segmentId, Boolean(priority));
      res.status(201).json({ job: { ...job, sizeBytes: job.sizeBytes.toString() } });
    } catch (err: any) {
      res.status(err.statusCode || 400).json({ error: err.message });
    }
  }
);

export default router;
