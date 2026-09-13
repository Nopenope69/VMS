import prisma from '../../config/database';
import { PrismaClient, RecordingMode } from '@prisma/client';
import mediaProvider from '../media/mediamtx.provider';

export type DayOfWeek =
  | 'MONDAY'
  | 'TUESDAY'
  | 'WEDNESDAY'
  | 'THURSDAY'
  | 'FRIDAY'
  | 'SATURDAY'
  | 'SUNDAY';

export type WeeklyMatrix = Record<DayOfWeek, RecordingMode[]>;

export const DEFAULT_WEEKLY_MATRIX: WeeklyMatrix = {
  MONDAY: Array(24).fill(RecordingMode.CONTINUOUS),
  TUESDAY: Array(24).fill(RecordingMode.CONTINUOUS),
  WEDNESDAY: Array(24).fill(RecordingMode.CONTINUOUS),
  THURSDAY: Array(24).fill(RecordingMode.CONTINUOUS),
  FRIDAY: Array(24).fill(RecordingMode.CONTINUOUS),
  SATURDAY: Array(24).fill(RecordingMode.CONTINUOUS),
  SUNDAY: Array(24).fill(RecordingMode.CONTINUOUS),
};

export class RecordingScheduleService {
  private prisma: PrismaClient;
  private timer: NodeJS.Timeout | null = null;
  private isEvaluating = false;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  start(intervalMs = 60000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.evaluateAll().catch((err) => {
        console.error('[RecordingSchedule] Periodic evaluation error:', err.message);
      });
    }, intervalMs);

    this.evaluateAll().catch(() => {});
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Translates a UTC Date object into site-local DayOfWeek and hour (0-23)
   * using standard IANA timezone formatting. Safe against DST and midnight drift.
   */
  getLocalTimeInfo(date: Date, timezone = 'Asia/Kolkata'): { day: DayOfWeek; hour: number } {
    try {
      // Formatter for day of week in English
      const dayFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        weekday: 'long',
      });
      // Formatter for hour in 24-hour cycle
      const hourFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: 'numeric',
        hour12: false,
      });

      const dayStr = dayFormatter.format(date).toUpperCase() as DayOfWeek;
      const rawHour = parseInt(hourFormatter.format(date), 10);
      const hour = rawHour === 24 ? 0 : rawHour;

      const validDays: DayOfWeek[] = [
        'MONDAY',
        'TUESDAY',
        'WEDNESDAY',
        'THURSDAY',
        'FRIDAY',
        'SATURDAY',
        'SUNDAY',
      ];

      const day = validDays.includes(dayStr) ? dayStr : 'MONDAY';
      return { day, hour: Math.min(Math.max(hour, 0), 23) };
    } catch {
      // Fallback to UTC if timezone string is invalid
      const dayIdx = date.getUTCDay(); // 0 is Sunday
      const dayMap: DayOfWeek[] = [
        'SUNDAY',
        'MONDAY',
        'TUESDAY',
        'WEDNESDAY',
        'THURSDAY',
        'FRIDAY',
        'SATURDAY',
      ];
      return {
        day: dayMap[dayIdx],
        hour: date.getUTCHours(),
      };
    }
  }

  /**
   * Idempotently evaluates schedule state for a single camera.
   * Dispatches commands to mediaProvider ONLY when the desired state transitions.
   */
  async evaluateCamera(
    cameraId: string,
    currentTime = new Date()
  ): Promise<{ applied: boolean; mode: RecordingMode; reason: string }> {
    const camera = await this.prisma.camera.findUnique({
      where: { id: cameraId },
      include: {
        site: true,
        recordingSchedule: true,
      },
    });

    if (!camera) {
      return { applied: false, mode: RecordingMode.OFF, reason: 'CAMERA_NOT_FOUND' };
    }

    if (!camera.isOnline) {
      return { applied: false, mode: RecordingMode.OFF, reason: 'CAMERA_OFFLINE' };
    }

    if (camera.recordingMode !== RecordingMode.SCHEDULED) {
      return { applied: false, mode: camera.recordingMode, reason: 'NOT_SCHEDULED_MODE' };
    }

    const timezone = camera.site?.timezone || 'Asia/Kolkata';
    const { day, hour } = this.getLocalTimeInfo(currentTime, timezone);

    // Read weekly matrix or use default continuous
    const schedule = camera.recordingSchedule;
    let desiredMode: RecordingMode = RecordingMode.CONTINUOUS;

    if (schedule && schedule.weeklyMatrixJson) {
      const matrix = schedule.weeklyMatrixJson as unknown as WeeklyMatrix;
      if (matrix[day] && Array.isArray(matrix[day]) && matrix[day][hour]) {
        desiredMode = matrix[day][hour];
      }
    }

    const lastApplied = schedule?.lastAppliedMode;

    // IDEMPOTENCY CHECK: If already in desired mode, do not spam MediaMTX
    if (lastApplied === desiredMode) {
      return {
        applied: false,
        mode: desiredMode,
        reason: `ALREADY_IN_DESIRED_STATE (${desiredMode})`,
      };
    }

    // Apply state transition
    try {
      if (desiredMode === RecordingMode.CONTINUOUS) {
        await mediaProvider.setRecording(camera.id, true);
      } else {
        // OFF or MOTION (idle until motion episode triggers)
        await mediaProvider.setRecording(camera.id, false);
      }

      if (schedule) {
        await this.prisma.recordingSchedule.update({
          where: { id: schedule.id },
          data: {
            lastAppliedMode: desiredMode,
            lastAppliedAt: currentTime,
          },
        });
      }

      return {
        applied: true,
        mode: desiredMode,
        reason: `STATE_TRANSITION_APPLIED (${lastApplied || 'INITIAL'} -> ${desiredMode})`,
      };
    } catch (err: any) {
      console.error(`[RecordingSchedule] Failed applying mode ${desiredMode} for ${camera.name}:`, err.message);
      return { applied: false, mode: desiredMode, reason: `ERROR: ${err.message}` };
    }
  }

  /**
   * Evaluates all cameras configured with recordingMode = SCHEDULED.
   */
  async evaluateAll(currentTime = new Date()): Promise<void> {
    if (this.isEvaluating) return;
    this.isEvaluating = true;

    try {
      const scheduledCameras = await this.prisma.camera.findMany({
        where: {
          recordingMode: RecordingMode.SCHEDULED,
          isOnline: true,
        },
        select: { id: true },
      });

      for (const cam of scheduledCameras) {
        await this.evaluateCamera(cam.id, currentTime);
      }
    } finally {
      this.isEvaluating = false;
    }
  }
}

export const recordingScheduleService = new RecordingScheduleService(prisma);
export default recordingScheduleService;
