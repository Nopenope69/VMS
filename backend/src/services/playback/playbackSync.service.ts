import { PlaybackSession, PlaybackSessionState, PrismaClient } from '@prisma/client';
import { RecordingCatalog, SeekTargetResult, FrameStepUnavailableError } from '../recording/catalog/recordingCatalog.service';

export interface CameraPlaybackState {
  cameraId: string;
  status: 'READY' | 'NO_RECORDING' | 'BUFFERING' | 'ERROR';
  segmentId?: string;
  segmentUri?: string;
  currentPts?: bigint;
  nearestKeyframePts?: bigint;
  offsetMs?: number;
  codec?: string | null;
  fps?: number | null;
  gapDurationMs?: number | null;
}

export interface SynchronizedSeekResult {
  sessionId: string;
  masterTimeUtc: Date;
  playbackRate: number;
  sessionState: PlaybackSessionState;
  cameras: CameraPlaybackState[];
}

/** A frame step: the seek result plus how the step was found. */
export interface FrameStepResult extends SynchronizedSeekResult {
  /** EXACT: the next real frame of the reference camera. APPROXIMATE: estimated from its frame rate. */
  precision: 'EXACT' | 'APPROXIMATE';
  /** The camera whose frame set the step; the others are brought to the same moment. */
  referenceCameraId: string;
  /** True when the reference camera has no further frame in that direction. */
  clamped: boolean;
}

export interface ReverseShuttleStep {
  cameraId: string;
  pts: bigint;
  offsetMs: number;
  utcTime: Date;
  segmentId: string;
}

export class PlaybackSyncService {
  private prisma: PrismaClient;
  private catalog: RecordingCatalog;

  constructor(prisma: PrismaClient, catalog?: RecordingCatalog) {
    this.prisma = prisma;
    this.catalog = catalog || new RecordingCatalog(prisma);
  }

  /**
   * Initializes a multi-camera synchronized playback session.
   */
  public async createPlaybackSession(
    tenantId: string,
    userId: string,
    cameraIds: string[],
    initialUtc: Date
  ): Promise<PlaybackSession> {
    if (!cameraIds || cameraIds.length === 0) {
      throw new Error('At least one cameraId is required for a playback session');
    }

    return this.prisma.playbackSession.create({
      data: {
        tenantId,
        userId,
        cameraIdsJson: cameraIds as any,
        masterTimeUtc: initialUtc,
        playbackRate: 1.0,
        state: PlaybackSessionState.PAUSED,
      },
    });
  }

  /**
   * Retrieves playback session by ID.
   */
  public async getPlaybackSession(sessionId: string): Promise<PlaybackSession | null> {
    return this.prisma.playbackSession.findUnique({
      where: { id: sessionId },
    });
  }

  /**
   * Synchronously seeks all cameras in the session to an authoritative UTC wall-clock timestamp.
   * Cameras inside recording gaps report 'NO_RECORDING' without stalling other cameras.
   */
  public async seekPlaybackSession(
    sessionId: string,
    targetUtc: Date
  ): Promise<SynchronizedSeekResult> {
    const session = await this.prisma.playbackSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) {
      throw new Error(`PlaybackSession ${sessionId} not found`);
    }

    const cameraIds = session.cameraIdsJson as string[];
    const cameraStates: CameraPlaybackState[] = [];

    // Query each camera's state against the centralized RecordingCatalog
    for (const cameraId of cameraIds) {
      const seekTarget = await this.catalog.findSeekTarget(
        cameraId,
        targetUtc
      );

      if (seekTarget.status === 'READY') {
        cameraStates.push({
          cameraId,
          status: 'READY',
          segmentId: seekTarget.segmentId,
          segmentUri: seekTarget.segmentUri,
          currentPts: seekTarget.currentPts ?? seekTarget.targetPts,
          nearestKeyframePts: seekTarget.nearestKeyframePts,
          offsetMs: seekTarget.offsetMs,
          codec: seekTarget.codec,
          fps: seekTarget.fps,
        });
      } else {
        cameraStates.push({
          cameraId,
          status: 'NO_RECORDING',
          gapDurationMs: seekTarget.gapDurationMs,
        });
      }
    }

    // Update session master clock
    const updatedSession = await this.prisma.playbackSession.update({
      where: { id: sessionId },
      data: {
        masterTimeUtc: targetUtc,
        state: session.state === PlaybackSessionState.STOPPED ? PlaybackSessionState.PAUSED : session.state,
      },
    });

