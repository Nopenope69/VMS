import fs from 'fs';
import path from 'path';

export interface ClockSanityCheckResult {
  valid: boolean;
  systemTime: Date;
  trustedFloor: Date;
  skewDetected: boolean;
  skewSeconds: number;
  reason?: string;
}

export class ClockGuard {
  // Hardcoded build epoch: 2026-09-01T00:00:00Z
  private static readonly BUILD_EPOCH = new Date('2026-09-01T00:00:00.000Z');
  private static stateFilePath: string = process.env.CLOCK_GUARD_STATE_PATH || '/etc/vigilone/clock_guard.state';
  private static lastKnownGoodTime: Date = ClockGuard.loadPersistedState();

  private static loadPersistedState(): Date {
    try {
      const filePath = this.stateFilePath || process.env.CLOCK_GUARD_STATE_PATH || '/etc/vigilone/clock_guard.state';
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf8').trim();
        const parsed = new Date(raw);
        if (!isNaN(parsed.getTime()) && parsed.getTime() > ClockGuard.BUILD_EPOCH.getTime()) {
          return parsed;
        }
      }
    } catch {
      // Fallback to build epoch if file unreadable or not present
    }
    return ClockGuard.BUILD_EPOCH;
  }

  private static persistState() {
    try {
      const filePath = this.stateFilePath || process.env.CLOCK_GUARD_STATE_PATH || '/etc/vigilone/clock_guard.state';
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, ClockGuard.lastKnownGoodTime.toISOString(), { encoding: 'utf8', mode: 0o600 });
      try {
        fs.chmodSync(filePath, 0o600);
      } catch {
        // Ignore chmod on filesystems that do not support POSIX modes
      }
    } catch {
      // Non-fatal if host path is read-only or in non-privileged environment
    }
  }

  public static setStateFilePath(filePath: string) {
    this.stateFilePath = filePath;
    this.lastKnownGoodTime = this.loadPersistedState();
  }

  public static getStateFilePath(): string {
    return this.stateFilePath;
  }

  public static getLastKnownGoodTime(): Date {
    return this.lastKnownGoodTime;
  }

  public static resetToEpoch() {
    this.lastKnownGoodTime = this.BUILD_EPOCH;
  }

  /**
   * Monotonically merges an external floor (e.g. from a backup or audit log).
   * Ensures the floor can never regress backward.
   */
  public static mergeBackupFloor(floor: Date): Date {
    if (floor.getTime() > this.lastKnownGoodTime.getTime()) {
      this.lastKnownGoodTime = floor;
      this.persistState();
    }
    return this.lastKnownGoodTime;
  }

  /**
   * Updates the monotonic last known good timestamp from persistent checkpoints
   * (e.g. latest audit log entry or license issue date).
   */
  public static recordCheckpoint(checkpoint: Date) {
    if (checkpoint.getTime() > this.lastKnownGoodTime.getTime()) {
      this.lastKnownGoodTime = checkpoint;
      this.persistState();
    }
  }

  /**
   * Evaluates system clock sanity against the monotonic floor.
   * If CMOS battery reset clock to 1970 or an operator manually wound back the clock,
   * flags skewDetected and returns the trusted floor.
   */
  public static checkClockSanity(
    now: Date = new Date(),
    licenseIssuedAt?: Date | null
  ): ClockSanityCheckResult {
    let trustedFloor = this.lastKnownGoodTime;

    if (licenseIssuedAt && licenseIssuedAt.getTime() > trustedFloor.getTime()) {
      trustedFloor = licenseIssuedAt;
    }

    const nowMs = now.getTime();
    const floorMs = trustedFloor.getTime();

    // Allow 5 minutes of backward clock jitter for standard NTP slewing
    const SKEW_TOLERANCE_MS = 300_000;

    if (nowMs < floorMs - SKEW_TOLERANCE_MS) {
      const skewSeconds = Math.round((floorMs - nowMs) / 1000);
      return {
        valid: false,
        systemTime: now,
        trustedFloor,
        skewDetected: true,
        skewSeconds,
        reason: `CLOCK_SKEW_DETECTED: System time (${now.toISOString()}) is behind trusted floor (${trustedFloor.toISOString()}) by ${skewSeconds} seconds. CMOS battery failure or clock rollback suspected.`,
      };
    }

    // Normal forward progression
    if (nowMs > this.lastKnownGoodTime.getTime()) {
      this.lastKnownGoodTime = now;
      this.persistState();
    }

    return {
      valid: true,
      systemTime: now,
      trustedFloor,
      skewDetected: false,
      skewSeconds: 0,
    };
  }

  /**
   * Returns a trustworthy timestamp for license evaluation.
   * If clock rollback is detected, returns the trusted floor instead of the bogus past time.
   */
  public static getSanitizedTimeForLicense(licenseIssuedAt?: Date | null): Date {
    const check = this.checkClockSanity(new Date(), licenseIssuedAt);
    if (check.skewDetected) {
      console.warn(`[ClockGuard] ${check.reason}. Enforcing monotonic trusted floor for licensing.`);
      return check.trustedFloor;
    }
    return check.systemTime;
  }
}

export default ClockGuard;
