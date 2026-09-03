import { Router, Request, Response } from 'express';
import { PrismaClient, JobStatus } from '@prisma/client';
import config from '../config/env';

const router = Router();
const prisma = new PrismaClient();

// Internal security middleware
function requireInternalSecret(req: Request, res: Response, next: Function) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Internal secret required' });
  }

  const token = authHeader.split(' ')[1];
  if (token !== config.INTERNAL_API_SECRET) {
    return res.status(403).json({ error: 'Forbidden: Invalid internal secret' });
  }

  next();
}

router.use(requireInternalSecret);

// MediaMTX runOnRecordSegmentComplete Webhook
router.post('/segment-complete', async (req: Request, res: Response) => {
  const { path: streamPath, file: segmentPath } = req.body;

  if (!streamPath || !segmentPath) {
    return res.status(400).json({ error: 'Missing path or file in payload' });
  }

  try {
    // Find camera matching this streamPath
    const camera = await prisma.camera.findFirst({
      where: { streamPath },
      select: { id: true, tenantId: true },
    });

    if (!camera) {
      // Path might be an orphaned or temporary test stream
      return res.status(404).json({ error: `Camera for streamPath '${streamPath}' not found` });
    }

    // Insert durable SegmentJob idempotently
    const job = await prisma.segmentJob.upsert({
      where: {
        tenantId_segmentPath: {
          tenantId: camera.tenantId,
          segmentPath,
        },
      },
      update: {}, // idempotent: if already queued, leave unchanged
      create: {
        tenantId: camera.tenantId,
        cameraId: camera.id,
        streamPath,
        segmentPath,
        status: JobStatus.PENDING,
      },
    });

    return res.status(200).json({ queued: true, jobId: job.id });
  } catch (err: any) {
    console.error('Error queuing segment job:', err);
    return res.status(500).json({ error: 'Failed to queue segment job' });
  }
});

export default router;
