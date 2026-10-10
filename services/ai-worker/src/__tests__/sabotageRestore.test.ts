import { SabotageDetector, SabotageFinding } from '../sabotageDetector';
import { FrameGeometry, VideoFrame } from '../types';
import { StreamSupervisor } from '../streamSupervisor';
import { ResourceGovernor } from '../frameQueue';
import { AuthenticatedInternalApiClient } from '../apiClient';

const W = 320;
const H = 180;
const GEOMETRY: FrameGeometry = {
  sourceWidth: W,
  sourceHeight: H,
  modelWidth: W,
  modelHeight: H,
  scale: 1,
  padX: 0,
  padY: 0,
};

function makeFrame(luma: number, tMs: number, cameraId = 'cam-1'): VideoFrame {
  const data = Buffer.alloc(W * H * 3, luma);
  return {
    cameraId,
    tenantId: 'tenant-1',
    streamPath: `${cameraId}/sub`,
    streamSessionId: 's',
    sequenceNumber: 1,
    sampledAt: new Date(tMs),
    receivedAt: new Date(tMs),
    width: W,
    height: H,
    channels: 3,
    data,
    geometry: GEOMETRY,
  };
}

describe('SabotageDetector.restoreActive across restarts', () => {
  it('restores active conditions and clears them after clearMs when frames are normal', () => {
    const det = new SabotageDetector({
      learnFrames: 2,
      clearMs: 10_000,
      holdMs: 5_000,
    });

    const tStart = 1_000_000;
    const tConfirmed = 1_010_000;

    det.restoreActive('cam-1', [
      {
        type: 'OCCLUSION',
        startedAt: new Date(tStart),
        confirmedAt: new Date(tConfirmed),
        score: 0.95,
        threshold: 0.5,
      },
    ]);

    expect(det.activeConditions('cam-1')).toEqual(['OCCLUSION']);

    // Send frame 1 to start learning
    let findings: SabotageFinding[] = [];
    findings.push(...det.observe(makeFrame(128, tConfirmed + 1000)));
    expect(findings).toEqual([]);
    expect(det.activeConditions('cam-1')).toEqual(['OCCLUSION']);

    // Send frame 2 to finish learning (learnFrames: 2)
    findings = det.observe(makeFrame(128, tConfirmed + 2000));
    expect(findings).toEqual([]);
    expect(det.activeConditions('cam-1')).toEqual(['OCCLUSION']);

    // Send frame 3 before clearMs elapsed (5s < 10s clearMs)
    findings = det.observe(makeFrame(128, tConfirmed + 5000));
    expect(findings).toEqual([]);
    expect(det.activeConditions('cam-1')).toEqual(['OCCLUSION']);

    // Send frame 4 after clearMs elapsed (11s >= 10s clearMs)
    const tCleared = tConfirmed + 11_000;
    findings = det.observe(makeFrame(128, tCleared));

    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.state).toBe('CLEARED');
    expect(f.type).toBe('OCCLUSION');
    expect(f.startedAt.getTime()).toBe(tStart);
    expect(f.confirmedAt.getTime()).toBe(tConfirmed);
    expect(f.clearedAt?.getTime()).toBe(tCleared);
    expect(f.clearReason).toBe('RESTORED');
    expect(f.score).toBe(0.95);
    expect(f.threshold).toBe(0.5);

    expect(det.activeConditions('cam-1')).toEqual([]);
  });

  it('does not overwrite existing active condition when called redundantly', () => {
    const det = new SabotageDetector();
    const t1 = new Date(1_000_000);
    const t2 = new Date(1_010_000);

    det.restoreActive('cam-1', [{ type: 'DEFOCUS', startedAt: t1, confirmedAt: t2, score: 0.8 }]);
    expect(det.activeConditions('cam-1')).toEqual(['DEFOCUS']);

    // Call restoreActive again with different startedAt
    det.restoreActive('cam-1', [{ type: 'DEFOCUS', startedAt: new Date(2_000_000), confirmedAt: new Date(2_010_000), score: 0.9 }]);
    expect(det.activeConditions('cam-1')).toEqual(['DEFOCUS']);
  });
});

