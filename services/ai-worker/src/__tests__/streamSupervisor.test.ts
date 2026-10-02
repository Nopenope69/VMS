import { StreamSupervisor } from '../streamSupervisor';
import { ResourceGovernor } from '../frameQueue';
import { DiscoveredCamera, VideoFrame } from '../types';

describe('StreamSupervisor: Multi-Camera Pipeline & Failure Isolation', () => {
  let mockApiClient: any;
  let mockAiWorker: any;
  let governor: ResourceGovernor;

  beforeEach(() => {
    mockApiClient = {
      fetchActiveCameras: jest.fn().mockResolvedValue([
        {
          id: 'cam-01',
          tenantId: 'tenant-alpha',
          name: 'Front Entrance',
          streamPath: 'cam_front',
          monitored: true,
        },
        {
          id: 'cam-02',
          tenantId: 'tenant-alpha',
          name: 'Rear Loading Dock',
          streamPath: 'cam_rear',
          monitored: true,
        },
      ]),
    };

    mockAiWorker = {
      processFrame: jest.fn().mockResolvedValue([
        {
          tenantId: 'tenant-alpha',
          cameraId: 'cam-01',
          type: 'PERSON_DETECTED',
          confidence: 0.9,
          inferenceId: 'inf-test-1',
        },
      ]),
    };

    governor = new ResourceGovernor({ maxConcurrentStreams: 10 });
  });

  describe('1. Camera Discovery & Multi-Stream Lifecycle Coordination', () => {
    it('syncs active cameras and registers streams with resource governor', async () => {
      const supervisor = new StreamSupervisor({
        apiClient: mockApiClient,
        aiWorker: mockAiWorker,
        governor,
        syncIntervalMs: 60000,
      });

      const discovered = await supervisor.syncCameras();

      expect(discovered).toHaveLength(2);
      expect(supervisor.getStreamCount()).toBe(2);
      expect(governor.getActiveStreamCount()).toBe(2);

      const telemetry = supervisor.getConsolidatedTelemetry();
      expect(telemetry['cam-01']).toBeDefined();
      expect(telemetry['cam-02']).toBeDefined();

      await supervisor.stopAll();
      expect(supervisor.getStreamCount()).toBe(0);
      expect(governor.getActiveStreamCount()).toBe(0);
    });

    it('stops stream when a camera goes offline in discovery', async () => {
      const supervisor = new StreamSupervisor({
        apiClient: mockApiClient,
        aiWorker: mockAiWorker,
        governor,
      });

      await supervisor.syncCameras();
      expect(supervisor.getStreamCount()).toBe(2);

      // Now cam-02 goes offline
      mockApiClient.fetchActiveCameras.mockResolvedValueOnce([
        {
          id: 'cam-01',
          tenantId: 'tenant-alpha',
          name: 'Front Entrance',
          streamPath: 'cam_front',
          monitored: true,
        },
        {
          id: 'cam-02',
          tenantId: 'tenant-alpha',
          name: 'Rear Loading Dock',
          streamPath: 'cam_rear',
          monitored: false, // no longer monitored
        },
      ]);

      await supervisor.syncCameras();
      expect(supervisor.getStreamCount()).toBe(1);
      expect(supervisor.getStreamManager('cam-02')).toBeUndefined();
      expect(governor.getActiveStreamCount()).toBe(1);

      await supervisor.stopAll();
    });

    it('respects concurrency limits and skips streams beyond capacity', async () => {
      const strictGovernor = new ResourceGovernor({ maxConcurrentStreams: 1 });
      const supervisor = new StreamSupervisor({
        apiClient: mockApiClient,
        aiWorker: mockAiWorker,
        governor: strictGovernor,
      });

      let warnMessage = '';
      supervisor.on('warn', (msg) => {
        warnMessage = msg;
      });

      await supervisor.syncCameras();

      // Only 1 stream admitted
      expect(supervisor.getStreamCount()).toBe(1);
      expect(strictGovernor.getActiveStreamCount()).toBe(1);
      expect(warnMessage).toContain('Concurrency limit reached');

      await supervisor.stopAll();
    });
  });

  describe('2. Pipeline Dispatch & AI Failure Isolation', () => {
    it('isolates AI inference errors: an inference failure never crashes stream supervisor', async () => {
      const supervisor = new StreamSupervisor({
        apiClient: mockApiClient,
        aiWorker: mockAiWorker,
        governor,
      });

      mockAiWorker.processFrame.mockRejectedValueOnce(new Error('Inference tensor shape error'));

      const manager = supervisor.startCameraStream({
        id: 'cam-isolated',
        tenantId: 'tenant-alpha',
        name: 'Isolated Cam',
        streamPath: 'cam_iso',
        monitored: true,
      });

      const testFrame: VideoFrame = {
        cameraId: 'cam-isolated',
        tenantId: 'tenant-alpha',
        streamPath: 'cam_iso',
        streamSessionId: 'sess-1',
        sequenceNumber: 1,
        sampledAt: new Date(),
        receivedAt: new Date(),
        width: 64,
        height: 48,
        channels: 3,
        data: Buffer.alloc(64 * 48 * 3),
        geometry: {
          sourceWidth: 640,
          sourceHeight: 480,
          modelWidth: 64,
          modelHeight: 48,
          scale: 0.1,
          padX: 0,
          padY: 0,
        },
      };

      let errorCaptured: any = null;
      supervisor.once('inferenceError', (err) => {
        errorCaptured = err;
      });

      // What StreamManager does for a decoded frame: enqueue it, then emit 'frame'
      manager.getQueue().enqueue(testFrame);
      manager.emit('frame', testFrame);

      // Wait a tick for async dispatch
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(errorCaptured).not.toBeNull();
      expect(errorCaptured.cameraId).toBe('cam-isolated');
      expect(errorCaptured.error).toContain('Inference tensor shape error');

      // The stream manager remains active
      expect(supervisor.getStreamCount()).toBe(1);

      await supervisor.stopAll();
    });
  });
});

describe('StreamSupervisor: each sampled frame is inferred at most once', () => {
  function frame(cameraId: string, seq: number): VideoFrame {
    return {
      cameraId, tenantId: 't', streamPath: 'p', streamSessionId: 's', sequenceNumber: seq,
      sampledAt: new Date(), receivedAt: new Date(), width: 8, height: 8, channels: 3,
      data: Buffer.alloc(8 * 8 * 3, seq * 10),
      geometry: { sourceWidth: 8, sourceHeight: 8, modelWidth: 8, modelHeight: 8, scale: 1, padX: 0, padY: 0 },
    };
  }

  it('processes every frame exactly once when inference keeps up (no re-processing of the queued copy)', async () => {
    const seen: number[] = [];
    const worker = { processFrame: jest.fn(async (f: VideoFrame) => { seen.push(f.sequenceNumber); return []; }) };
    const api = { fetchActiveCameras: jest.fn().mockResolvedValue([]) };
    const supervisor = new StreamSupervisor({ apiClient: api as any, aiWorker: worker as any, gateMode: 'off' } as any);
    const manager = supervisor.startCameraStream({ id: 'cam-x', tenantId: 't', name: 'x', streamPath: 'x', monitored: true }, { sourceWidth: 8, sourceHeight: 8 });
    // Simulate what StreamManager does for each decoded frame: enqueue, then emit.
    for (let i = 1; i <= 3; i++) {
      manager.getQueue().enqueue(frame('cam-x', i));
      manager.emit('frame', frame('cam-x', i));
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 50));
    await supervisor.stopAll();
    expect(seen).toEqual([1, 2, 3]);
  });
});
