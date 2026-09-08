import { TripwireDirection } from '@prisma/client';
import { Point2D, LineSide, SpatialGeometry } from './geometry';

export interface TrackObservation {
  trackId: string;
  centroid: Point2D;
  timestamp?: Date;
  cameraId?: string;
}

export interface TripwireRuleInput {
  id: string;
  name: string;
  direction: TripwireDirection;
  lineCoordinates: [Point2D, Point2D];
  cooldownSeconds?: number;
}

export interface TripwireCrossingResult {
  ruleId: string;
  ruleName: string;
  trackId: string;
  directionCrossed: 'A_TO_B' | 'B_TO_A';
  timestamp: Date;
}

export interface LoiteringRuleInput {
  id: string;
  name: string;
  polygon: Point2D[];
  dwellThresholdSeconds: number;
  cooldownSeconds?: number;
}

export interface LoiteringResult {
  ruleId: string;
  ruleName: string;
  trackId: string;
  dwellDurationSeconds: number;
  timestamp: Date;
}

export interface LoiteringEvaluationOptions {
  observationStatus?: 'OBSERVED' | 'OBSERVED_OUTSIDE' | 'TEMPORARILY_UNOBSERVED';
  observationTimeoutMs?: number; // Default 2000ms
}

interface TripwireStateEntry {
  lastSide: LineSide;
  lastCrossedAt?: number;
  lastSeenAt: number;
  cameraId?: string;
}

interface LoiteringStateEntry {
  dwellStartMs: number | null;
  lastObservedAtMs: number;
  lastAlertMs?: number;
  lastSeenAt: number;
  isLost?: boolean;
  cameraId?: string;
}

export interface LedgerMetrics {
  activeTripwireTracks: number;
  activeLoiteringTracks: number;
  evictedCount: number;
  expiredCount: number;
}

export interface TrackStateLedgerConfig {
  ttlMs?: number; // Default 10 minutes (600,000 ms)
  maxTracksPerCamera?: number; // Default 500
  maxTracksGlobal?: number; // Default 5000
}

/**
 * Authoritative in-memory TrackStateLedger with bounded memory,
 * LRU eviction, 3-state hysteresis for tripwires, and observation-loss rules for loitering.
 */
export class TrackStateLedger {
  private readonly ttlMs: number;
  private readonly maxTracksPerCamera: number;
  private readonly maxTracksGlobal: number;

  private tripwireMap = new Map<string, TripwireStateEntry>();
  private loiteringMap = new Map<string, LoiteringStateEntry>();

  private evictedCount = 0;
  private expiredCount = 0;

  constructor(config?: TrackStateLedgerConfig) {
    this.ttlMs = config?.ttlMs ?? 10 * 60 * 1000; // 10 minutes
    this.maxTracksPerCamera = config?.maxTracksPerCamera ?? 500;
    this.maxTracksGlobal = config?.maxTracksGlobal ?? 5000;
  }

