/**
 * The camera registry: the one place that finds a tenant's camera (and its presets, tours and zones), onboards a
 * camera and removes one. Every camera route goes through it, so the tenant boundary is checked in one place:
 * a camera, preset, tour or zone of another tenant is "not found", never readable or writable.
 *
 * Onboarding is all-or-nothing: if the media engine refuses the stream, the camera row is removed again, so a
 * retry does not leave a duplicate camera behind.
 */
import crypto from 'crypto';
import { Prisma, PrismaClient, RecorderState } from '@prisma/client';
import { encryptCredential, decryptCredential } from '../../utils/crypto';
import onvifManager from '../onvif/client';
import { detectVendorFromManufacturer } from '../onvif/quirks';
import mediaProvider from '../media/mediamtx.provider';
import sceneChangeDetector from '../motion/sceneChangeDetector.service';
import { AuditChainService } from '../audit/auditChain.service';

/** A missing camera, preset, tour or zone (or one of another tenant). Routes answer 404 with its message. */
export class CameraNotFoundError extends Error {
  readonly statusCode = 404;
}

export interface Actor {
  tenantId: string;
  userId: string;
  ipAddress: string;
  userAgent?: string;
}

export interface OnboardInput {
  name: string;
  ipAddress: string;
  onvifPort?: number;
  rtspPort?: number;
  username?: string;
  password?: string;
  siteId?: string;
  recordingMode?: 'CONTINUOUS' | 'MOTION' | 'SCHEDULED' | string;
  manualRtspUri?: string;
  vendorQuirks?: string[];
}

export interface OnvifCredentials {
  hostname: string;
  port: number;
  username: string;
  password: string;
}

export class CameraRegistry {
  constructor(private readonly prisma: PrismaClient) {}

  /** The tenant's camera, or CameraNotFoundError. */
  async require<I extends Prisma.CameraInclude | undefined = undefined>(tenantId: string, cameraId: string, include?: I) {
    const camera = await this.prisma.camera.findFirst({ where: { id: cameraId, tenantId }, ...(include ? { include } : {}) });
    if (!camera) throw new CameraNotFoundError('Camera not found');
    return camera as Prisma.CameraGetPayload<{ include: I }>;
  }

  /** A preset of the tenant's camera, or CameraNotFoundError. */
  async requirePreset(tenantId: string, cameraId: string, presetId: string) {
    const camera = await this.require(tenantId, cameraId);
    const preset = await this.prisma.ptzPreset.findFirst({ where: { id: presetId, cameraId: camera.id } });
    if (!preset) throw new CameraNotFoundError('Preset not found');
    return { camera, preset };
  }

  /** A guard tour of the tenant's camera, or CameraNotFoundError. */
  async requireTour(tenantId: string, cameraId: string, tourId: string) {
    const camera = await this.require(tenantId, cameraId);
    const tour = await this.prisma.ptzTour.findFirst({ where: { id: tourId, cameraId: camera.id } });
    if (!tour) throw new CameraNotFoundError('Tour not found');
    return { camera, tour };
  }

  /** A detection zone of the tenant's camera, or CameraNotFoundError. */
  async requireZone(tenantId: string, cameraId: string, zoneId: string) {
    const camera = await this.require(tenantId, cameraId);
    const zone = await this.prisma.detectionZone.findFirst({ where: { id: zoneId, cameraId: camera.id } });
    if (!zone) throw new CameraNotFoundError('Zone not found');
    return { camera, zone };
  }

  /** ONVIF connection details with the decrypted credentials. */
  onvifCredentials(camera: { ipAddress: string; onvifPort: number; encryptedAuth: string | null }): OnvifCredentials {
    const creds = camera.encryptedAuth ? JSON.parse(decryptCredential(camera.encryptedAuth)) : { username: '', password: '' };
    return { hostname: camera.ipAddress, port: camera.onvifPort, username: creds.username, password: creds.password };
  }

