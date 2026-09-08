import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { encryptCredential, decryptCredential } from '../../utils/crypto';
import { AuditChainService } from '../audit/auditChain.service';

export interface BackupArchive {
  format: 'VIGILONE_BACKUP_V1';
  version: number;
  schemaVersion: string;
  applianceId: string;
  tenantId: string;
  createdAt: string;
  checksumSha256: string;
  encryptedPayload: string; // AES-256-GCM encrypted base64 payload
}

export interface RestoreSummary {
  success: boolean;
  restoredCounts: {
    sites: number;
    cameras: number;
    schedules: number;
    zones: number;
    layouts: number;
    watchlists: number;
    notificationChannels: number;
  };
  restoredAt: Date;
}

export class DisasterRecoveryService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Generates an encrypted configuration backup archive for an appliance tenant.
   * INVARIANT: Strictly configuration metadata (<5MB); multi-terabyte video recordings are excluded.
   */
  public async exportApplianceBackup(tenantId: string): Promise<BackupArchive> {
    const [
      tenant,
      sites,
      cameras,
      schedules,
      zones,
      layouts,
      watchlists,
      notificationChannels,
      eventRules,
      licenses,
    ] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: tenantId } }),
      this.prisma.site.findMany({ where: { tenantId } }),
      this.prisma.camera.findMany({
        where: { tenantId },
        select: {
          id: true,
          tenantId: true,
          siteId: true,
          name: true,
          ipAddress: true,
          onvifPort: true,
          rtspPort: true,
          encryptedAuth: true,
          streamPath: true,
          mainRtspUri: true,
          subRtspUri: true,
          recordingMode: true,
          hasPtz: true,
          vendorQuirks: true,
        },
      }),
      this.prisma.recordingSchedule.findMany({ where: { tenantId } }),
      this.prisma.detectionZone.findMany({ where: { tenantId } }),
      this.prisma.layout.findMany({ where: { tenantId } }),
      this.prisma.vehicleWatchlist.findMany({ where: { tenantId } }),
      this.prisma.notificationChannel.findMany({ where: { tenantId } }),
      this.prisma.eventRule.findMany({ where: { tenantId } }),
      this.prisma.license.findMany({ where: { tenantId } }),
    ]);

    if (!tenant) {
      throw new Error(`Tenant ${tenantId} not found`);
    }

    const payload = {
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
      sites,
      cameras,
      schedules,
      zones,
      layouts,
      watchlists,
      notificationChannels,
      eventRules,
      licenses,
    };

    const serialized = JSON.stringify(payload);
    const checksumSha256 = crypto.createHash('sha256').update(serialized).digest('hex');
    const encryptedPayload = encryptCredential(serialized);

    return {
      format: 'VIGILONE_BACKUP_V1',
      version: 1,
      schemaVersion: '5.22.0',
      applianceId: process.env.APPLIANCE_ID || 'vigilone-edge-appliance-01',
      tenantId,
      createdAt: new Date().toISOString(),
      checksumSha256,
      encryptedPayload,
    };
  }

  /**
   * Restores an appliance configuration backup within a transactional boundary.
   * Performs schema version validation, decryption, and checksum verification before applying.
   */
  public async restoreApplianceBackup(
    backup: BackupArchive,
    targetTenantId: string,
    operatorUserId?: string,
    ipAddress: string = '127.0.0.1'
  ): Promise<RestoreSummary> {
    // 1. Validate Format & Version
    if (backup.format !== 'VIGILONE_BACKUP_V1' || backup.version > 1) {
      throw new Error(`Incompatible backup format or version: ${backup.format} v${backup.version}`);
    }

    // 2. Decrypt Payload
    let decryptedJson: string;
    try {
      decryptedJson = decryptCredential(backup.encryptedPayload);
    } catch (err: any) {
      throw new Error(`Failed to decrypt backup archive: ${err.message}. Incorrect encryption key.`);
    }

    // 3. Verify Integrity Checksum
    const calculatedChecksum = crypto.createHash('sha256').update(decryptedJson).digest('hex');
    if (calculatedChecksum !== backup.checksumSha256) {
      throw new Error('Corrupted backup archive: SHA-256 checksum mismatch');
    }

    const data = JSON.parse(decryptedJson);

    // 4. Transactional Restoration
    const restoredCounts = {
      sites: 0,
      cameras: 0,
      schedules: 0,
      zones: 0,
      layouts: 0,
      watchlists: 0,
      notificationChannels: 0,
    };

    await this.prisma.$transaction(async (tx) => {
      // Sites
      if (Array.isArray(data.sites)) {
        for (const site of data.sites) {
          await tx.site.upsert({
            where: { id: site.id },
            create: {
              id: site.id,
              tenantId: targetTenantId,
              name: site.name,
              timezone: site.timezone,
            },
            update: {
              name: site.name,
              timezone: site.timezone,
            },
          });
          restoredCounts.sites++;
        }
      }

      // Cameras
      if (Array.isArray(data.cameras)) {
        for (const cam of data.cameras) {
          await tx.camera.upsert({
            where: { id: cam.id },
            create: {
              id: cam.id,
              tenantId: targetTenantId,
              siteId: cam.siteId,
              name: cam.name,
              ipAddress: cam.ipAddress,
              onvifPort: cam.onvifPort,
              rtspPort: cam.rtspPort,
              encryptedAuth: cam.encryptedAuth,
              streamPath: cam.streamPath,
              mainRtspUri: cam.mainRtspUri,
              subRtspUri: cam.subRtspUri,
              recordingMode: cam.recordingMode,
              hasPtz: cam.hasPtz,
              vendorQuirks: cam.vendorQuirks,
            },
            update: {
              name: cam.name,
              ipAddress: cam.ipAddress,
              encryptedAuth: cam.encryptedAuth,
              recordingMode: cam.recordingMode,
              hasPtz: cam.hasPtz,
            },
          });
          restoredCounts.cameras++;
        }
      }

      // Recording Schedules
      if (Array.isArray(data.schedules)) {
        for (const sched of data.schedules) {
          await tx.recordingSchedule.upsert({
            where: { cameraId: sched.cameraId },
            create: {
              tenantId: targetTenantId,
              cameraId: sched.cameraId,
              weeklyMatrixJson: sched.weeklyMatrixJson,
              version: sched.version || 1,
            },
            update: {
              weeklyMatrixJson: sched.weeklyMatrixJson,
              version: sched.version || 1,
            },
          });
          restoredCounts.schedules++;
        }
      }

      // Detection Zones
      if (Array.isArray(data.zones)) {
        for (const zone of data.zones) {
          await tx.detectionZone.upsert({
            where: { id: zone.id },
            create: {
              id: zone.id,
              tenantId: targetTenantId,
              cameraId: zone.cameraId,
              name: zone.name,
              type: zone.type,
              priority: zone.priority,
              enabled: zone.enabled,
              polygonCoordinates: zone.polygonCoordinates,
            },
            update: {
              name: zone.name,
              type: zone.type,
              priority: zone.priority,
              enabled: zone.enabled,
              polygonCoordinates: zone.polygonCoordinates,
            },
          });
          restoredCounts.zones++;
        }
      }

      // Saved Layouts
      if (Array.isArray(data.layouts)) {
        for (const layout of data.layouts) {
          await tx.layout.upsert({
            where: { id: layout.id },
            create: {
              id: layout.id,
              tenantId: targetTenantId,
              userId: operatorUserId,
              name: layout.name,
              gridType: layout.gridType,
              visibility: layout.visibility,
              slotsJson: layout.slotsJson,
              isDefault: layout.isDefault,
            },
            update: {
              name: layout.name,
              gridType: layout.gridType,
              visibility: layout.visibility,
              slotsJson: layout.slotsJson,
              isDefault: layout.isDefault,
            },
          });
          restoredCounts.layouts++;
        }
      }

      // Vehicle Watchlists
      if (Array.isArray(data.watchlists)) {
        for (const wl of data.watchlists) {
          await tx.vehicleWatchlist.upsert({
            where: {
              tenantId_normalizedPlate: {
                tenantId: targetTenantId,
                normalizedPlate: wl.normalizedPlate,
              },
            },
            create: {
              tenantId: targetTenantId,
              plateNumber: wl.plateNumber,
              normalizedPlate: wl.normalizedPlate,
              category: wl.category,
              ownerName: wl.ownerName,
              notes: wl.notes,
              alertOnMatch: wl.alertOnMatch,
              severity: wl.severity,
              active: wl.active,
            },
            update: {
              category: wl.category,
              ownerName: wl.ownerName,
              notes: wl.notes,
              alertOnMatch: wl.alertOnMatch,
              severity: wl.severity,
              active: wl.active,
            },
          });
          restoredCounts.watchlists++;
        }
      }

      // Notification Channels
      if (Array.isArray(data.notificationChannels)) {
        for (const chan of data.notificationChannels) {
          await tx.notificationChannel.upsert({
            where: { id: chan.id },
            create: {
              id: chan.id,
              tenantId: targetTenantId,
              name: chan.name,
              type: chan.type,
              targetUrl: chan.targetUrl,
              secretToken: chan.secretToken,
              configJson: chan.configJson,
              minSeverity: chan.minSeverity,
              enabled: chan.enabled,
            },
            update: {
              name: chan.name,
              type: chan.type,
              targetUrl: chan.targetUrl,
              secretToken: chan.secretToken,
              configJson: chan.configJson,
              minSeverity: chan.minSeverity,
              enabled: chan.enabled,
            },
          });
          restoredCounts.notificationChannels++;
        }
      }
    });

    // 5. Audit Logging
    await AuditChainService.record(this.prisma, {
      tenantId: targetTenantId,
      userId: operatorUserId,
      action: 'SYSTEM_RESTORE_APPLIANCE',
      resourceType: 'ApplianceBackup',
      resourceId: backup.applianceId,
      ipAddress,
      metadata: {
        backupCreatedAt: backup.createdAt,
        restoredCounts,
      },
    });

    return {
      success: true,
      restoredCounts,
      restoredAt: new Date(),
    };
  }
}

export default DisasterRecoveryService;
