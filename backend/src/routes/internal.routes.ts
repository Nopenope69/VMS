import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import prisma from '../config/database';
import { EventType, JobStatus } from '@prisma/client';
import config from '../config/env';
import { ModelManifestService } from '../services/ai/modelManifest.service';

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

// Governed Detection Event Ingestion Handler
export async function handleIngestDetection(req: Request, res: Response) {
  const {
    tenantId,
    cameraId,
    modelManifestId,
    inferenceId,
    type,
    confidence,
    boundingBox,
    centroid,
    attributesJson,
    timestamp,
    snapshotPath,
  } = req.body;

  // 1. Mandatory identity & relation validation
  if (!tenantId || typeof tenantId !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid tenantId' });
  }
  if (!cameraId || typeof cameraId !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid cameraId' });
  }
  if (!modelManifestId || typeof modelManifestId !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid modelManifestId' });
  }
  if (!inferenceId || typeof inferenceId !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid unique inferenceId' });
  }

  // 2. Detection class / event type validation
  if (!type || !Object.values(EventType).includes(type as EventType)) {
    return res.status(400).json({ error: `Invalid detection type: '${type}'. Must be a valid EventType.` });
  }

  // 3. Confidence score validation (0.0 to 1.0)
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1.0 || isNaN(confidence)) {
    return res.status(400).json({ error: 'Confidence must be a float between 0.0 and 1.0' });
  }

  // 4. Bounding box validation if present
  if (boundingBox) {
    if (
      typeof boundingBox.x !== 'number' ||
      typeof boundingBox.y !== 'number' ||
      typeof boundingBox.width !== 'number' ||
      typeof boundingBox.height !== 'number' ||
      boundingBox.x < 0 ||
      boundingBox.y < 0 ||
      boundingBox.width <= 0 ||
      boundingBox.height <= 0
    ) {
      return res.status(400).json({ error: 'boundingBox coordinates must be valid normalized numbers' });
    }
  }

  try {
    // 5. Verify camera belongs to tenant
    const camera = await prisma.camera.findFirst({
      where: {
        OR: [{ id: cameraId }, { streamPath: cameraId }],
        tenantId,
      },
      select: { id: true, tenantId: true },
    });
    if (!camera) {
      return res.status(404).json({ error: `Camera '${cameraId}' not found for tenant '${tenantId}'` });
    }

    // 6. Verify model manifest exists and is active
    const manifest = await prisma.modelManifest.findUnique({
      where: { id: modelManifestId },
    });
    if (!manifest) {
      return res.status(404).json({ error: `ModelManifest '${modelManifestId}' not found` });
    }
    if (!manifest.isActive) {
      return res.status(400).json({ error: `ModelManifest '${modelManifestId}' is inactive` });
    }

    // 7. Database-native idempotency on inferenceId
    const eventTime = timestamp ? new Date(timestamp) : new Date();

    const detection = await prisma.detectionEvent.upsert({
      where: { inferenceId },
      update: {}, // Idempotent: duplicate submission leaves original record unmodified
      create: {
        tenantId,
        cameraId: camera.id,
        modelManifestId: manifest.id,
        inferenceId,
        type: type as EventType,
        confidence,
        boundingBox: boundingBox ?? undefined,
        centroid: centroid ?? undefined,
        attributesJson: attributesJson ?? undefined,
        snapshotPath: snapshotPath ?? undefined,
        timestamp: eventTime,
      },
    });

    return res.status(200).json({ success: true, detectionId: detection.id, inferenceId });
  } catch (err: any) {
    // Handle concurrent retry race condition on unique constraint
    if (err.code === 'P2002') {
      const existing = await prisma.detectionEvent.findUnique({ where: { inferenceId } });
      return res.status(200).json({ success: true, detectionId: existing?.id, inferenceId });
    }
    console.error('Error ingesting detection:', err);
    return res.status(500).json({ error: 'Failed to ingest detection event' });
  }
}

// Camera Discovery for AI Worker Loopback Feeds (Strict Privacy Redaction)
export async function handleGetInternalCameras(req: Request, res: Response) {
  try {
    const where: any = {};
    if (typeof req.query.tenantId === 'string' && req.query.tenantId.trim()) {
      where.tenantId = req.query.tenantId.trim();
    }
    if (req.query.isOnline !== undefined) {
      where.isOnline = req.query.isOnline === 'true';
    }

    // Explicitly select only non-sensitive fields. Never expose IP, ONVIF credentials, or external RTSP URIs.
    const cameras = await prisma.camera.findMany({
      where,
      select: {
        id: true,
        tenantId: true,
        name: true,
        streamPath: true,
        isOnline: true,
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

export default router;