  list(tenantId: string) {
    return this.prisma.camera.findMany({
      where: { tenantId },
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
        site: { select: { id: true, name: true, timezone: true } },
      },
    });
  }

  /**
   * Onboards a camera: resolves the site, probes ONVIF (unless a manual RTSP URI is given), stores the camera,
   * creates its media path and audits it. `warnings` says when the RTSP URI is a guess because the ONVIF probe
   * failed.
   */
  async onboard(actor: Actor, input: OnboardInput) {
    const { name, ipAddress, onvifPort = 80, rtspPort = 554, username, password, recordingMode = 'CONTINUOUS', manualRtspUri } = input;
    const siteId = await this.resolveSite(actor.tenantId, input.siteId);
    const encryptedAuth = username || password ? encryptCredential(JSON.stringify({ username: username || '', password: password || '' })) : undefined;
    const streamPath = `cam_${crypto.randomBytes(6).toString('hex')}`;
    const warnings: string[] = [];

    let mainRtspUri = manualRtspUri;
    let subRtspUri: string | undefined;
    let hasPtz = false;
    // Unknown until the camera reports it; never invent a model or firmware version.
    let manufacturer = 'UNKNOWN';
    let model = 'UNKNOWN';
    let serialNumber = 'UNKNOWN';
    let firmwareVersion = 'UNKNOWN';
    let detectedQuirks: string[] = input.vendorQuirks || [];

    if (!mainRtspUri) {
      const onvif = { hostname: ipAddress, port: onvifPort, username, password };
      try {
        const devInfo = await onvifManager.getDeviceInformation(onvif);
        ({ manufacturer, model, serialNumber, firmwareVersion } = devInfo);
        if (detectedQuirks.length === 0) detectedQuirks = detectVendorFromManufacturer(manufacturer, model);
        const streamInfo = await onvifManager.resolveStreamUris(onvif);
        mainRtspUri = streamInfo.mainStreamUri;
        subRtspUri = streamInfo.subStreamUri;
        hasPtz = streamInfo.hasPtz;
      } catch (onvifErr: any) {
        const userPart = username && password ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
        mainRtspUri = `rtsp://${userPart}${ipAddress}:${rtspPort}/live`;
        warnings.push(`ONVIF probe failed (${onvifErr.message}); the RTSP URI rtsp://${ipAddress}:${rtspPort}/live is a guess. Set a manual RTSP URI if the stream does not start.`);
        console.warn(`[CameraRegistry] ONVIF probe of ${ipAddress} failed, using a guessed RTSP URI: ${onvifErr.message}`);
      }
    }

    const isContinuous = recordingMode === 'CONTINUOUS';
    const camera = await this.prisma.camera.create({
      data: {
        tenantId: actor.tenantId,
        siteId,
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
        recordingMode: recordingMode as any,
        recorderState: isContinuous ? RecorderState.RUNNING : RecorderState.STOPPED,
        // isOnline is the "monitored" flag the stream and recording watchdogs select on; nothing updates it later.
        isOnline: true,
        lastSeenAt: new Date(),
      },
    });

    try {
      await mediaProvider.createOrUpdateStream({ path: streamPath, sourceRtspUrl: mainRtspUri!, record: isContinuous });
    } catch (err: any) {
      // All or nothing: without its media path the camera cannot stream or record, so it is not kept.
      await this.prisma.camera.delete({ where: { id: camera.id } }).catch((delErr) => {
        console.error(`[CameraRegistry] could not remove camera ${camera.id} after the media engine refused it: ${delErr.message}`);
      });
      throw Object.assign(new Error(`the media engine refused the stream: ${err.message}`), { statusCode: 502 });
    }

    if (recordingMode === 'MOTION') sceneChangeDetector.startProbe(camera.id, subRtspUri || mainRtspUri!);

    await AuditChainService.record(this.prisma, {
      tenantId: actor.tenantId,
      userId: actor.userId,
      action: 'CAMERA_CREATE',
      resourceType: 'Camera',
      resourceId: camera.id,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      metadata: { cameraName: camera.name, ipAddress: camera.ipAddress, recordingMode: camera.recordingMode, siteId, ...(warnings.length ? { warnings } : {}) },
    });
    return { camera, warnings };
  }

  /** Stops the camera's probe, removes its media path and the camera, and audits it. */
  async remove(actor: Actor, cameraId: string) {
    const camera = await this.require(actor.tenantId, cameraId);
    sceneChangeDetector.stopProbe(camera.id);
    await mediaProvider.deleteStream(camera.streamPath);
    await this.prisma.camera.delete({ where: { id: camera.id } });
    await AuditChainService.record(this.prisma, {
      tenantId: actor.tenantId,
      userId: actor.userId,
      action: 'CAMERA_DELETE',
      resourceType: 'Camera',
      resourceId: camera.id,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      metadata: { cameraName: camera.name, streamPath: camera.streamPath },
    });
    return camera;
  }

  /** The given site (which must be the tenant's), or the tenant's first site, created if there is none. */
  private async resolveSite(tenantId: string, siteId?: string): Promise<string> {
    if (siteId) {
      const site = await this.prisma.site.findFirst({ where: { id: siteId, tenantId } });
      if (!site) throw new CameraNotFoundError('Specified site not found');
      return site.id;
    }
    const existing = await this.prisma.site.findFirst({ where: { tenantId } });
    if (existing) return existing.id;
    const created = await this.prisma.site.create({ data: { tenantId, name: 'Primary Site', timezone: 'Asia/Kolkata' } });
    return created.id;
  }
}
