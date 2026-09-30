import prisma from './config/database';
import config from './config/env';
import app from './app';
import { aggregator, aiRuntime } from './routes/anpr.routes';
import { redactionQueue } from './routes/privacy.routes';
import { RetentionPurger } from './services/privacy/dataProtection.service';

const retentionPurger = new RetentionPurger(prisma);
import { CropPurger } from './services/crops/cropPurge.service';
import { startCropWorkers } from './services/crops/cropWorkers';
import { startEmbeddingWorkers } from './services/search/embeddingWorkers';
import { startVlmWorkers } from './services/vlm/vlmWorkers';

const cropPurger = new CropPurger(prisma);
let cropWorkers: { stop(): void } | null = null;
let embeddingWorkers: { stop(): void } | null = null;
let vlmWorkers: { stop(): void } | null = null;
import { dispatcher } from './routes/notification.routes';
import { alarmWorkflow } from './routes/alarm.routes';
import { cameraEventManager } from './routes/cameraEvents.routes';
import { FeatureFlag, isFeatureEnabled } from './config/featureFlags';
import { RecordingCatalog } from './services/recording/catalog/recordingCatalog.service';
import { StorageSentinelService } from './services/storageSentinel.service';
import SegmentJobWorkerService from './services/storage/segmentJobWorker.service';
import StartupReconcilerService from './services/reconciliation/startupReconciler.service';
import recordingScheduleService from './services/schedule/recordingSchedule.service';
import streamWatchdogService from './services/watchdog/streamWatchdog.service';
import { recordingWatchdogService } from './services/recording/recordingWatchdog.service';
import cameraConnectionManager from './services/camera/cameraConnectionManager.service';
import { incidentOrchestrator } from './services/incident/orchestrator/incidentOrchestrator.service';

// Background Services
export const recordingCatalog = new RecordingCatalog(prisma);
const storageSentinel = new StorageSentinelService(prisma);

export const server = app.listen(config.PORT, () => {
  console.log(`[VigilOne] Backend API running on port ${config.PORT} (env: ${config.NODE_ENV})`);
  console.log(`[VigilOne] MediaMTX API configured at: ${config.MEDIAMTX_API_URL}`);

  // Start background services & startup reconciler unless running in test mode
  if (config.NODE_ENV !== 'test') {
    SegmentJobWorkerService.start(2000);
    recordingCatalog.startReconciler(300000); // 5-minute safety reconciliation fallback
    storageSentinel.start(60000);
    recordingScheduleService.start(60000);
    streamWatchdogService.start(30000);
    recordingCatalog.startRetention(3600000);
    recordingWatchdogService.start(30000);
    if (isFeatureEnabled(FeatureFlag.ANPR)) {
      aggregator.start();
      // Legacy in-process ANPR runtime (no model of its own). Object detection runs in the
      // ai-worker (Phase 2); this one only serves the flagged ANPR routes until P4.1 replaces it.
      aiRuntime.start();
    }
    dispatcher.start();
    incidentOrchestrator.start();
    alarmWorkflow.start(15000);
    retentionPurger.start(Number(process.env.DPDP_PURGE_INTERVAL_MS || 3_600_000));
    redactionQueue
      .recoverInterrupted()
      .then((n) => n && console.warn(`[Redaction] ${n} job(s) interrupted by a restart were marked FAILED`))
      .catch((err) => console.error('[Redaction] recovery failed:', err.message));
    if (isFeatureEnabled(FeatureFlag.CAMERA_EVENTS)) cameraEventManager.start(15000);
    cropWorkers = startCropWorkers(cropPurger);
    embeddingWorkers = startEmbeddingWorkers(prisma);
    vlmWorkers = startVlmWorkers(prisma);

    // Boot self-healing: reconcile PostgreSQL desired state with MediaMTX reality
    StartupReconcilerService.reconcile().catch((err) => {
      console.error('[StartupReconciler] Boot reconciliation warning:', err.message);
    });
  }
});

process.on('SIGTERM', async () => {
  console.log('[VigilOne] Shutting down gracefully...');
  SegmentJobWorkerService.stop();
  recordingCatalog.stop();
  storageSentinel.stop();
  recordingScheduleService.stop();
  streamWatchdogService.stop();
  recordingWatchdogService.stop();
  cameraConnectionManager.stop();
  aggregator.stop();
  aiRuntime.stop();
  dispatcher.stop();
  incidentOrchestrator.stop();
  alarmWorkflow.stop();
  retentionPurger.stop();
  cropWorkers?.stop();
  embeddingWorkers?.stop();
  vlmWorkers?.stop();
  await cameraEventManager.stop();
  server.close(() => {
    prisma.$disconnect();
    process.exit(0);
  });
});

export default app;
