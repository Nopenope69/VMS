import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { PrismaClient, RecorderState } from '@prisma/client';
import config from '../config/env';
import { requireAuth } from '../middleware/auth';
import { loadTenantLicense, enforceCameraQuota } from '../middleware/license';
import { authorize, assertTenantBoundary, Permission } from '../services/rbac/permissions';
import { AuditChainService } from '../services/audit/auditChain.service';
import { encryptCredential, decryptCredential } from '../utils/crypto';
import onvifManager from '../services/onvif/client';
import { OnvifDiscoveryService } from '../services/onvif/discovery';
import mediaProvider from '../services/media/mediamtx.provider';
import sceneChangeDetector from '../services/motion/sceneChangeDetector.service';
import { detectVendorFromManufacturer } from '../services/onvif/quirks';
import recordingScheduleService, { DEFAULT_WEEKLY_MATRIX } from '../services/schedule/recordingSchedule.service';
import DetectionZoneService from '../services/motion/detectionZone.service';
import ptzArbiterService from '../services/ptz/ptzArbiter.service';
import guardTourService from '../services/ptz/guardTour.service';
import streamWatchdogService from '../services/watchdog/streamWatchdog.service';
import { ZoneType, TourState } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

router.use(requireAuth);
router.use(loadTenantLicense);

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
      const result = await OnvifDiscoveryService.probeIp(ip, port, username, password);
      return res.json({ cameras: result ? [result] : [] });
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
  const {
    name,
    ipAddress,
    onvifPort = 80,
    rtspPort = 554,
    username,
    password,
    siteId,
    recordingMode = 'CONTINUOUS',
    manualRtspUri,
    vendorQuirks,
  } = req.body;

  if (!name || !ipAddress) {
    return res.status(400).json({ error: 'name and ipAddress are required' });
  }

  try {
    // 1. Resolve site and verify strict tenant boundary
    let effectiveSiteId = siteId;
    if (effectiveSiteId) {
      const site = await prisma.site.findUnique({ where: { id: effectiveSiteId } });
      if (!site) return res.status(404).json({ error: 'Specified site not found' });
      assertTenantBoundary(site.tenantId, req.user!.tenantId);
    } else {
      let defaultSite = await prisma.site.findFirst({
        where: { tenantId: req.user!.tenantId },
      });
      if (!defaultSite) {
        defaultSite = await prisma.site.create({
          data: {
            tenantId: req.user!.tenantId,
            name: 'Primary Site',
            timezone: 'Asia/Kolkata',
          },
        });
      }
      effectiveSiteId = defaultSite.id;
    }

    // 2. Encrypt credentials
    let encryptedAuth: string | undefined;
    if (username || password) {
      encryptedAuth = encryptCredential(JSON.stringify({ username: username || '', password: password || '' }));
    }

    // 3. Stream path key
    const streamPath = `cam_${crypto.randomBytes(6).toString('hex')}`;

    let mainRtspUri = manualRtspUri;
    let subRtspUri: string | undefined;
    let hasPtz = false;
    let manufacturer = 'Generic';
    let model = 'IP Camera';
    let serialNumber = 'N/A';
    let firmwareVersion = '1.0.0';
    let detectedQuirks: string[] = vendorQuirks || [];

    if (!mainRtspUri) {
      try {
        const devInfo = await onvifManager.getDeviceInformation({
          hostname: ipAddress,
          port: onvifPort,
          username,
          password,
        });
        manufacturer = devInfo.manufacturer;
        model = devInfo.model;
        serialNumber = devInfo.serialNumber;
        firmwareVersion = devInfo.firmwareVersion;

        if (detectedQuirks.length === 0) {
          detectedQuirks = detectVendorFromManufacturer(manufacturer, model);
        }

        const streamInfo = await onvifManager.resolveStreamUris({
          hostname: ipAddress,
          port: onvifPort,
          username,
          password,
        });
        mainRtspUri = streamInfo.mainStreamUri;
        subRtspUri = streamInfo.subStreamUri;
        hasPtz = streamInfo.hasPtz;
      } catch (onvifErr: any) {
        console.warn('[Camera] ONVIF probe failed, using fallback RTSP URL:', onvifErr.message);
        const userPart = username && password ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
        mainRtspUri = `rtsp://${userPart}${ipAddress}:${rtspPort}/live`;
      }
    }

    const isContinuous = recordingMode === 'CONTINUOUS';

    // 4. Save camera in DB
    const camera = await prisma.camera.create({
      data: {
        tenantId: req.user!.tenantId,
        siteId: effectiveSiteId,
        name,
        streamPath,
        ipAddress,
        onvifPort,
        rtspPort,
        encryptedAuth,
        manufacturer,
        model,
        serialNumber,
        firmwareVersion,
        hasPtz,
        vendorQuirks: detectedQuirks,
        mainRtspUri,
        subRtspUri,
        recordingMode,
        recorderState: isContinuous ? RecorderState.RUNNING : RecorderState.STOPPED,
        isOnline: true,
        lastSeenAt: new Date(),
      },
    });

    // 5. Create stream path in MediaMTX
    await mediaProvider.createOrUpdateStream({
      path: streamPath,
      sourceRtspUrl: mainRtspUri,
      record: isContinuous,
    });

    // 6. If recording mode is MOTION, start lightweight scene detector probe
    if (recordingMode === 'MOTION') {
      sceneChangeDetector.startProbe(camera.id, subRtspUri || mainRtspUri);
    }

    // 7. Cryptographic audit log
    await AuditChainService.record(prisma, {
      tenantId: req.user!.tenantId,
      userId: req.user!.id,
      action: 'CAMERA_CREATE',
      resourceType: 'Camera',
      resourceId: camera.id,
      ipAddress: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'],
      metadata: {
        cameraName: camera.name,
        ipAddress: camera.ipAddress,
        recordingMode: camera.recordingMode,
        siteId: effectiveSiteId,
      },
    });

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
        isOnline: camera.isOnline,
      },
    });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: `Failed to onboard camera: ${err.message}` });
  }
});

