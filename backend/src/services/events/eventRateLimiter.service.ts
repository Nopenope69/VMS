export interface RateLimitStatus {
  allowed: boolean;
  droppedCount: number;
  lastAllowedAt: number;
}

export class EventRateLimiter {
  private static cameraWindows = new Map<string, { lastAllowedAt: number; droppedCount: number }>();
  private static readonly WINDOW_MS = 1000; // 1 second minimum interval between raw trigger emissions
  private static readonly MAX_DROPPED_LOG = 100;

  /**
   * Evaluates if a raw event trigger from a camera should be admitted or throttled.
   */
  public static shouldProcessTrigger(cameraId: string): boolean {
    const now = Date.now();
    const entry = this.cameraWindows.get(cameraId);

    if (!entry) {
      this.cameraWindows.set(cameraId, { lastAllowedAt: now, droppedCount: 0 });
      return true;
    }

    if (now - entry.lastAllowedAt >= this.WINDOW_MS) {
      if (entry.droppedCount > 0) {
        console.warn(
          `[EventRateLimiter] Camera ${cameraId} throttled ${entry.droppedCount} raw event spikes in preceding window.`
        );
      }
      entry.lastAllowedAt = now;
      entry.droppedCount = 0;
      return true;
    }

    // Dropped / throttled
    entry.droppedCount++;
    return false;
  }

  public static getStats(cameraId: string): RateLimitStatus | null {
    const entry = this.cameraWindows.get(cameraId);
    if (!entry) return null;
    return {
      allowed: Date.now() - entry.lastAllowedAt >= this.WINDOW_MS,
      droppedCount: entry.droppedCount,
      lastAllowedAt: entry.lastAllowedAt,
    };
  }

  public static reset() {
    this.cameraWindows.clear();
  }
}

export default EventRateLimiter;
