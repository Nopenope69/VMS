import { Router, Request, Response } from 'express';
import prisma from '../config/database';
import mediaProvider from '../services/media/mediamtx.provider';

const router = Router();

router.get('/health', async (req: Request, res: Response) => {
  let dbStatus = 'ok';
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err: any) {
    dbStatus = `error: ${err.message}`;
  }

  let mediaEngineStatus = 'ok';
  try {
    // getStreamStatus swallows errors (returns null), so it cannot detect an unreachable engine.
    await mediaProvider.ping();
  } catch (err: any) {
    mediaEngineStatus = `error: ${err.message}`;
  }

  const isHealthy = dbStatus === 'ok';

  return res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    services: {
      database: dbStatus,
      mediaEngine: mediaEngineStatus,
    },
  });
});

export default router;
