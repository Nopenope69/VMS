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
 * PTZ ContinuousMove & Stop
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
      await onvifManager.ptzContinuousMove(onvifCreds, token, { x, y, zoom });
      return res.json({ success: true, action: 'moved' });
    }

    if (action === 'stop') {
      await onvifManager.ptzStop(onvifCreds, token);
      return res.json({ success: true, action: 'stopped' });
    }

    return res.status(400).json({ error: 'Invalid PTZ action' });
  } catch (err: any) {
    return res.status(500).json({ error: `PTZ error: ${err.message}` });
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
