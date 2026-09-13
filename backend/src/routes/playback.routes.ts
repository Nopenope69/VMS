import { Router, Request, Response } from 'express';
import fs from 'fs';
import prisma from '../config/database';
import { requireAuth } from '../middleware/auth';
import { RecordingCatalog } from '../services/recording/catalog/recordingCatalog.service';
import { PlaybackSyncService } from '../services/playback/playbackSync.service';

const router = Router();
const recordingCatalog = new RecordingCatalog(prisma);
const playbackSyncService = new PlaybackSyncService(prisma, recordingCatalog);

router.use(requireAuth);

/**
 * Query recording segments for a camera across a time window (with gap detection)
 */
router.get('/:cameraId/segments', async (req: Request, res: Response) => {
  const { start, end } = req.query;

  try {
    const camera = await prisma.camera.findFirst({
      where: { id: req.params.cameraId, tenantId: req.user!.tenantId },
    });
    if (!camera) return res.status(404).json({ error: 'Camera not found' });

    const startDate = start ? new Date(start as string) : new Date(0);
    const endDate = end ? new Date(end as string) : new Date(Date.now() + 365 * 86400000);

    const segments = await recordingCatalog.findSegments(camera.id, startDate, endDate);

    // Detect gaps if time range provided
    let gaps: any[] = [];
    if (start && end) {
      const coverage = await recordingCatalog.getCoverage(camera.id, startDate, endDate);
      gaps = coverage.gaps;
    }

    // Convert BigInt to string for JSON serialization
    const serialized = segments.map((s) => ({
      ...s,
      sizeBytes: s.sizeBytes.toString(),
      startPts: s.startPts.toString(),
      endPts: s.endPts.toString(),
      segmentUri: s.filePath,
    }));

    return res.json({ segments: serialized, gaps });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Get comprehensive recording coverage blocks and gaps for camera timeline
 */
router.get('/:cameraId/coverage', async (req: Request, res: Response) => {
  const { start, end, gapThresholdMs } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query parameters are required' });
  }

  try {
    const camera = await prisma.camera.findFirst({
      where: { id: req.params.cameraId, tenantId: req.user!.tenantId },
    });
    if (!camera) return res.status(404).json({ error: 'Camera not found' });

    const coverage = await recordingCatalog.getCoverage(
      camera.id,
      new Date(start as string),
      new Date(end as string),
      gapThresholdMs ? parseInt(gapThresholdMs as string, 10) : 2000
    );

    return res.json(coverage);
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

/**
 * SYNCHRONIZED MULTI-CAMERA PLAYBACK WORKSTREAM
 */

/**
 * Initialize a synchronized multi-camera playback session
 */
router.post('/sync/sessions', async (req: Request, res: Response) => {
  const { cameraIds, initialUtc } = req.body;
  if (!cameraIds || !Array.isArray(cameraIds) || cameraIds.length === 0) {
    return res.status(400).json({ error: 'cameraIds array is required' });
  }

  try {
    const targetUtc = initialUtc ? new Date(initialUtc) : new Date();
    const session = await playbackSyncService.createPlaybackSession(
      req.user!.tenantId,
      req.user!.id,
      cameraIds,
      targetUtc
    );

    const seekResult = await playbackSyncService.seekPlaybackSession(session.id, targetUtc);
    const serializedCameras = seekResult.cameras.map((c) => ({
      ...c,
      currentPts: c.currentPts?.toString(),
      nearestKeyframePts: c.nearestKeyframePts?.toString(),
    }));

    return res.status(201).json({
      session,
      initialSeek: { ...seekResult, cameras: serializedCameras },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Get synchronized playback session state
 */
router.get('/sync/sessions/:sessionId', async (req: Request, res: Response) => {
  try {
    const session = await playbackSyncService.getPlaybackSession(req.params.sessionId);
    if (!session || session.tenantId !== req.user!.tenantId) {
      return res.status(404).json({ error: 'Playback session not found' });
    }
    return res.json(session);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Synchronously seek all cameras in the session to an authoritative UTC wall-clock time
 */
router.post('/sync/sessions/:sessionId/seek', async (req: Request, res: Response) => {
  const { targetUtc } = req.body;
  if (!targetUtc) {
    return res.status(400).json({ error: 'targetUtc timestamp is required' });
  }

  try {
    const session = await playbackSyncService.getPlaybackSession(req.params.sessionId);
    if (!session || session.tenantId !== req.user!.tenantId) {
      return res.status(404).json({ error: 'Playback session not found' });
    }

    const seekResult = await playbackSyncService.seekPlaybackSession(
      session.id,
      new Date(targetUtc)
    );

    // Serialize BigInts in camera state
    const serializedCameras = seekResult.cameras.map((c) => ({
      ...c,
      currentPts: c.currentPts?.toString(),
      nearestKeyframePts: c.nearestKeyframePts?.toString(),
    }));

    return res.json({ ...seekResult, cameras: serializedCameras });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Set playback rate (-16x to +16x)
 */
router.post('/sync/sessions/:sessionId/rate', async (req: Request, res: Response) => {
  const { rate } = req.body;
  if (typeof rate !== 'number') {
    return res.status(400).json({ error: 'rate must be a number' });
  }

  try {
    const session = await playbackSyncService.getPlaybackSession(req.params.sessionId);
    if (!session || session.tenantId !== req.user!.tenantId) {
      return res.status(404).json({ error: 'Playback session not found' });
    }

    const updated = await playbackSyncService.setPlaybackRate(session.id, rate);
    return res.json(updated);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

/**
 * Step frame forward or backward (exact PTS delta, no 33ms assumption)
 */
router.post('/sync/sessions/:sessionId/step', async (req: Request, res: Response) => {
  const { direction } = req.body;
  if (direction !== 'FORWARD' && direction !== 'BACKWARD') {
    return res.status(400).json({ error: "direction must be 'FORWARD' or 'BACKWARD'" });
  }

  try {
    const session = await playbackSyncService.getPlaybackSession(req.params.sessionId);
    if (!session || session.tenantId !== req.user!.tenantId) {
      return res.status(404).json({ error: 'Playback session not found' });
    }

    const stepResult = await playbackSyncService.stepSessionFrame(session.id, direction);

    const serializedCameras = stepResult.cameras.map((c) => ({
      ...c,
      currentPts: c.currentPts?.toString(),
      nearestKeyframePts: c.nearestKeyframePts?.toString(),
    }));

    return res.json({ ...stepResult, cameras: serializedCameras });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Get keyframe steps for reverse / fast shuttle scrubbing
 */
router.get('/sync/shuttle', async (req: Request, res: Response) => {
  const { cameraIds, startUtc, endUtc, direction } = req.query;
  if (!cameraIds || !startUtc || !endUtc) {
    return res.status(400).json({ error: 'cameraIds, startUtc, and endUtc are required' });
  }

  try {
    const camIdArray = Array.isArray(cameraIds) ? (cameraIds as string[]) : (cameraIds as string).split(',');
    const shuttleSteps = await playbackSyncService.getShuttleKeyframes(
      req.user!.tenantId,
      camIdArray,
      new Date(startUtc as string),
      new Date(endUtc as string),
      (direction as 'FORWARD' | 'REVERSE') || 'REVERSE'
    );

    return res.json(shuttleSteps);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Index a segment into RecordingSegment catalog
 */
router.post('/index/segment', async (req: Request, res: Response) => {
  const {
    cameraId,
    segmentUri,
    startUtc,
    endUtc,
    startPts,
    endPts,
    timebaseNumerator,
    timebaseDenominator,
    codec,
    width,
    height,
    fps,
    keyframeIndexJson,
    storageLocation,
  } = req.body;

  if (!cameraId || !segmentUri || !startUtc || !endUtc) {
    return res.status(400).json({ error: 'cameraId, segmentUri, startUtc, and endUtc are required' });
  }

  try {
    const segment = await recordingCatalog.registerSegment({
      tenantId: req.user!.tenantId,
      cameraId,
      filePath: segmentUri,
      startTime: new Date(startUtc),
      endTime: new Date(endUtc),
      startPts: startPts !== undefined ? BigInt(startPts) : undefined,
      endPts: endPts !== undefined ? BigInt(endPts) : undefined,
      timebaseNumerator,
      timebaseDenominator,
      codec,
      width,
      height,
      fps,
      keyframeIndexJson,
      storageLocation,
    });

    return res.status(201).json({
      ...segment,
      segmentUri: segment.filePath,
      sizeBytes: segment.sizeBytes.toString(),
      startPts: segment.startPts.toString(),
      endPts: segment.endPts.toString(),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
