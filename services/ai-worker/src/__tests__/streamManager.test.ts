import { StreamManager } from '../streamManager';

describe('StreamManager: 8-State Lifecycle & Reconnection Logic', () => {
  const sampleConfig = {
    cameraId: 'cam-manager-test',
    tenantId: 'tenant-test',
    streamPath: 'cam_manager_test',
    baseBackoffMs: 1000,
    maxBackoffMs: 30000,
    jitterMs: 200,
  };

  describe('1. Lifecycle State Machine Initialization', () => {
    it('initializes in DISCOVERED state with clean telemetry', () => {
      const manager = new StreamManager(sampleConfig);

      expect(manager.getState()).toBe('DISCOVERED');

      const telemetry = manager.getTelemetry();
      expect(telemetry.cameraId).toBe('cam-manager-test');
      expect(telemetry.state).toBe('DISCOVERED');
      expect(telemetry.reconnectCount).toBe(0);
      expect(telemetry.queueDepth).toBe(0);
      expect(telemetry.droppedFrames).toBe(0);
      expect(telemetry.processedFrames).toBe(0);
    });
  });

  describe('2. Exponential Reconnect Backoff Calculation', () => {
    it('calculates exponential backoff with bounded jitter', () => {
      const manager = new StreamManager(sampleConfig);

      // Attempt 0: 1000 * 2^0 = 1000 + [0..200]
      const d0 = manager.calculateBackoffDelay(0);
      expect(d0).toBeGreaterThanOrEqual(1000);
      expect(d0).toBeLessThanOrEqual(1200);

      // Attempt 1: 1000 * 2^1 = 2000 + [0..200]
      const d1 = manager.calculateBackoffDelay(1);
      expect(d1).toBeGreaterThanOrEqual(2000);
      expect(d1).toBeLessThanOrEqual(2200);

      // Attempt 2: 1000 * 2^2 = 4000 + [0..200]
      const d2 = manager.calculateBackoffDelay(2);
      expect(d2).toBeGreaterThanOrEqual(4000);
      expect(d2).toBeLessThanOrEqual(4200);

      // Attempt 10: should cap at maxBackoffMs (30000) + [0..200]
      const d10 = manager.calculateBackoffDelay(10);
      expect(d10).toBeGreaterThanOrEqual(30000);
      expect(d10).toBeLessThanOrEqual(30200);
    });
  });

  describe('3. Graceful Shutdown & Queue Clearing', () => {
    it('transitions to STOPPED and clears the queue on stop()', async () => {
      const manager = new StreamManager(sampleConfig);

      await manager.stop();

      expect(manager.getState()).toBe('STOPPED');
      expect(manager.getQueue().isEmpty()).toBe(true);
    });
  });
});