    return {
      sessionId: updatedSession.id,
      masterTimeUtc: targetUtc,
      playbackRate: updatedSession.playbackRate,
      sessionState: updatedSession.state,
      cameras: cameraStates,
    };
  }

  /**
   * Updates playback rate (-16x to +16x) and session state (PLAYING vs PAUSED).
   */
  public async setPlaybackRate(
    sessionId: string,
    rate: number
  ): Promise<PlaybackSession> {
    const allowedRates = [-16, -8, -4, -2, -1, -0.5, 0, 0.25, 0.5, 1, 2, 4, 8, 16];
    if (!allowedRates.includes(rate)) {
      throw new Error(`Unsupported playback rate: ${rate}x. Allowed: ${allowedRates.join(', ')}`);
    }

    const newState = rate === 0 ? PlaybackSessionState.PAUSED : PlaybackSessionState.PLAYING;

    return this.prisma.playbackSession.update({
      where: { id: sessionId },
      data: {
        playbackRate: rate,
        state: newState,
      },
    });
  }

  /**
   * Advances the master UTC wall-clock time using monotonic elapsed delta.
   * ΔmasterUtc = monotonicDeltaMs * playbackRate.
   */
  public async advanceMasterClock(
    sessionId: string,
    monotonicDeltaMs: number
  ): Promise<SynchronizedSeekResult> {
    const session = await this.prisma.playbackSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) {
      throw new Error(`PlaybackSession ${sessionId} not found`);
    }

    if (session.state !== PlaybackSessionState.PLAYING || session.playbackRate === 0) {
      return this.seekPlaybackSession(sessionId, session.masterTimeUtc);
    }

    const effectiveDeltaMs = Math.round(monotonicDeltaMs * session.playbackRate);
    const newMasterUtc = new Date(session.masterTimeUtc.getTime() + effectiveDeltaMs);

    return this.seekPlaybackSession(sessionId, newMasterUtc);
  }

  /**
   * Steps all active cameras in the session forward or backward by one frame delta.
   * Does NOT assume 33ms; uses exact timebase and FPS per camera segment.
   */
  public async stepSessionFrame(
    sessionId: string,
    direction: 'FORWARD' | 'BACKWARD'
  ): Promise<FrameStepResult> {
    const session = await this.prisma.playbackSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) {
      throw new Error(`PlaybackSession ${sessionId} not found`);
    }

    const cameraIds = session.cameraIdsJson as string[];
    // The first camera with footage at this moment is the reference: the step lands on ITS next real frame, and the
    // other cameras are brought to that moment. When no camera can step (no readable file and no frame rate), the
    // step is refused: guessing a 25 fps step would put a forensic step on the wrong frame.
    let step: Awaited<ReturnType<RecordingCatalog['stepToAdjacentFrame']>> | null = null;
    let referenceCameraId: string | null = null;
    let lastError: unknown = null;

    for (const cameraId of cameraIds) {
      const seekTarget = await this.catalog.findSeekTarget(cameraId, session.masterTimeUtc);
      if (seekTarget.status !== 'READY' || !seekTarget.segmentId || seekTarget.currentPts === undefined) continue;
      try {
        step = await this.catalog.stepToAdjacentFrame(cameraId, seekTarget.segmentId, seekTarget.currentPts, direction);
        referenceCameraId = cameraId;
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!step || !referenceCameraId) {
      throw lastError instanceof FrameStepUnavailableError
        ? lastError
        : new FrameStepUnavailableError('no camera has footage at this moment that can be stepped');
    }

    // Freeze session in PAUSED state on single-frame step
    await this.prisma.playbackSession.update({
      where: { id: sessionId },
      data: {
        state: PlaybackSessionState.PAUSED,
        playbackRate: 0,
      },
    });

    const seek = await this.seekPlaybackSession(sessionId, step.utc);
    return { ...seek, precision: step.precision, referenceCameraId, clamped: step.clamped };
  }

  /**
   * Reverse Shuttle Invariant:
   * Generates descending keyframe sequence for reverse scrubbing across specified cameras.
   */
  public async getShuttleKeyframes(
    tenantId: string,
    cameraIds: string[],
    startUtc: Date,
    endUtc: Date,
    direction: 'FORWARD' | 'REVERSE' = 'REVERSE'
  ): Promise<Record<string, ReverseShuttleStep[]>> {
    const result: Record<string, ReverseShuttleStep[]> = {};

    for (const cameraId of cameraIds) {
      const segments = await this.catalog.findSegments(
        cameraId,
        startUtc,
        endUtc
      );
      const steps: ReverseShuttleStep[] = [];

      for (const seg of segments) {
        const keyframes = (seg.keyframeIndexJson as any[]) || [];
        const timebaseDen = seg.timebaseDenominator || 90000;
        const timebaseNum = seg.timebaseNumerator || 1;
        const msPerPts = (Number(timebaseNum) * 1000) / Number(timebaseDen);

        for (const kf of keyframes) {
          const kfPts = BigInt(kf.pts);
          const offsetMs = Math.round(Number(kfPts - seg.startPts) * msPerPts);
          const kfUtc = new Date(seg.startTime.getTime() + offsetMs);
          if (kfUtc >= startUtc && kfUtc <= endUtc) {
            steps.push({
              cameraId,
              pts: kfPts,
              offsetMs,
              utcTime: kfUtc,
              segmentId: seg.id,
            });
          }
        }
      }

      // Sort by UTC wall-clock time
      if (direction === 'REVERSE') {
        steps.sort((a, b) => b.utcTime.getTime() - a.utcTime.getTime());
      } else {
        steps.sort((a, b) => a.utcTime.getTime() - b.utcTime.getTime());
      }

      result[cameraId] = steps;
    }

    return result;
  }
}