  /**
   * Evaluates tripwire crossing using 3-state hysteresis with ON_LINE epsilon buffer (Correction 3).
   */
  public evaluateTripwire(
    rule: TripwireRuleInput,
    track: TrackObservation,
    currentTimeMs: number = Date.now()
  ): TripwireCrossingResult | null {
    this.pruneExpired(currentTimeMs);

    const key = `${rule.id}_${track.trackId}`;
    const [pointA, pointB] = rule.lineCoordinates;

    const currentSide = SpatialGeometry.computeLineSide(
      pointA,
      pointB,
      track.centroid,
      0.005
    );

    let state = this.tripwireMap.get(key);
    let crossedDirection: 'A_TO_B' | 'B_TO_A' | null = null;

    if (!state) {
      state = {
        lastSide: currentSide,
        lastSeenAt: currentTimeMs,
        cameraId: track.cameraId,
      };
      this.ensureCapacity(this.tripwireMap, track.cameraId);
      this.tripwireMap.set(key, state);
    } else {
      // Refresh LRU position and timestamp
      state.lastSeenAt = currentTimeMs;
      if (track.cameraId && !state.cameraId) state.cameraId = track.cameraId;

      if (state.lastSide === 'SIDE_A' && currentSide === 'SIDE_B') {
        crossedDirection = 'A_TO_B';
        state.lastSide = 'SIDE_B';
      } else if (state.lastSide === 'SIDE_B' && currentSide === 'SIDE_A') {
        crossedDirection = 'B_TO_A';
        state.lastSide = 'SIDE_A';
      } else if (currentSide !== 'ON_LINE') {
        state.lastSide = currentSide;
      }
      // If currentSide === 'ON_LINE', we keep state.lastSide so that when it exits
      // to the opposite side, it correctly detects the crossing, while oscillating
      // in/out of the buffer without crossing causes no event.

      this.tripwireMap.delete(key);
      this.tripwireMap.set(key, state);
    }

    if (!crossedDirection) return null;

    // Direction enforcement
    if (rule.direction === TripwireDirection.A_TO_B && crossedDirection !== 'A_TO_B') {
      return null;
    }
    if (rule.direction === TripwireDirection.B_TO_A && crossedDirection !== 'B_TO_A') {
      return null;
    }

    // Cooldown enforcement
    const cooldownMs = (rule.cooldownSeconds ?? 10) * 1000;
    if (state.lastCrossedAt && currentTimeMs - state.lastCrossedAt < cooldownMs) {
      return null;
    }

    state.lastCrossedAt = currentTimeMs;

    return {
      ruleId: rule.id,
      ruleName: rule.name,
      trackId: track.trackId,
      directionCrossed: crossedDirection,
      timestamp: new Date(currentTimeMs),
    };
  }

  /**
   * Evaluates continuous loitering dwell time with observation-loss rule (Correction 4).
   * - Explicit observation outside polygon immediately resets dwell timer.
   * - Detector dropouts <= observationTimeoutMs (default 2000ms) retain dwell timer.
   * - Dropouts > observationTimeoutMs reset the dwell timer.
   */
  public evaluateLoitering(
    rule: LoiteringRuleInput,
    track: TrackObservation,
    currentTimeMs: number = Date.now(),
    options?: LoiteringEvaluationOptions
  ): LoiteringResult | null {
    this.pruneExpired(currentTimeMs);

    const key = `${rule.id}_${track.trackId}`;
    const observationTimeoutMs = options?.observationTimeoutMs ?? 2000;

    let state = this.loiteringMap.get(key);
    if (!state) {
      state = {
        dwellStartMs: null,
        lastObservedAtMs: currentTimeMs,
        lastSeenAt: currentTimeMs,
        cameraId: track.cameraId,
      };
      this.ensureCapacity(this.loiteringMap, track.cameraId);
      this.loiteringMap.set(key, state);
    } else {
      state.lastSeenAt = currentTimeMs;
      if (track.cameraId && !state.cameraId) state.cameraId = track.cameraId;
      this.loiteringMap.delete(key);
      this.loiteringMap.set(key, state);
    }

    // Handle explicit temporary unobserved status
    if (options?.observationStatus === 'TEMPORARILY_UNOBSERVED') {
      state.isLost = true;
      const gapMs = currentTimeMs - state.lastObservedAtMs;
      if (gapMs > observationTimeoutMs) {
        state.dwellStartMs = null;
      }
      return null;
    }

    // Check if target is inside polygon
    const isInside =
      options?.observationStatus !== 'OBSERVED_OUTSIDE' &&
      SpatialGeometry.isPointInPolygon(track.centroid, rule.polygon);

    if (!isInside) {
      // EXPLICIT EXIT: Immediately reset dwell timer!
      state.dwellStartMs = null;
      state.isLost = false;
      state.lastObservedAtMs = currentTimeMs;
      return null;
    }

    // INSIDE: check if returning from dropout
    if (state.isLost) {
      const gapMs = currentTimeMs - state.lastObservedAtMs;
      if (gapMs > observationTimeoutMs) {
        // Dropout exceeded timeout -> reset dwell start
        state.dwellStartMs = currentTimeMs;
      } else if (state.dwellStartMs === null) {
        state.dwellStartMs = currentTimeMs;
      }
      state.isLost = false;
    } else if (state.dwellStartMs === null) {
      state.dwellStartMs = currentTimeMs;
    }

    state.lastObservedAtMs = currentTimeMs;

    const dwellStart = state.dwellStartMs ?? currentTimeMs;
    const elapsedSeconds = (currentTimeMs - dwellStart) / 1000;
    if (elapsedSeconds >= rule.dwellThresholdSeconds) {
      const cooldownMs = (rule.cooldownSeconds ?? 30) * 1000;
      if (state.lastAlertMs && currentTimeMs - state.lastAlertMs < cooldownMs) {
        return null;
      }

      state.lastAlertMs = currentTimeMs;
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        trackId: track.trackId,
        dwellDurationSeconds: Math.round(elapsedSeconds),
        timestamp: new Date(currentTimeMs),
      };
    }

