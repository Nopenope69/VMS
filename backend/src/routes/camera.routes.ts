import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../config/database';
import config from '../config/env';
import { requireAuth } from '../middleware/auth';
import { loadTenantLicense, enforceCameraQuota } from '../middleware/license';
import { authorize, Permission } from '../services/rbac/permissions';
import onvifManager from '../services/onvif/client';
import { OnvifDiscoveryService } from '../services/onvif/discovery';
import recordingScheduleService, { DEFAULT_WEEKLY_MATRIX } from '../services/schedule/recordingSchedule.service';
import DetectionZoneService from '../services/motion/detectionZone.service';
import ptzArbiterService from '../services/ptz/ptzArbiter.service';
import guardTourService from '../services/ptz/guardTour.service';
import streamWatchdogService from '../services/watchdog/streamWatchdog.service';
import { ZoneType } from '@prisma/client';
import { cameraRegistry as cameras } from '../composition';
import { Actor } from '../services/camera/cameraRegistry';

/**
 * Camera HTTP routes. Every camera, preset, tour and zone is found through the CameraRegistry, which enforces
 * the tenant boundary; handlers only parse the request and shape the response.
 */
const router = Router();

router.use(requireAuth);
router.use(loadTenantLicense);

const actor = (req: Request): Actor => ({
  tenantId: req.user!.tenantId,
  userId: req.user!.id,
  ipAddress: req.ip || '127.0.0.1',
  userAgent: req.headers['user-agent'],
});

const fail = (res: Response, err: any, prefix = '') =>
  res.status(err.statusCode || 500).json({ error: `${prefix}${err.message}` });

/**
 * Camera Discovery endpoint
 */
router.post('/discover', authorize(Permission.CAMERA_CREATE), async (req: Request, res: Response) => {
  const { mode = 'multicast', ip, port = 80, subnet, username, password } = req.body;

  try {
    if (mode === 'multicast') {
      const results = await OnvifDiscoveryService.discoverMulticast(4000);
      return res.json({ cameras: results });
    }

    if (mode === 'ip') {
      if (!ip) return res.status(400).json({ error: 'IP address is required for IP probe' });
      try {
        const result = await OnvifDiscoveryService.probeIp(ip, port, username, password);
        return res.json({ cameras: result ? [result] : [] });
      } catch (validationErr: any) {
        return res.status(400).json({ error: validationErr.message });
      }
    }

    if (mode === 'subnet') {
      if (!subnet) return res.status(400).json({ error: 'Subnet CIDR is required (e.g. 192.168.1.0/24)' });
      if (req.user!.role !== 'SUPER_ADMIN' && req.user!.role !== 'TENANT_ADMIN') {
        return res.status(403).json({ error: 'Subnet scanning requires Administrator privileges' });
      }
      const results = await OnvifDiscoveryService.scanSubnet(subnet, port);
      return res.json({ cameras: results });
    }

    return res.status(400).json({ error: 'Invalid discovery mode' });
  } catch (err: any) {
    return res.status(500).json({ error: `Discovery failed: ${err.message}` });
  }
});

/**
 * Onboard a new camera (Gated by CAMERA_CREATE and enforceCameraQuota)
 */
router.post('/', authorize(Permission.CAMERA_CREATE), enforceCameraQuota, async (req: Request, res: Response) => {
  const { name, ipAddress } = req.body;
  if (!name || !ipAddress) {
    return res.status(400).json({ error: 'name and ipAddress are required' });
  }
  try {
    const { camera, warnings } = await cameras.onboard(actor(req), req.body);
    return res.status(201).json({
      camera: {
        id: camera.id,
        name: camera.name,
        streamPath: camera.streamPath,
        ipAddress: camera.ipAddress,
        manufacturer: camera.manufacturer,
        model: camera.model,
        hasPtz: camera.hasPtz,
        recordingMode: camera.recordingMode,
        recorderState: camera.recorderState,
        isOnline: false, // not seen by the stream watchdog yet
      },
      ...(warnings.length ? { warnings } : {}),
    });
  } catch (err: any) {
    return fail(res, err, 'Failed to onboard camera: ');
  }
});

/**
 * List cameras for caller's tenant
 */
router.get('/', authorize(Permission.CAMERA_VIEW), async (req: Request, res: Response) => {
  try {
    return res.json({ cameras: await cameras.list(req.user!.tenantId) });
  } catch (err: any) {
    return fail(res, err);
  }
});

/**
 * Mint a short-lived (60s) media token for WHEP / HLS streaming
 */
