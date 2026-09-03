import { Router, Request, Response } from 'express';
import fs from 'fs';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth';

const router = Router();
const prisma = new PrismaClient();

router.use(requireAuth);

/**
 * Query recording segments for a camera across a time window
 */
router.get('/:cameraId/segments', async (req: Request, res: Response) => {
  const { start, end } = req.query;

  try {
    const camera = await prisma.camera.findFirst({
      where: { id: req.params.cameraId, tenantId: req.user!.tenantId },
    });
    if (!camera) return res.status(404).json({ error: 'Camera not found' });

    const whereClause: any = {
      cameraId: camera.id,
      status: 'FINALIZED',
    };

    if (start) {
      whereClause.endTime = { gte: new Date(start as string) };
    }
    if (end) {
      whereClause.startTime = { lte: new Date(end as string) };
    }

    const segments = await prisma.recordingSegment.findMany({
      where: whereClause,
      orderBy: { startTime: 'asc' },
      select: {
        id: true,
        startTime: true,
        endTime: true,
        durationMs: true,
        sizeBytes: true,
        codec: true,
        width: true,
        height: true,
        fps: true,
        sha256Hash: true,
      },
    });

    // Convert BigInt to string for JSON serialization
    const serialized = segments.map((s) => ({
      ...s,
      sizeBytes: s.sizeBytes.toString(),
    }));

    return res.json({ segments: serialized });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Stream an fMP4 recording segment with HTTP range support
 */
router.get('/stream/:segmentId', async (req: Request, res: Response) => {
  try {
    const segment = await prisma.recordingSegment.findUnique({
      where: { id: req.params.segmentId },
      include: { camera: true },
    });

    if (!segment || segment.camera.tenantId !== req.user!.tenantId) {
      return res.status(404).json({ error: 'Segment not found' });
    }

    if (!fs.existsSync(segment.filePath)) {
      return res.status(404).json({ error: 'Segment file missing on storage disk' });
    }

    const stat = fs.statSync(segment.filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      // Parse Range header e.g. "bytes=32324-"
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      const fileStream = fs.createReadStream(segment.filePath, { start, end });

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'video/mp4',
      });

      fileStream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
      });
      fs.createReadStream(segment.filePath).pipe(res);
    }
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
