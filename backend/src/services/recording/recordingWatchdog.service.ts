import { PrismaClient, EventType, EventSeverity, AlarmState } from '@prisma/client';

export interface RecordingGap {
  cameraId: string;
  gapStart: Date;
  gapEnd: Date;
  gapDurationSeconds: number;
}

export interface RecordingHealthReport {
  cameraId: string;
  cameraName: string;
  isRecording: boolean;
  lastSegmentAt: Date | null;
  health: 'HEALTHY' | 'WARNING' | 'GAP_DETECTED' | 'STALLED';
  activeGapsCount: number;
  reason?: string;
}

export class RecordingWatchdogService {
  private prisma: PrismaClient;
  private timer: NodeJS.Timeout | null = null;
  private isChecking = false;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  start(intervalMs = 60000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.checkAllRecorders().catch((err) => {
        console.error('[RecordingWatchdog] Scheduled check error:', err.message);
      });
    }, intervalMs);

    // Initial check
    this.checkAllRecorders().catch(() => {});
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Scans consecutive segments for a camera across a time interval to detect
   * missing footage or dropped stream fragments exceeding thresholdMs (default 5000ms).
   */
  async detectGaps(
    cameraId: string,
    startTime: Date,
    endTime: Date,
    thresholdMs = 5000
  ): Promise<RecordingGap[]> {
    const segments = await this.prisma.recordingSegment.findMany({
      where: {
        cameraId,
        startTime: { gte: startTime },
        endTime: { lte: endTime },
        status: 'FINALIZED',
      },
      orderBy: { startTime: 'asc' },
      select: {
        id: true,
        startTime: true,
        endTime: true,
      },
    });

    const gaps: RecordingGap[] = [];

    for (let i = 1; i < segments.length; i++) {
      const prevEnd = segments[i - 1].endTime.getTime();
      const currStart = segments[i].startTime.getTime();
      const diffMs = currStart - prevEnd;

      if (diffMs > thresholdMs) {
        gaps.push({
          cameraId,
          gapStart: segments[i - 1].endTime,
          gapEnd: segments[i].startTime,
          gapDurationSeconds: Math.round(diffMs / 1000),
        });
      }
    }

    return gaps;
  }

  /**
   * Evaluates all cameras that should currently be recording.
   * Emits RECORDING_GAP / RECORDING_FAILURE alarms if media engine has stalled
   * or expected segments have failed to finalize.
   */
  async checkAllRecorders(maxSegmentAgeSec = 660): Promise<RecordingHealthReport[]> {
    if (this.isChecking) return [];
    this.isChecking = true;

    const reports: RecordingHealthReport[] = [];

    try {
      const activeCameras = await this.prisma.camera.findMany({
        where: {
          isOnline: true,
          recorderState: 'RUNNING',
        },
        select: {
          id: true,
          name: true,
          tenantId: true,
          lastStateChangeAt: true,
        },
      });

      const now = new Date();

      for (const camera of activeCameras) {
        const latestSegment = await this.prisma.recordingSegment.findFirst({
          where: { cameraId: camera.id },
          orderBy: { endTime: 'desc' },
        });

        let health: RecordingHealthReport['health'] = 'HEALTHY';
        let reason: string | undefined;

        if (!latestSegment) {
          const recordingDurationSec = (now.getTime() - camera.lastStateChangeAt.getTime()) / 1000;
          if (recordingDurationSec > maxSegmentAgeSec) {
            health = 'STALLED';
            reason = `No recording segments produced after ${Math.round(recordingDurationSec)}s of active recording`;
          }
        } else {
          const ageSec = (now.getTime() - latestSegment.endTime.getTime()) / 1000;
          if (ageSec > maxSegmentAgeSec) {
            health = 'GAP_DETECTED';
            reason = `Latest recorded segment is ${Math.round(ageSec)}s old (expected < ${maxSegmentAgeSec}s)`;
          }
        }

        if (health === 'STALLED' || health === 'GAP_DETECTED') {
          await this.raiseRecordingAlarm(camera.tenantId, camera.id, camera.name, health, reason!);
        }

        reports.push({
          cameraId: camera.id,
          cameraName: camera.name,
          isRecording: true,
          lastSegmentAt: latestSegment?.endTime || null,
          health,
          activeGapsCount: health === 'HEALTHY' ? 0 : 1,
          reason,
        });
      }
    } finally {
      this.isChecking = false;
    }

    return reports;
  }

  private async raiseRecordingAlarm(
    tenantId: string,
    cameraId: string,
    cameraName: string,
    health: 'STALLED' | 'GAP_DETECTED',
    reason: string
  ): Promise<void> {
    try {
      const eventType = health === 'STALLED' ? EventType.RECORDING_FAILURE : EventType.RECORDING_GAP;

      const existing = await this.prisma.alarm.findFirst({
        where: {
          tenantId,
          cameraId,
          state: AlarmState.ACTIVE,
          title: { contains: 'Recording' },
        },
      });

      if (existing) return;

      const event = await this.prisma.event.create({
        data: {
          cameraId,
          type: eventType,
          severity: EventSeverity.CRITICAL,
          title: `Recording Watchdog: ${health} on ${cameraName}`,
          description: reason,
          metadata: { health, reason, checkedAt: new Date().toISOString() },
        },
      });

      await this.prisma.alarm.create({
        data: {
          tenantId,
          cameraId,
          eventId: event.id,
          title: `Critical: Recording ${health} on ${cameraName}`,
          description: reason,
          severity: EventSeverity.CRITICAL,
          state: AlarmState.ACTIVE,
          metadataJson: { health, reason },
        },
      });
    } catch (err: any) {
      console.error(`[RecordingWatchdog] Failed to raise recording alarm for ${cameraName}:`, err.message);
    }
  }
}

export const recordingWatchdogService = new RecordingWatchdogService(new PrismaClient());
export default RecordingWatchdogService;