router.post('/:id/media-token', authorize(Permission.CAMERA_VIEW), async (req: Request, res: Response) => {
  try {
    const camera = await cameras.require(req.user!.tenantId, req.params.id);
    const mediaToken = jwt.sign(
      { sub: req.user!.id, tenantId: req.user!.tenantId, cameraId: camera.id, streamPath: camera.streamPath, action: 'read' },
      config.JWT_SECRET,
      { expiresIn: '60s' }
    );
    return res.json({
      token: mediaToken,
      streamPath: camera.streamPath,
      whepUrl: `/whep/${camera.streamPath}/whep`,
      hlsUrl: `/hls/${camera.streamPath}/index.m3u8`,
      expiresInSeconds: 60,
    });
  } catch (err: any) {
    return fail(res, err);
  }
});

/**
 * PTZ ContinuousMove & Stop (Gated by PTZ Arbiter & Concurrency Lock)
 */
router.post('/:id/ptz', authorize(Permission.CAMERA_PTZ), async (req: Request, res: Response) => {
  const { action, x = 0, y = 0, zoom = 0, profileToken } = req.body;
  try {
    const camera = await cameras.require(req.user!.tenantId, req.params.id);
    if (!camera.hasPtz) return res.status(400).json({ error: 'Camera does not support PTZ' });
    const onvifCreds = cameras.onvifCredentials(camera);
    const token = profileToken || 'Profile_1';
    if (action === 'move') {
      await ptzArbiterService.manualMove(camera.id, req.user!.id, onvifCreds, token, { x, y, zoom });
      return res.json({ success: true, action: 'moved' });
    }
    if (action === 'stop') {
      await ptzArbiterService.manualStop(camera.id, req.user!.id, onvifCreds, token);
      return res.json({ success: true, action: 'stopped' });
    }
    return res.status(400).json({ error: 'Invalid PTZ action' });
  } catch (err: any) {
    return fail(res, err, 'PTZ error: ');
  }
});

/**
 * PTZ Presets: List
 */
router.get('/:id/ptz/presets', authorize(Permission.CAMERA_VIEW), async (req: Request, res: Response) => {
  try {
    const camera = await cameras.require(req.user!.tenantId, req.params.id);
    const presets = await prisma.ptzPreset.findMany({ where: { cameraId: camera.id }, orderBy: { name: 'asc' } });
    return res.json({ presets });
  } catch (err: any) {
    return fail(res, err);
  }
});

/**
 * PTZ Presets: Save Current Position as Preset. The camera must store it: a preset the camera did not save
 * would move nowhere, so a refused SetPreset is an error, not a preset with an invented token.
 */
router.post('/:id/ptz/presets', authorize(Permission.PTZ_MANAGE), async (req: Request, res: Response) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Preset name is required' });
  try {
    const camera = await cameras.require(req.user!.tenantId, req.params.id);
    let presetToken: string;
    try {
      presetToken = await onvifManager.setPreset(cameras.onvifCredentials(camera), 'Profile_1', name, `preset_${Date.now()}`);
    } catch (err: any) {
      return res.status(502).json({ error: `The camera did not save the preset: ${err.message}` });
    }
    const preset = await prisma.ptzPreset.create({
      data: { tenantId: req.user!.tenantId, cameraId: camera.id, name, presetToken },
    });
    return res.status(201).json({ preset });
  } catch (err: any) {
    return fail(res, err);
  }
});

/**
 * PTZ Presets: Goto Preset
 */
router.post('/:id/ptz/presets/:presetId/goto', authorize(Permission.CAMERA_PTZ), async (req: Request, res: Response) => {
  try {
    const { camera, preset } = await cameras.requirePreset(req.user!.tenantId, req.params.id, req.params.presetId);
    await ptzArbiterService.gotoPreset(camera.id, req.user!.id, cameras.onvifCredentials(camera), 'Profile_1', preset.presetToken);
    return res.json({ success: true, message: `Navigated to preset ${preset.name}` });
  } catch (err: any) {
    return fail(res, err);
  }
});

/**
 * PTZ Presets: Delete
 */
router.delete('/:id/ptz/presets/:presetId', authorize(Permission.PTZ_MANAGE), async (req: Request, res: Response) => {
  try {
    const { preset } = await cameras.requirePreset(req.user!.tenantId, req.params.id, req.params.presetId);
    await prisma.ptzPreset.delete({ where: { id: preset.id } });
    return res.json({ success: true, message: 'Preset deleted' });
  } catch (err: any) {
    return fail(res, err);
  }
});

