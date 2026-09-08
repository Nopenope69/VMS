import { DisasterRecoveryService, BackupArchive } from '../services/system/disasterRecovery.service';
import { AuditChainService } from '../services/audit/auditChain.service';
import { decryptCredential } from '../utils/crypto';
import crypto from 'crypto';

describe('DisasterRecoveryService (.vigilone-backup Export & Transactional Restore)', () => {
  let service: DisasterRecoveryService;
  let mockPrisma: any;
  const tenantId = 'tenant_dr_01';

  const mockTenant = { id: tenantId, name: 'Main Campus', slug: 'main-campus' };
  const mockSites = [{ id: 'site_1', tenantId, name: 'North Gate', timezone: 'Asia/Kolkata' }];
  const mockCameras = [
    {
      id: 'cam_1',
      tenantId,
      siteId: 'site_1',
      name: 'LPR North Entry',
      ipAddress: '192.168.1.101',
      onvifPort: 80,
      rtspPort: 554,
      encryptedAuth: 'enc_auth_str',
      streamPath: 'cam1',
      mainRtspUri: 'rtsp://192.168.1.101:554/stream1',
      subRtspUri: 'rtsp://192.168.1.101:554/stream2',
      recordingMode: 'CONTINUOUS',
      hasPtz: false,
      vendorQuirks: null,
    },
  ];
  const mockSchedules = [
    {
      cameraId: 'cam_1',
      tenantId,
      weeklyMatrixJson: { monday: ['00:00-23:59'] },
      version: 1,
    },
  ];
  const mockZones = [
    {
      id: 'zone_1',
      tenantId,
      cameraId: 'cam_1',
      name: 'Entry Lane 1',
      type: 'INCLUSION',
      priority: 'HIGH',
      enabled: true,
      polygonCoordinates: [{ x: 0.1, y: 0.1 }],
    },
  ];
  const mockLayouts = [
    {
      id: 'lay_1',
      tenantId,
      userId: 'usr_1',
      name: 'Default 4-Up',
      gridType: 'GRID_2X2',
      visibility: 'GLOBAL',
      slotsJson: [],
      isDefault: true,
    },
  ];
  const mockWatchlists = [
    {
      tenantId,
      plateNumber: 'DL 01 AB 1234',
      normalizedPlate: 'DL01AB1234',
      category: 'HOTLIST_STOLEN',
      ownerName: 'Stolen Swift',
      notes: 'Reported stolen',
      alertOnMatch: true,
      severity: 'CRITICAL',
      active: true,
    },
  ];
  const mockNotificationChannels = [
    {
      id: 'chan_1',
      tenantId,
      name: 'SecOps Webhook',
      type: 'WEBHOOK',
      targetUrl: 'https://security.vigilone.internal/webhook',
      secretToken: 'whsec_test',
      configJson: {},
      minSeverity: 'WARNING',
      enabled: true,
    },
  ];

  beforeEach(() => {
    jest.spyOn(AuditChainService, 'record').mockResolvedValue({} as any);

    mockPrisma = {
      tenant: {
        findUnique: jest.fn().mockResolvedValue(mockTenant),
      },
      site: {
        findMany: jest.fn().mockResolvedValue(mockSites),
        upsert: jest.fn().mockResolvedValue({}),
      },
      camera: {
        findMany: jest.fn().mockResolvedValue(mockCameras),
        upsert: jest.fn().mockResolvedValue({}),
      },
      recordingSchedule: {
        findMany: jest.fn().mockResolvedValue(mockSchedules),
        upsert: jest.fn().mockResolvedValue({}),
      },
      detectionZone: {
        findMany: jest.fn().mockResolvedValue(mockZones),
        upsert: jest.fn().mockResolvedValue({}),
      },
      layout: {
        findMany: jest.fn().mockResolvedValue(mockLayouts),
        upsert: jest.fn().mockResolvedValue({}),
      },
      vehicleWatchlist: {
        findMany: jest.fn().mockResolvedValue(mockWatchlists),
        upsert: jest.fn().mockResolvedValue({}),
      },
      notificationChannel: {
        findMany: jest.fn().mockResolvedValue(mockNotificationChannels),
        upsert: jest.fn().mockResolvedValue({}),
      },
      eventRule: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({}),
      },
      license: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn().mockImplementation(async (callback) => {
        return callback(mockPrisma);
      }),
    };

    service = new DisasterRecoveryService(mockPrisma);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Configuration Export Boundary (<5MB)', () => {
    it('should export encrypted configuration archive with strict schema and checksum', async () => {
      const backup = await service.exportApplianceBackup(tenantId);

      expect(backup.format).toBe('VIGILONE_BACKUP_V1');
      expect(backup.version).toBe(1);
      expect(backup.tenantId).toBe(tenantId);
      expect(backup.checksumSha256).toBeDefined();
      expect(backup.encryptedPayload).toBeDefined();

      // Verify payload decrypts and matches checksum
      const decrypted = decryptCredential(backup.encryptedPayload);
      const computedHash = crypto.createHash('sha256').update(decrypted).digest('hex');
      expect(computedHash).toBe(backup.checksumSha256);

      const parsed = JSON.parse(decrypted);
      expect(parsed.tenant.id).toBe(tenantId);
      expect(parsed.sites).toHaveLength(1);
      expect(parsed.cameras).toHaveLength(1);
      expect(parsed.watchlists).toHaveLength(1);
      expect(parsed.notificationChannels).toHaveLength(1);

      // Verify strict exclusion of bulky media/video chunks
      expect((parsed as any).recordings).toBeUndefined();
      expect((parsed as any).videoSegments).toBeUndefined();
      expect((parsed as any).evidenceFiles).toBeUndefined();
    });

    it('should throw error if tenant does not exist', async () => {
      mockPrisma.tenant.findUnique.mockResolvedValue(null);
      await expect(service.exportApplianceBackup('nonexistent')).rejects.toThrow(
        'Tenant nonexistent not found'
      );
    });
  });

  describe('Transactional Restore', () => {
    it('should restore configuration successfully with matching counts', async () => {
      const backup = await service.exportApplianceBackup(tenantId);
      const result = await service.restoreApplianceBackup(backup, tenantId, 'usr_admin', '192.168.1.50');

      expect(result.success).toBe(true);
      expect(result.restoredCounts.sites).toBe(1);
      expect(result.restoredCounts.cameras).toBe(1);
      expect(result.restoredCounts.schedules).toBe(1);
      expect(result.restoredCounts.zones).toBe(1);
      expect(result.restoredCounts.layouts).toBe(1);
      expect(result.restoredCounts.watchlists).toBe(1);
      expect(result.restoredCounts.notificationChannels).toBe(1);

      expect(AuditChainService.record).toHaveBeenCalledWith(
        mockPrisma,
        expect.objectContaining({
          action: 'SYSTEM_RESTORE_APPLIANCE',
          tenantId,
          userId: 'usr_admin',
        })
      );
    });

    it('should reject backup with invalid format or version', async () => {
      const invalidBackup: BackupArchive = {
        format: 'INVALID_FORMAT' as any,
        version: 99,
        schemaVersion: '1.0',
        applianceId: 'app_1',
        tenantId,
        createdAt: new Date().toISOString(),
        checksumSha256: 'abc',
        encryptedPayload: 'def',
      };

      await expect(
        service.restoreApplianceBackup(invalidBackup, tenantId)
      ).rejects.toThrow('Incompatible backup format or version');
    });

    it('should reject corrupted backup archive when checksum does not match', async () => {
      const backup = await service.exportApplianceBackup(tenantId);
      backup.checksumSha256 = 'tampered_sha256_checksum_0000000000000000000000000000000000';

      await expect(
        service.restoreApplianceBackup(backup, tenantId)
      ).rejects.toThrow('Corrupted backup archive: SHA-256 checksum mismatch');
    });

    it('should reject archive with corrupted encrypted payload', async () => {
      const backup = await service.exportApplianceBackup(tenantId);
      backup.encryptedPayload = 'invalid:base64:payload:tampered';

      await expect(
        service.restoreApplianceBackup(backup, tenantId)
      ).rejects.toThrow('Failed to decrypt backup archive');
    });
  });
});
