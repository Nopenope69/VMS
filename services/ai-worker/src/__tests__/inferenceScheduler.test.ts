import {
  InferenceScheduler,
  InferenceTimeoutError,
  StaleFrameDroppedError,
} from '../inferenceScheduler';

describe('InferenceScheduler', () => {
  it('bounds concurrent execution to maxConcurrency (default 2)', async () => {
    const scheduler = new InferenceScheduler({ maxConcurrency: 2, timeoutMs: 500 });
    let concurrentRunning = 0;
    let peakConcurrent = 0;

    const createTask = (durationMs: number) => async () => {
      concurrentRunning++;
      peakConcurrent = Math.max(peakConcurrent, concurrentRunning);
      await new Promise((r) => setTimeout(r, durationMs));
      concurrentRunning--;
      return 'done';
    };

    // Schedule 4 tasks across different cameras
    const p1 = scheduler.schedule('cam-1', 1, createTask(40));
    const p2 = scheduler.schedule('cam-2', 1, createTask(40));
    const p3 = scheduler.schedule('cam-3', 1, createTask(40));
    const p4 = scheduler.schedule('cam-4', 1, createTask(40));

    expect(scheduler.getActiveConcurrent()).toBeLessThanOrEqual(2);

    const results = await Promise.all([p1, p2, p3, p4]);
    expect(results).toEqual(['done', 'done', 'done', 'done']);
    expect(peakConcurrent).toBe(2);

    const telemetry = scheduler.getTelemetry();
    expect(telemetry.inferenceCount).toBe(4);
    expect(telemetry.successCount).toBe(4);
    expect(telemetry.errorCount).toBe(0);
    expect(telemetry.timeoutCount).toBe(0);
    expect(telemetry.activeConcurrent).toBe(0);
  });

  it('triggers hard deadline timeout when execution exceeds timeoutMs', async () => {
    const scheduler = new InferenceScheduler({ maxConcurrency: 1, timeoutMs: 30 });

    const slowTask = async () => {
      await new Promise((r) => setTimeout(r, 100)); // takes 100ms > 30ms deadline
      return 'too late';
    };

    await expect(scheduler.schedule('cam-slow', 1, slowTask)).rejects.toThrow(
      InferenceTimeoutError
    );

    const telemetry = scheduler.getTelemetry();
    expect(telemetry.timeoutCount).toBe(1);
    expect(telemetry.successCount).toBe(0);
  });

  it('discards older stale queued frame in favor of newest frame for the same camera', async () => {
    const scheduler = new InferenceScheduler({ maxConcurrency: 1, timeoutMs: 500 });

    // Task 1 blocks the single slot for 80ms
    const blockerPromise = scheduler.schedule('cam-busy', 1, async () => {
      await new Promise((r) => setTimeout(r, 80));
      return 'blocker done';
    });

    // Schedule frame 2 for cam-target (enters queue)
    const frame2Promise = scheduler.schedule('cam-target', 2, async () => {
      return 'frame 2';
    });

    // Before frame 2 can start, frame 3 arrives for cam-target!
    const frame3Promise = scheduler.schedule('cam-target', 3, async () => {
      return 'frame 3';
    });

    // Frame 2 must be rejected as stale
    await expect(frame2Promise).rejects.toThrow(StaleFrameDroppedError);

    // Frame 3 and blocker should succeed
    const resBlocker = await blockerPromise;
    const res3 = await frame3Promise;

    expect(resBlocker).toBe('blocker done');
    expect(res3).toBe('frame 3');

    const telemetry = scheduler.getTelemetry();
    expect(telemetry.droppedStaleCount).toBe(1);
    expect(telemetry.successCount).toBe(2);
  });

  it('captures errors and maintains accurate telemetry', async () => {
    const scheduler = new InferenceScheduler({ maxConcurrency: 2, timeoutMs: 200 });

    const failingTask = async () => {
      throw new Error('Neural network execution failure');
    };

    await expect(scheduler.schedule('cam-err', 1, failingTask)).rejects.toThrow(
      'Neural network execution failure'
    );

    const telemetry = scheduler.getTelemetry();
    expect(telemetry.errorCount).toBe(1);
    expect(telemetry.inferenceCount).toBe(1);
  });
});
