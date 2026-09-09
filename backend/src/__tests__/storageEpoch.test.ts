import { StorageEpochService } from '../services/storage/storageEpoch.service';

describe('Phase 2: StorageEpochService & Evidentiary Provenance', () => {
  let prismaMock: any;
  let epochTable: Map<string, any>;
  let eventsTable: any[];
  let service: StorageEpochService;

  beforeEach(() => {
    epochTable = new Map();
    eventsTable = [];

    prismaMock = {
      storageEpoch: {
        findFirst: jest.fn().mockImplementation(({ where, orderBy }) => {
          let list = Array.from(epochTable.values()).filter((e) => {
            if (e.cameraId !== where.cameraId) return false;
            if (where.endedAt === null && e.endedAt != null) return false;
            return true;
          });
          if (orderBy?.epochNumber === 'desc') {
            list.sort((a, b) => b.epochNumber - a.epochNumber);
          }
          return Promise.resolve(list[0] || null);
        }),
        create: jest.fn().mockImplementation(({ data }) => {
          const created = { id: `epoch-${epochTable.size + 1}`, ...data };
          epochTable.set(created.id, created);
          return Promise.resolve(created);
        }),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const existing = epochTable.get(where.id);
          const updated = { ...existing, ...data };
          epochTable.set(where.id, updated);
          return Promise.resolve(updated);
        }),
      },
      event: {
        create: jest.fn().mockImplementation(({ data }) => {
          eventsTable.push(data);
          return Promise.resolve(data);
        }),
      },
    };

    service = new StorageEpochService(prismaMock);
  });

  it('initializes Genesis epoch (epoch 1) with 64-zero previous hash and deterministic sha256', async () => {
    const epoch = await service.getOrCreateActiveEpoch('tenant-1', 'cam-101', 'vol-alpha');

    expect(epoch.epochNumber).toBe(1);
    expect(epoch.prevEpochHash).toBe('0'.repeat(64));
    expect(epoch.storageVolumeId).toBe('vol-alpha');
    expect(epoch.transitionReason).toBe('GENESIS_PROVISION');
    expect(epoch.epochHash).toBeDefined();
    expect(epoch.epochHash?.length).toBe(64);
  });

  it('chains previous epoch hash on failover transition and logs STORAGE_FAILOVER event', async () => {
    // Epoch 1
    const epoch1 = await service.getOrCreateActiveEpoch('tenant-1', 'cam-101', 'vol-alpha');

    // Trigger failover to vol-beta
    const epoch2 = await service.transitionEpoch({
      tenantId: 'tenant-1',
      cameraId: 'cam-101',
      toVolumeId: 'vol-beta',
      reason: 'FAILOVER_EROFS',
    });

    expect(epoch2.epochNumber).toBe(2);
    expect(epoch2.storageVolumeId).toBe('vol-beta');
    expect(epoch2.prevEpochHash).toBe(epoch1.epochHash);
    expect(epoch2.transitionReason).toBe('FAILOVER_EROFS');

    // Verify epoch 1 was closed with endedAt
    const updatedEpoch1 = epochTable.get(epoch1.id);
    expect(updatedEpoch1.endedAt).toBeDefined();

    // Verify audit event
    expect(eventsTable.length).toBe(1);
    expect(eventsTable[0].type).toBe('STORAGE_FAILOVER');
    expect(eventsTable[0].metadata.fromVolumeId).toBe('vol-alpha');
    expect(eventsTable[0].metadata.toVolumeId).toBe('vol-beta');
    expect(eventsTable[0].metadata.newEpochNumber).toBe(2);
  });
});
