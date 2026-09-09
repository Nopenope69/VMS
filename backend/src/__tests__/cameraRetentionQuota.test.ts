import { RetentionPriority } from '@prisma/client';
import { RetentionPolicyEngine } from '../services/recording/catalog/retentionPolicy';
import { StorageAdapter } from '../services/recording/catalog/storageAdapter';

describe('Phase 2: Priority-Driven Retention & Per-Camera Quota Engine', () => {
  let prismaMock: any;
  let mockStorageAdapter: StorageAdapter;
  let engine: RetentionPolicyEngine;

  let segmentsTable: Map<string, any>;
  let pinsTable: Map<string, any>;
  let alarmsTable: any[];

  beforeEach(() => {
    segmentsTable = new Map();
    pinsTable = new Map();
    alarmsTable = [];

    mockStorageAdapter = {
      stat: jest.fn().mockResolvedValue({ exists: true, size: 1000, mtime: new Date() }),
      deleteFile: jest.fn().mockResolvedValue(undefined),
      readFile: jest.fn().mockResolvedValue(Buffer.alloc(0)),
      scanDirectory: jest.fn().mockResolvedValue([]),
    };

    prismaMock = {
      $executeRaw: jest.fn().mockImplementation(async () => 1),
      camera: {
        findMany: jest.fn(),
      },
      retentionPolicy: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      recordingSegment: {
        findMany: jest.fn().mockImplementation(({ where }) => {
          let list = Array.from(segmentsTable.values());
          if (where?.cameraId) list = list.filter((s) => s.cameraId === where.cameraId);
          if (where?.status) list = list.filter((s) => s.status === where.status);
          list.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
          return Promise.resolve(list);
        }),
      },
      alarm: {
        create: jest.fn().mockImplementation(({ data }) => {
          alarmsTable.push(data);
          return Promise.resolve(data);
        }),
      },
    };

    const mockSegmentRepo: any = {
      findRetentionCandidates: jest.fn().mockResolvedValue([]),
      findSegmentsForQuota: jest.fn().mockResolvedValue([]),
      deleteSegment: jest.fn().mockImplementation((id: string) => {
        segmentsTable.delete(id);
        return Promise.resolve();
      }),
    };

    const mockPinRegistry: any = {
      isPinned: jest.fn().mockImplementation((id: string) => {
        return Promise.resolve(pinsTable.has(id));
      }),
      getPinnedSegmentIds: jest.fn().mockImplementation((ids: string[]) => {
        const pinned = new Set<string>();
        for (const id of ids) {
          if (pinsTable.has(id)) pinned.add(id);
        }
        return Promise.resolve(pinned);
      }),
    };

    engine = new RetentionPolicyEngine(
      prismaMock,
      mockSegmentRepo,
      mockPinRegistry,
      mockStorageAdapter
    );
  });

  it('prunes camera exceeding its maxStorageGigabytes while leaving other cameras untouched', async () => {
    const now = new Date();

    // Setup 2 cameras: Cam A has a 5GB quota; Cam B has no quota
    const camA = {
      id: 'cam-a',
      name: 'Parking Lot',
      tenantId: 'tenant-1',
      retentionPriority: RetentionPriority.LOW,
      retentionPolicy: {
        continuousDays: 30,
        motionDays: 90,
        maxStorageGigabytes: 2, // 2 GB quota
      },
    };

    const camB = {
      id: 'cam-b',
      name: 'Main Vault',
      tenantId: 'tenant-1',
      retentionPriority: RetentionPriority.HIGH,
      retentionPolicy: {
        continuousDays: 30,
        motionDays: 90,
        maxStorageGigabytes: 100, // 100 GB quota
      },
    };

    prismaMock.camera.findMany.mockResolvedValue([camA, camB]);

    // Populate segments for Cam A: 4 segments of 1 GB each = 4 GB (exceeds 2 GB quota by 2 GB)
    const oneGb = 1024n * 1024n * 1024n;
    for (let i = 1; i <= 4; i++) {
      const segId = `seg-a-${i}`;
      segmentsTable.set(segId, {
        id: segId,
        cameraId: 'cam-a',
        filePath: `/data/cam-a/seg-${i}.mp4`,
        startTime: new Date(now.getTime() - (10 - i) * 3600 * 1000),
        endTime: new Date(now.getTime() - (9 - i) * 3600 * 1000),
        sizeBytes: oneGb,
        status: 'FINALIZED',
      });
    }

    // Populate segment for Cam B: 1 segment of 1 GB (within 100 GB quota)
    segmentsTable.set('seg-b-1', {
      id: 'seg-b-1',
      cameraId: 'cam-b',
      filePath: `/data/cam-b/seg-1.mp4`,
      startTime: new Date(now.getTime() - 5 * 3600 * 1000),
      endTime: new Date(now.getTime() - 4 * 3600 * 1000),
      sizeBytes: oneGb,
      status: 'FINALIZED',
    });

    const report = await engine.pruneCameraQuotasAndRetention('tenant-1', now);

    // Cam A should have purged its 2 oldest unpinned segments (seg-a-1 and seg-a-2) to fit under 2GB
    expect(report.purgedCount).toBe(2);
    expect(report.reclaimedBytes).toBe(oneGb * 2n);
    expect(mockStorageAdapter.deleteFile).toHaveBeenCalledWith('/data/cam-a/seg-1.mp4');
    expect(mockStorageAdapter.deleteFile).toHaveBeenCalledWith('/data/cam-a/seg-2.mp4');

    // Cam B's segment must not have been deleted
    expect(mockStorageAdapter.deleteFile).not.toHaveBeenCalledWith('/data/cam-b/seg-1.mp4');
  });

  it('protects actively pinned segments from deletion during quota overage and raises exhaustion alarm', async () => {
    const now = new Date();

    const camA = {
      id: 'cam-a',
      name: 'Cash Register',
      tenantId: 'tenant-1',
      retentionPriority: RetentionPriority.NORMAL,
      retentionPolicy: {
        continuousDays: 30,
        motionDays: 90,
        maxStorageGigabytes: 1, // 1 GB quota
      },
    };

    prismaMock.camera.findMany.mockResolvedValue([camA]);

    const oneGb = 1024n * 1024n * 1024n;
    // 2 segments of 1 GB each = 2 GB total. seg-a-1 is PINNED under legal hold!
    segmentsTable.set('seg-a-1', {
      id: 'seg-a-1',
      cameraId: 'cam-a',
      filePath: `/data/cam-a/seg-1.mp4`,
      startTime: new Date(now.getTime() - 8 * 3600 * 1000),
      endTime: new Date(now.getTime() - 7 * 3600 * 1000),
      sizeBytes: oneGb,
      status: 'FINALIZED',
    });
    pinsTable.set('seg-a-1', { id: 'pin-1', segmentId: 'seg-a-1' });

    segmentsTable.set('seg-a-2', {
      id: 'seg-a-2',
      cameraId: 'cam-a',
      filePath: `/data/cam-a/seg-2.mp4`,
      startTime: new Date(now.getTime() - 6 * 3600 * 1000),
      endTime: new Date(now.getTime() - 5 * 3600 * 1000),
      sizeBytes: oneGb,
      status: 'FINALIZED',
    });
    pinsTable.set('seg-a-2', { id: 'pin-2', segmentId: 'seg-a-2' });

    // Mock atomic delete to return 0 when pinned
    prismaMock.$executeRaw.mockResolvedValue(0);

    const report = await engine.pruneCameraQuotasAndRetention('tenant-1', now);

    // No files should be deleted because both are pinned!
    expect(report.purgedCount).toBe(0);
    expect(report.pinnedSkippedCount).toBeGreaterThanOrEqual(2);
    expect(report.exhaustionCondition).toBe(true);
    expect(mockStorageAdapter.deleteFile).not.toHaveBeenCalled();

    // Alarm must be raised
    expect(alarmsTable.length).toBe(1);
    expect(alarmsTable[0].title).toBe('STORAGE_QUOTA_PINNED_EXHAUSTION');
  });
});
