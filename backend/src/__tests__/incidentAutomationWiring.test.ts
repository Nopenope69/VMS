import { incidentOrchestrator } from '../services/incident/orchestrator/incidentOrchestrator.service';
import { SceneChangeDetectorService } from '../services/motion/sceneChangeDetector.service';
import { StreamWatchdogService } from '../services/watchdog/streamWatchdog.service';
import prisma from '../config/database';
import mediaProvider from '../services/media/mediamtx.provider';
import checkDiskSpace from 'check-disk-space';
import { StorageSentinelService } from '../services/storageSentinel.service';

jest.mock('../config/database', () => {
  return {
    camera: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(1),
    },
    detectionZone: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    event: {
      create: jest.fn().mockResolvedValue({ id: 'evt-created-001' }),
      update: jest.fn().mockResolvedValue({ id: 'evt-created-001' }),
    },
    evidencePin: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    streamDiagnostic: {
      create: jest.fn().mockResolvedValue({ id: 'diag-001' }),
    },
    alarm: {
      create: jest.fn().mockResolvedValue({ id: 'alarm-001' }),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({ id: 'alarm-001' }),
    },
    recordingSegment: {
      findMany: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _sum: { sizeBytes: 0n } }),
    },
    storageVolume: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    tenant: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
});

jest.mock('../services/media/mediamtx.provider', () => ({
  setRecording: jest.fn().mockResolvedValue(undefined),
  createOrUpdateStream: jest.fn().mockResolvedValue(undefined),
  getStreamStatus: jest.fn().mockResolvedValue({ ready: true }),
}));

jest.mock('check-disk-space', () => {
  return jest.fn().mockResolvedValue({
    size: 200 * 1024 * 1024 * 1024,
    free: 25 * 1024 * 1024 * 1024, // 25 GB free (freeRatio = 0.125 > 0.05, projected > 2h, but < 30GB minFreeBytes, triggering EMERGENCY_PURGE)
  });
});

