import { RecordingMode, DegradationReason } from '@prisma/client';
import { StorageDegradeManagerService } from '../services/storage/storageDegradeManager.service';
import checkDiskSpace from 'check-disk-space';

jest.mock('check-disk-space');
const mockedCheckDiskSpace = checkDiskSpace as jest.MockedFunction<typeof checkDiskSpace>;

describe('Phase 2: StorageDegradeManagerService & Adaptive Ingestion', () => {
  let prismaMock: any;
  let camerasTable: Map<string, any>;
  let eventsTable: any[];
  let alarmsTable: any[];
  let service: StorageDegradeManagerService;

  beforeEach(() => {
    camerasTable = new Map();
    eventsTable = [];
    alarmsTable = [];

    // Setup 3 cameras: Low, Normal, High priority all configured as CONTINUOUS
    camerasTable.set('cam-low', {
      id: 'cam-low',
      name: 'Corridor',
      tenantId: 'tenant-1',
      retentionPriority: 'LOW',
      recordingMode: RecordingMode.CONTINUOUS,
      effectiveRecordingMode: RecordingMode.CONTINUOUS,
      degradationReason: DegradationReason.NONE,
      degradationSince: null,
      recorderState: 'RUNNING',
    });

    camerasTable.set('cam-norm', {
      id: 'cam-norm',
      name: 'Main Entrance',
      tenantId: 'tenant-1',
      retentionPriority: 'NORMAL',
      recordingMode: RecordingMode.CONTINUOUS,
      effectiveRecordingMode: RecordingMode.CONTINUOUS,
      degradationReason: DegradationReason.NONE,
      degradationSince: null,
      recorderState: 'RUNNING',
    });

    camerasTable.set('cam-high', {
      id: 'cam-high',
      name: 'Vault',
      tenantId: 'tenant-1',
      retentionPriority: 'HIGH',
      recordingMode: RecordingMode.CONTINUOUS,
      effectiveRecordingMode: RecordingMode.CONTINUOUS,
      degradationReason: DegradationReason.NONE,
      degradationSince: null,
      recorderState: 'RUNNING',
    });

    prismaMock = {
      recordingSegment: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { sizeBytes: 50n * 1024n * 1024n * 1024n } }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      camera: {
        count: jest.fn().mockImplementation((args?: any) => {
          const where = args?.where;
          let list = Array.from(camerasTable.values());
          if (where?.degradationReason?.not) {
            list = list.filter((c) => c.degradationReason !== where.degradationReason.not);
          }
          if (where?.recorderState) {
            list = list.filter((c) => c.recorderState === where.recorderState);
          }
          return Promise.resolve(list.length);
        }),
        findMany: jest.fn().mockImplementation(({ where }) => {
          let list = Array.from(camerasTable.values());
          if (where?.degradationReason?.not) {
            list = list.filter((c) => c.degradationReason !== where.degradationReason.not);
          }
          return Promise.resolve(list);
        }),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const cam = camerasTable.get(where.id);
          const updated = { ...cam, ...data };
          camerasTable.set(where.id, updated);
          return Promise.resolve(updated);
        }),
        updateMany: jest.fn().mockImplementation(({ where, data }) => {
          let count = 0;
          for (const [id, cam] of camerasTable.entries()) {
            if (where.retentionPriority && cam.retentionPriority !== where.retentionPriority) continue;
            if (where.recordingMode && cam.recordingMode !== where.recordingMode) continue;
            camerasTable.set(id, { ...cam, ...data });
            count++;
          }
          return Promise.resolve({ count });
        }),
      },
      tenant: {
        findMany: jest.fn().mockResolvedValue([{ id: 'tenant-1' }]),
      },
      event: {
        create: jest.fn().mockImplementation(({ data }) => {
          eventsTable.push(data);
          return Promise.resolve(data);
        }),
      },
      alarm: {
        create: jest.fn().mockImplementation(({ data }) => {
          alarmsTable.push(data);
          return Promise.resolve(data);
        }),
      },
    };

    service = new StorageDegradeManagerService(prismaMock);
  });

  it('calculates write rate and triggers CRITICAL adaptive degradation without modifying configured recordingMode', async () => {
    // Mock disk with 92% used (8% free -> triggers CRITICAL)
    mockedCheckDiskSpace.mockResolvedValueOnce({
      diskPath: '/recordings',
      size: 1000 * 1024 * 1024 * 1024, // 1000 GB
      free: 80 * 1024 * 1024 * 1024,   // 80 GB (8% free)
    });

    const analysis = await service.evaluateStorageVitals('/recordings');

    expect(analysis.state).toBe('CRITICAL');
    expect(analysis.projectedExhaustionHours).toBeDefined();

    // Verify camera adaptations:
    // Low priority camera: effectiveRecordingMode must be MOTION, but configured recordingMode must stay CONTINUOUS
    const lowCam = camerasTable.get('cam-low');
    expect(lowCam.effectiveRecordingMode).toBe(RecordingMode.MOTION);
    expect(lowCam.recordingMode).toBe(RecordingMode.CONTINUOUS);
    expect(lowCam.degradationReason).toBe(DegradationReason.STORAGE_PRESSURE_CRITICAL);

    // Normal priority camera: effectiveRecordingMode must be MOTION
    const normCam = camerasTable.get('cam-norm');
    expect(normCam.effectiveRecordingMode).toBe(RecordingMode.MOTION);
    expect(normCam.recordingMode).toBe(RecordingMode.CONTINUOUS);

    // High priority camera: must remain CONTINUOUS under CRITICAL
    const highCam = camerasTable.get('cam-high');
    expect(highCam.effectiveRecordingMode).toBe(RecordingMode.CONTINUOUS);

    // Verify audit event
    expect(eventsTable.some((e) => e.type === 'STORAGE_DEGRADED_MODE_ACTIVE')).toBe(true);
  });

  it('restores configured recording mode when storage pressure clears (hysteresis recovery)', async () => {
    // 1. Enter CRITICAL state
    mockedCheckDiskSpace.mockResolvedValueOnce({
      diskPath: '/recordings',
      size: 1000 * 1024 * 1024 * 1024,
      free: 80 * 1024 * 1024 * 1024, // 8% free
    });
    await service.evaluateStorageVitals('/recordings');
    expect(service.getState()).toBe('CRITICAL');

    // 2. Clear disk pressure (e.g. 600 GB free -> 72h exhaustion -> AVAILABLE)
    mockedCheckDiskSpace.mockResolvedValueOnce({
      diskPath: '/recordings',
      size: 1000 * 1024 * 1024 * 1024,
      free: 600 * 1024 * 1024 * 1024, // 60% free (>48h projected)
    });
    const recoveredAnalysis = await service.evaluateStorageVitals('/recordings');

    expect(recoveredAnalysis.state).toBe('AVAILABLE');

    // Verify all cameras restored
    const lowCam = camerasTable.get('cam-low');
    expect(lowCam.effectiveRecordingMode).toBe(RecordingMode.CONTINUOUS);
    expect(lowCam.degradationReason).toBe(DegradationReason.NONE);
    expect(lowCam.degradationSince).toBeNull();

    expect(eventsTable.some((e) => e.type === 'STORAGE_DEGRADED_MODE_CLEARED')).toBe(true);
  });
});
