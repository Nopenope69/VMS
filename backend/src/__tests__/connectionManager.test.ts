import { CameraConnectionManager } from '../services/camera/cameraConnectionManager.service';

describe('CameraConnectionManager Reconnect Storm Mitigation', () => {
  let manager: CameraConnectionManager;

  beforeEach(() => {
    manager = new CameraConnectionManager();
  });

  afterEach(() => {
    manager.stop();
  });

  it('should register and track camera connection state', () => {
    const info = manager.registerCamera('cam_conn_01');
    expect(info.state).toBe('OFFLINE');
    expect(info.retries).toBe(0);
  });

  it('should calculate exponential backoff with randomized jitter', () => {
    const backoff0 = manager.calculateBackoffMs(0); // 1s + jitter (0-3s) -> 1000-4000
    const backoff1 = manager.calculateBackoffMs(1); // 2s + jitter -> 2000-5000
    const backoff2 = manager.calculateBackoffMs(2); // 4s + jitter -> 4000-7000

    expect(backoff0).toBeGreaterThanOrEqual(1000);
    expect(backoff0).toBeLessThanOrEqual(4500);

    expect(backoff1).toBeGreaterThanOrEqual(2000);
    expect(backoff1).toBeLessThanOrEqual(5500);

    expect(backoff2).toBeGreaterThanOrEqual(4000);
    expect(backoff2).toBeLessThanOrEqual(7500);
  });

  it('should cap exponential backoff at 30 seconds plus jitter per Contract Section 3.1', () => {
    const backoff10 = manager.calculateBackoffMs(10); // capped at 30s + jitter
    expect(backoff10).toBeGreaterThanOrEqual(30000);
    expect(backoff10).toBeLessThanOrEqual(33500);
  });

  it('processes queued reconnection and successfully transitions to ONLINE when handler succeeds', async () => {
    manager.setReconnectionHandler(async (cameraId) => {
      return { success: true };
    });

    manager.enqueueConnection('cam_live_01');
    expect(manager.getQueueLength()).toBe(1);

    await manager.processQueue();

    const info = manager.getCameraStatus('cam_live_01');
    expect(info?.state).toBe('ONLINE');
    expect(info?.retries).toBe(0);
    expect(info?.lastConnectedAt).toBeInstanceOf(Date);
    expect(manager.getActiveHandshakes()).toBe(0);
    expect(manager.getQueueLength()).toBe(0);
  });

  it('backs off and re-queues camera when reconnection fails without blocking activeHandshakes', async () => {
    manager.setReconnectionHandler(async (cameraId) => {
      return { success: false, error: 'ECONNREFUSED' };
    });

    manager.reportDisconnect('cam_live_02', 'RTSP_TIMEOUT');
    expect(manager.getCameraStatus('cam_live_02')?.state).toBe('DEGRADED');

    await manager.processQueue();

    const info = manager.getCameraStatus('cam_live_02');
    expect(info?.state).toBe('RECONNECT_BACKOFF');
    expect(info?.retries).toBe(1);
    expect(info?.lastError).toBe('ECONNREFUSED');
    expect(info?.nextAttemptAt).toBeInstanceOf(Date);
    expect(info!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    // Active handshake released!
    expect(manager.getActiveHandshakes()).toBe(0);
    // Camera is re-queued with backoff
    expect(manager.getQueueLength()).toBe(1);
  });

  it('respects MAX_CONCURRENT_HANDSHAKES and prevents queue deadlock under burst', async () => {
    let resolveFirstHandshake: (val: any) => void;
    const hangingPromise = new Promise<{ success: boolean }>((resolve) => {
      resolveFirstHandshake = resolve;
    });

    let invocationCount = 0;
    manager.setReconnectionHandler(async (cameraId) => {
      invocationCount++;
      return hangingPromise;
    });

    manager.enqueueConnection('cam_burst_1');
    manager.enqueueConnection('cam_burst_2');
    manager.enqueueConnection('cam_burst_3');
    manager.enqueueConnection('cam_burst_4');

    // Process up to max concurrent handshakes (3)
    await manager.processQueue(); // 1
    await manager.processQueue(); // 2
    await manager.processQueue(); // 3
    await manager.processQueue(); // 4th should be skipped due to MAX_CONCURRENT_HANDSHAKES

    expect(manager.getActiveHandshakes()).toBe(3);
    expect(invocationCount).toBe(3);
    expect(manager.getQueueLength()).toBe(1); // 4th stays in queue

    // Resolve hanging connections
    resolveFirstHandshake!({ success: true });
    await new Promise((r) => setTimeout(r, 10));

    expect(manager.getActiveHandshakes()).toBe(0);

    // Now 4th can be processed
    await manager.processQueue();
    expect(invocationCount).toBe(4);
  });
});

