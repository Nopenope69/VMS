import { StreamWatchdogService, StreamTelemetrySample } from '../services/watchdog/streamWatchdog.service';

describe('StreamWatchdogService - Baseline Deviation Inspector & Recovery', () => {
  let service: StreamWatchdogService;
  let mockPrisma: any;
  let createdAlarms: any[] = [];
  let updatedAlarms: any[] = [];

  beforeEach(() => {
    createdAlarms = [];
    updatedAlarms = [];

    mockPrisma = {
      camera: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'cam_dog_01',
          name: 'Front Gate High-Res',
          tenantId: 'tenant_01',
          streamPath: 'cam_dog_01',
          streamBaseline: {
            expectedFps: 25.0,
            expectedBitrateKbpsMin: 2000,
            expectedBitrateKbpsMax: 6000,
            expectedResolution: '1920x1080',
            expectedGopSeconds: 2.0,
          },
        }),
      },
      streamDiagnostic: {
        create: jest.fn().mockResolvedValue({ id: 'diag_01' }),
      },
      event: {
        create: jest.fn().mockResolvedValue({ id: 'event_deg_01' }),
      },
      alarm: {
        create: jest.fn().mockImplementation(({ data }) => {
          const a = { id: `alarm_${createdAlarms.length + 1}`, ...data };
          createdAlarms.push(a);
          return Promise.resolve(a);
        }),
        findFirst: jest.fn().mockImplementation(() => Promise.resolve(createdAlarms[0] || null)),
        update: jest.fn().mockImplementation(({ where, data }) => {
          updatedAlarms.push({ where, data });
          return Promise.resolve({ ...createdAlarms[0], ...data });
        }),
      },
    };

    service = new StreamWatchdogService(mockPrisma);
  });

  it('should classify nominal stream as healthy with low deviation score', async () => {
    const nominalSample: StreamTelemetrySample = {
      fps: 25.0,
      bitrateKbps: 3500, // within 2000-6000 kbps
      resolution: '1920x1080',
      videoCodec: 'h264',
      gopInterval: 2.0,
      ready: true,
    };

    const res = await service.evaluateStream('cam_dog_01', nominalSample);

    expect(res.isDegraded).toBe(false);
    expect(res.deviationScore).toBe(0);
    expect(createdAlarms).toHaveLength(0);
    expect(mockPrisma.streamDiagnostic.create).toHaveBeenCalledTimes(1);
  });

  it('should flag LOW_FPS degradation and raise alarm when FPS drops below 50% of baseline', async () => {
    const lowFpsSample: StreamTelemetrySample = {
      fps: 10.0, // Expected 25.0 -> 60% drop
      bitrateKbps: 2500,
      resolution: '1920x1080',
      videoCodec: 'h264',
      gopInterval: 2.0,
      ready: true,
    };

    const res = await service.evaluateStream('cam_dog_01', lowFpsSample);

    expect(res.isDegraded).toBe(true);
    expect(res.primaryIssue).toBe('LOW_FPS');
    expect(res.deviationScore).toBeGreaterThanOrEqual(0.24);
    expect(createdAlarms).toHaveLength(1);
    expect(createdAlarms[0].title).toContain('LOW_FPS');
  });

  it('should flag BITRATE_COLLAPSE when incoming stream bandwidth plummets', async () => {
    const lowBitrateSample: StreamTelemetrySample = {
      fps: 25.0,
      bitrateKbps: 400, // Expected >= 2000 kbps
      resolution: '1920x1080',
      videoCodec: 'h264',
      gopInterval: 2.0,
      ready: true,
    };

    const res = await service.evaluateStream('cam_dog_01', lowBitrateSample);

    expect(res.isDegraded).toBe(true);
    expect(res.primaryIssue).toBe('BITRATE_COLLAPSE');
    expect(createdAlarms).toHaveLength(1);
  });

  it('should auto-resolve active alarm when stream metrics recover to nominal', async () => {
    // 1. First trigger degraded state
    const degradedSample: StreamTelemetrySample = {
      fps: 8.0,
      bitrateKbps: 500,
      resolution: '1920x1080',
      videoCodec: 'h264',
      ready: true,
    };
    await service.evaluateStream('cam_dog_01', degradedSample);
    expect(createdAlarms).toHaveLength(1);

    // 2. Next sample recovers to nominal
    const recoveredSample: StreamTelemetrySample = {
      fps: 25.0,
      bitrateKbps: 3000,
      resolution: '1920x1080',
      videoCodec: 'h264',
      gopInterval: 2.0,
      ready: true,
    };
    const res = await service.evaluateStream('cam_dog_01', recoveredSample);

    expect(res.isDegraded).toBe(false);
    expect(updatedAlarms).toHaveLength(1);
    expect(updatedAlarms[0].data.state).toBe('RESOLVED');
    expect(updatedAlarms[0].data.resolutionNotes).toContain('Auto-resolved');
  });
});
