/**
 * The composition root: every long-lived module of the backend is built here, once, and wired to the others.
 * Routes take their instances from here instead of constructing their own, and server.ts starts and stops
 * the background services through startBackgroundServices / stopBackgroundServices.
 *
 * One RecordingCatalog serves recording queries, evidence, playback, the alarm workflow and the orchestrator's
 * bookmarks. One IncidentOrchestrator is built here and every event producer is handed its ingestEvent (none of
 * them imports it). Its RelayAdapter drives relays for rules, the relay routes and door unlocks.
 */
import prisma from './config/database';
import { FeatureFlag, isFeatureEnabled } from './config/featureFlags';
import { RecordingCatalog } from './services/recording/catalog/recordingCatalog.service';
import { EvidenceArchive } from './services/evidence/archive';
import { IncidentOrchestrator } from './services/incident/orchestrator/incidentOrchestrator.service';
import { AlarmWorkflowService } from './services/incident/workflow/alarmWorkflow.service';
import { NotificationAdapter } from './services/incident/orchestrator/adapters/notificationAdapter';
import NotificationDispatcherService from './services/notification/notificationDispatcher.service';
import PlateTrackAggregatorService from './services/anpr/plateTrackAggregator.service';
import EdgeAiRuntimeService from './services/ai/edgeAiRuntime.service';
import { VideoRedactorService } from './services/privacy/videoRedactor.service';
import { RedactionQueue } from './services/privacy/redactionQueue';
import { RetentionPurger } from './services/privacy/dataProtection.service';
import { CameraEventManager } from './services/cameraEvents/cameraEventManager.service';
import { PlaybackSyncService } from './services/playback/playbackSync.service';
import { StorageSentinelService } from './services/storageSentinel.service';
import { DoorMonitor } from './services/access/doorMonitor';
import { CropPurger } from './services/crops/cropPurge.service';
import { startCropWorkers } from './services/crops/cropWorkers';
import { startEmbeddingWorkers } from './services/search/embeddingWorkers';
import { FederationUplink, startFederationUplink } from './services/federation/uplink';
import { ArchiveWorker, archiveIntervalMs, ObjectStorageArchiveService } from './services/storage/objectStorageArchive.service';
import { startVlmWorkers } from './services/vlm/vlmWorkers';
import SegmentJobWorkerService from './services/storage/segmentJobWorker.service';
import StartupReconcilerService from './services/reconciliation/startupReconciler.service';
import recordingScheduleService from './services/schedule/recordingSchedule.service';
import streamWatchdogService from './services/watchdog/streamWatchdog.service';
import sceneChangeDetector from './services/motion/sceneChangeDetector.service';
import { recordingWatchdogService } from './services/recording/recordingWatchdog.service';
import cameraConnectionManager from './services/camera/cameraConnectionManager.service';
import { setting } from './config/settings';
import { CameraRegistry } from './services/camera/cameraRegistry';
import { TrackIndexService } from './services/tracks/trackIndex.service';

// --- Modules shared by routes and background services ---------------------------------------------------
export const recordingCatalog = new RecordingCatalog(prisma);
export const cameraRegistry = new CameraRegistry(prisma);
export const incidentOrchestrator = new IncidentOrchestrator(prisma, { recordingCatalog });
export const relayAdapter = incidentOrchestrator.relay;
const ingest = (ev: Parameters<IncidentOrchestrator['ingestEvent']>[0]) => incidentOrchestrator.ingestEvent(ev);
export const evidenceArchive = new EvidenceArchive(prisma, recordingCatalog);
export const playbackSync = new PlaybackSyncService(prisma, recordingCatalog);
export const alarmWorkflow = new AlarmWorkflowService(prisma, new NotificationAdapter(prisma), recordingCatalog);
export const notificationDispatcher = new NotificationDispatcherService(prisma);
export const plateAggregator = new PlateTrackAggregatorService(prisma);
plateAggregator.setEventSink(ingest);
streamWatchdogService.setEventSink(ingest);
sceneChangeDetector.setEventSink(ingest);
export const trackIndex = new TrackIndexService(prisma);
export const edgeAiRuntime = new EdgeAiRuntimeService(prisma);
export const videoRedactor = new VideoRedactorService(prisma);
export const redactionQueue = new RedactionQueue(prisma, videoRedactor);
export const cameraEventManager = new CameraEventManager(prisma, ingest);

// --- Background-only modules ------------------------------------------------------------------------------
const storageSentinel = new StorageSentinelService(prisma, ingest);
const doorMonitor = new DoorMonitor(prisma, ingest);
const retentionPurger = new RetentionPurger(prisma);
const cropPurger = new CropPurger(prisma);
let cropWorkers: { stop(): void } | null = null;
let embeddingWorkers: { stop(): void } | null = null;
let federationUplink: FederationUplink | null = null;
let archiveWorker: ArchiveWorker | null = null;
let vlmWorkers: { stop(): void } | null = null;

/**
 * Background services. With high availability on (VIGILONE_HA_NODE_ID set), only the node holding the leader
 * lease runs them; see services/cluster/leaderLease.ts and docs/operations/HIGH_AVAILABILITY.md.
 */
export function startBackgroundServices(): void {
  SegmentJobWorkerService.start(2000);
  recordingCatalog.startReconciler(300000); // 5-minute safety reconciliation fallback
  recordingCatalog.startIntegrityChecks(); // presence/size every run, content hash within a byte budget (INTEGRITY_* settings)
  storageSentinel.start(60000);
  recordingScheduleService.start(60000);
  streamWatchdogService.start(30000);
  recordingCatalog.startRetention(3600000);
  recordingWatchdogService.start(30000);
  if (isFeatureEnabled(FeatureFlag.ANPR)) {
    plateAggregator.start();
    // Legacy in-process ANPR runtime (no model of its own). Object detection runs in the
    // ai-worker (Phase 2); this one only serves the flagged ANPR routes until P4.1 replaces it.
    edgeAiRuntime.start();
  }
  notificationDispatcher.start();
  incidentOrchestrator.start();
  alarmWorkflow.start(15000);
  retentionPurger.start(setting('DPDP_PURGE_INTERVAL_MS'));
  redactionQueue
    .recoverInterrupted()
    .then((n) => n && console.warn(`[Redaction] ${n} job(s) interrupted by a restart were marked FAILED`))
    .catch((err) => console.error('[Redaction] recovery failed:', err.message));
  if (isFeatureEnabled(FeatureFlag.CAMERA_EVENTS)) cameraEventManager.start(15000);
  if (isFeatureEnabled(FeatureFlag.DIO_RELAY)) doorMonitor.start(setting('DOOR_POLL_INTERVAL_MS'));
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

/** Stops every background service (safe to call when they never started). */
export async function stopBackgroundServices(): Promise<void> {
  SegmentJobWorkerService.stop();
  recordingCatalog.stop();
  storageSentinel.stop();
  doorMonitor.stop();
  recordingScheduleService.stop();
  streamWatchdogService.stop();
  recordingWatchdogService.stop();
  cameraConnectionManager.stop();
  plateAggregator.stop();
  edgeAiRuntime.stop();
  notificationDispatcher.stop();
  incidentOrchestrator.stop();
  alarmWorkflow.stop();
  retentionPurger.stop();
  cropWorkers?.stop();
  embeddingWorkers?.stop();
  federationUplink?.stop();
  archiveWorker?.stop();
  vlmWorkers?.stop();
  await cameraEventManager.stop();
}
