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
import { FederationUplink, startFederationUplink } from './services/federation/uplink';
import { ArchiveWorker, archiveIntervalMs, ObjectStorageArchiveService } from './services/storage/objectStorageArchive.service';
import { startVlmWorkers } from './services/vlm/vlmWorkers';

const cropPurger = new CropPurger(prisma);
let cropWorkers: { stop(): void } | null = null;
let embeddingWorkers: { stop(): void } | null = null;
let federationUplink: FederationUplink | null = null;
let archiveWorker: ArchiveWorker | null = null;
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
import { LeaderLease } from './services/cluster/leaderLease';
import { setClusterRoleSource } from './services/cluster/clusterRole';

// Background Services
export const recordingCatalog = new RecordingCatalog(prisma);
const storageSentinel = new StorageSentinelService(prisma);


/**
 * Background services. With high availability on (VIGILONE_HA_NODE_ID set), only the node holding the leader
 * lease runs them; see services/cluster/leaderLease.ts and docs/operations/HIGH_AVAILABILITY.md.
 */
function startBackgroundServices(): void {
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
  if (isFeatureEnabled(FeatureFlag.OBJECT_STORAGE_ARCHIVE)) {
    archiveWorker = new ArchiveWorker(new ObjectStorageArchiveService(prisma));
    archiveWorker.start(archiveIntervalMs()); // throws on a bad interval, before anything runs
  }
  startFederationUplink(prisma)
    .then((u) => {
      federationUplink = u;
      if (u) console.log('[FederationUplink] syncing to headquarters');
    })
    .catch((err) => {
      console.error(`[FederationUplink] not started: ${err.message}`);
      process.exit(1);
    });
  vlmWorkers = startVlmWorkers(prisma);

  // Boot self-healing: reconcile PostgreSQL desired state with MediaMTX reality
  StartupReconcilerService.reconcile().catch((err) => {
    console.error('[StartupReconciler] Boot reconciliation warning:', err.message);
  });
}

const haNodeId = process.env.VIGILONE_HA_NODE_ID?.trim();
export const leaderLease = haNodeId
  ? new LeaderLease(prisma, {
      nodeId: haNodeId,
      ttlMs: Number(process.env.VIGILONE_HA_LEASE_TTL_MS || 15_000),
      onLeader: () => startBackgroundServices(),
      // Background services must not keep running without the lease: exit, and let the supervisor restart this
      // node as a follower.
      onLost: (reason) => {
        console.error(`[VigilOne] Lost the leader lease (${reason}); exiting so background services stop.`);
        process.exit(75);
      },
      log: (m) => console.log(m),
    })
  : null;
setClusterRoleSource(() => (leaderLease ? { nodeId: leaderLease.nodeId, role: leaderLease.currentRole } : null));

export const server = app.listen(config.PORT, () => {
  console.log(`[VigilOne] Backend API running on port ${config.PORT} (env: ${config.NODE_ENV})`);
  console.log(`[VigilOne] MediaMTX API configured at: ${config.MEDIAMTX_API_URL}`);

  // Start background services & startup reconciler unless running in test mode
  if (config.NODE_ENV !== 'test') {
    if (leaderLease) {
      console.log(`[VigilOne] High availability on: node ${leaderLease.nodeId}; background services run only on the leader`);
      leaderLease.start();
    } else {
      startBackgroundServices();
    }
  }
});

process.on('SIGTERM', async () => {
  console.log('[VigilOne] Shutting down gracefully...');
  await leaderLease?.release().catch((err) => console.error('[VigilOne] lease release failed:', err.message));
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
  federationUplink?.stop();
  archiveWorker?.stop();
  vlmWorkers?.stop();
  await cameraEventManager.stop();
  server.close(() => {
    prisma.$disconnect();
    process.exit(0);
  });
});

export default app;
