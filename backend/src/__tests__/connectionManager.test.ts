import net from 'net';
import { CameraConnectionManager } from '../services/camera/cameraConnectionManager.service';
import prisma from '../config/database';
import mediaProvider from '../services/media/mediamtx.provider';

jest.mock('../config/database', () => ({
  camera: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
  },
}));

jest.mock('../services/media/mediamtx.provider', () => ({
  createOrUpdateStream: jest.fn().mockResolvedValue(undefined),
  setRecording: jest.fn().mockResolvedValue(undefined),
}));

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

  describe('defaultReconnectionHandler Real TCP Socket Probing & MediaMTX Wiring', () => {
    it('successfully connects to live ephemeral TCP port, registers MediaMTX stream, and transitions camera ONLINE', async () => {
      // 1. Create live ephemeral TCP server
      const tcpServer = net.createServer((socket) => {
        socket.on('error', () => {});
      });

      await new Promise<void>((resolve) => {
        tcpServer.listen(0, '127.0.0.1', () => resolve());
      });

      const port = (tcpServer.address() as net.AddressInfo).port;

      try {
        (prisma.camera.findUnique as jest.Mock).mockResolvedValue({
          id: 'cam_tcp_live_01',
          name: 'Live Gate Camera',
          ipAddress: '127.0.0.1',
          rtspPort: port,
          streamPath: 'live_gate_stream',
          mainRtspUri: `rtsp://127.0.0.1:${port}/live`,
          desiredRecorderState: 'RUNNING',
          encryptedAuth: null,
        });

        // Clear mock calls
        (mediaProvider.createOrUpdateStream as jest.Mock).mockClear();

        // Enqueue camera WITHOUT custom handler -> triggers defaultReconnectionHandler
        const statePromise = new Promise<string>((resolve) => {
          manager.on('stateChange', (id, state) => {
            if (id === 'cam_tcp_live_01' && state !== 'CONNECTING') {
              resolve(state);
            }
          });
        });

        manager.enqueueConnection('cam_tcp_live_01');
        expect(manager.getQueueLength()).toBe(1);

        await manager.processQueue();
        const finalState = await statePromise;
        expect(finalState).toBe('ONLINE');

        const status = manager.getCameraStatus('cam_tcp_live_01');
        expect(status?.state).toBe('ONLINE');
        expect(status?.retries).toBe(0);
        expect(status?.lastConnectedAt).toBeInstanceOf(Date);

        expect(mediaProvider.createOrUpdateStream).toHaveBeenCalledTimes(1);
        expect(mediaProvider.createOrUpdateStream).toHaveBeenCalledWith({
          path: 'live_gate_stream',
          sourceRtspUrl: `rtsp://127.0.0.1:${port}/live`,
          record: true,
        });
      } finally {
        await new Promise<void>((resolve) => tcpServer.close(() => resolve()));
      }
    });

    it('detects closed TCP port, refuses MediaMTX registration, and transitions camera to RECONNECT_BACKOFF', async () => {
      // Choose an unused/closed ephemeral port
      const dummyServer = net.createServer();
      await new Promise<void>((resolve) => dummyServer.listen(0, '127.0.0.1', () => resolve()));
      const closedPort = (dummyServer.address() as net.AddressInfo).port;
      await new Promise<void>((resolve) => dummyServer.close(() => resolve()));

      (prisma.camera.findUnique as jest.Mock).mockResolvedValue({
        id: 'cam_tcp_dead_01',
        name: 'Dead Gate Camera',
        ipAddress: '127.0.0.1',
        rtspPort: closedPort,
        streamPath: 'dead_gate_stream',
        mainRtspUri: `rtsp://127.0.0.1:${closedPort}/live`,
        desiredRecorderState: 'RUNNING',
        encryptedAuth: null,
      });

      (mediaProvider.createOrUpdateStream as jest.Mock).mockClear();

      const deadStatePromise = new Promise<string>((resolve) => {
        manager.on('stateChange', (id, state) => {
          if (id === 'cam_tcp_dead_01' && state !== 'CONNECTING') {
            resolve(state);
          }
        });
      });

      manager.enqueueConnection('cam_tcp_dead_01');
      await manager.processQueue();
      const deadFinalState = await deadStatePromise;
      expect(deadFinalState).toBe('RECONNECT_BACKOFF');

      const status = manager.getCameraStatus('cam_tcp_dead_01');
      expect(status?.state).toBe('RECONNECT_BACKOFF');
      expect(status?.retries).toBe(1);
      expect(status?.lastError).toContain('unreachable on network');

      // MediaMTX must NOT be called for dead camera
      expect(mediaProvider.createOrUpdateStream).not.toHaveBeenCalled();
    });
  });
});

