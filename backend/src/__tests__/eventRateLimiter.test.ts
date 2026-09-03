import EventRateLimiter from '../services/events/eventRateLimiter.service';

describe('EventRateLimiter Flapping & Event Storm Protection', () => {
  const testCameraId = 'cam_rate_limit_01';

  beforeEach(() => {
    EventRateLimiter.reset();
  });

  it('should allow initial event trigger for a camera', () => {
    const allowed = EventRateLimiter.shouldProcessTrigger(testCameraId);
    expect(allowed).toBe(true);
  });

  it('should throttle rapid consecutive triggers from the same camera', () => {
    const first = EventRateLimiter.shouldProcessTrigger(testCameraId);
    expect(first).toBe(true);

    // Immediate 10 subsequent calls in the same millisecond window should all be dropped
    let droppedCount = 0;
    for (let i = 0; i < 10; i++) {
      if (!EventRateLimiter.shouldProcessTrigger(testCameraId)) {
        droppedCount++;
      }
    }

    expect(droppedCount).toBe(10);

    const stats = EventRateLimiter.getStats(testCameraId);
    expect(stats?.droppedCount).toBe(10);
  });

  it('should isolate rate limiting between independent cameras', () => {
    const camA = 'cam_alpha';
    const camB = 'cam_beta';

    expect(EventRateLimiter.shouldProcessTrigger(camA)).toBe(true);
    expect(EventRateLimiter.shouldProcessTrigger(camB)).toBe(true);

    // Flooding camA should not affect camB's admission
    EventRateLimiter.shouldProcessTrigger(camA);
    EventRateLimiter.shouldProcessTrigger(camA);

    expect(EventRateLimiter.getStats(camA)?.droppedCount).toBe(2);
    expect(EventRateLimiter.getStats(camB)?.droppedCount).toBe(0);
  });
});
