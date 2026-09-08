import { PrismaClient, TourState } from '@prisma/client';
import onvifManager, { OnvifCredentials } from '../onvif/client';

export interface PtzVector {
  x: number;
  y: number;
  zoom?: number;
}

export interface CameraArbiterState {
  state: TourState;
  activeTourId: string | null;
  activeOperatorId: string | null;
  lockExpiresAt: Date | null;
  inactivityTimer: NodeJS.Timeout | null;
  resumeCallback: (() => Promise<void>) | null;
}

export class PtzArbiterService {
  private prisma: PrismaClient;
  private arbiterStates = new Map<string, CameraArbiterState>();
  private readonly LOCK_TTL_MS = 15000; // 15 seconds lock lease
  private readonly INACTIVITY_RESUME_MS = 30000; // 30 seconds operator inactivity before resuming tour

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  private getOrCreateState(cameraId: string): CameraArbiterState {
    let state = this.arbiterStates.get(cameraId);
    if (!state) {
      state = {
        state: TourState.STOPPED,
        activeTourId: null,
        activeOperatorId: null,
        lockExpiresAt: null,
        inactivityTimer: null,
        resumeCallback: null,
      };
      this.arbiterStates.set(cameraId, state);
    }
    return state;
  }

  /**
   * Attempts to acquire or refresh exclusive operator PTZ lock lease.
   * Prevents two operators from fighting over the same PTZ camera.
   */
  async acquireLock(
    cameraId: string,
    userId: string,
    ttlMs = this.LOCK_TTL_MS
  ): Promise<{ success: boolean; holderId?: string; expiresAt?: Date }> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);

    const existingLock = await this.prisma.ptzLock.findUnique({
      where: { cameraId },
    });

    if (existingLock && existingLock.expiresAt > now && existingLock.userId !== userId) {
      // Locked by another operator
      return {
        success: false,
        holderId: existingLock.userId,
        expiresAt: existingLock.expiresAt,
      };
    }

    // Acquire or upsert lease
    await this.prisma.ptzLock.upsert({
      where: { cameraId },
      update: { userId, expiresAt, acquiredAt: now },
      create: { cameraId, userId, expiresAt, acquiredAt: now },
    });

    const state = this.getOrCreateState(cameraId);
    state.activeOperatorId = userId;
    state.lockExpiresAt = expiresAt;

    return { success: true, expiresAt };
  }

  /**
   * Releases an operator's PTZ lock lease.
   */
  async releaseLock(cameraId: string, userId: string): Promise<void> {
    const existing = await this.prisma.ptzLock.findUnique({ where: { cameraId } });
    if (existing && existing.userId === userId) {
      await this.prisma.ptzLock.delete({ where: { cameraId } });
    }

    const state = this.getOrCreateState(cameraId);
    if (state.activeOperatorId === userId) {
      state.activeOperatorId = null;
      state.lockExpiresAt = null;
    }
  }

  /**
   * Registers that an automated Guard Tour has begun running.
   */
  registerTourStarted(cameraId: string, tourId: string, resumeCallback?: () => Promise<void>): void {
    const state = this.getOrCreateState(cameraId);
    state.state = TourState.RUNNING;
    state.activeTourId = tourId;
    if (resumeCallback) {
      state.resumeCallback = resumeCallback;
    }
  }

  /**
   * Registers that an automated Guard Tour has stopped.
   */
  registerTourStopped(cameraId: string): void {
    const state = this.getOrCreateState(cameraId);
    state.state = TourState.STOPPED;
    state.activeTourId = null;
    state.resumeCallback = null;
    if (state.inactivityTimer) {
      clearTimeout(state.inactivityTimer);
      state.inactivityTimer = null;
    }
  }

  /**
   * Dispatches manual move with operator preemption and inactivity auto-resumption.
   */
  async manualMove(
    cameraId: string,
    userId: string,
    creds: OnvifCredentials,
    profileToken: string,
    vector: PtzVector
  ): Promise<void> {
    // 1. Enforce Concurrency Lock
    const lock = await this.acquireLock(cameraId, userId);
    if (!lock.success) {
      const err: any = new Error(
        `PTZ camera is currently locked by another operator (${lock.holderId}).`
      );
      err.statusCode = 409;
      throw err;
    }

    const state = this.getOrCreateState(cameraId);

    // 2. Preempt active Guard Tour if one is running
    if (state.state === TourState.RUNNING) {
      state.state = TourState.MANUAL_OVERRIDE;
    }

    // 3. Reset 30s inactivity auto-resumption timer
    this.resetInactivityTimer(cameraId);

    // 4. Command physical ONVIF camera
    await onvifManager.ptzContinuousMove(creds, profileToken, vector);
  }

  /**
   * Dispatches manual stop with operator inactivity tracking.
   */
  async manualStop(
    cameraId: string,
    userId: string,
    creds: OnvifCredentials,
    profileToken: string
  ): Promise<void> {
    const state = this.getOrCreateState(cameraId);
    if (state.activeOperatorId && state.activeOperatorId !== userId) {
      const lock = await this.acquireLock(cameraId, userId);
      if (!lock.success) {
        const err: any = new Error(`PTZ camera locked by operator ${lock.holderId}`);
        err.statusCode = 409;
        throw err;
      }
    }

    this.resetInactivityTimer(cameraId);
    await onvifManager.ptzStop(creds, profileToken);
  }

  /**
   * Dispatches manual goto preset.
   */
  async gotoPreset(
    cameraId: string,
    userId: string,
    creds: OnvifCredentials,
    profileToken: string,
    presetToken: string,
    speed?: number
  ): Promise<void> {
    const lock = await this.acquireLock(cameraId, userId);
    if (!lock.success) {
      const err: any = new Error(`PTZ camera locked by operator ${lock.holderId}`);
      err.statusCode = 409;
      throw err;
    }

    const state = this.getOrCreateState(cameraId);
    if (state.state === TourState.RUNNING) {
      state.state = TourState.MANUAL_OVERRIDE;
    }
    this.resetInactivityTimer(cameraId);

    await onvifManager.gotoPreset(creds, profileToken, presetToken, speed);
  }

  private resetInactivityTimer(cameraId: string): void {
    const state = this.getOrCreateState(cameraId);
    if (state.inactivityTimer) {
      clearTimeout(state.inactivityTimer);
    }

    state.inactivityTimer = setTimeout(async () => {
      await this.handleInactivityTimeout(cameraId);
    }, this.INACTIVITY_RESUME_MS);
  }

  /**
   * Triggered when operator has sent no commands for 30 seconds.
   * If a guard tour was preempted, automatically resumes the tour!
   */
  async handleInactivityTimeout(cameraId: string): Promise<void> {
    const state = this.getOrCreateState(cameraId);
    state.inactivityTimer = null;

    // Release operator lock
    if (state.activeOperatorId) {
      await this.releaseLock(cameraId, state.activeOperatorId);
    }

    // If camera was in MANUAL_OVERRIDE and has a tour to resume
    if (state.state === TourState.MANUAL_OVERRIDE && state.activeTourId) {
      state.state = TourState.RUNNING;
      if (state.resumeCallback) {
        try {
          await state.resumeCallback();
        } catch (err: any) {
          console.error(`[PtzArbiter] Auto-resumption error for camera ${cameraId}:`, err.message);
        }
      }
    } else if (state.state === TourState.MANUAL_OVERRIDE) {
      state.state = TourState.STOPPED;
    }
  }

  getState(cameraId: string): {
    state: TourState;
    activeOperatorId: string | null;
    activeTourId: string | null;
    isLocked: boolean;
  } {
    const s = this.getOrCreateState(cameraId);
    const isLocked = Boolean(s.lockExpiresAt && s.lockExpiresAt > new Date());
    return {
      state: s.state,
      activeOperatorId: s.activeOperatorId,
      activeTourId: s.activeTourId,
      isLocked,
    };
  }
}

export const ptzArbiterService = new PtzArbiterService(new PrismaClient());
export default ptzArbiterService;
