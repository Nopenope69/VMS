import { ChildProcess, spawn } from 'child_process';
import { PrismaClient, EventType, EventSeverity } from '@prisma/client';
import mediaProvider from '../media/mediamtx.provider';
import EventRateLimiter from '../events/eventRateLimiter.service';
import DetectionZoneService, { Point2D, BoundingBox2D } from './detectionZone.service';

const prisma = new PrismaClient();

export interface CameraMotionState {
  state: 'IDLE' | 'ACTIVE' | 'COOLDOWN';
  activeEventId: string | null;
  firstDetectedAt: Date;
  lastDetectedAt: Date;
  motionSpikes: number;
  cooldownTimer: NodeJS.Timeout | null;
}

export class SceneChangeDetectorService {
  private cameraStates = new Map<string, CameraMotionState>();
  private activeProbes = new Map<string, ChildProcess>();
  private cooldownDurationMs = 60000; // 60 seconds debounce

  constructor(cooldownMs = 60000) {
    this.cooldownDurationMs = cooldownMs;
  }

  /**
   * Processes a scene-change trigger event through the camera episode state machine.
   * Consolidates continuous bursts of scene changes into a single logical Event episode.
   * Filters through DetectionZoneService if detection coordinates are provided.
   */
  async handleSceneChange(
    cameraId: string,
    confidence: number = 0.45,
    detectionCoords?: Point2D | BoundingBox2D
  ): Promise<void> {
    // 1. Evaluate Detection Zones if coordinates are provided
    let zoneSnapshot: any = undefined;
    if (detectionCoords) {
      try {
        const zones = await prisma.detectionZone.findMany({
          where: { cameraId, enabled: true },
        });
        if (zones.length > 0) {
          const evaluation = DetectionZoneService.evaluateDetection(detectionCoords, zones);
          if (!evaluation.allowed) {
            // Blocked by exclusion mask or not inside active inclusion zones
            return;
          }
          zoneSnapshot = DetectionZoneService.createZoneSnapshot(zones);
        }
      } catch (err: any) {
        console.warn(`[SceneDetector] Zone evaluation error for ${cameraId}:`, err.message);
      }
    }

    // 2. Check EventRateLimiter to suppress raw spike storms
    if (!EventRateLimiter.shouldProcessTrigger(cameraId)) {
      const current = this.cameraStates.get(cameraId);
      if (current && current.state === 'ACTIVE') {
        current.motionSpikes += 1;
        current.lastDetectedAt = new Date();
      }
      return;
    }

    const now = new Date();
    let current = this.cameraStates.get(cameraId);

    if (!current || current.state === 'IDLE') {
      // Transition: IDLE -> ACTIVE (New Episode)
      try {
        const event = await prisma.event.create({
          data: {
            cameraId,
            type: EventType.MOTION,
            severity: EventSeverity.INFO,
            title: 'Scene Change Episode Detected',
            description: `Visual activity detected via scene change score ${confidence.toFixed(2)}. Episode started.`,
            startTime: now,
            firstDetectedAt: now,
            lastDetectedAt: now,
            motionSpikes: 1,
            metadata: {
              initialScore: confidence,
              detectionCoords: detectionCoords as any,
              zoneConfigSnapshot: zoneSnapshot,
            } as any,
          },
        });

        // Trigger recording start via abstraction layer
        await mediaProvider.setRecording(cameraId, true);

        const stateObj: CameraMotionState = {
          state: 'ACTIVE',
          activeEventId: event.id,
          firstDetectedAt: now,
          lastDetectedAt: now,
          motionSpikes: 1,
          cooldownTimer: null,
        };

        this.scheduleCooldown(cameraId, stateObj);
        this.cameraStates.set(cameraId, stateObj);
      } catch (err: any) {
        console.error(`[SceneDetector] Failed to activate episode for camera ${cameraId}:`, err.message);
      }
    } else {
      // Transition: ACTIVE or COOLDOWN with fresh movement
      current.motionSpikes += 1;
      current.lastDetectedAt = now;
      current.state = 'ACTIVE';

      // Reset the 60-second cooldown timer
      if (current.cooldownTimer) {
        clearTimeout(current.cooldownTimer);
        current.cooldownTimer = null;
      }

      this.scheduleCooldown(cameraId, current);
    }
  }

