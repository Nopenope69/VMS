import { ConfigSyncService, DesiredConfigPayload, ConfigAckPayload } from '../services/federation/configSync.service';

describe('ConfigSyncService (Declarative Desired-State Configuration & Versioned ACKs)', () => {
  let service: ConfigSyncService;
  let mockPrisma: any;
  const tenantId = 'tenant_cfg_01';
  const nodeUuid = 'node_cfg_edge_001';
  const nodeId = 'db_node_id_001';

  beforeEach(() => {
    mockPrisma = {
      camera: { findMany: jest.fn() },
      recordingSchedule: { findMany: jest.fn() },
      detectionZone: { findMany: jest.fn() },
      vehicleWatchlist: { findMany: jest.fn() },
      automationRule: { findMany: jest.fn() },
      federatedNode: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      configSyncRecord: {
        create: jest.fn(),
        updateMany: jest.fn(),
      },
      $transaction: jest.fn(async (ops: any[]) => Promise.all(ops)),
    };
    service = new ConfigSyncService(mockPrisma);
  });

  describe('Desired State Configuration Bundle Generation', () => {
    it('should aggregate tenant configuration into versioned declarative payload', async () => {
      mockPrisma.camera.findMany.mockResolvedValue([
        {
          id: 'cam_01',
          name: 'Main Gate',
          ipAddress: '192.168.1.50',
          rtspPort: 554,
          mainRtspUri: 'rtsp://192.168.1.50:554/live',
          subRtspUri: 'rtsp://192.168.1.50:554/sub',
        },
      ]);
      mockPrisma.recordingSchedule.findMany.mockResolvedValue([{ id: 'sched_01' }]);
      mockPrisma.detectionZone.findMany.mockResolvedValue([{ id: 'zone_01' }]);
      mockPrisma.vehicleWatchlist.findMany.mockResolvedValue([{ id: 'wl_01' }]);
      mockPrisma.automationRule.findMany.mockResolvedValue([{ id: 'rule_01', enabled: true }]);

      const config = await service.generateDesiredConfig(tenantId, 12);

      expect(config.version).toBe(12);
      expect(config.tenantId).toBe(tenantId);
      expect(config.cameras).toHaveLength(1);
      expect(config.cameras[0].name).toBe('Main Gate');
      expect(config.schedules).toHaveLength(1);
      expect(config.detectionZones).toHaveLength(1);
      expect(config.watchlists).toHaveLength(1);
      expect(config.automationRules).toHaveLength(1);
      expect(config.generatedAt).toBeDefined();
    });
  });

  describe('Config Sync Record Creation', () => {
    it('should create pending sync record for target node', async () => {
      mockPrisma.federatedNode.findUnique.mockResolvedValue({
        id: nodeId,
        nodeUuid,
        tenantId,
      });
      mockPrisma.configSyncRecord.create.mockResolvedValue({
        id: 'sync_rec_01',
        nodeId,
        desiredVersion: 5,
        status: 'PENDING',
      });

      const payload: DesiredConfigPayload = {
        version: 5,
        tenantId,
        cameras: [],
        schedules: [],
        detectionZones: [],
        watchlists: [],
        automationRules: [],
        generatedAt: new Date().toISOString(),
      };

      const record = await service.createSyncRecord(nodeUuid, payload);

      expect(record.status).toBe('PENDING');
      expect(mockPrisma.configSyncRecord.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId,
            nodeId,
            desiredVersion: 5,
            status: 'PENDING',
          }),
        })
      );
    });

    it('should throw error when node is not found', async () => {
      mockPrisma.federatedNode.findUnique.mockResolvedValue(null);
      await expect(
        service.createSyncRecord('invalid_node', {} as any)
      ).rejects.toThrow('Node invalid_node not found');
    });
  });

  describe('CONFIG_ACK Handling', () => {
    it('should update sync record and federated node when edge applies configuration', async () => {
      mockPrisma.federatedNode.findUnique.mockResolvedValue({
        id: nodeId,
        nodeUuid,
        tenantId,
      });

      const ack: ConfigAckPayload = {
        desiredVersion: 7,
        appliedVersion: 7,
        status: 'APPLIED',
        appliedAt: new Date().toISOString(),
      };

      const result = await service.handleConfigAck(nodeUuid, ack);

      expect(result.success).toBe(true);
      expect(result.appliedVersion).toBe(7);
      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(mockPrisma.configSyncRecord.updateMany).toHaveBeenCalledWith({
        where: { nodeId, desiredVersion: 7 },
        data: expect.objectContaining({
          appliedVersion: 7,
          status: 'APPLIED',
        }),
      });
      expect(mockPrisma.federatedNode.update).toHaveBeenCalledWith({
        where: { nodeUuid },
        data: { configVersionApplied: 7 },
      });
    });

    it('should record error and rejected status on ACK failure', async () => {
      mockPrisma.federatedNode.findUnique.mockResolvedValue({
        id: nodeId,
        nodeUuid,
        tenantId,
      });

      const ack: ConfigAckPayload = {
        desiredVersion: 8,
        appliedVersion: 7, // Stays at 7
        status: 'REJECTED',
        error: 'Schema migration conflict on edge SQLite',
        appliedAt: new Date().toISOString(),
      };

      const result = await service.handleConfigAck(nodeUuid, ack);

      expect(result.success).toBe(true);
      expect(mockPrisma.configSyncRecord.updateMany).toHaveBeenCalledWith({
        where: { nodeId, desiredVersion: 8 },
        data: expect.objectContaining({
          appliedVersion: 7,
          status: 'REJECTED',
          errorMessage: 'Schema migration conflict on edge SQLite',
        }),
      });
    });
  });

  describe('Protocol Version Compatibility', () => {
    it('should report compatible when protocol versions match', () => {
      const check = service.isCompatible(1, 1);
      expect(check.compatible).toBe(true);
      expect(check.reason).toBeUndefined();
    });

    it('should report incompatible when protocol versions differ', () => {
      const check = service.isCompatible(2, 1);
      expect(check.compatible).toBe(false);
      expect(check.reason).toContain('Protocol version mismatch');
    });
  });
});
