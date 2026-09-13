import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import prisma from '../config/database';
import { JobStatus } from '@prisma/client';
import config from '../config/env';

const router = Router();

// Internal security middleware
export function requireInternalSecret(req: Request, res: Response, next: Function) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Internal secret required' });
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer' || !parts[1]) {
    return res.status(401).json({ error: 'Unauthorized: Malformed Bearer authorization header' });
  }

  const token = parts[1];
  const secret = config.INTERNAL_API_SECRET;
  if (!secret) {
    return res.status(500).json({ error: 'Internal API secret not configured on appliance' });
  }

  const tokenBuf = Buffer.from(token, 'utf8');
  const secretBuf = Buffer.from(secret, 'utf8');

  const isLengthMatch = tokenBuf.length === secretBuf.length;
  const tokenHash = crypto.createHash('sha256').update(tokenBuf).digest();
  const secretHash = crypto.createHash('sha256').update(secretBuf).digest();

  const isMatch = crypto.timingSafeEqual(tokenHash, secretHash) && isLengthMatch;
  if (!isMatch) {
    return res.status(403).json({ error: 'Forbidden: Invalid internal secret' });
  }

  next();
}

router.use(requireInternalSecret);

// MediaMTX runOnRecordSegmentComplete Webhook
export async function handleSegmentComplete(req: Request, res: Response) {
  const { path: streamPath, file: segmentPath } = req.body;

  if (!streamPath || !segmentPath) {
    return res.status(400).json({ error: 'Missing path or file in payload' });
  }

  try {
    // Find camera matching this streamPath or camera id
    const camera = await prisma.camera.findFirst({
      where: { OR: [{ streamPath }, { id: streamPath }] },
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
}

router.post('/segment-complete', handleSegmentComplete);

export default router;
