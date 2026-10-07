import { StreamSupervisor } from '../streamSupervisor';
import { InternalApiError } from '../apiClient';
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

describe('StreamSupervisor: camera-sabotage reports (ADR 0019)', () => {
  const finding = {
    cameraId: 'cam-s', tenantId: 't', type: 'OCCLUSION' as const, score: 0.97, threshold: 0.5,
    startedAt: new Date('2026-10-07T10:00:00Z'), confirmedAt: new Date('2026-10-07T10:00:10Z'),
    measurements: { meanLuma: 128, stdLuma: 3, darkFraction: 0, brightFraction: 0, sharpness: 1, referenceSharpness: 0.6, similarity: 0.02 },
  };
  function frame(seq: number): VideoFrame {
    return {
      cameraId: 'cam-s', tenantId: 't', streamPath: 'p', streamSessionId: 's', sequenceNumber: seq,
      sampledAt: new Date(), receivedAt: new Date(), width: 8, height: 8, channels: 3, data: Buffer.alloc(8 * 8 * 3, 50),
      geometry: { sourceWidth: 8, sourceHeight: 8, modelWidth: 8, modelHeight: 8, scale: 1, padX: 0, padY: 0 },
    };
  }
  function setup(reportCameraSabotage: jest.Mock, observe: jest.Mock = jest.fn().mockReturnValueOnce([finding]).mockReturnValue([])) {
    const worker = { processFrame: jest.fn().mockResolvedValue([]) };
    const api = { fetchActiveCameras: jest.fn().mockResolvedValue([]), reportCameraSabotage };
    const sabotage = { observe, forget: jest.fn() };
    const supervisor = new StreamSupervisor({ apiClient: api as any, aiWorker: worker as any, gateMode: 'off', sabotage: sabotage as any, sabotageRetryDelaysMs: [5, 5] });
    const warnings: string[] = [];
    supervisor.on('warn', (m) => warnings.push(String(m)));
    const manager = supervisor.startCameraStream({ id: 'cam-s', tenantId: 't', name: 's', streamPath: 's', monitored: true }, { sourceWidth: 8, sourceHeight: 8 });
    const emit = (seq: number) => {
      manager.getQueue().enqueue(frame(seq));
      manager.emit('frame', frame(seq));
    };
    return { supervisor, worker, sabotage, warnings, emit };
  }
  const settle = () => new Promise((r) => setTimeout(r, 60));

  it('checks every sampled frame and reports a finding with the contract body', async () => {
    const report = jest.fn().mockResolvedValue({ eventId: 'ev_sabotage_x' });
    const { supervisor, worker, sabotage, emit } = setup(report);
    emit(1);
    emit(2);
    await settle();
    expect(sabotage.observe).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toEqual({
      cameraId: 'cam-s', tenantId: 't', changeType: 'OCCLUSION', score: 0.97, threshold: 0.5,
      startedAtUtc: '2026-10-07T10:00:00.000Z', confirmedAtUtc: '2026-10-07T10:00:10.000Z', method: 'classical-v1',
      measurements: finding.measurements,
    });
    expect(worker.processFrame).toHaveBeenCalled(); // inference still runs
    await supervisor.stopAll();
  });

  it('retries a transport failure, then gives up with a warning', async () => {
    const report = jest.fn().mockRejectedValue(new InternalApiError(undefined, 'timed out'));
    const { supervisor, warnings, emit } = setup(report);
    emit(1);
    await settle();
    expect(report).toHaveBeenCalledTimes(3);
    expect(warnings.some((w) => w.includes('was not recorded'))).toBe(true);
    await supervisor.stopAll();
  });

  it('does not retry a refusal, and says once that the backend flag is off', async () => {
    const refused = jest.fn().mockRejectedValue(new InternalApiError(400, 'bad'));
    const a = setup(refused);
    a.emit(1);
    await settle();
    expect(refused).toHaveBeenCalledTimes(1);
    await a.supervisor.stopAll();

    const disabled = jest.fn().mockRejectedValue(new InternalApiError(501, 'off'));
    const b = setup(disabled, jest.fn().mockReturnValue([finding]));
    b.emit(1);
    b.emit(2);
    await settle();
    expect(disabled).toHaveBeenCalledTimes(2);
    expect(b.warnings.filter((w) => w.includes('VIGILONE_FEATURE_CAMERA_SABOTAGE'))).toHaveLength(1);
    await b.supervisor.stopAll();
  });

  it('a detector that throws does not stop inference', async () => {
    const report = jest.fn();
    const { supervisor, worker, warnings, emit } = setup(report, jest.fn(() => { throw new Error('boom'); }));
    emit(1);
    await settle();
    expect(worker.processFrame).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
    expect(warnings.some((w) => w.includes('camera-sabotage check failed'))).toBe(true);
    await supervisor.stopAll();
  });

  it('forgets a camera whose stream stops', async () => {
    const { supervisor, sabotage } = setup(jest.fn());
    await supervisor.stopCameraStream('cam-s');
    expect(sabotage.forget).toHaveBeenCalledWith('cam-s');
    await supervisor.stopAll();
  });
});
