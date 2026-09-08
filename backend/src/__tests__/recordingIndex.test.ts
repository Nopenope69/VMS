import { PrismaClient } from '@prisma/client';
import { RecordingIndexService } from '../services/recording/recordingIndex.service';
import { RecordingCatalog } from '../services/recording/catalog/recordingCatalog.service';

describe('Legacy Compatibility: RecordingIndexService facade over RecordingCatalog', () => {
  let prisma: any;
  let catalog: any;
  let indexService: RecordingIndexService;

  beforeEach(() => {
    prisma = {} as PrismaClient;
    catalog = {
      registerSegment: jest.fn(),
      findSeekTarget: jest.fn(),
      findSegments: jest.fn(),
      stepToAdjacentFrame: jest.fn(),
      getCoverage: jest.fn(),
    } as unknown as RecordingCatalog;

    indexService = new RecordingIndexService(prisma, catalog);
  });

  describe('Segment Indexing & PTS/UTC Timebase Translation', () => {
    it('delegates segment indexing to RecordingCatalog.registerSegment', async () => {
      const startUtc = new Date('2026-09-08T10:00:00.000Z');
      const endUtc = new Date('2026-09-08T10:01:00.000Z');

      (catalog.registerSegment as jest.Mock).mockResolvedValue({
        id: 'seg-1',
        tenantId: 'tenant-1',
        cameraId: 'cam-1',
        filePath: '/storage/cam-1/seg_001.mp4',
        startTime: startUtc,
        endTime: endUtc,
        startPts: 0n,
        endPts: 5400000n,
        fps: 30.0,
      });

      const seg = await indexService.indexSegment({
        tenantId: 'tenant-1',
        cameraId: 'cam-1',
        segmentUri: '/storage/cam-1/seg_001.mp4',
        startUtc,
        endUtc,
        timebaseNumerator: 1,
        timebaseDenominator: 90000,
        fps: 30.0,
      });

      expect(catalog.registerSegment).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          cameraId: 'cam-1',
          filePath: '/storage/cam-1/seg_001.mp4',
          startTime: startUtc,
          endTime: endUtc,
        })
      );
      expect(seg.id).toBe('seg-1');
      expect(seg.startPts).toBe(0n);
      expect(seg.endPts).toBe(5400000n);
    });

    it('rejects segment where endUtc is before startUtc', async () => {
      const startUtc = new Date('2026-09-08T10:05:00.000Z');
      const endUtc = new Date('2026-09-08T10:00:00.000Z');

      await expect(
        indexService.indexSegment({
          tenantId: 'tenant-1',
          cameraId: 'cam-1',
          segmentUri: '/storage/bad.mp4',
          startUtc,
          endUtc,
        })
      ).rejects.toThrow('endUtc cannot be earlier than startUtc');
    });
  });

  describe('Centralized Seek Target Resolution', () => {
    it('translates RecordingCatalog seek result into legacy format', async () => {
      const targetUtc = new Date('2026-09-08T10:00:15.000Z');

      (catalog.findSeekTarget as jest.Mock).mockResolvedValue({
        status: 'READY',
        segmentId: 'seg-1',
        segmentUri: '/storage/seg1.mp4',
        targetPts: 1350000n,
        nearestKeyframePts: 900000n,
        offsetMs: 15000,
        codec: 'h264',
        fps: 25.0,
        gapDurationMs: null,
      });

      const res = await indexService.findSeekTarget('tenant-1', 'cam-1', targetUtc);
      expect(res.found).toBe(true);
      expect(res.isGap).toBe(false);
      expect(res.targetPts).toBe(1350000n);
      expect(res.nearestKeyframePts).toBe(900000n);
      expect(res.deltaMsFromStart).toBe(15000);
      expect(res.segment.id).toBe('seg-1');
    });

    it('identifies recording gaps and reports gap duration', async () => {
      const targetUtc = new Date('2026-09-08T10:03:00.000Z');

      (catalog.findSeekTarget as jest.Mock).mockResolvedValue({
        status: 'NO_RECORDING',
        gapDurationMs: 120000,
      });

      const res = await indexService.findSeekTarget('tenant-1', 'cam-1', targetUtc);
      expect(res.found).toBe(false);
      expect(res.isGap).toBe(true);
      expect(res.gapDurationMs).toBe(120000);
    });
  });

  describe('Frame Stepping Delegation', () => {
    it('delegates stepping to catalog.stepToAdjacentFrame', async () => {
      (catalog.stepToAdjacentFrame as jest.Mock).mockResolvedValue({
        segmentId: 'seg-25fps',
        newPts: 39600n,
        frameDeltaPts: 3600n,
      });

      const step = await indexService.stepFrame('seg-25fps', 36000n, 'FORWARD', 'cam-1');

      expect(catalog.stepToAdjacentFrame).toHaveBeenCalledWith('cam-1', 'seg-25fps', 36000n, 'FORWARD');
      expect(step.newPts).toBe(39600n);
      expect(step.frameDeltaPts).toBe(3600n);
    });
  });

  describe('Recording Coverage & Gap Calculation', () => {
    it('delegates coverage query to catalog.getCoverage', async () => {
      const queryStart = new Date('2026-09-08T10:00:00.000Z');
      const queryEnd = new Date('2026-09-08T10:10:00.000Z');

      (catalog.getCoverage as jest.Mock).mockResolvedValue({
        cameraId: 'cam-1',
        rangeStart: queryStart,
        rangeEnd: queryEnd,
        coverageBlocks: [
          { startUtc: queryStart, endUtc: new Date('2026-09-08T10:04:00.000Z'), segmentIds: ['seg-a'] },
        ],
        gaps: [
          { startUtc: new Date('2026-09-08T10:04:00.000Z'), endUtc: new Date('2026-09-08T10:06:00.000Z'), durationMs: 120000 },
        ],
      });

      const coverage = await indexService.getRecordingCoverage(
        'tenant-1',
        'cam-1',
        queryStart,
        queryEnd
      );

      expect(catalog.getCoverage).toHaveBeenCalledWith('cam-1', queryStart, queryEnd, 2000);
      expect(coverage.coverageBlocks.length).toBe(1);
      expect(coverage.gaps.length).toBe(1);
    });
  });
});
