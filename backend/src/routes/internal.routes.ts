import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import prisma from '../config/database';
import { EventType, JobStatus } from '@prisma/client';
import config from '../config/env';
import { ModelManifestService } from '../services/ai/modelManifest.service';
import { ModelRegistryService, ModelRegistryError } from '../services/ai/modelRegistry.service';
import { DetectionIngestionService, DetectionIngestionError } from '../services/ai/detectionIngestion.service';
import { spatialEngine } from '../services/spatial/engine';
import { AnprIngestionService, AnprIngestionError } from '../services/anpr/anprIngestion.service';
import { incidentOrchestrator, plateAggregator as anprAggregator, trackIndex } from '../composition';
import { FeatureFlag, isFeatureEnabled } from '../config/featureFlags';
import { CameraSabotageError, CameraSabotageService } from '../services/camera/cameraSabotage';

let currentSpatialEngine = spatialEngine;

export function setSpatialEngine(engine: any) {
  currentSpatialEngine = engine;
}

export function getSpatialEngine() {
  return currentSpatialEngine;
}

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

// Model Manifest Registration Handler
export async function handleRegisterModelManifest(req: Request, res: Response) {
  try {
    const service = new ModelManifestService(prisma);
    const manifest = await service.registerModelManifest(req.body);
    return res.status(201).json({ manifest });
  } catch (err: any) {
    if (
      err.message?.includes('validation failed') ||
      err.message?.includes('immutability violation')
    ) {
      return res.status(400).json({ error: err.message });
    }
    console.error('Error registering model manifest:', err);
    return res.status(500).json({ error: 'Failed to register model manifest' });
  }
}

// Governed Detection Event Ingestion Handler (Phase 2: provenance required, orchestrator-fed)
export async function handleIngestDetection(req: Request, res: Response) {
  try {
    const out = await getDetectionIngestion().ingest(req.body);
    return res.status(200).json({
      success: true,
      detectionId: out.detectionId,
      inferenceId: out.inferenceId,
      ...(out.duplicate ? { duplicate: true } : {}),
      incidentsCreated: out.incidentsCreated,
      aiEventsEmitted: out.aiEventsEmitted,
    });
  } catch (err: any) {
    if (err instanceof DetectionIngestionError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code, inferenceId: req.body?.inferenceId });
    }
    console.error('Error ingesting detection:', err);
    return res.status(500).json({ error: 'Failed to ingest detection event' });
  }
}

let detectionIngestion: DetectionIngestionService | null = null;
function getDetectionIngestion(): DetectionIngestionService {
  if (!detectionIngestion) detectionIngestion = new DetectionIngestionService(prisma, () => currentSpatialEngine, incidentOrchestrator, undefined, trackIndex);
  return detectionIngestion;
}
/** Test hook: replace the ingestion service (e.g. with an injected orchestrator). */
export function setDetectionIngestionService(svc: DetectionIngestionService | null) {
  detectionIngestion = svc;
}

// --- Model registry for the AI worker (P2.6) ---

const registry = () => new ModelRegistryService(prisma);

export async function handleGetDeployedModel(req: Request, res: Response) {
  const task = typeof req.query.task === 'string' && req.query.task ? req.query.task : 'object_detection';
  try {
    return res.status(200).json({ model: await registry().getDeployed(task) });
  } catch (err: any) {
    console.error('Error reading deployed model:', err);
    return res.status(500).json({ error: 'Failed to read the deployed model' });
  }
}

