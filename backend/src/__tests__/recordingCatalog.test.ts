import { PrismaClient, SegmentStatus, EventSeverity, AlarmState } from '@prisma/client';
import { RecordingCatalog } from '../services/recording/catalog/recordingCatalog.service';
import { StorageAdapter } from '../services/recording/catalog/storageAdapter';
import { MediaProbeAdapter, MediaProbeResult } from '../services/recording/catalog/mediaProbeAdapter';

describe('Candidate 01: RecordingCatalog (Authoritative Recording Spine)', () => {
  let prisma: any;
  let mockStorageAdapter: StorageAdapter;
  let mockProbeAdapter: MediaProbeAdapter;
  let catalog: RecordingCatalog;

  const sampleCameraId = 'cam-101';
  const sampleTenantId = 'tenant-corp';
  const sampleFilePath = '/data/recordings/cam-101/2026-09-08_10-00-00.mp4';

  beforeEach(() => {
    // In-memory backing stores for mock Prisma
    const segmentTable: Map<string, any> = new Map();
    const pinTable: Map<string, any> = new Map();
    const alarmTable: any[] = [];

    prisma = {
      recordingSegment: {
        upsert: jest.fn().mockImplementation(({ where, create, update }) => {
          const key = where.filePath;
          if (segmentTable.has(key)) {
            const existing = segmentTable.get(key);
            const updated = { ...existing, ...update, updatedAt: new Date() };
            segmentTable.set(key, updated);
            return Promise.resolve(updated);
          }
          const created = {
            id: `seg-${segmentTable.size + 1}`,
            ...create,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          segmentTable.set(key, created);
          return Promise.resolve(created);
        }),
        findUnique: jest.fn().mockImplementation(({ where }) => {
          if (where.id) {
            for (const seg of segmentTable.values()) {
              if (seg.id === where.id) return Promise.resolve(seg);
            }
          }
          if (where.filePath) {
            return Promise.resolve(segmentTable.get(where.filePath) || null);
          }
          return Promise.resolve(null);
        }),
        findFirst: jest.fn().mockImplementation(({ where, orderBy }) => {
          const list = Array.from(segmentTable.values()).filter((s) => {
            if (s.cameraId !== where.cameraId) return false;
            if (where.startTime?.lte && s.startTime > where.startTime.lte) return false;
            if (where.endTime?.gte && s.endTime < where.endTime.gte) return false;
            if (where.endTime?.lte && s.endTime > where.endTime.lte) return false;
            if (where.startTime?.gt && s.startTime <= where.startTime.gt) return false;
            return true;
          });
          if (orderBy?.startTime === 'desc') list.sort((a, b) => b.startTime.getTime() - a.startTime.getTime());
          else if (orderBy?.endTime === 'desc') list.sort((a, b) => b.endTime.getTime() - a.endTime.getTime());
          else if (orderBy?.startTime === 'asc') list.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
          return Promise.resolve(list[0] || null);
        }),
        findMany: jest.fn().mockImplementation(({ where, orderBy }) => {
          let list = Array.from(segmentTable.values());
          if (where?.cameraId) list = list.filter((s) => s.cameraId === where.cameraId);
          if (where?.tenantId) list = list.filter((s) => s.tenantId === where.tenantId);
          if (where?.startTime?.lte) list = list.filter((s) => s.startTime <= where.startTime.lte);
          if (where?.endTime?.gte) list = list.filter((s) => s.endTime >= where.endTime.gte);
          if (where?.endTime?.lt) list = list.filter((s) => s.endTime < where.endTime.lt);
          if (where?.status) list = list.filter((s) => s.status === where.status);
          if (orderBy?.startTime === 'asc') list.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
          return Promise.resolve(list);
        }),
        delete: jest.fn().mockImplementation(({ where }) => {
          for (const [key, seg] of segmentTable.entries()) {
            if (seg.id === where.id) {
              segmentTable.delete(key);
              return Promise.resolve(seg);
            }
          }
          return Promise.resolve(null);
        }),
      },
      evidencePin: {
        findFirst: jest.fn().mockImplementation(({ where }) => {
          for (const pin of pinTable.values()) {
            if (pin.segmentId === where.segmentId) {
              const isReleased = pin.releasedAt != null;
              if (where.releasedAt === null && isReleased) continue;
              if (where.expiresAt?.gt && pin.expiresAt <= where.expiresAt.gt) continue;
              return Promise.resolve(pin);
            }
          }
          return Promise.resolve(null);
        }),
        findMany: jest.fn().mockImplementation(({ where }) => {
          const list = Array.from(pinTable.values()).filter((pin) => {
            if (where.segmentId?.in && !where.segmentId.in.includes(pin.segmentId)) return false;
            const isReleased = pin.releasedAt != null;
            if (where.releasedAt === null && isReleased) return false;
            if (where.expiresAt?.gt && pin.expiresAt <= where.expiresAt.gt) return false;
            return true;
          });
          return Promise.resolve(list);
        }),
        count: jest.fn().mockImplementation(({ where }) => {
          let count = 0;
          for (const pin of pinTable.values()) {
            if (pin.segmentId === where.segmentId) {
              const isReleased = pin.releasedAt != null;
              if (where.releasedAt === null && isReleased) continue;
              if (where.expiresAt?.gt && pin.expiresAt <= where.expiresAt.gt) continue;
              count++;
            }
          }
          return Promise.resolve(count);
        }),
        create: jest.fn().mockImplementation(({ data }) => {
          const pin = { id: `pin-${pinTable.size + 1}`, releasedAt: null, ...data };
          pinTable.set(pin.id, pin);
          return Promise.resolve(pin);
        }),
      },
      alarm: {
        create: jest.fn().mockImplementation(({ data }) => {
          const a = { id: `alarm-${alarmTable.length + 1}`, ...data };
          alarmTable.push(a);
          return Promise.resolve(a);
        }),
      },
    } as unknown as PrismaClient;

    mockStorageAdapter = {
      stat: jest.fn().mockResolvedValue({
        size: 15_000_000,
        mtime: new Date('2026-09-08T10:01:00.000Z'),
        exists: true,
      }),
      readFile: jest.fn().mockResolvedValue(Buffer.from('video data')),
      deleteFile: jest.fn().mockResolvedValue(undefined),
      scanDirectory: jest.fn().mockResolvedValue([]),
    };

    mockProbeAdapter = {
      probeMedia: jest.fn().mockResolvedValue({
        durationMs: 60000,
        codec: 'h264',
        width: 1920,
        height: 1080,
        fps: 25.0,
        timebaseNumerator: 1,
        timebaseDenominator: 90000,
        keyframeIndex: [
          { pts: 0n, fileOffset: 0 },
          { pts: 900000n, fileOffset: 10000 },
        ],
      } as MediaProbeResult),
    };

    catalog = new RecordingCatalog(prisma, mockStorageAdapter, mockProbeAdapter);
  });

  describe('Idempotent Registration & FFprobe Inspection', () => {
    it('registers a segment, probing container when metadata is missing', async () => {
      const seg = await catalog.registerSegment({
        tenantId: sampleTenantId,
        cameraId: sampleCameraId,
        filePath: sampleFilePath,
        startTime: new Date('2026-09-08T10:00:00.000Z'),
        endTime: new Date('2026-09-08T10:01:00.000Z'),
      });

      expect(seg.id).toBe('seg-1');
      expect(seg.filePath).toBe(sampleFilePath);
      expect(seg.codec).toBe('h264');
      expect(seg.startPts).toBe(0n);
      // 60,000 ms * 90000 / 1000 = 5,400,000 pts
      expect(seg.endPts).toBe(5400000n);
      expect(mockProbeAdapter.probeMedia).toHaveBeenCalledWith(sampleFilePath);
    });

    it('upserts idempotently on re-registration without creating duplicate rows', async () => {
      await catalog.registerSegment({
        tenantId: sampleTenantId,
        cameraId: sampleCameraId,
        filePath: sampleFilePath,
        startTime: new Date('2026-09-08T10:00:00.000Z'),
        endTime: new Date('2026-09-08T10:01:00.000Z'),
      });

      const updated = await catalog.registerSegment({
        tenantId: sampleTenantId,
        cameraId: sampleCameraId,
        filePath: sampleFilePath,
        startTime: new Date('2026-09-08T10:00:00.000Z'),
        endTime: new Date('2026-09-08T10:01:00.000Z'),
        sha256Hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      });

      expect(updated.id).toBe('seg-1');
      expect(updated.sha256Hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
      expect(prisma.recordingSegment.upsert).toHaveBeenCalledTimes(2);
    });
  });

  describe('Centralized Seek Target Resolution (Wall-Clock to Media PTS)', () => {
    it('returns READY and exact PTS when seeking inside an active segment', async () => {
      await catalog.registerSegment({
        tenantId: sampleTenantId,
        cameraId: sampleCameraId,
        filePath: sampleFilePath,
        startTime: new Date('2026-09-08T10:00:00.000Z'),
        endTime: new Date('2026-09-08T10:01:00.000Z'),
        durationMs: 60000,
        startPts: 0n,
        timebaseNumerator: 1,
        timebaseDenominator: 90000,
        keyframeIndexJson: [
          { pts: 0, offsetMs: 0 },
          { pts: 900000, offsetMs: 10000 },
          { pts: 1800000, offsetMs: 20000 },
        ],
      });

      // Target at 10:00:15 (15 seconds in)
      const seek = await catalog.findSeekTarget(sampleCameraId, new Date('2026-09-08T10:00:15.000Z'));

      expect(seek.status).toBe('READY');
      expect(seek.segmentId).toBe('seg-1');
      expect(seek.segmentUri).toBe(sampleFilePath);
      // 15 seconds * 90000 pts/sec = 1,350,000 pts
      expect(seek.targetPts).toBe(1350000n);
      // Nearest preceding keyframe at 10s = 900,000 pts
      expect(seek.nearestKeyframePts).toBe(900000n);
      expect(seek.offsetMs).toBe(15000);
      expect(seek.gapDurationMs).toBeNull();
    });

    it('returns NO_RECORDING with gap duration when seeking outside segments', async () => {
      await catalog.registerSegment({
        tenantId: sampleTenantId,
        cameraId: sampleCameraId,
        filePath: sampleFilePath,
        startTime: new Date('2026-09-08T10:00:00.000Z'),
        endTime: new Date('2026-09-08T10:01:00.000Z'),
      });

      // Seek at 10:05:00 (4 minutes past segment end)
      const seek = await catalog.findSeekTarget(sampleCameraId, new Date('2026-09-08T10:05:00.000Z'));

      expect(seek.status).toBe('NO_RECORDING');
      expect(seek.gapDurationMs).toBe(240000); // 4 minutes
    });
  });

  describe('Non-FPS-Dependent Frame Stepping', () => {
    it('steps through discrete keyframes when available', async () => {
      const seg = await catalog.registerSegment({
        tenantId: sampleTenantId,
        cameraId: sampleCameraId,
        filePath: sampleFilePath,
        startTime: new Date('2026-09-08T10:00:00.000Z'),
        endTime: new Date('2026-09-08T10:01:00.000Z'),
        startPts: 0n,
        endPts: 5400000n,
        keyframeIndexJson: [
          { pts: 0 },
          { pts: 90000 },
          { pts: 180000 },
        ],
      });

      const forward = await catalog.stepToAdjacentFrame(sampleCameraId, seg.id, 0n, 'FORWARD');
      expect(forward.newPts).toBe(90000n);

      const backward = await catalog.stepToAdjacentFrame(sampleCameraId, seg.id, 90000n, 'BACKWARD');
      expect(backward.newPts).toBe(0n);
    });

    it('falls back to exact timebase-derived delta when keyframe list is missing', async () => {
      const seg = await catalog.registerSegment({
        tenantId: sampleTenantId,
        cameraId: sampleCameraId,
        filePath: sampleFilePath,
        startTime: new Date('2026-09-08T10:00:00.000Z'),
        endTime: new Date('2026-09-08T10:01:00.000Z'),
        startPts: 0n,
        endPts: 5400000n,
        fps: 25.0,
        timebaseNumerator: 1,
        timebaseDenominator: 90000,
        keyframeIndexJson: [],
      });

      // At 25 FPS and 90,000 Hz timebase, delta per frame = 90000 / 25 = 3600 pts
      const step = await catalog.stepToAdjacentFrame(sampleCameraId, seg.id, 10000n, 'FORWARD');
      expect(step.newPts).toBe(13600n);
      expect(step.frameDeltaPts).toBe(3600n);
    });
  });

  describe('Wall-Clock Coverage & Gap Calculation', () => {
    it('calculates coverage blocks and detects gaps exceeding threshold without carrying PTS', async () => {
      // Segment 1: 10:00:00 to 10:05:00
      await catalog.registerSegment({
        tenantId: sampleTenantId,
        cameraId: sampleCameraId,
        filePath: '/data/seg1.mp4',
        startTime: new Date('2026-09-08T10:00:00.000Z'),
        endTime: new Date('2026-09-08T10:05:00.000Z'),
      });

      // Segment 2: 10:06:00 to 10:10:00 (1 minute gap: 60,000 ms)
      await catalog.registerSegment({
        tenantId: sampleTenantId,
        cameraId: sampleCameraId,
        filePath: '/data/seg2.mp4',
        startTime: new Date('2026-09-08T10:06:00.000Z'),
        endTime: new Date('2026-09-08T10:10:00.000Z'),
      });

      const coverage = await catalog.getCoverage(
        sampleCameraId,
        new Date('2026-09-08T10:00:00.000Z'),
        new Date('2026-09-08T10:10:00.000Z'),
        2000 // 2s gap threshold
      );

      expect(coverage.coverageBlocks.length).toBe(2);
      expect(coverage.coverageBlocks[0].startUtc).toEqual(new Date('2026-09-08T10:00:00.000Z'));
      expect(coverage.coverageBlocks[0].endUtc).toEqual(new Date('2026-09-08T10:05:00.000Z'));

      expect(coverage.gaps.length).toBe(1);
      expect(coverage.gaps[0].durationMs).toBe(60000);
      expect(coverage.gaps[0].reason).toBe('INTER_SEGMENT_GAP');
    });
  });

  describe('Evidence Pin Precedence & Retention Pruning', () => {
    it('deletes expired unpinned segments but preserves actively pinned segments', async () => {
      // Unpinned segment (35 days old)
      const unpinned = await catalog.registerSegment({
        tenantId: sampleTenantId,
        cameraId: sampleCameraId,
        filePath: '/data/old_unpinned.mp4',
        startTime: new Date('2026-08-01T00:00:00.000Z'),
        endTime: new Date('2026-08-01T01:00:00.000Z'),
        sizeBytes: 10_000_000n,
      });

      // Pinned segment (35 days old, but pinned for investigation)
      const pinned = await catalog.registerSegment({
        tenantId: sampleTenantId,
        cameraId: sampleCameraId,
        filePath: '/data/old_pinned.mp4',
        startTime: new Date('2026-08-01T00:00:00.000Z'),
        endTime: new Date('2026-08-01T01:00:00.000Z'),
        sizeBytes: 20_000_000n,
      });

      await catalog.pinSegment(sampleTenantId, pinned.id, 'job-investigation-1', 'Court subpoena evidence');

      expect(await catalog.isPinned(pinned.id)).toBe(true);
      expect(await catalog.isPinned(unpinned.id)).toBe(false);

      const pruneReport = await catalog.pruneRetention(sampleTenantId, {
        maxRetentionDays: 30,
      });

      expect(pruneReport.purgedCount).toBe(1);
      expect(pruneReport.reclaimedBytes).toBe(10_000_000n);
      expect(pruneReport.pinnedSkippedCount).toBe(1);
      expect(mockStorageAdapter.deleteFile).toHaveBeenCalledWith('/data/old_unpinned.mp4');
      expect(mockStorageAdapter.deleteFile).not.toHaveBeenCalledWith('/data/old_pinned.mp4');
    });

    it('raises STORAGE_QUOTA_PINNED_EXHAUSTION when disk quota cannot be met due to pins', async () => {
      // Pinned segment taking 50MB
      const pinned = await catalog.registerSegment({
        tenantId: sampleTenantId,
        cameraId: sampleCameraId,
        filePath: '/data/heavy_pinned.mp4',
        startTime: new Date('2026-08-01T00:00:00.000Z'),
        endTime: new Date('2026-08-01T01:00:00.000Z'),
        sizeBytes: 50_000_000n,
      });
      await catalog.pinSegment(sampleTenantId, pinned.id, 'job-court-2', 'Litigation hold');

      // Target quota is 10MB, but 50MB is pinned. No unpinned candidates exist.
      const pruneReport = await catalog.pruneRetention(sampleTenantId, {
        targetQuotaBytes: 10_000_000n,
      });

      expect(pruneReport.exhaustionCondition).toBe(true);
      expect(prisma.alarm.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            severity: EventSeverity.CRITICAL,
            state: AlarmState.ACTIVE,
            title: 'STORAGE_QUOTA_PINNED_EXHAUSTION',
          }),
        })
      );
    });
  });
});
