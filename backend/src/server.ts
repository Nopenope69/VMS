import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { PrismaClient } from '@prisma/client';
import config from './config/env';
import healthRoutes from './routes/health.routes';
import authRoutes from './routes/auth.routes';
import mediaAuthRoutes from './routes/mediaAuth.routes';
import cameraRoutes from './routes/camera.routes';
import playbackRoutes from './routes/playback.routes';
import evidenceRoutes from './routes/evidence.routes';
import siteRoutes from './routes/site.routes';
import userRoutes from './routes/user.routes';
import eventRoutes from './routes/event.routes';
import auditRoutes from './routes/audit.routes';
import licenseRoutes from './routes/license.routes';
import internalRoutes from './routes/internal.routes';
import { RecordingIndexerService } from './services/recordingIndexer.service';
import { StorageSentinelService } from './services/storageSentinel.service';
import SegmentJobWorkerService from './services/storage/segmentJobWorker.service';
import StartupReconcilerService from './services/reconciliation/startupReconciler.service';

const app = express();
const prisma = new PrismaClient();

// Security middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// API Routes
app.use('/api/v1', healthRoutes);
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/media', mediaAuthRoutes);
app.use('/api/v1/cameras', cameraRoutes);
app.use('/api/v1/playback', playbackRoutes);
app.use('/api/v1/evidence', evidenceRoutes);
app.use('/api/v1/sites', siteRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/events', eventRoutes);
app.use('/api/v1/audit', auditRoutes);
app.use('/api/v1/license', licenseRoutes);
app.use('/api/v1/internal', internalRoutes);

// Global Error Handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('[Server Error]', err);
  res.status(err.statusCode || 500).json({ error: err.message || 'Internal Server Error' });
});

// Background Services
const indexer = new RecordingIndexerService(prisma);
const storageSentinel = new StorageSentinelService(prisma);

export const server = app.listen(config.PORT, () => {
  console.log(`[VigilOne] Backend API running on port ${config.PORT} (env: ${config.NODE_ENV})`);
  console.log(`[VigilOne] MediaMTX API configured at: ${config.MEDIAMTX_API_URL}`);

  // Start background services & startup reconciler unless running in test mode
  if (config.NODE_ENV !== 'test') {
    SegmentJobWorkerService.start(2000);
    indexer.start(300000); // 5-minute safety reconciliation fallback
    storageSentinel.start(60000);

    // Boot self-healing: reconcile PostgreSQL desired state with MediaMTX reality
    StartupReconcilerService.reconcile().catch((err) => {
      console.error('[StartupReconciler] Boot reconciliation warning:', err.message);
    });
  }
});

process.on('SIGTERM', async () => {
  console.log('[VigilOne] Shutting down gracefully...');
  SegmentJobWorkerService.stop();
  indexer.stop();
  storageSentinel.stop();
  server.close(() => {
    prisma.$disconnect();
    process.exit(0);
  });
});

export default app;
