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

  it('should cap exponential backoff at 60 seconds plus jitter', () => {
    const backoff10 = manager.calculateBackoffMs(10); // capped at 60s + jitter
    expect(backoff10).toBeGreaterThanOrEqual(60000);
    expect(backoff10).toBeLessThanOrEqual(63500);
  });
});
