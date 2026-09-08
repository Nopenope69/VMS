import { SyncEngineService, SyncBatchPayload } from '../services/federation/syncEngine.service';

describe('SyncEngineService (Store-and-Forward Sync & Monotonic Sequence Continuity)', () => {
  let service: SyncEngineService;
  let mockPrisma: any;
  const nodeUuid = 'node_sync_edge_001';
  const tenantId = 'tenant_fed_01';

  beforeEach(() => {
    mockPrisma = {
      federatedNode: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      detectionEvent: {
        create: jest.fn(),
      },
      $transaction: jest.fn(async (cb: any) => {
        return cb(mockPrisma);
      }),
    };
    service = new SyncEngineService(mockPrisma);
  });

  describe('Sync Cursor Tracking', () => {
    it('should retrieve individual cursors for EVENT, AUDIT, and ALARM streams', async () => {
      mockPrisma.federatedNode.findUnique.mockResolvedValue({
        nodeUuid,
        syncCursorEvent: 150n,
        syncCursorAudit: 42n,
        syncCursorAlarm: 10n,
      });

      expect(await service.getSyncCursor(nodeUuid, 'EVENT')).toBe(150n);
      expect(await service.getSyncCursor(nodeUuid, 'AUDIT')).toBe(42n);
      expect(await service.getSyncCursor(nodeUuid, 'ALARM')).toBe(10n);
    });

    it('should throw error if node is not found', async () => {
      mockPrisma.federatedNode.findUnique.mockResolvedValue(null);
      await expect(service.getSyncCursor('nonexistent', 'EVENT')).rejects.toThrow(
        'Federated node nonexistent not found'
      );
    });
  });

  describe('Batch Processing & Monotonic Sequence Continuity', () => {
    it('should accept sequential batch and advance sync cursor transactionally', async () => {
      mockPrisma.federatedNode.findUnique.mockResolvedValue({
        nodeUuid,
        tenantId,
        syncCursorEvent: 100n,
      });

      const batch: SyncBatchPayload = {
        streamType: 'EVENT',
        fromSeq: 101n,
        toSeq: 103n,
        items: [
          {
            seq: 101n,
            id: 'evt_101',
            type: 'MOTION',
            timestamp: new Date().toISOString(),
            data: { cameraId: 'cam_01', confidence: 0.95 },
          },
          {
            seq: 102n,
            id: 'evt_102',
            type: 'TRIPWIRE_CROSSING',
            timestamp: new Date().toISOString(),
            data: { cameraId: 'cam_01', confidence: 0.88 },
          },
          {
            seq: 103n,
            id: 'evt_103',
            type: 'LOITERING_DWELL',
            timestamp: new Date().toISOString(),
            data: { cameraId: 'cam_01', confidence: 0.92 },
          },
        ],
      };

      const ack = await service.processSyncBatch(nodeUuid, batch);

      expect(ack.status).toBe('ACCEPTED');
      expect(ack.acknowledgedCursor).toBe(103n);
      expect(mockPrisma.detectionEvent.create).toHaveBeenCalledTimes(3);
      expect(mockPrisma.federatedNode.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { nodeUuid },
          data: { syncCursorEvent: 103n },
        })
      );
    });

    it('should detect sequence gap and return GAP_DETECTED without advancing cursor', async () => {
      mockPrisma.federatedNode.findUnique.mockResolvedValue({
        nodeUuid,
        tenantId,
        syncCursorEvent: 100n,
      });

      // Gap: expects 101n, but arrives 105n
      const batch: SyncBatchPayload = {
        streamType: 'EVENT',
        fromSeq: 105n,
        toSeq: 106n,
        items: [],
      };

      const ack = await service.processSyncBatch(nodeUuid, batch);

      expect(ack.status).toBe('GAP_DETECTED');
      expect(ack.acknowledgedCursor).toBe(100n);
      expect(ack.error).toContain('Expected sequence 101, but received 105');
      expect(mockPrisma.detectionEvent.create).not.toHaveBeenCalled();
      expect(mockPrisma.federatedNode.update).not.toHaveBeenCalled();
    });

    it('should ignore duplicate batches where toSeq <= currentCursor', async () => {
      mockPrisma.federatedNode.findUnique.mockResolvedValue({
        nodeUuid,
        tenantId,
        syncCursorEvent: 200n,
      });

      // Duplicate batch with sequences already processed
      const batch: SyncBatchPayload = {
        streamType: 'EVENT',
        fromSeq: 190n,
        toSeq: 200n,
        items: [],
      };

      const ack = await service.processSyncBatch(nodeUuid, batch);

      expect(ack.status).toBe('DUPLICATE_IGNORED');
      expect(ack.acknowledgedCursor).toBe(200n);
      expect(mockPrisma.detectionEvent.create).not.toHaveBeenCalled();
    });

    it('should handle partial overlapping batches by filtering previously committed items', async () => {
      mockPrisma.federatedNode.findUnique.mockResolvedValue({
        nodeUuid,
        tenantId,
        syncCursorEvent: 50n,
      });

      // Overlap: starts at 50n (already seen), ends at 52n
      const batch: SyncBatchPayload = {
        streamType: 'EVENT',
        fromSeq: 50n,
        toSeq: 52n,
        items: [
          {
            seq: 50n,
            id: 'evt_50',
            type: 'MOTION',
            timestamp: new Date().toISOString(),
            data: { cameraId: 'cam_01' },
          },
          {
            seq: 51n,
            id: 'evt_51',
            type: 'MOTION',
            timestamp: new Date().toISOString(),
            data: { cameraId: 'cam_01' },
          },
          {
            seq: 52n,
            id: 'evt_52',
            type: 'MOTION',
            timestamp: new Date().toISOString(),
            data: { cameraId: 'cam_01' },
          },
        ],
      };

      const ack = await service.processSyncBatch(nodeUuid, batch);

      expect(ack.status).toBe('ACCEPTED');
      expect(ack.acknowledgedCursor).toBe(52n);
      // Only items 51 and 52 should be created, item 50 should be skipped
      expect(mockPrisma.detectionEvent.create).toHaveBeenCalledTimes(2);
      expect(mockPrisma.federatedNode.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { nodeUuid },
          data: { syncCursorEvent: 52n },
        })
      );
    });
  });
});