/**
 * PTZ Tours: List & Create
 */
router.get('/:id/ptz/tours', authorize(Permission.CAMERA_VIEW), async (req: Request, res: Response) => {
  try {
    const camera = await cameras.require(req.user!.tenantId, req.params.id);
    const tours = await prisma.ptzTour.findMany({ where: { cameraId: camera.id }, orderBy: { createdAt: 'desc' } });
    return res.json({ tours });
  } catch (err: any) {
    return fail(res, err);
  }
});

router.post('/:id/ptz/tours', authorize(Permission.PTZ_MANAGE), async (req: Request, res: Response) => {
  const { name, steps } = req.body;
  if (!name || !Array.isArray(steps) || steps.length === 0) {
    return res.status(400).json({ error: 'Tour name and non-empty steps array required' });
  }
  try {
    const camera = await cameras.require(req.user!.tenantId, req.params.id);
    const tour = await prisma.ptzTour.create({
      data: { tenantId: req.user!.tenantId, cameraId: camera.id, name, stepsJson: steps },
    });
    return res.status(201).json({ tour });
  } catch (err: any) {
    return fail(res, err);
  }
});

router.post('/:id/ptz/tours/:tourId/start', authorize(Permission.PTZ_MANAGE), async (req: Request, res: Response) => {
  try {
    const { camera, tour } = await cameras.requireTour(req.user!.tenantId, req.params.id, req.params.tourId);
    await guardTourService.startTour(tour.id, cameras.onvifCredentials(camera));
    return res.json({ success: true, message: 'Guard tour started' });
  } catch (err: any) {
    return fail(res, err);
  }
});

router.post('/:id/ptz/tours/:tourId/stop', authorize(Permission.PTZ_MANAGE), async (req: Request, res: Response) => {
  try {
    const { tour } = await cameras.requireTour(req.user!.tenantId, req.params.id, req.params.tourId);
    await guardTourService.stopTour(tour.id);
    return res.json({ success: true, message: 'Guard tour stopped' });
  } catch (err: any) {
    return fail(res, err);
  }
});

router.delete('/:id/ptz/tours/:tourId', authorize(Permission.PTZ_MANAGE), async (req: Request, res: Response) => {
  try {
    const { tour } = await cameras.requireTour(req.user!.tenantId, req.params.id, req.params.tourId);
    await guardTourService.stopTour(tour.id);
    await prisma.ptzTour.delete({ where: { id: tour.id } });
    return res.json({ success: true, message: 'Tour deleted' });
  } catch (err: any) {
    return fail(res, err);
  }
});

/**
 * Recording Schedule: Get & Put
 */
router.get('/:id/schedule', authorize(Permission.CAMERA_VIEW), async (req: Request, res: Response) => {
  try {
    const camera = await cameras.require(req.user!.tenantId, req.params.id, { recordingSchedule: true, site: true });
    const schedule = camera.recordingSchedule || { weeklyMatrixJson: DEFAULT_WEEKLY_MATRIX, lastAppliedMode: camera.recordingMode };
    return res.json({ schedule, timezone: camera.site?.timezone || 'Asia/Kolkata', recordingMode: camera.recordingMode });
  } catch (err: any) {
    return fail(res, err);
  }
});

router.put('/:id/schedule', authorize(Permission.SCHEDULE_MANAGE), async (req: Request, res: Response) => {
  const { weeklyMatrix, recordingMode } = req.body;
  try {
    const camera = await cameras.require(req.user!.tenantId, req.params.id, { recordingSchedule: true });
    if (recordingMode) {
      await prisma.camera.update({ where: { id: camera.id }, data: { recordingMode } });
    }
    let schedule = camera.recordingSchedule;
    if (schedule) {
      schedule = await prisma.recordingSchedule.update({
        where: { id: schedule.id },
        data: { weeklyMatrixJson: weeklyMatrix, version: { increment: 1 } },
      });
    } else {
      schedule = await prisma.recordingSchedule.create({
        data: { tenantId: req.user!.tenantId, cameraId: camera.id, weeklyMatrixJson: weeklyMatrix || DEFAULT_WEEKLY_MATRIX, version: 1 },
      });
    }
    // Trigger immediate evaluation if camera is in SCHEDULED mode
    await recordingScheduleService.evaluateCamera(camera.id);
    return res.json({ success: true, schedule });
  } catch (err: any) {
    return fail(res, err);
  }
});

/**
 * Detection Zones: List, Create, Update, Delete & Test
 */
