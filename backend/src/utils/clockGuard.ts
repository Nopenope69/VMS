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
  private static lastKnownGoodTime: Date = this.BUILD_EPOCH;

  /**
   * Updates the monotonic last known good timestamp from persistent checkpoints
   * (e.g. latest audit log entry or license issue date).
   */
  public static recordCheckpoint(checkpoint: Date) {
    if (checkpoint.getTime() > this.lastKnownGoodTime.getTime()) {
      this.lastKnownGoodTime = checkpoint;
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
