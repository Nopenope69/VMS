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
