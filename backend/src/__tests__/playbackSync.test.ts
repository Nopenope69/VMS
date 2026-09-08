import { PlaybackSessionState, PrismaClient } from '@prisma/client';
import { PlaybackSyncService } from '../services/playback/playbackSync.service';
import { RecordingCatalog } from '../services/recording/catalog/recordingCatalog.service';

describe('Bucket 6: Multi-Camera Synchronized Playback & Reverse Shuttle', () => {
  let prisma: any;
  let recordingCatalog: any;
  let playbackService: PlaybackSyncService;

  beforeEach(() => {
    prisma = {
      playbackSession: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'sess-sync-1', ...data })),
        findUnique: jest.fn(),
        update: jest.fn().mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data })),
      },
    } as unknown as PrismaClient;

    recordingCatalog = {
      findSeekTarget: jest.fn(),
      findSegments: jest.fn(),
      stepToAdjacentFrame: jest.fn(),
    } as unknown as RecordingCatalog;

    playbackService = new PlaybackSyncService(prisma, recordingCatalog);
  });

  describe('Multi-Camera Synchronized Seeking & Gap Hold', () => {
    it('synchronously seeks multiple cameras; holds gap camera at NO_RECORDING', async () => {
      const targetUtc = new Date('2026-09-08T12:00:00.000Z');

      (prisma.playbackSession.findUnique as jest.Mock).mockResolvedValue({
        id: 'sess-sync-1',
        tenantId: 'tenant-1',
        cameraIdsJson: ['cam-1', 'cam-2'],
        masterTimeUtc: new Date('2026-09-08T11:50:00.000Z'),
        playbackRate: 1.0,
        state: PlaybackSessionState.PAUSED,
      });

      // cam-1 has recording footage; cam-2 is in a gap
      (recordingCatalog.findSeekTarget as jest.Mock).mockImplementation((camId, _targetUtc) => {
        if (camId === 'cam-1') {
          return Promise.resolve({
            status: 'READY',
            segmentId: 'seg-cam-1',
            segmentUri: '/storage/cam1.mp4',
            codec: 'h264',
            fps: 25.0,
            targetPts: BigInt(900000),
            nearestKeyframePts: BigInt(720000),
            offsetMs: 10000,
          });
        }
        return Promise.resolve({
          status: 'NO_RECORDING',
          gapDurationMs: 45000,
        });
      });

      const res = await playbackService.seekPlaybackSession('sess-sync-1', targetUtc);

      expect(res.sessionId).toBe('sess-sync-1');
      expect(res.masterTimeUtc).toEqual(targetUtc);
      expect(res.cameras.length).toBe(2);

      const cam1State = res.cameras.find((c) => c.cameraId === 'cam-1')!;
      expect(cam1State.status).toBe('READY');
      expect(cam1State.segmentId).toBe('seg-cam-1');
      expect(cam1State.currentPts).toBe(BigInt(900000));

      const cam2State = res.cameras.find((c) => c.cameraId === 'cam-2')!;
      expect(cam2State.status).toBe('NO_RECORDING');
      expect(cam2State.gapDurationMs).toBe(45000);
    });
  });

  describe('Playback Rate Control & Monotonic Advancing', () => {
    it('sets forward and reverse variable rates (-16x to +16x)', async () => {
      await playbackService.setPlaybackRate('sess-sync-1', 4.0);
      expect(prisma.playbackSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'sess-sync-1' },
          data: { playbackRate: 4.0, state: PlaybackSessionState.PLAYING },
        })
      );

      await playbackService.setPlaybackRate('sess-sync-1', -8.0);
      expect(prisma.playbackSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'sess-sync-1' },
          data: { playbackRate: -8.0, state: PlaybackSessionState.PLAYING },
        })
      );
    });

    it('rejects unsupported fractional playback rates', async () => {
      await expect(
        playbackService.setPlaybackRate('sess-sync-1', 3.75)
      ).rejects.toThrow('Unsupported playback rate: 3.75x');
    });

    it('advances master clock using monotonic delta and rate multiplier', async () => {
      const initialUtc = new Date('2026-09-08T12:00:00.000Z');

      (prisma.playbackSession.findUnique as jest.Mock).mockResolvedValue({
        id: 'sess-sync-1',
        tenantId: 'tenant-1',
        cameraIdsJson: ['cam-1'],
        masterTimeUtc: initialUtc,
        playbackRate: 2.0, // 2x speed
        state: PlaybackSessionState.PLAYING,
      });

      (recordingCatalog.findSeekTarget as jest.Mock).mockResolvedValue({
        status: 'READY',
        segmentId: 'seg-1',
        segmentUri: '/v.mp4',
      });

      // 500ms monotonic elapsed at 2x rate = +1000ms wall-clock advance
      const res = await playbackService.advanceMasterClock('sess-sync-1', 500);

      expect(res.masterTimeUtc.getTime()).toBe(initialUtc.getTime() + 1000);
    });
  });

  describe('Reverse Shuttle Keyframe Scrubbing', () => {
    it('extracts descending keyframe sequences across cameras for reverse playback', async () => {
      const startUtc = new Date('2026-09-08T10:00:00.000Z');
      const endUtc = new Date('2026-09-08T10:01:00.000Z');

      (recordingCatalog.findSegments as jest.Mock).mockResolvedValue([
        {
          id: 'seg-1',
          startTime: startUtc,
          endTime: endUtc,
          startPts: BigInt(0),
          timebaseNumerator: 1,
          timebaseDenominator: 90000,
          keyframeIndexJson: [
            { pts: 0, offsetMs: 0, isKeyframe: true },
            { pts: 180000, offsetMs: 2000, isKeyframe: true },
            { pts: 360000, offsetMs: 4000, isKeyframe: true },
          ],
        },
      ]);

      const shuttle = await playbackService.getShuttleKeyframes(
        'tenant-1',
        ['cam-1'],
        startUtc,
        endUtc,
        'REVERSE'
      );

      const steps = shuttle['cam-1'];
      expect(steps.length).toBe(3);
      // Reverse order: descending UTC timestamps
      expect(steps[0].offsetMs).toBe(4000);
      expect(steps[1].offsetMs).toBe(2000);
      expect(steps[2].offsetMs).toBe(0);
    });
  });
});