  private scheduleCooldown(cameraId: string, state: CameraMotionState) {
    state.cooldownTimer = setTimeout(async () => {
      await this.finalizeEpisode(cameraId);
    }, this.cooldownDurationMs);
  }

  /**
   * Finalizes a motion episode when no scene change has occurred during the 60s cooldown window.
   */
  async finalizeEpisode(cameraId: string): Promise<void> {
    const current = this.cameraStates.get(cameraId);
    if (!current || !current.activeEventId) {
      this.cameraStates.delete(cameraId);
      return;
    }

    const now = new Date();
    const durationSeconds = Math.max(
      1,
      Math.round((current.lastDetectedAt.getTime() - current.firstDetectedAt.getTime()) / 1000)
    );

    try {
      // 1. Stop recording via abstraction layer
      await mediaProvider.setRecording(cameraId, false);

      // 2. Finalize the single consolidated Event row
      await prisma.event.update({
        where: { id: current.activeEventId },
        data: {
          endTime: now,
          lastDetectedAt: current.lastDetectedAt,
          durationSeconds,
          motionSpikes: current.motionSpikes,
          description: `Scene change episode concluded. Recorded ${current.motionSpikes} spikes over ${durationSeconds} seconds.`,
        },
      });
    } catch (err: any) {
      console.error(`[SceneDetector] Error finalizing episode for camera ${cameraId}:`, err.message);
    } finally {
      if (current.cooldownTimer) {
        clearTimeout(current.cooldownTimer);
      }
      this.cameraStates.delete(cameraId);
    }
  }

  /**
   * Spawns a lightweight FFmpeg probe.
   * STRICT INVARIANT: PULLS EXCLUSIVELY FROM MEDIAMTX LOCALHOST RELAY AT 1 FPS DOWN-SAMPLED TO 320x180.
   * Zero direct camera connection and minimal host CPU overhead.
   */
  startProbe(cameraId: string, streamPathOrRtspUrl: string, threshold = 0.4) {
    if (this.activeProbes.has(cameraId)) {
      this.stopProbe(cameraId);
    }

    // Determine relay URL: if caller passed a full URL, extract path or use loopback
    const relayUrl = streamPathOrRtspUrl.startsWith('rtsp://')
      ? streamPathOrRtspUrl
      : `rtsp://127.0.0.1:8554/${streamPathOrRtspUrl}`;

    // Downscale to 320x180 @ 1 fps to eliminate CPU decode melt
    const args = [
      '-nostats',
      '-loglevel', 'info',
      '-rtsp_transport', 'tcp',
      '-i', relayUrl,
      '-vf', `fps=1,scale=320:180,select=gt(scene\\,${threshold}),metadata=print:file=-`,
      '-f', 'null',
      '-',
    ];

    const proc = spawn('ffmpeg', args);
    this.activeProbes.set(cameraId, proc);

    proc.stdout.on('data', (data) => {
      const output = data.toString();
      if (output.includes('lavfi.scene_score')) {
        const match = output.match(/lavfi\.scene_score=([0-9.]+)/);
        const score = match ? parseFloat(match[1]) : threshold;
        this.handleSceneChange(cameraId, score);
      }
    });

    proc.on('error', (err) => {
      console.warn(`[SceneDetector] Probe process error for camera ${cameraId}:`, err.message);
      this.activeProbes.delete(cameraId);
    });

    proc.on('exit', () => {
      this.activeProbes.delete(cameraId);
    });
  }

  stopProbe(cameraId: string) {
    const proc = this.activeProbes.get(cameraId);
    if (proc) {
      proc.kill('SIGTERM');
      this.activeProbes.delete(cameraId);
    }
  }

  getState(cameraId: string): CameraMotionState | undefined {
    return this.cameraStates.get(cameraId);
  }

  destroy() {
    for (const [id, proc] of this.activeProbes.entries()) {
      proc.kill('SIGTERM');
    }
    this.activeProbes.clear();

    for (const [, state] of this.cameraStates.entries()) {
      if (state.cooldownTimer) {
        clearTimeout(state.cooldownTimer);
      }
    }
    this.cameraStates.clear();
  }
}

export const sceneChangeDetector = new SceneChangeDetectorService();
export default sceneChangeDetector;