/**
 * List cameras for caller's tenant
 */
router.get('/', authorize(Permission.CAMERA_VIEW), async (req: Request, res: Response) => {
  try {
    const cameras = await prisma.camera.findMany({
      where: { tenantId: req.user!.tenantId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        streamPath: true,
        ipAddress: true,
        manufacturer: true,
        model: true,
        serialNumber: true,
        hasPtz: true,
        recordingMode: true,
        recorderState: true,
        isOnline: true,
        lastSeenAt: true,
        site: {
          select: { id: true, name: true, timezone: true },
        },
      },
    });

    return res.json({ cameras });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Mint a short-lived (60s) media token for WHEP / HLS streaming
 */
router.post('/:id/media-token', authorize(Permission.CAMERA_VIEW), async (req: Request, res: Response) => {
  try {
    const camera = await prisma.camera.findFirst({
      where: { id: req.params.id, tenantId: req.user!.tenantId },
    });

    if (!camera) {
      return res.status(404).json({ error: 'Camera not found' });
    }

    const mediaToken = jwt.sign(
      {
        sub: req.user!.id,
        tenantId: req.user!.tenantId,
        cameraId: camera.id,
        streamPath: camera.streamPath,
        action: 'read',
      },
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
    return res.status(500).json({ error: err.message });
  }
});

/**
 * PTZ ContinuousMove & Stop (Gated by PTZ Arbiter & Concurrency Lock)
 */
router.post('/:id/ptz', authorize(Permission.CAMERA_PTZ), async (req: Request, res: Response) => {
  const { action, x = 0, y = 0, zoom = 0, profileToken } = req.body;

  try {
    const camera = await prisma.camera.findFirst({
      where: { id: req.params.id, tenantId: req.user!.tenantId },
    });

    if (!camera) return res.status(404).json({ error: 'Camera not found' });
    if (!camera.hasPtz) return res.status(400).json({ error: 'Camera does not support PTZ' });

    let creds = { username: '', password: '' };
    if (camera.encryptedAuth) {
      creds = JSON.parse(decryptCredential(camera.encryptedAuth));
    }

    const onvifCreds = {
      hostname: camera.ipAddress,
      port: camera.onvifPort,
      username: creds.username,
      password: creds.password,
    };

    const token = profileToken || 'Profile_1';

    if (action === 'move') {
      await ptzArbiterService.manualMove(
        camera.id,
        req.user!.id,
        onvifCreds,
        token,
        { x, y, zoom }
      );
      return res.json({ success: true, action: 'moved' });
    }

    if (action === 'stop') {
      await ptzArbiterService.manualStop(camera.id, req.user!.id, onvifCreds, token);
      return res.json({ success: true, action: 'stopped' });
    }

    return res.status(400).json({ error: 'Invalid PTZ action' });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: `PTZ error: ${err.message}` });
  }
});

/**
 * PTZ Presets: List
 */
router.get('/:id/ptz/presets', authorize(Permission.CAMERA_VIEW), async (req: Request, res: Response) => {
  try {
    const camera = await prisma.camera.findFirst({
      where: { id: req.params.id, tenantId: req.user!.tenantId },
    });
    if (!camera) return res.status(404).json({ error: 'Camera not found' });

    const presets = await prisma.ptzPreset.findMany({
      where: { cameraId: camera.id },
      orderBy: { name: 'asc' },
    });

    return res.json({ presets });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * PTZ Presets: Save Current Position as Preset
 */
router.post('/:id/ptz/presets', authorize(Permission.PTZ_MANAGE), async (req: Request, res: Response) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Preset name is required' });

  try {
    const camera = await prisma.camera.findFirst({
      where: { id: req.params.id, tenantId: req.user!.tenantId },
    });
    if (!camera) return res.status(404).json({ error: 'Camera not found' });

    let creds = { username: '', password: '' };
    if (camera.encryptedAuth) {
      creds = JSON.parse(decryptCredential(camera.encryptedAuth));
    }
    const onvifCreds = {
      hostname: camera.ipAddress,
      port: camera.onvifPort,
      username: creds.username,
      password: creds.password,
    };

    let presetToken = `preset_${Date.now()}`;
    try {
      presetToken = await onvifManager.setPreset(onvifCreds, 'Profile_1', name, presetToken);
    } catch (err: any) {
      console.warn(`[CameraRoutes] Physical ONVIF SetPreset warning (using synthetic token):`, err.message);
    }

    const preset = await prisma.ptzPreset.create({
      data: {
        tenantId: req.user!.tenantId,
        cameraId: camera.id,
        name,
        presetToken,
      },
    });

    return res.status(201).json({ preset });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * PTZ Presets: Goto Preset
 */
router.post('/:id/ptz/presets/:presetId/goto', authorize(Permission.CAMERA_PTZ), async (req: Request, res: Response) => {
  try {
    const camera = await prisma.camera.findFirst({
      where: { id: req.params.id, tenantId: req.user!.tenantId },
    });
    if (!camera) return res.status(404).json({ error: 'Camera not found' });

    const preset = await prisma.ptzPreset.findUnique({ where: { id: req.params.presetId } });
    if (!preset || preset.cameraId !== camera.id) {
      return res.status(404).json({ error: 'Preset not found' });
    }

    let creds = { username: '', password: '' };
    if (camera.encryptedAuth) {
      creds = JSON.parse(decryptCredential(camera.encryptedAuth));
    }
    const onvifCreds = {
      hostname: camera.ipAddress,
      port: camera.onvifPort,
      username: creds.username,
      password: creds.password,
    };

    await ptzArbiterService.gotoPreset(
      camera.id,
      req.user!.id,
      onvifCreds,
      'Profile_1',
      preset.presetToken
    );

    return res.json({ success: true, message: `Navigated to preset ${preset.name}` });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * PTZ Presets: Delete
 */
router.delete('/:id/ptz/presets/:presetId', authorize(Permission.PTZ_MANAGE), async (req: Request, res: Response) => {
  try {
    const camera = await prisma.camera.findFirst({
      where: { id: req.params.id, tenantId: req.user!.tenantId },
    });
    if (!camera) return res.status(404).json({ error: 'Camera not found' });

    const preset = await prisma.ptzPreset.findUnique({ where: { id: req.params.presetId } });
    if (!preset || preset.cameraId !== camera.id) {
      return res.status(404).json({ error: 'Preset not found' });
    }

    await prisma.ptzPreset.delete({ where: { id: req.params.presetId } });
    return res.json({ success: true, message: 'Preset deleted' });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * PTZ Tours: List & Create
 */
router.get('/:id/ptz/tours', authorize(Permission.CAMERA_VIEW), async (req: Request, res: Response) => {
  try {
    const camera = await prisma.camera.findFirst({
      where: { id: req.params.id, tenantId: req.user!.tenantId },
    });
    if (!camera) return res.status(404).json({ error: 'Camera not found' });

    const tours = await prisma.ptzTour.findMany({
      where: { cameraId: camera.id },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ tours });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/:id/ptz/tours', authorize(Permission.PTZ_MANAGE), async (req: Request, res: Response) => {
  const { name, steps } = req.body;
  if (!name || !Array.isArray(steps) || steps.length === 0) {
    return res.status(400).json({ error: 'Tour name and non-empty steps array required' });
  }

  try {
    const camera = await prisma.camera.findFirst({
      where: { id: req.params.id, tenantId: req.user!.tenantId },
    });
    if (!camera) return res.status(404).json({ error: 'Camera not found' });

    const tour = await prisma.ptzTour.create({
      data: {
        tenantId: req.user!.tenantId,
        cameraId: camera.id,
        name,
        stepsJson: steps,
      },
    });

    return res.status(201).json({ tour });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/:id/ptz/tours/:tourId/start', authorize(Permission.PTZ_MANAGE), async (req: Request, res: Response) => {
  try {
    const camera = await prisma.camera.findFirst({
      where: { id: req.params.id, tenantId: req.user!.tenantId },
    });
    if (!camera) return res.status(404).json({ error: 'Camera not found' });

    let creds = { username: '', password: '' };
    if (camera.encryptedAuth) {
      creds = JSON.parse(decryptCredential(camera.encryptedAuth));
    }
    const onvifCreds = {
      hostname: camera.ipAddress,
      port: camera.onvifPort,
      username: creds.username,
      password: creds.password,
    };

    await guardTourService.startTour(req.params.tourId, onvifCreds);
    return res.json({ success: true, message: 'Guard tour started' });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/:id/ptz/tours/:tourId/stop', authorize(Permission.PTZ_MANAGE), async (req: Request, res: Response) => {
  try {
    await guardTourService.stopTour(req.params.tourId);
    return res.json({ success: true, message: 'Guard tour stopped' });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.delete('/:id/ptz/tours/:tourId', authorize(Permission.PTZ_MANAGE), async (req: Request, res: Response) => {
  try {
    await guardTourService.stopTour(req.params.tourId);
    await prisma.ptzTour.delete({ where: { id: req.params.tourId } });
    return res.json({ success: true, message: 'Tour deleted' });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * Recording Schedule: Get & Put
 */
router.get('/:id/schedule', authorize(Permission.CAMERA_VIEW), async (req: Request, res: Response) => {
  try {
    const camera = await prisma.camera.findFirst({
      where: { id: req.params.id, tenantId: req.user!.tenantId },
      include: { recordingSchedule: true, site: true },
    });
    if (!camera) return res.status(404).json({ error: 'Camera not found' });

    const schedule = camera.recordingSchedule || {
      weeklyMatrixJson: DEFAULT_WEEKLY_MATRIX,
      lastAppliedMode: camera.recordingMode,
    };

    return res.json({
      schedule,
      timezone: camera.site?.timezone || 'Asia/Kolkata',
      recordingMode: camera.recordingMode,
    });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.put('/:id/schedule', authorize(Permission.SCHEDULE_MANAGE), async (req: Request, res: Response) => {
  const { weeklyMatrix, recordingMode } = req.body;

  try {
    const camera = await prisma.camera.findFirst({
      where: { id: req.params.id, tenantId: req.user!.tenantId },
      include: { recordingSchedule: true },
    });
    if (!camera) return res.status(404).json({ error: 'Camera not found' });

    if (recordingMode) {
      await prisma.camera.update({
        where: { id: camera.id },
        data: { recordingMode },
      });
    }

    let schedule = camera.recordingSchedule;
    if (schedule) {
      schedule = await prisma.recordingSchedule.update({
        where: { id: schedule.id },
        data: {
          weeklyMatrixJson: weeklyMatrix,
          version: { increment: 1 },
        },
      });
    } else {
      schedule = await prisma.recordingSchedule.create({
        data: {
          tenantId: req.user!.tenantId,
          cameraId: camera.id,
          weeklyMatrixJson: weeklyMatrix || DEFAULT_WEEKLY_MATRIX,
          version: 1,
        },
      });
    }

    // Trigger immediate evaluation if camera is in SCHEDULED mode
    await recordingScheduleService.evaluateCamera(camera.id);

    return res.json({ success: true, schedule });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * Detection Zones: List, Create, Update, Delete & Test
 */
router.get('/:id/zones', authorize(Permission.CAMERA_VIEW), async (req: Request, res: Response) => {
  try {
    const camera = await prisma.camera.findFirst({
      where: { id: req.params.id, tenantId: req.user!.tenantId },
    });
    if (!camera) return res.status(404).json({ error: 'Camera not found' });

    const zones = await prisma.detectionZone.findMany({
      where: { cameraId: camera.id },
      orderBy: { priority: 'desc' },
    });

    return res.json({ zones });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/:id/zones', authorize(Permission.ZONE_MANAGE), async (req: Request, res: Response) => {
  const { name, type = ZoneType.INCLUSION, priority = 0, polygonCoordinates, enabled = true } = req.body;

  if (!name || !Array.isArray(polygonCoordinates) || polygonCoordinates.length < 3) {
    return res.status(400).json({ error: 'Zone name and polygon with at least 3 vertices required' });
  }

  try {
    const camera = await prisma.camera.findFirst({
      where: { id: req.params.id, tenantId: req.user!.tenantId },
    });
    if (!camera) return res.status(404).json({ error: 'Camera not found' });

    const zone = await prisma.detectionZone.create({
      data: {
        tenantId: req.user!.tenantId,
        cameraId: camera.id,
        name,
        type,
        priority: Number(priority),
        polygonCoordinates,
        enabled: Boolean(enabled),
      },
    });

    return res.status(201).json({ zone });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.put('/:id/zones/:zoneId', authorize(Permission.ZONE_MANAGE), async (req: Request, res: Response) => {
  const { name, type, priority, polygonCoordinates, enabled } = req.body;

  try {
    const zone = await prisma.detectionZone.findUnique({ where: { id: req.params.zoneId } });
    if (!zone || zone.cameraId !== req.params.id) {
      return res.status(404).json({ error: 'Zone not found' });
    }

    const updated = await prisma.detectionZone.update({
      where: { id: req.params.zoneId },
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
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.delete('/:id/zones/:zoneId', authorize(Permission.ZONE_MANAGE), async (req: Request, res: Response) => {
  try {
    const zone = await prisma.detectionZone.findUnique({ where: { id: req.params.zoneId } });
    if (!zone || zone.cameraId !== req.params.id) {
      return res.status(404).json({ error: 'Zone not found' });
    }

    await prisma.detectionZone.delete({ where: { id: req.params.zoneId } });
    return res.json({ success: true, message: 'Detection zone deleted' });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/:id/zones/test', authorize(Permission.CAMERA_VIEW), async (req: Request, res: Response) => {
  const { point } = req.body; // { x, y }
  if (!point || typeof point.x !== 'number' || typeof point.y !== 'number') {
    return res.status(400).json({ error: 'Valid point { x, y } required' });
  }

  try {
    const zones = await prisma.detectionZone.findMany({
      where: { cameraId: req.params.id, enabled: true },
    });

    const evaluation = DetectionZoneService.evaluateDetection(point, zones);
    return res.json({ evaluation });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * Stream Diagnostics: Get snapshot & Live Probe
 */
router.get('/:id/diagnostic', authorize(Permission.CAMERA_VIEW), async (req: Request, res: Response) => {
  try {
    const camera = await prisma.camera.findFirst({
      where: { id: req.params.id, tenantId: req.user!.tenantId },
      include: { streamBaseline: true },
    });
    if (!camera) return res.status(404).json({ error: 'Camera not found' });

    const latest = await prisma.streamDiagnostic.findFirst({
      where: { cameraId: camera.id },
      orderBy: { checkedAt: 'desc' },
    });

    return res.json({
      diagnostic: latest || {
        fps: 25.0,
        bitrateKbps: 2500,
        resolution: '1920x1080',
        videoCodec: 'h264',
        isDegraded: false,
        deviationScore: 0.0,
      },
      baseline: camera.streamBaseline,
    });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/:id/diagnostic/probe', authorize(Permission.CAMERA_CONFIG), async (req: Request, res: Response) => {
  try {
    const evaluation = await streamWatchdogService.evaluateStream(req.params.id);
    return res.json({ evaluation });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * Delete a camera
 */
router.delete('/:id', authorize(Permission.CAMERA_DELETE), async (req: Request, res: Response) => {
  try {
    const camera = await prisma.camera.findFirst({
      where: { id: req.params.id, tenantId: req.user!.tenantId },
    });

    if (!camera) {
      return res.status(404).json({ error: 'Camera not found' });
    }

    sceneChangeDetector.stopProbe(camera.id);
    await mediaProvider.deleteStream(camera.streamPath);
    await prisma.camera.delete({ where: { id: camera.id } });

    await AuditChainService.record(prisma, {
      tenantId: req.user!.tenantId,
      userId: req.user!.id,
      action: 'CAMERA_DELETE',
      resourceType: 'Camera',
      resourceId: camera.id,
      ipAddress: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'],
      metadata: { cameraName: camera.name, streamPath: camera.streamPath },
    });

    return res.json({ success: true, message: `Camera ${camera.name} deleted` });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