describe('StreamSupervisor reconciliation of open conditions', () => {
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
      ]),
      fetchOpenSabotageConditions: jest.fn().mockResolvedValue({
        conditions: [
          {
            id: 'cond-1',
            cameraId: 'cam-01',
            tenantId: 'tenant-alpha',
            changeType: 'BLINDED',
            startedAt: '2026-10-10T12:00:00.000Z',
            confirmedAt: '2026-10-10T12:00:10.000Z',
            score: 0.9,
            threshold: 0.4,
            method: 'classical-v1',
          },
        ],
      }),
    };

    mockAiWorker = {
      processFrame: jest.fn().mockResolvedValue([]),
    };

    governor = new ResourceGovernor({ maxConcurrentStreams: 10 });
  });

  it('restores open sabotage conditions on syncCameras', async () => {
    const sabotage = new SabotageDetector();
    const supervisor = new StreamSupervisor({
      apiClient: mockApiClient,
      aiWorker: mockAiWorker,
      governor,
      sabotage,
    });

    await supervisor.syncCameras();

    expect(mockApiClient.fetchOpenSabotageConditions).toHaveBeenCalledTimes(1);
    expect(sabotage.activeConditions('cam-01')).toEqual(['BLINDED']);

    await supervisor.stopAll();
  });

  it('does not fail syncCameras if fetchOpenSabotageConditions fails', async () => {
    mockApiClient.fetchOpenSabotageConditions.mockRejectedValue(new Error('backend down'));
    const sabotage = new SabotageDetector();
    const supervisor = new StreamSupervisor({
      apiClient: mockApiClient,
      aiWorker: mockAiWorker,
      governor,
      sabotage,
    });

    const warnSpy = jest.fn();
    supervisor.on('warn', warnSpy);

    const cams = await supervisor.syncCameras();
    expect(cams).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('open sabotage'));

    await supervisor.stopAll();
  });
});