export async function handleBootstrapDeploy(req: Request, res: Response) {
  const { modelManifestId, adapterId } = req.body || {};
  if (typeof modelManifestId !== 'string' || !modelManifestId || typeof adapterId !== 'string' || !adapterId) {
    return res.status(400).json({ error: 'modelManifestId and adapterId are required' });
  }
  try {
    const r = await registry().deployIfNoneDeployed(modelManifestId, adapterId);
    return res.status(200).json({ deployed: r.deployed, model: r.manifest });
  } catch (err: any) {
    if (err instanceof ModelRegistryError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    console.error('Error in bootstrap deploy:', err);
    return res.status(500).json({ error: 'Failed to deploy model' });
  }
}

export async function handleModelLifecycleEvent(req: Request, res: Response) {
  try {
    await registry().recordWorkerReport(req.body || {});
    return res.status(201).json({ recorded: true });
  } catch (err: any) {
    if (err instanceof ModelRegistryError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    console.error('Error recording model lifecycle event:', err);
    return res.status(500).json({ error: 'Failed to record model lifecycle event' });
  }
}

/**
 * Motion-gating inputs for the worker (P2.5): a camera is ARMED when an enabled spatial rule or an
 * AI-trigger automation rule applies to it; lastMotionAt is the latest classical motion episode.
 */
export async function handleGetAiActivity(_req: Request, res: Response) {
  try {
    const cameras = await prisma.camera.findMany({ select: { id: true, tenantId: true } });
    const spatial = await prisma.spatialAnalyticsRule.findMany({ where: { enabled: true }, select: { cameraId: true } });
    const aiRules = await prisma.automationRule.findMany({
      where: { enabled: true, triggerType: { in: ['PERSON_DETECTED', 'VEHICLE_DETECTED', 'TRIPWIRE_CROSS', 'LOITERING_DWELL', 'UNATTENDED_OBJECT', 'WRONG_WAY', 'PERSON_DOWN', 'FENCE_CLIMB'] } },
      select: { tenantId: true, triggerConfigJson: true },
    });
    const since = new Date(Date.now() - 10 * 60 * 1000);
    const motion = await prisma.event.groupBy({
      by: ['cameraId'],
      where: { type: EventType.MOTION, lastDetectedAt: { gte: since } },
      _max: { lastDetectedAt: true },
    });
    const armedCams = new Set(spatial.map((r) => r.cameraId));
    const armedTenants = new Set<string>();
    for (const r of aiRules) {
      const camId = (r.triggerConfigJson as any)?.cameraId;
      if (camId) armedCams.add(camId);
      else armedTenants.add(r.tenantId);
    }
    const lastMotion = new Map(motion.map((m) => [m.cameraId, m._max.lastDetectedAt]));
    return res.status(200).json({
      cameras: cameras.map((c) => ({
        cameraId: c.id,
        armed: armedCams.has(c.id) || armedTenants.has(c.tenantId),
        lastMotionAt: lastMotion.get(c.id)?.toISOString() ?? null,
      })),
    });
  } catch (err: any) {
    console.error('Error computing AI activity:', err);
    return res.status(500).json({ error: 'Failed to compute AI activity' });
  }
}

// Camera Discovery for AI Worker Loopback Feeds (Strict Privacy Redaction)
export async function handleGetInternalCameras(req: Request, res: Response) {
  try {
    const where: any = {};
    if (typeof req.query.tenantId === 'string' && req.query.tenantId.trim()) {
      where.tenantId = req.query.tenantId.trim();
    }
    if (req.query.monitored !== undefined) {
      where.monitored = req.query.monitored === 'true';
    }

    // Explicitly select only non-sensitive fields. Never expose IP, ONVIF credentials, or external RTSP URIs.
    const cameras = await prisma.camera.findMany({
      where,
      select: {
        id: true,
        tenantId: true,
        name: true,
        streamPath: true,
        monitored: true,
      },
      orderBy: { name: 'asc' },
    });

    return res.status(200).json({ cameras });
  } catch (err: any) {
    console.error('Error fetching internal cameras:', err);
    return res.status(500).json({ error: 'Failed to retrieve internal cameras' });
  }
}

router.get('/cameras', handleGetInternalCameras);
router.post('/segment-complete', handleSegmentComplete);
router.post('/model-manifests', handleRegisterModelManifest);
router.post('/detections', handleIngestDetection);
router.get('/ai/models/deployed', handleGetDeployedModel);
router.post('/ai/models/bootstrap-deploy', handleBootstrapDeploy);
router.post('/ai/model-events', handleModelLifecycleEvent);
router.get('/ai/activity', handleGetAiActivity);

/** ANPR adapter endpoints (P4.1). Off with the ANPR flag, like the public ANPR API. */
function anprEnabled(res: Response): boolean {
  if (isFeatureEnabled(FeatureFlag.ANPR)) return true;
  res.status(501).json({ error: 'ANPR is disabled on this appliance', code: 'FEATURE_DISABLED' });
  return false;
}

router.get('/anpr/cameras', async (_req: Request, res: Response) => {
  if (!anprEnabled(res)) return;
  const cameras = await prisma.camera.findMany({
    where: { lprMode: true },
    select: { id: true, tenantId: true, streamPath: true, lprConfigJson: true },
  });
  return res.json({ cameras: cameras.map((c) => ({ cameraId: c.id, tenantId: c.tenantId, streamPath: c.streamPath, lpr: c.lprConfigJson ?? {} })) });
});

router.post('/anpr/observations', async (req: Request, res: Response) => {
  if (!anprEnabled(res)) return;
  try {
    const results = await new AnprIngestionService(prisma, anprAggregator, trackIndex).ingest(req.body);
    return res.json({ accepted: results.length, observations: results.map((r) => ({ id: r.observationId, plate: r.normalizedPlate, isNew: r.isNewObservation, watchlist: r.matchedWatchlist.map((m) => m.id) })) });
  } catch (err: any) {
    if (err instanceof AnprIngestionError) return res.status(err.status).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: err.message });
  }
});

/** Camera-sabotage reports from the AI worker (ADR 0019). Off with the CAMERA_SABOTAGE flag. */
let cameraSabotage: CameraSabotageService | null = null;
router.post('/camera-sabotage', async (req: Request, res: Response) => {
  if (!isFeatureEnabled(FeatureFlag.CAMERA_SABOTAGE)) {
    return res.status(501).json({ error: 'Camera-sabotage detection is disabled on this appliance', code: 'FEATURE_DISABLED' });
  }
  try {
    cameraSabotage ??= new CameraSabotageService(prisma, (ev) => incidentOrchestrator.ingestEvent(ev));
    const { eventId, result } = await cameraSabotage.report(req.body);
    return res.json({
      eventId,
      ...(result.duplicate ? { duplicate: true } : {}),
      rulesTriggered: result.rulesTriggered,
      ...(result.alarmId ? { alarmId: result.alarmId } : {}),
    });
  } catch (err: any) {
    if (err instanceof CameraSabotageError) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error('Error ingesting camera-sabotage report:', err);
    return res.status(500).json({ error: 'Failed to ingest camera-sabotage report' });
  }
});

export default router;