    return null;
  }

  /**
   * Notifies the ledger that a track was temporarily unobserved (detector dropout).
   */
  public handleDropout(
    ruleId: string,
    trackId: string,
    currentTimeMs: number = Date.now(),
    observationTimeoutMs: number = 2000
  ): void {
    const key = `${ruleId}_${trackId}`;
    let state = this.loiteringMap.get(key);
    if (!state) {
      state = {
        dwellStartMs: null,
        lastObservedAtMs: currentTimeMs,
        lastSeenAt: currentTimeMs,
        isLost: true,
      };
      this.loiteringMap.set(key, state);
      return;
    }

    state.isLost = true;
    state.lastSeenAt = currentTimeMs;
    if (currentTimeMs - state.lastObservedAtMs > observationTimeoutMs) {
      state.dwellStartMs = null;
    }
  }

  /**
   * Enforces bounded memory caps: per-camera and global LRU eviction.
   */
  private ensureCapacity<T extends { lastSeenAt: number; cameraId?: string }>(
    map: Map<string, T>,
    cameraId?: string
  ): void {
    // 1. Check global limit
    while (map.size >= this.maxTracksGlobal) {
      const oldestKey = map.keys().next().value;
      if (oldestKey !== undefined) {
        map.delete(oldestKey);
        this.evictedCount++;
      } else {
        break;
      }
    }

    // 2. Check per-camera limit if cameraId is known
    if (cameraId) {
      let cameraTrackCount = 0;
      for (const entry of map.values()) {
        if (entry.cameraId === cameraId) cameraTrackCount++;
      }

      if (cameraTrackCount >= this.maxTracksPerCamera) {
        // Evict oldest track for this camera
        for (const [key, entry] of map.entries()) {
          if (entry.cameraId === cameraId) {
            map.delete(key);
            this.evictedCount++;
            break;
          }
        }
      }
    }
  }

  /**
   * Prunes entries that have exceeded TTL.
   */
  public pruneExpired(currentTimeMs: number = Date.now()): void {
    for (const [key, entry] of this.tripwireMap.entries()) {
      if (currentTimeMs - entry.lastSeenAt > this.ttlMs) {
        this.tripwireMap.delete(key);
        this.expiredCount++;
      }
    }

    for (const [key, entry] of this.loiteringMap.entries()) {
      if (currentTimeMs - entry.lastSeenAt > this.ttlMs) {
        this.loiteringMap.delete(key);
        this.expiredCount++;
      }
    }
  }

  /**
   * Returns current telemetry metrics.
   */
  public getMetrics(): LedgerMetrics {
    return {
      activeTripwireTracks: this.tripwireMap.size,
      activeLoiteringTracks: this.loiteringMap.size,
      evictedCount: this.evictedCount,
      expiredCount: this.expiredCount,
    };
  }

  /**
   * Clears all track state (useful for tests).
   */
  public clear(): void {
    this.tripwireMap.clear();
    this.loiteringMap.clear();
    this.evictedCount = 0;
    this.expiredCount = 0;
  }
}
