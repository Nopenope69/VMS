import { RecordingWatchdogService } from '../services/recording/recordingWatchdog.service';
import { RetentionService } from '../services/recording/retention.service';

describe('Recording Watchdog & Retention Services', () => {
  describe('RecordingWatchdogService - Gap Detection', () => {
    it('should detect continuous recording with no gaps under threshold', async () => {
      const mockPrisma: any = {
        recordingSegment: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'seg_1',
              startTime: new Date('2026-09-07T00:00:00Z'),
              endTime: new Date('2026-09-07T00:10:00Z'),
            },
            {
              id: 'seg_2',
              startTime: new Date('2026-09-07T00:10:01Z'), // 1s diff (under 5s threshold)
              endTime: new Date('2026-09-07T00:20:00Z'),
            },
          ]),
        },
      };

      const watchdog = new RecordingWatchdogService(mockPrisma);
      const gaps = await watchdog.detectGaps(
        'cam_01',
        new Date('2026-09-07T00:00:00Z'),
        new Date('2026-09-07T00:20:00Z'),
        5000
      );

      expect(gaps).toHaveLength(0);
    });

    it('should flag recording gap when gap exceeds 5000ms threshold', async () => {
      const mockPrisma: any = {
        recordingSegment: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'seg_1',
              startTime: new Date('2026-09-07T00:00:00Z'),
              endTime: new Date('2026-09-07T00:10:00Z'),
            },
            {
              id: 'seg_2',
              // 45 second gap!
              startTime: new Date('2026-09-07T00:10:45Z'),
              endTime: new Date('2026-09-07T00:20:00Z'),
            },
          ]),
        },
      };

      const watchdog = new RecordingWatchdogService(mockPrisma);
      const gaps = await watchdog.detectGaps(
        'cam_01',
        new Date('2026-09-07T00:00:00Z'),
        new Date('2026-09-07T00:20:00Z'),
        5000
      );

      expect(gaps).toHaveLength(1);
      expect(gaps[0].gapDurationSeconds).toBe(45);
      expect(gaps[0].gapStart).toEqual(new Date('2026-09-07T00:10:00Z'));
      expect(gaps[0].gapEnd).toEqual(new Date('2026-09-07T00:10:45Z'));
    });

    it('should detect stalled recorders and raise critical alarm', async () => {
      const mockEventCreate = jest.fn().mockResolvedValue({ id: 'event_rec_gap_01' });
      const mockAlarmCreate = jest.fn().mockResolvedValue({ id: 'alarm_rec_gap_01' });

      const mockPrisma: any = {
        camera: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'cam_stalled_01',
              name: 'Loading Bay',
              tenantId: 'tenant_01',
              // Started recording 15 minutes ago
              lastStateChangeAt: new Date(Date.now() - 900 * 1000),
            },
          ]),
        },
        recordingSegment: {
          // No segments finalized ever!
          findFirst: jest.fn().mockResolvedValue(null),
        },
        alarm: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: mockAlarmCreate,
        },
        event: {
          create: mockEventCreate,
        },
      };

      const watchdog = new RecordingWatchdogService(mockPrisma);
      const reports = await watchdog.checkAllRecorders(600); // 10 min max

      expect(reports).toHaveLength(1);
      expect(reports[0].health).toBe('STALLED');
      expect(mockEventCreate).toHaveBeenCalledTimes(1);
      expect(mockAlarmCreate).toHaveBeenCalledTimes(1);
      expect(mockAlarmCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            title: expect.stringContaining('STALLED on Loading Bay'),
            severity: 'CRITICAL',
            state: 'ACTIVE',
          }),
        })
      );
    });
  });

  describe('RetentionService - Policy Pruning & Pin Protection', () => {
    it('should prune expired unpinned segments and preserve pinned segments', async () => {
      const now = new Date('2026-09-07T00:00:00Z');
      const sixtyDaysAgo = new Date('2026-07-09T00:00:00Z');
      const tenDaysAgo = new Date('2026-08-28T00:00:00Z');

      const mockDelete = jest.fn().mockResolvedValue({});
      const mockPrisma: any = {
        retentionPolicy: {
          findMany: jest.fn().mockResolvedValue([
            {
              tenantId: 'tenant_01',
              cameraId: null,
              continuousDays: 30, // 30-day retention
              motionDays: 90,
            },
          ]),
        },
        recordingSegment: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'seg_recent',
              tenantId: 'tenant_01',
              cameraId: 'cam_01',
              endTime: tenDaysAgo, // Within 30 days
              filePath: '/recordings/cam_01/recent.mp4',
              sizeBytes: BigInt(50000000),
              evidencePins: [],
            },
            {
              id: 'seg_expired_unpinned',
              tenantId: 'tenant_01',
              cameraId: 'cam_01',
              endTime: sixtyDaysAgo, // Older than 30 days -> PRUNED
              filePath: '/recordings/cam_01/expired.mp4',
              sizeBytes: BigInt(100000000),
              evidencePins: [],
            },
            {
              id: 'seg_expired_PINNED',
              tenantId: 'tenant_01',
              cameraId: 'cam_01',
              endTime: sixtyDaysAgo, // Older than 30 days, BUT PINNED -> PRESERVED!
              filePath: '/recordings/cam_01/pinned.mp4',
              sizeBytes: BigInt(200000000),
              evidencePins: [
                {
                  id: 'pin_01',
                  expiresAt: new Date('2026-10-01T00:00:00Z'),
                  releasedAt: null,
                },
              ],
            },
          ]),
          delete: mockDelete,
        },
      };

      const retention = new RetentionService(mockPrisma);
      const report = await retention.executeRetentionPrune(now);

      expect(report.evaluatedSegmentsCount).toBe(3);
      expect(report.purgedCount).toBe(1);
      expect(report.pinnedSkippedCount).toBe(1);
      expect(report.reclaimedBytes).toBe(BigInt(100000000));
      expect(mockDelete).toHaveBeenCalledTimes(1);
      expect(mockDelete).toHaveBeenCalledWith({ where: { id: 'seg_expired_unpinned' } });
    });
  });
});
