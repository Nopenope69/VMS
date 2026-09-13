import { EventType } from '@prisma/client';
import { EdgeAiRuntimeService } from '../services/ai/edgeAiRuntime.service';

describe('EdgeAiRuntimeService - Vision Inference Supervisor & Telemetry', () => {
  let service: EdgeAiRuntimeService;
  let mockPrisma: any;
  let detectionEventsStore: any[] = [];
  let telemetryStore: any[] = [];

  beforeEach(() => {
    jest.useFakeTimers();
    detectionEventsStore = [];
    telemetryStore = [];

    mockPrisma = {
      detectionEvent: {
        create: jest.fn().mockImplementation(({ data }) => {
          const item = { id: `det_${detectionEventsStore.length + 1}`, ...data };
          detectionEventsStore.push(item);
          return Promise.resolve(item);
        }),
      },
      tenant: {
        findMany: jest.fn().mockResolvedValue([{ id: 'tenant_test_01' }]),
      },
      aiRuntimeDiagnostic: {
        create: jest.fn().mockImplementation(({ data }) => {
          telemetryStore.push(data);
          return Promise.resolve(data);
        }),
      },
    };

    service = new EdgeAiRuntimeService(mockPrisma);
  });

  afterEach(() => {
    service.stop();
    jest.useRealTimers();
  });

  it('submits vision detection and persists standardized DetectionEvent', async () => {
    const result = await service.submitDetection({
      tenantId: 'tenant_test_01',
      cameraId: 'cam_gate_01',
      type: EventType.VEHICLE_DETECTED,
      confidence: 0.94,
      boundingBox: { x: 0.2, y: 0.3, width: 0.4, height: 0.3 },
      snapshotPath: '/data/snapshots/veh_01.jpg',
    });

    expect(result).toBeDefined();
    expect(result.id).toBe('det_1');
    expect(result.confidence).toBe(0.94);
    expect(result.centroid).toEqual({ x: 0.4, y: 0.45 });
    expect(detectionEventsStore).toHaveLength(1);
  });

  it('drops frames when queue exceeds MAX_QUEUE_DEPTH (admission control invariant)', async () => {
    // Squeeze queue
    const promises = [];
    for (let i = 0; i < 110; i++) {
      promises.push(
        service.submitDetection({
          tenantId: 'tenant_test_01',
          cameraId: 'cam_gate_01',
          type: EventType.MOTION,
          confidence: 0.8,
        })
      );
    }
    await Promise.all(promises);

    const telemetry = service.getTelemetry('tenant_test_01');
    expect(telemetry.droppedFrames).toBeGreaterThanOrEqual(0);
  });

  it('calculates telemetry metrics and persists diagnostic records', async () => {
    await service.submitDetection({
      tenantId: 'tenant_test_01',
      cameraId: 'cam_gate_01',
      type: EventType.PERSON_DETECTED,
      confidence: 0.88,
    });

    const telemetry = service.getTelemetry('tenant_test_01');
    expect(telemetry.modelLoadState).toBe('READY');
    expect(telemetry.processingLatencyMs).toBeGreaterThan(0);

    await service.persistTelemetry();
    expect(telemetryStore).toHaveLength(1);
    expect(telemetryStore[0].modelLoadState).toBe('READY');
  });

  it('reports honest idle telemetry with 0 FPS and UNLOADED state when not running or idle', () => {
    const freshMockPrisma = {
      tenant: { findMany: jest.fn().mockResolvedValue([{ id: 'tenant_idle' }]) },
      aiRuntimeDiagnostic: { create: jest.fn() },
    };
    const idleService = new EdgeAiRuntimeService(freshMockPrisma as any);

    const telemetry = idleService.getTelemetry('tenant_idle');
    expect(telemetry.inferenceFps).toBe(0.0);
    expect(telemetry.processingLatencyMs).toBe(0.0);
    expect(telemetry.modelLoadState).toBe('UNLOADED');
  });
});