describe('IncidentOrchestrator Automation Loop Wiring', () => {
  let ingestSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    ingestSpy = jest.spyOn(incidentOrchestrator, 'ingestEvent').mockResolvedValue({
      eventId: 'mock-ingest-evt',
      correlationId: 'mock-corr-1',
      rulesEvaluated: 1,
      rulesTriggered: 1,
      actionsQueued: 1,
      ruleExecutionIds: ['exec-1'],
    });
  });

  afterEach(() => {
    ingestSpy.mockRestore();
  });

  it('wires SceneChangeDetectorService to ingestEvent on motion episode start', async () => {
    (prisma.camera.findUnique as jest.Mock).mockResolvedValue({
      id: 'cam-motion-1',
      tenantId: 'tenant-automation',
      siteId: 'site-alpha',
    });

    const sceneDetector = new SceneChangeDetectorService(1000);
    await sceneDetector.handleSceneChange('cam-motion-1', 0.88);

    expect(ingestSpy).toHaveBeenCalledTimes(1);
    const eventArg = ingestSpy.mock.calls[0][0];
    expect(eventArg.source).toBe('VISION_AI');
    expect(eventArg.type).toBe('MOTION');
    expect(eventArg.cameraId).toBe('cam-motion-1');
    expect(eventArg.tenantId).toBe('tenant-automation');
    expect(eventArg.payload.kind).toBe('MOTION');
    expect(eventArg.payload.score).toBe(0.88);
  });

  it('wires StreamWatchdogService to ingestEvent on camera stall / offline transition', async () => {
    (prisma.camera.findUnique as jest.Mock).mockResolvedValue({
      id: 'cam-stream-1',
      name: 'Gate Camera',
      tenantId: 'tenant-automation',
      siteId: 'site-beta',
      streamPath: 'cam_gate',
      streamBaseline: {
        expectedFps: 25.0,
        expectedBitrateKbpsMin: 1500,
        expectedBitrateKbpsMax: 6000,
        expectedResolution: '1920x1080',
        expectedGopSeconds: 2.0,
      },
    });

    const watchdog = new StreamWatchdogService(prisma as any);
    // Evaluate stream with stalled metrics (ready = false)
    await watchdog.evaluateStream('cam-stream-1', {
      fps: 0,
      bitrateKbps: 0,
      resolution: 'UNKNOWN',
      videoCodec: 'none',
      ready: false,
    });

    expect(ingestSpy).toHaveBeenCalledTimes(1);
    const eventArg = ingestSpy.mock.calls[0][0];
    expect(eventArg.source).toBe('WATCHDOG');
    expect(eventArg.type).toBe('CAMERA_OFFLINE');
    expect(eventArg.severity).toBe('CRITICAL');
    expect(eventArg.cameraId).toBe('cam-stream-1');
    expect(eventArg.tenantId).toBe('tenant-automation');
    expect(eventArg.payload.kind).toBe('CAMERA_OFFLINE');
    expect(eventArg.payload.reason).toBe('STREAM_STALLED');
  });

  it('wires StorageSentinelService to ingestEvent on pinned storage exhaustion', async () => {
    // Return 0 unpinned segments -> triggers PINNED_STORAGE_EXHAUSTION
    (prisma.recordingSegment.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.tenant.findMany as jest.Mock).mockResolvedValue([{ id: 'tenant-automation' }]);

    const sentinel = new StorageSentinelService(prisma as any);
    await sentinel.checkAndPurge(80, 70, 30 * 1024 * 1024 * 1024);

    expect(ingestSpy).toHaveBeenCalledTimes(1);
    const eventArg = ingestSpy.mock.calls[0][0];
    expect(eventArg.source).toBe('SYSTEM');
    expect(eventArg.type).toBe('SYSTEM_ALERT');
    expect(eventArg.severity).toBe('CRITICAL');
    expect(eventArg.payload.kind).toBe('SYSTEM_ALERT');
    expect(eventArg.payload.alertCode).toBe('PINNED_STORAGE_EXHAUSTION');
    // Alarms need a real tenant row (the old 'system-appliance' pseudo-tenant violated the FK).
    expect(eventArg.tenantId).toBe('tenant-automation');
  });

  it('reports NON_RECORDING_STORAGE_EXHAUSTION (not "all pinned") when there are no finalized recordings', async () => {
    (prisma.recordingSegment.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.tenant.findMany as jest.Mock).mockResolvedValue([{ id: 'tenant-automation' }]);
    (prisma.recordingSegment as any).count = jest.fn().mockResolvedValue(0);
    try {
      const sentinel = new StorageSentinelService(prisma as any);
      await sentinel.checkAndPurge(80, 70, 30 * 1024 * 1024 * 1024);
      const eventArg = ingestSpy.mock.calls[0][0];
      expect(eventArg.payload.alertCode).toBe('NON_RECORDING_STORAGE_EXHAUSTION');
      expect(eventArg.payload.message).toMatch(/no finalized recordings to purge/);
    } finally {
      delete (prisma.recordingSegment as any).count;
    }
  });

  it('reports PINNED_STORAGE_EXHAUSTION with the pinned count when finalized recordings exist but none are purgeable', async () => {
    (prisma.recordingSegment.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.tenant.findMany as jest.Mock).mockResolvedValue([{ id: 'tenant-automation' }]);
    (prisma.recordingSegment as any).count = jest.fn().mockResolvedValue(12);
    try {
      const sentinel = new StorageSentinelService(prisma as any);
      await sentinel.checkAndPurge(80, 70, 30 * 1024 * 1024 * 1024);
      const eventArg = ingestSpy.mock.calls[0][0];
      expect(eventArg.payload.alertCode).toBe('PINNED_STORAGE_EXHAUSTION');
      expect(eventArg.payload.message).toMatch(/all 12 finalized recordings are pinned/);
    } finally {
      delete (prisma.recordingSegment as any).count;
    }
  });

  it('raises the storage alarm for every tenant, and for none (loudly) before bootstrap', async () => {
    (prisma.recordingSegment.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.tenant.findMany as jest.Mock).mockResolvedValue([{ id: 't1' }, { id: 't2' }]);
    await new StorageSentinelService(prisma as any).checkAndPurge(80, 70, 30 * 1024 * 1024 * 1024);
    expect(ingestSpy.mock.calls.map((c: any[]) => c[0].tenantId)).toEqual(['t1', 't2']);

    ingestSpy.mockClear();
    (prisma.tenant.findMany as jest.Mock).mockResolvedValue([]);
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await new StorageSentinelService(prisma as any).checkAndPurge(80, 70, 30 * 1024 * 1024 * 1024);
    expect(ingestSpy).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('no tenant exists yet'))).toBe(true);
    errSpy.mockRestore();
  });
});
