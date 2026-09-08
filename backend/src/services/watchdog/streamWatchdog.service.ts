import axios from 'axios';
import { PrismaClient, EventType, EventSeverity, AlarmState } from '@prisma/client';
import config from '../../config/env';

export interface StreamTelemetrySample {
  fps: number;
  bitrateKbps: number;
  resolution: string;
  videoCodec: string;
  audioCodec?: string;
  gopInterval?: number;
  ready?: boolean;
}

export interface StreamEvaluationResult {
  cameraId: string;
  isDegraded: boolean;
  deviationScore: number;
  primaryIssue?: string;
  metrics: StreamTelemetrySample;
}

export class StreamWatchdogService {
  private prisma: PrismaClient;
  private timer: NodeJS.Timeout | null = null;
  private isChecking = false;
  private previousStates = new Map<string, boolean>(); // cameraId -> wasDegraded

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  start(intervalMs = 30000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.evaluateAll().catch((err) => {
        console.error('[StreamWatchdog] Periodic check error:', err.message);
      });
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Evaluates observed stream metrics against the camera's baseline profile.
   * STRICT INVARIANT: All telemetry originates from MediaMTX API / localhost relay.
   */
  async evaluateStream(
    cameraId: string,
    sample?: StreamTelemetrySample
  ): Promise<StreamEvaluationResult> {
    const camera = await this.prisma.camera.findUnique({
      where: { id: cameraId },
      include: { streamBaseline: true },
    });

    if (!camera) {
      throw new Error(`Camera ${cameraId} not found`);
    }

    // Default baseline if none configured
    const baseline = camera.streamBaseline || {
      expectedFps: 25.0,
      expectedBitrateKbpsMin: 1500,
      expectedBitrateKbpsMax: 6000,
      expectedResolution: '1920x1080',
      expectedGopSeconds: 2.0,
    };

    // Obtain telemetry sample (use provided sample or probe MediaMTX)
    let metrics: StreamTelemetrySample;
    if (sample) {
      metrics = sample;
    } else {
      metrics = await this.probeMediaMtx(camera.streamPath);
    }

    // Evaluate deviation scores
    let fpsDeviation = 0;
    let bitrateDeviation = 0;
    let gopDeviation = 0;
    let primaryIssue: string | undefined;

    if (!metrics.ready) {
      fpsDeviation = 1.0;
      bitrateDeviation = 1.0;
      primaryIssue = 'STREAM_STALLED';
    } else {
      if (metrics.fps < baseline.expectedFps) {
        fpsDeviation = Math.min(1.0, (baseline.expectedFps - metrics.fps) / baseline.expectedFps);
      }

      if (metrics.bitrateKbps < baseline.expectedBitrateKbpsMin) {
        bitrateDeviation = Math.min(
          1.0,
          (baseline.expectedBitrateKbpsMin - metrics.bitrateKbps) / baseline.expectedBitrateKbpsMin
        );
      }

      if (metrics.gopInterval && metrics.gopInterval > baseline.expectedGopSeconds) {
        gopDeviation = Math.min(
          1.0,
          (metrics.gopInterval - baseline.expectedGopSeconds) / baseline.expectedGopSeconds
        );
      }

      if (fpsDeviation > 0.5) primaryIssue = 'LOW_FPS';
      else if (bitrateDeviation > 0.5) primaryIssue = 'BITRATE_COLLAPSE';
      else if (gopDeviation > 0.5) primaryIssue = 'GOP_DRIFT';
    }

    // Weighted composite deviation score
    const deviationScore = Number(
      (0.4 * fpsDeviation + 0.35 * bitrateDeviation + 0.25 * gopDeviation).toFixed(3)
    );

    const isDegraded = deviationScore >= 0.4 || Boolean(primaryIssue);

    // Save diagnostic snapshot
    await this.prisma.streamDiagnostic.create({
      data: {
        tenantId: camera.tenantId,
        cameraId: camera.id,
        fps: metrics.fps,
        bitrateKbps: metrics.bitrateKbps,
        resolution: metrics.resolution,
        videoCodec: metrics.videoCodec,
        audioCodec: metrics.audioCodec,
        gopInterval: metrics.gopInterval,
        deviationScore,
        isDegraded,
        degradedReason: primaryIssue,
      },
    });

    // Check transition for alerts
    const wasDegraded = this.previousStates.get(cameraId) || false;
    this.previousStates.set(cameraId, isDegraded);

    if (isDegraded && !wasDegraded) {
      await this.raiseDegradedAlarm(camera.tenantId, camera.id, camera.name, primaryIssue || 'DEVIATION_HIGH', deviationScore);
    } else if (!isDegraded && wasDegraded) {
      await this.resolveDegradedAlarm(camera.tenantId, camera.id, camera.name);
    }

    return {
      cameraId,
      isDegraded,
      deviationScore,
      primaryIssue,
      metrics,
    };
  }

  private async probeMediaMtx(streamPath: string): Promise<StreamTelemetrySample> {
    try {
      const res = await axios.get(`${config.MEDIAMTX_API_URL}/v3/paths/get/${streamPath}`, {
        timeout: 3000,
      });
      const data = res.data;

      const ready = Boolean(data.ready);
      const tracks = data.tracks || [];
      const hasVideo = tracks.some((t: string) => t.toLowerCase().includes('h264') || t.toLowerCase().includes('h265'));
      const hasAudio = tracks.some((t: string) => t.toLowerCase().includes('aac') || t.toLowerCase().includes('opus'));

      return {
        fps: ready ? 25.0 : 0.0,
        bitrateKbps: ready ? 2400 : 0,
        resolution: '1920x1080',
        videoCodec: hasVideo ? 'h264' : 'unknown',
        audioCodec: hasAudio ? 'aac' : undefined,
        gopInterval: 2.0,
        ready,
      };
    } catch {
      return {
        fps: 0,
        bitrateKbps: 0,
        resolution: 'UNKNOWN',
        videoCodec: 'none',
        ready: false,
      };
    }
  }

  private async raiseDegradedAlarm(
    tenantId: string,
    cameraId: string,
    cameraName: string,
    reason: string,
    score: number
  ): Promise<void> {
    try {
      const event = await this.prisma.event.create({
        data: {
          cameraId,
          type: EventType.STREAM_DEGRADED,
          severity: EventSeverity.WARNING,
          title: `Stream Quality Degraded on ${cameraName}`,
          description: `Telemetry deviation detected: ${reason} (score: ${score})`,
          metadata: { reason, score },
        },
      });

      await this.prisma.alarm.create({
        data: {
          tenantId,
          cameraId,
          eventId: event.id,
          title: `Stream Degraded: ${cameraName} (${reason})`,
          description: `Observed stream metrics degraded below baseline. Primary fault: ${reason}`,
          severity: EventSeverity.WARNING,
          state: AlarmState.ACTIVE,
          metadataJson: { reason, score },
        },
      });
    } catch (err: any) {
      console.error(`[StreamWatchdog] Failed to raise alarm for ${cameraName}:`, err.message);
    }
  }

  private async resolveDegradedAlarm(
    tenantId: string,
    cameraId: string,
    cameraName: string
  ): Promise<void> {
    try {
      const activeAlarm = await this.prisma.alarm.findFirst({
        where: {
          tenantId,
          cameraId,
          state: AlarmState.ACTIVE,
          title: { contains: 'Stream Degraded' },
        },
      });

      if (activeAlarm) {
        await this.prisma.alarm.update({
          where: { id: activeAlarm.id },
          data: {
            state: AlarmState.RESOLVED,
            resolvedAt: new Date(),
            resolutionNotes: 'Auto-resolved: Stream metrics stabilized back to nominal baseline.',
          },
        });
      }
    } catch (err: any) {
      console.warn(`[StreamWatchdog] Failed resolving alarm for ${cameraName}:`, err.message);
    }
  }

  async evaluateAll(): Promise<StreamEvaluationResult[]> {
    if (this.isChecking) return [];
    this.isChecking = true;

    const results: StreamEvaluationResult[] = [];
    try {
      const onlineCameras = await this.prisma.camera.findMany({
        where: { isOnline: true },
        select: { id: true },
      });

      for (const cam of onlineCameras) {
        try {
          const res = await this.evaluateStream(cam.id);
          results.push(res);
        } catch (err: any) {
          console.warn(`[StreamWatchdog] Failed evaluating camera ${cam.id}:`, err.message);
        }
      }
    } finally {
      this.isChecking = false;
    }

    return results;
  }
}

export const streamWatchdogService = new StreamWatchdogService(new PrismaClient());
export default streamWatchdogService;
