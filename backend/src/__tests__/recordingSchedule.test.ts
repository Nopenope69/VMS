import { RecordingMode } from '@prisma/client';
import { RecordingScheduleService, DEFAULT_WEEKLY_MATRIX } from '../services/schedule/recordingSchedule.service';
import mediaProvider from '../services/media/mediamtx.provider';

jest.mock('../services/media/mediamtx.provider', () => ({
  setRecording: jest.fn().mockResolvedValue(undefined),
}));

describe('RecordingScheduleService - Idempotent Timezone Engine', () => {
  let service: RecordingScheduleService;
  let mockPrisma: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma = {
      camera: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
      recordingSchedule: {
        update: jest.fn().mockResolvedValue({}),
      },
    };
    service = new RecordingScheduleService(mockPrisma);
  });

  describe('Timezone & Midnight Boundary Arithmetic', () => {
    it('should correctly convert UTC to Asia/Kolkata facility timezone across midnight', () => {
      // UTC: Sunday 2026-09-06 20:00:00
      // In Asia/Kolkata (+05:30): Monday 2026-09-07 01:30:00 -> MONDAY, hour 1
      const sundayNightUtc = new Date('2026-09-06T20:00:00Z');
      const timeInfo = service.getLocalTimeInfo(sundayNightUtc, 'Asia/Kolkata');

      expect(timeInfo.day).toBe('MONDAY');
      expect(timeInfo.hour).toBe(1);
    });

    it('should correctly convert UTC to America/New_York facility timezone across day boundary', () => {
      // UTC: Monday 2026-09-07 02:00:00
      // In America/New_York (EDT UTC-4): Sunday 2026-09-06 22:00:00 -> SUNDAY, hour 22
      const mondayEarlyUtc = new Date('2026-09-07T02:00:00Z');
      const timeInfo = service.getLocalTimeInfo(mondayEarlyUtc, 'America/New_York');

      expect(timeInfo.day).toBe('SUNDAY');
      expect(timeInfo.hour).toBe(22);
    });
  });

  describe('Idempotent State Machine & MediaMTX Command Execution', () => {
    it('should apply state transition on initial evaluation and command MediaMTX', async () => {
      const customMatrix = { ...DEFAULT_WEEKLY_MATRIX };
      // Monday at 10:00 is CONTINUOUS
      customMatrix.MONDAY = [...DEFAULT_WEEKLY_MATRIX.MONDAY];
      customMatrix.MONDAY[10] = RecordingMode.CONTINUOUS;

      mockPrisma.camera.findUnique.mockResolvedValue({
        id: 'cam_sch_01',
        name: 'Main Gate',
        isOnline: true,
        recordingMode: RecordingMode.SCHEDULED,
        site: { timezone: 'UTC' },
        recordingSchedule: {
          id: 'sch_01',
          weeklyMatrixJson: customMatrix,
          lastAppliedMode: null, // Initial startup
        },
      });

      const evalTime = new Date('2026-09-07T10:00:00Z'); // Monday 10:00 UTC
      const result = await service.evaluateCamera('cam_sch_01', evalTime);

      expect(result.applied).toBe(true);
      expect(result.mode).toBe(RecordingMode.CONTINUOUS);
      expect(mediaProvider.setRecording).toHaveBeenCalledWith('cam_sch_01', true);
      expect(mockPrisma.recordingSchedule.update).toHaveBeenCalledWith({
        where: { id: 'sch_01' },
        data: {
          lastAppliedMode: RecordingMode.CONTINUOUS,
          lastAppliedAt: evalTime,
        },
      });
    });

    it('should NOT command MediaMTX if desired state matches already applied state (Idempotency Invariant)', async () => {
      const customMatrix = { ...DEFAULT_WEEKLY_MATRIX };
      customMatrix.MONDAY = [...DEFAULT_WEEKLY_MATRIX.MONDAY];
      customMatrix.MONDAY[10] = RecordingMode.CONTINUOUS;

      mockPrisma.camera.findUnique.mockResolvedValue({
        id: 'cam_sch_01',
        name: 'Main Gate',
        isOnline: true,
        recordingMode: RecordingMode.SCHEDULED,
        site: { timezone: 'UTC' },
        recordingSchedule: {
          id: 'sch_01',
          weeklyMatrixJson: customMatrix,
          lastAppliedMode: RecordingMode.CONTINUOUS, // Already applied!
        },
      });

      const evalTime = new Date('2026-09-07T10:05:00Z'); // 5 minutes later, still hour 10
      const result = await service.evaluateCamera('cam_sch_01', evalTime);

      expect(result.applied).toBe(false);
      expect(result.reason).toContain('ALREADY_IN_DESIRED_STATE');
      // MediaMTX must NOT be called repeatedly every minute!
      expect(mediaProvider.setRecording).not.toHaveBeenCalled();
      expect(mockPrisma.recordingSchedule.update).not.toHaveBeenCalled();
    });

    it('should transition and stop recording when moving into an OFF hour', async () => {
      const customMatrix = { ...DEFAULT_WEEKLY_MATRIX };
      customMatrix.MONDAY = [...DEFAULT_WEEKLY_MATRIX.MONDAY];
      customMatrix.MONDAY[11] = RecordingMode.OFF;

      mockPrisma.camera.findUnique.mockResolvedValue({
        id: 'cam_sch_01',
        name: 'Main Gate',
        isOnline: true,
        recordingMode: RecordingMode.SCHEDULED,
        site: { timezone: 'UTC' },
        recordingSchedule: {
          id: 'sch_01',
          weeklyMatrixJson: customMatrix,
          lastAppliedMode: RecordingMode.CONTINUOUS, // Was previously CONTINUOUS
        },
      });

      const evalTime = new Date('2026-09-07T11:00:00Z'); // Monday 11:00 UTC (OFF cell)
      const result = await service.evaluateCamera('cam_sch_01', evalTime);

      expect(result.applied).toBe(true);
      expect(result.mode).toBe(RecordingMode.OFF);
      expect(mediaProvider.setRecording).toHaveBeenCalledWith('cam_sch_01', false);
      expect(mockPrisma.recordingSchedule.update).toHaveBeenCalledWith({
        where: { id: 'sch_01' },
        data: {
          lastAppliedMode: RecordingMode.OFF,
          lastAppliedAt: evalTime,
        },
      });
    });

    it('should skip evaluation if camera is offline', async () => {
      mockPrisma.camera.findUnique.mockResolvedValue({
        id: 'cam_sch_offline',
        name: 'Perimeter 3',
        isOnline: false,
        recordingMode: RecordingMode.SCHEDULED,
      });

      const result = await service.evaluateCamera('cam_sch_offline');
      expect(result.applied).toBe(false);
      expect(result.reason).toBe('CAMERA_OFFLINE');
      expect(mediaProvider.setRecording).not.toHaveBeenCalled();
    });
  });
});