router.get('/:id/zones', authorize(Permission.CAMERA_VIEW), async (req: Request, res: Response) => {
  try {
    const camera = await cameras.require(req.user!.tenantId, req.params.id);
    const zones = await prisma.detectionZone.findMany({ where: { cameraId: camera.id }, orderBy: { priority: 'desc' } });
    return res.json({ zones });
  } catch (err: any) {
    return fail(res, err);
  }
});

router.post('/:id/zones', authorize(Permission.ZONE_MANAGE), async (req: Request, res: Response) => {
  const { name, type = ZoneType.INCLUSION, priority = 0, polygonCoordinates, enabled = true } = req.body;
  if (!name || !Array.isArray(polygonCoordinates) || polygonCoordinates.length < 3) {
    return res.status(400).json({ error: 'Zone name and polygon with at least 3 vertices required' });
  }
  try {
    const camera = await cameras.require(req.user!.tenantId, req.params.id);
    const zone = await prisma.detectionZone.create({
      data: { tenantId: req.user!.tenantId, cameraId: camera.id, name, type, priority: Number(priority), polygonCoordinates, enabled: Boolean(enabled) },
    });
    return res.status(201).json({ zone });
  } catch (err: any) {
    return fail(res, err);
  }
});

router.put('/:id/zones/:zoneId', authorize(Permission.ZONE_MANAGE), async (req: Request, res: Response) => {
  const { name, type, priority, polygonCoordinates, enabled } = req.body;
  try {
    const { zone } = await cameras.requireZone(req.user!.tenantId, req.params.id, req.params.zoneId);
    const updated = await prisma.detectionZone.update({
      where: { id: zone.id },
      data: {
        ...(name ? { name } : {}),
        ...(type ? { type } : {}),
        ...(priority !== undefined ? { priority: Number(priority) } : {}),
        ...(polygonCoordinates ? { polygonCoordinates } : {}),
        ...(enabled !== undefined ? { enabled: Boolean(enabled) } : {}),
        version: { increment: 1 },
      },
    });
    return res.json({ zone: updated });
  } catch (err: any) {
    return fail(res, err);
  }
});

router.delete('/:id/zones/:zoneId', authorize(Permission.ZONE_MANAGE), async (req: Request, res: Response) => {
  try {
    const { zone } = await cameras.requireZone(req.user!.tenantId, req.params.id, req.params.zoneId);
    await prisma.detectionZone.delete({ where: { id: zone.id } });
    return res.json({ success: true, message: 'Detection zone deleted' });
  } catch (err: any) {
    return fail(res, err);
  }
});

router.post('/:id/zones/test', authorize(Permission.CAMERA_VIEW), async (req: Request, res: Response) => {
  const { point } = req.body; // { x, y }
  if (!point || typeof point.x !== 'number' || typeof point.y !== 'number') {
    return res.status(400).json({ error: 'Valid point { x, y } required' });
  }
  try {
    const camera = await cameras.require(req.user!.tenantId, req.params.id);
    const zones = await prisma.detectionZone.findMany({ where: { cameraId: camera.id, enabled: true } });
    return res.json({ evaluation: DetectionZoneService.evaluateDetection(point, zones) });
  } catch (err: any) {
    return fail(res, err);
  }
});

/**
 * Stream Diagnostics: the latest real measurement (null when the camera was never measured) & a live probe.
 */
router.get('/:id/diagnostic', authorize(Permission.CAMERA_VIEW), async (req: Request, res: Response) => {
  try {
    const camera = await cameras.require(req.user!.tenantId, req.params.id, { streamBaseline: true });
    const latest = await prisma.streamDiagnostic.findFirst({ where: { cameraId: camera.id }, orderBy: { checkedAt: 'desc' } });
    return res.json({ diagnostic: latest, baseline: camera.streamBaseline });
  } catch (err: any) {
    return fail(res, err);
  }
});

router.post('/:id/diagnostic/probe', authorize(Permission.CAMERA_CONFIG), async (req: Request, res: Response) => {
  try {
    const camera = await cameras.require(req.user!.tenantId, req.params.id);
    const evaluation = await streamWatchdogService.evaluateStream(camera.id);
    return res.json({ evaluation });
  } catch (err: any) {
    return fail(res, err);
  }
});

/**
 * Delete a camera
 */
router.delete('/:id', authorize(Permission.CAMERA_DELETE), async (req: Request, res: Response) => {
  try {
    const camera = await cameras.remove(actor(req), req.params.id);
    return res.json({ success: true, message: `Camera ${camera.name} deleted` });
  } catch (err: any) {
    return fail(res, err);
  }
});

export default router;