describe('per-camera sensitivity override thresholds (ADR 0019)', () => {
  function makeVStripedFrame(tMs: number, cameraId: string): VideoFrame {
    const data = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const bx = Math.floor(x / 10);
        const val = bx % 2 === 0 ? 40 : 200;
        const idx = (y * W + x) * 3;
        data[idx] = val;
        data[idx + 1] = val;
        data[idx + 2] = val;
      }
    }
    return {
      cameraId,
      tenantId: 'tenant-1',
      streamPath: `${cameraId}/sub`,
      streamSessionId: 's',
      sequenceNumber: 1,
      sampledAt: new Date(tMs),
      receivedAt: new Date(tMs),
      width: W,
      height: H,
      channels: 3,
      data,
      geometry: GEOMETRY,
    };
  }

  function makeFrameStd10(tMs: number, cameraId: string): VideoFrame {
    const blend = 0.47;
    const data = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y++) {
      const by = Math.floor(y / 10);
      for (let x = 0; x < W; x++) {
        const bx = Math.floor(x / 10);
        const refSign = bx % 2 === 0 ? -1 : 1;
        const orthSign = by % 2 === 0 ? -1 : 1;
        const val = Math.round(128 + 10 * (blend * refSign + Math.sqrt(1 - blend * blend) * orthSign));
        const idx = (y * W + x) * 3;
        data[idx] = val;
        data[idx + 1] = val;
        data[idx + 2] = val;
      }
    }
    return {
      cameraId,
      tenantId: 'tenant-1',
      streamPath: `${cameraId}/sub`,
      streamSessionId: 's',
      sequenceNumber: 1,
      sampledAt: new Date(tMs),
      receivedAt: new Date(tMs),
      width: W,
      height: H,
      channels: 3,
      data,
      geometry: GEOMETRY,
    };
  }

  it('Camera with custom flatStd: 8 ignores frame with stdLuma: 10, while default camera with flatStd: 12 confirms OCCLUSION', () => {
    const det = new SabotageDetector({
      learnFrames: 2,
      holdMs: 2000,
    });

    det.setCameraConfig('cam-custom', { flatStd: 8 });

    // Learn reference frames (2 frames)
    det.observe(makeVStripedFrame(1000, 'cam-default'));
    det.observe(makeVStripedFrame(2000, 'cam-default'));
    det.observe(makeVStripedFrame(1000, 'cam-custom'));
    det.observe(makeVStripedFrame(2000, 'cam-custom'));

    expect(det.isReady('cam-default')).toBe(true);
    expect(det.isReady('cam-custom')).toBe(true);

    // Send frame with stdLuma ~ 10 over 3 seconds (> holdMs 2000)
    let defFindings: SabotageFinding[] = [];
    let custFindings: SabotageFinding[] = [];
    for (let t = 3000; t <= 6000; t += 1000) {
      defFindings.push(...det.observe(makeFrameStd10(t, 'cam-default')));
      custFindings.push(...det.observe(makeFrameStd10(t, 'cam-custom')));
    }

    // Default camera with flatStd: 12 confirms OCCLUSION
    expect(defFindings.some((f) => f.state === 'CONFIRMED' && f.type === 'OCCLUSION')).toBe(true);
    // Custom camera with flatStd: 8 ignores frame (no findings)
    expect(custFindings).toHaveLength(0);
  });

  it('Camera with custom holdMs: 2000 confirms condition earlier than default 10000ms', () => {
    const det = new SabotageDetector({
      learnFrames: 2,
      holdMs: 10_000,
    });

    det.setCameraConfig('cam-fast', { holdMs: 2000 });

    // Learn reference frames
    det.observe(makeVStripedFrame(1000, 'cam-default'));
    det.observe(makeVStripedFrame(2000, 'cam-default'));
    det.observe(makeVStripedFrame(1000, 'cam-fast'));
    det.observe(makeVStripedFrame(2000, 'cam-fast'));

    // Feed flat black frames (darkFraction = 1.0 -> OCCLUSION)
    let fastFindings: SabotageFinding[] = [];
    let defFindings: SabotageFinding[] = [];

    // t = 3000 (first suspect frame)
    fastFindings.push(...det.observe(makeFrame(5, 3000, 'cam-fast')));
    defFindings.push(...det.observe(makeFrame(5, 3000, 'cam-default')));
    expect(fastFindings).toHaveLength(0);
    expect(defFindings).toHaveLength(0);

    // t = 4000 (1000ms elapsed)
    fastFindings.push(...det.observe(makeFrame(5, 4000, 'cam-fast')));
    defFindings.push(...det.observe(makeFrame(5, 4000, 'cam-default')));
    expect(fastFindings).toHaveLength(0);
    expect(defFindings).toHaveLength(0);

    // t = 5000 (2000ms elapsed >= 2000ms holdMs for cam-fast, but < 10000ms for cam-default)
    fastFindings.push(...det.observe(makeFrame(5, 5000, 'cam-fast')));
    defFindings.push(...det.observe(makeFrame(5, 5000, 'cam-default')));

    expect(fastFindings).toHaveLength(1);
    expect(fastFindings[0].state).toBe('CONFIRMED');
    expect(fastFindings[0].type).toBe('OCCLUSION');
    expect(defFindings).toHaveLength(0);

    // Advance to t = 13000 (10000ms elapsed >= default holdMs)
    for (let t = 6000; t <= 12000; t += 1000) {
      defFindings.push(...det.observe(makeFrame(5, t, 'cam-default')));
    }
    expect(defFindings).toHaveLength(0);

    defFindings.push(...det.observe(makeFrame(5, 13000, 'cam-default')));
    expect(defFindings).toHaveLength(1);
    expect(defFindings[0].state).toBe('CONFIRMED');
    expect(defFindings[0].type).toBe('OCCLUSION');
  });

  it('StreamSupervisor applies camera sabotageConfig during syncCameras', async () => {
    const sabotage = new SabotageDetector();
    const setConfigSpy = jest.spyOn(sabotage, 'setCameraConfig');

    const mockApiClient = {
      fetchActiveCameras: jest.fn().mockResolvedValue([
        {
          id: 'cam-01',
          tenantId: 'tenant-alpha',
          name: 'Front Entrance',
          streamPath: 'cam_front',
          monitored: true,
          sabotageConfig: {
            holdSeconds: 5,
            clearSeconds: 20,
            graceSeconds: 2,
            flatStd: 8,
            coveredSimilarity: 0.6,
          },
        },
      ]),
      fetchOpenSabotageConditions: jest.fn().mockResolvedValue({ conditions: [] }),
    };

    const supervisor = new StreamSupervisor({
      apiClient: mockApiClient as any,
      aiWorker: { processFrame: jest.fn() } as any,
      governor: new ResourceGovernor({ maxConcurrentStreams: 10 }),
      sabotage,
    });

    await supervisor.syncCameras();

    expect(setConfigSpy).toHaveBeenCalledWith('cam-01', {
      holdMs: 5000,
      clearMs: 20000,
      graceMs: 2000,
      flatStd: 8,
      coveredSimilarity: 0.6,
      blindedFraction: undefined,
      defocusSharpnessRatio: undefined,
      displacedSimilarity: undefined,
    });

    await supervisor.stopAll();
  });
});
