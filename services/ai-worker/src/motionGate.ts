import { VideoFrame } from './types';

/**
 * Motion-gated scheduling (P2.5). Decides, per camera and frame, whether a sampled frame is worth
 * an inference. Inference runs when:
 *
 *  1. the camera is ARMED: it has an enabled AI rule (tripwire, loitering, person/vehicle
 *     trigger). Rules need continuous tracks, so every sampled frame is inferred;
 *  2. the backend reports recent scene-change / motion activity on the camera (classical
 *     detector, substream), within `motionHoldMs`;
 *  3. the frame differs from the last inferred one (cheap local grey-level difference on a
 *     sparse pixel grid) above `diffThreshold`;
 *  4. the camera still has live tracks (hold until they end), or
 *  5. a keep-alive interval passed (slow movers that never trip the difference test).
 *
 * Then a global token bucket caps inferences per second across all cameras (the frame budget).
 * Every decision is returned with a reason so the caller can count drops by reason.
 */
export type GateDecision =
  | { run: true; reason: 'armed' | 'backend_motion' | 'pixel_change' | 'active_tracks' | 'keepalive' | 'gate_off' }
  | { run: false; reason: 'static_scene' | 'budget_exhausted' };

export interface CameraActivity {
  armed: boolean;
  lastMotionAt?: number;
}

export interface MotionGateOptions {
  mode?: 'motion' | 'off';
  /** Mean absolute grey difference (0..255) on the sample grid that counts as change. Default 6. */
  diffThreshold?: number;
  /** Sample every Nth pixel in x and y. Default 8. */
  gridStep?: number;
  motionHoldMs?: number;
  keepAliveMs?: number;
  /** Frame budget: inferences per second across all cameras. Default 10. */
  maxInferencesPerSecond?: number;
  now?: () => number;
}

interface CameraState {
  lastGrey?: Uint8Array;
  lastInferredAt?: number;
}

export class MotionGate {
  private cameras = new Map<string, CameraState>();
  private activity = new Map<string, CameraActivity>();
  private tokens: number;
  private lastRefill: number;
  private readonly opts: Required<Omit<MotionGateOptions, 'now'>>;
  private readonly now: () => number;

  constructor(options: MotionGateOptions = {}) {
    this.opts = {
      mode: options.mode ?? 'motion',
      diffThreshold: options.diffThreshold ?? 6,
      gridStep: Math.max(1, options.gridStep ?? 8),
      motionHoldMs: options.motionHoldMs ?? 10000,
      keepAliveMs: options.keepAliveMs ?? 30000,
      maxInferencesPerSecond: Math.max(0.1, options.maxInferencesPerSecond ?? 10),
    };
    this.now = options.now ?? Date.now;
    this.tokens = this.opts.maxInferencesPerSecond;
    this.lastRefill = this.now();
  }

  /** Replaces the per-camera activity snapshot polled from the backend. */
  public setActivity(activity: Record<string, CameraActivity>): void {
    this.activity = new Map(Object.entries(activity));
  }

  public forget(cameraId: string): void {
    this.cameras.delete(cameraId);
  }

  public decide(frame: VideoFrame, hasActiveTracks: boolean): GateDecision {
    const cam = this.cameras.get(frame.cameraId) ?? {};
    this.cameras.set(frame.cameraId, cam);
    const t = this.now();

    let reason: Exclude<GateDecision, { run: false }>['reason'] | null = null;
    const grey = sampleGrey(frame, this.opts.gridStep);
    if (this.opts.mode === 'off') reason = 'gate_off';
    else {
      const act = this.activity.get(frame.cameraId);
      if (act?.armed) reason = 'armed';
      else if (act?.lastMotionAt !== undefined && t - act.lastMotionAt <= this.opts.motionHoldMs) reason = 'backend_motion';
      else if (hasActiveTracks) reason = 'active_tracks';
      else if (!cam.lastGrey || meanAbsDiff(grey, cam.lastGrey) >= this.opts.diffThreshold) reason = 'pixel_change';
      else if (cam.lastInferredAt === undefined || t - cam.lastInferredAt >= this.opts.keepAliveMs) reason = 'keepalive';
    }

    if (!reason) return { run: false, reason: 'static_scene' };
    if (!this.takeToken(t)) return { run: false, reason: 'budget_exhausted' };
    cam.lastGrey = grey;
    cam.lastInferredAt = t;
    return { run: true, reason };
  }

  private takeToken(t: number): boolean {
    const rate = this.opts.maxInferencesPerSecond;
    this.tokens = Math.min(rate, this.tokens + ((t - this.lastRefill) / 1000) * rate);
    this.lastRefill = t;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

/** Grey levels (BT.601 luma) on a sparse grid of an RGB24 frame. */
export function sampleGrey(frame: Pick<VideoFrame, 'data' | 'width' | 'height'>, step: number): Uint8Array {
  const cols = Math.ceil(frame.width / step);
  const rows = Math.ceil(frame.height / step);
  const out = new Uint8Array(cols * rows);
  let k = 0;
  for (let y = 0; y < frame.height; y += step) {
    for (let x = 0; x < frame.width; x += step) {
      const i = (y * frame.width + x) * 3;
      out[k++] = (frame.data[i] * 77 + frame.data[i + 1] * 150 + frame.data[i + 2] * 29) >> 8;
    }
  }
  return out;
}

export function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) return Number.POSITIVE_INFINITY;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}
