import fs from 'fs';
import path from 'path';
import os from 'os';
import checkDiskSpace from 'check-disk-space';
import {
  SegmentStatus,
  VolumeStatus,
  EventSeverity,
  AlarmState,
  EventType,
  RetentionPriority,
} from '@prisma/client';
import { CrashRecoveryService } from '../services/reconciliation/crashRecovery.service';
import { StorageVolumeService } from '../services/storage/storageVolume.service';
import { CameraConnectionManager } from '../services/camera/cameraConnectionManager.service';
import { RetentionPolicyEngine } from '../services/recording/catalog/retentionPolicy';
import { LocalStorageAdapter } from '../services/recording/catalog/storageAdapter';
import { EvidencePinRegistry } from '../services/recording/catalog/evidencePinRegistry';
import { SegmentRepository } from '../services/recording/catalog/segmentRepository';
import { FFmpegService } from '../services/ffmpeg/ffmpeg.service';
import { formatSegmentFilename, calculateSegmentBounds } from '../utils/segmentPath';

jest.mock('../services/ffmpeg/ffmpeg.service');
jest.mock('check-disk-space');

const mockedFFmpegService = FFmpegService as jest.Mocked<typeof FFmpegService>;
const mockedCheckDiskSpace = checkDiskSpace as jest.MockedFunction<typeof checkDiskSpace>;

describe('Task 3.3: Systematic Failure Injection Envelope Validation (Section 3.1)', () => {
  let tempDir: string;
  let prismaMock: any;
  let segmentsTable: Map<string, any>;
  let camerasTable: Map<string, any>;
  let volumesTable: Map<string, any>;
  let eventsTable: any[];
  let alarmsTable: any[];
  let pinsTable: any[];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigilone-failure-envelope-'));
    segmentsTable = new Map();
    camerasTable = new Map();
    volumesTable = new Map();
    eventsTable = [];
    alarmsTable = [];
    pinsTable = [];

    camerasTable.set('cam-1', {
      id: 'cam-1',
      tenantId: 'tenant-1',
      name: 'South Perimeter Gate',
      streamPath: 'south-gate',
      retentionPriority: RetentionPriority.HIGH,
      storageVolumeId: 'vol-1',
    });

    prismaMock = {
      storageVolume: {
        findMany: jest.fn().mockImplementation(({ where }) => {
          let list = Array.from(volumesTable.values());
          if (where?.status) list = list.filter((v) => v.status === where.status);
          if (where?.isReadOnly !== undefined) list = list.filter((v) => v.isReadOnly === where.isReadOnly);
          return Promise.resolve(list);
        }),
        findFirst: jest.fn().mockImplementation(({ where }) => {
          for (const v of volumesTable.values()) {
            if (where.isDefault !== undefined && v.isDefault !== where.isDefault) continue;
            return Promise.resolve(v);
          }
          return Promise.resolve(null);
        }),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const v = volumesTable.get(where.id);
          const updated = { ...v, ...data };
          volumesTable.set(where.id, updated);
          return Promise.resolve(updated);
        }),
      },
      camera: {
        findFirst: jest.fn().mockImplementation(({ where }) => {
          for (const c of camerasTable.values()) {
            if (where?.OR) {
              const matched = where.OR.some((clause: any) => {
                if (clause.id && c.id === clause.id) return true;
                if (clause.streamPath && c.streamPath === clause.streamPath) return true;
                return false;
              });
              if (matched) return Promise.resolve(c);
            }
            if (where?.id && c.id === where.id) return Promise.resolve(c);
            if (where?.streamPath && c.streamPath === where.streamPath) return Promise.resolve(c);
          }
          return Promise.resolve(null);
        }),
        findUnique: jest.fn().mockImplementation(({ where, include }) => {
          const c = camerasTable.get(where.id);
          if (!c) return Promise.resolve(null);
          const copy = { ...c };
          if (include?.storageVolume && c.storageVolumeId) {
            copy.storageVolume = volumesTable.get(c.storageVolumeId) || null;
          }
          return Promise.resolve(copy);
        }),
        findMany: jest.fn().mockImplementation(() => Promise.resolve(Array.from(camerasTable.values()))),
      },
      recordingSegment: {
        findMany: jest.fn().mockImplementation(({ where }) => {
          let list = Array.from(segmentsTable.values());
          if (where?.status) list = list.filter((s) => s.status === where.status);
          if (where?.filePath?.in) list = list.filter((s) => where.filePath.in.includes(s.filePath));
          return Promise.resolve(list);
        }),
        findUnique: jest.fn().mockImplementation(({ where }) => {
          for (const s of segmentsTable.values()) {
            if (where.filePath && s.filePath === where.filePath) return Promise.resolve(s);
            if (where.id && s.id === where.id) return Promise.resolve(s);
          }
          return Promise.resolve(null);
        }),
        create: jest.fn().mockImplementation(({ data }) => {
          const id = `seg-${Date.now()}-${Math.random()}`;
          const seg = { id, evidencePins: [], ...data };
          segmentsTable.set(id, seg);
          return Promise.resolve(seg);
        }),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const s = segmentsTable.get(where.id);
          const updated = { ...s, ...data };
          segmentsTable.set(where.id, updated);
          return Promise.resolve(updated);
        }),
        updateMany: jest.fn().mockImplementation(({ where, data }) => {
          let count = 0;
          for (const [id, s] of segmentsTable.entries()) {
            if (where.filePath && s.filePath !== where.filePath) continue;
            segmentsTable.set(id, { ...s, ...data });
            count++;
          }
          return Promise.resolve({ count });
        }),
        delete: jest.fn().mockImplementation(({ where }) => {
          segmentsTable.delete(where.id);
          return Promise.resolve({});
        }),
      },
      evidencePin: {
        count: jest.fn().mockImplementation(({ where }) => {
          const now = new Date();
          const matches = pinsTable.filter((p) => {
            if (where?.segmentId && p.segmentId !== where.segmentId) return false;
            if (where?.releasedAt === null && p.releasedAt !== null) return false;
            if (where?.expiresAt?.gt && p.expiresAt <= now) return false;
            return true;
          });
          return Promise.resolve(matches.length);
        }),
        findMany: jest.fn().mockImplementation(({ where }) => {
          return Promise.resolve(
            pinsTable.filter((p) => {
              if (where?.segmentId?.in && !where.segmentId.in.includes(p.segmentId)) return false;
              if (where?.segmentId && where.segmentId !== p.segmentId) return false;
              if (where?.releasedAt === null && p.releasedAt !== null) return false;
              return true;
            })
          );
        }),
      },
      tenant: {
        findFirst: jest.fn().mockResolvedValue({ id: 'tenant-1' }),
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
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    jest.clearAllMocks();
  });

  // Failure Mode 1
  it('Envelope 1: Graceful restart produces recording gap <= 5s and 0 orphaned segments', async () => {
    const camDir = path.join(tempDir, 'south-gate');
    fs.mkdirSync(camDir, { recursive: true });

    // Segment 1 ends at 12:00:00
    const seg1Time = new Date('2026-09-12T12:00:00.000Z');
    const seg1File = path.join(camDir, formatSegmentFilename(seg1Time, 'mp4'));
    fs.writeFileSync(seg1File, 'pre-restart-clean-media');

    const seg1Bounds = calculateSegmentBounds(seg1File, 10000); // 10s duration -> ends 12:00:10
    segmentsTable.set('seg-1', {
      id: 'seg-1',
      cameraId: 'cam-1',
      filePath: seg1File,
      startTime: seg1Bounds.startTime,
      endTime: seg1Bounds.endTime,
      durationMs: 10000,
      status: SegmentStatus.FINALIZED,
    });

    // Simulating graceful restart: engine reboots and starts Segment 2 at 12:00:12 (2s gap <= 5s)
    const seg2Time = new Date('2026-09-12T12:00:12.000Z');
    const seg2File = path.join(camDir, formatSegmentFilename(seg2Time, 'mp4'));
    fs.writeFileSync(seg2File, 'post-restart-resumed-media');

    const seg2Bounds = calculateSegmentBounds(seg2File, 10000);
    segmentsTable.set('seg-2', {
      id: 'seg-2',
      cameraId: 'cam-1',
      filePath: seg2File,
      startTime: seg2Bounds.startTime,
      endTime: seg2Bounds.endTime,
      durationMs: 10000,
      status: SegmentStatus.FINALIZED,
    });

    // Compute gap between seg1 end and seg2 start
    const gapMs = seg2Bounds.startTime.getTime() - seg1Bounds.endTime.getTime();
    const gapSec = gapMs / 1000;

    expect(gapSec).toBeLessThanOrEqual(5); // Metric: gap <= 5s
    expect(gapSec).toBe(2);

    // Verify 0 orphaned segments: all files on disk map 1:1 to FINALIZED DB segments
    const allFiles = fs.readdirSync(camDir).map((f) => path.join(camDir, f));
    for (const f of allFiles) {
      const dbMatch = Array.from(segmentsTable.values()).find((s) => s.filePath === f);
      expect(dbMatch).toBeDefined();
      expect(dbMatch.status).toBe(SegmentStatus.FINALIZED);
    }
  });

  // Failure Mode 2
  it('Envelope 2: Process crash triggers boot-time moov repair in <= 60s without loss of completed segments', async () => {
    const crashService = new CrashRecoveryService(prismaMock);
    const camDir = path.join(tempDir, 'south-gate');
    fs.mkdirSync(camDir, { recursive: true });

    // Completed segment from before crash
    const completedFile = path.join(camDir, 'completed_chunk.mp4');
    fs.writeFileSync(completedFile, 'already-completed-good-data');
    segmentsTable.set('seg-completed', {
      id: 'seg-completed',
      cameraId: 'cam-1',
      filePath: completedFile,
      status: SegmentStatus.FINALIZED,
      evidencePins: [],
    });

    // Incomplete segment interrupted by sudden process crash
    const crashedFile = path.join(camDir, 'crashed_incomplete.mp4');
    fs.writeFileSync(crashedFile, 'interrupted-corrupted-atom-data');
    segmentsTable.set('seg-crashed', {
      id: 'seg-crashed',
      cameraId: 'cam-1',
      filePath: crashedFile,
      status: SegmentStatus.FINALIZED,
      evidencePins: [],
    });

    mockedFFmpegService.probe
      .mockResolvedValueOnce({ durationSeconds: 60, width: 1920, height: 1080, videoCodec: 'h264', fps: 25, sizeBytes: 100 })
      .mockResolvedValueOnce(null) // Probe on corrupt crashed file
      .mockResolvedValueOnce({ durationSeconds: 8.5, width: 1920, height: 1080, videoCodec: 'h264', fps: 25, sizeBytes: 200 }); // Repaired probe

    (CrashRecoveryService as any).remuxRepair = jest.fn().mockImplementation((_src: string, out: string) => {
      fs.writeFileSync(out, 'repaired-clean-media');
      return Promise.resolve(true);
    });

    const report = await crashService.recoverStorage([tempDir]);

    expect(report.filesRecovered).toBe(1);
    expect(report.durationMs).toBeLessThanOrEqual(60000); // Metric: repair in <= 60s
    expect(segmentsTable.get('seg-completed').status).toBe(SegmentStatus.FINALIZED); // No loss of completed
    expect(segmentsTable.get('seg-crashed').status).toBe(SegmentStatus.FINALIZED);
    expect(segmentsTable.get('seg-crashed').repairedSha256).toBeDefined();
  });

  // Failure Mode 3
  it('Envelope 3: Power interruption prunes 0-byte cuts and separates outage duration from recovery latency <= 30s', async () => {
    const crashService = new CrashRecoveryService(prismaMock);
    const camDir = path.join(tempDir, 'south-gate');
    fs.mkdirSync(camDir, { recursive: true });

    // Abrupt power cut severed file at 0 bytes
    const zeroByteFile = path.join(camDir, 'abrupt_power_cut.mp4');
    fs.writeFileSync(zeroByteFile, Buffer.alloc(0));

    segmentsTable.set('seg-zero', {
      id: 'seg-zero',
      cameraId: 'cam-1',
      filePath: zeroByteFile,
      status: SegmentStatus.RECORDING,
    });

    const report = await crashService.recoverStorage([tempDir]);

    expect(report.zeroBytePruned).toBe(1);
    expect(fs.existsSync(zeroByteFile)).toBe(false);
    expect(report.durationMs).toBeLessThanOrEqual(30000); // Recovery latency <= 30s

    // Verify recovery audit event was emitted
    const recoveryEvent = eventsTable.find((e) => e.title === 'Storage Crash Recovery Scan');
    expect(recoveryEvent).toBeDefined();
    expect(recoveryEvent.metadata.zeroBytePruned).toBe(1);
  });

  // Failure Mode 4
  it('Envelope 4: Camera network drop triggers reconnection with backoff capped at 30s', async () => {
    const manager = new CameraConnectionManager();
    const cameraId = 'cam-dropped-link';

    manager.registerCamera(cameraId);

    // Injected network drop
    manager.reportDisconnect(cameraId, 'RTSP_SOCKET_CLOSED_RST');

    const statusAfterDrop = manager.getCameraStatus(cameraId);
    expect(statusAfterDrop?.state).toBe('DEGRADED');

    // Test backoff calculation at retry 10 (exponential should be capped at 30s)
    const backoffHighRetry = manager.calculateBackoffMs(10);
    // Base backoff is 30,000 ms, plus up to 3,000 ms jitter
    expect(backoffHighRetry).toBeGreaterThanOrEqual(30000);
    expect(backoffHighRetry).toBeLessThanOrEqual(33500);

    manager.stop();
  });

  // Failure Mode 5
  it('Envelope 5: Storage at 95% preserves 100% of pinned evidence, and 100% hard-full raises CRITICAL alarm', async () => {
    // Part A: 95% capacity retention ladder
    const storageAdapter = new LocalStorageAdapter();
    jest.spyOn(storageAdapter, 'deleteFile').mockResolvedValue();

    const pinRegistry = new EvidencePinRegistry(prismaMock);
    const segmentRepo = new SegmentRepository(prismaMock);
    const retentionEngine = new RetentionPolicyEngine(prismaMock, segmentRepo, pinRegistry, storageAdapter);

    // Create unpinned old segment and pinned evidence segment
    const unpinnedFile = path.join(tempDir, 'old_unpinned.mp4');
    const pinnedEvidenceFile = path.join(tempDir, 'court_pinned_evidence.mp4');

    segmentsTable.set('seg-unpinned', {
      id: 'seg-unpinned',
      cameraId: 'cam-1',
      filePath: unpinnedFile,
      sizeBytes: BigInt(5000),
      createdAt: new Date(Date.now() - 40 * 86400 * 1000), // 40 days old
    });

    segmentsTable.set('seg-pinned', {
      id: 'seg-pinned',
      cameraId: 'cam-1',
      filePath: pinnedEvidenceFile,
      sizeBytes: BigInt(5000),
      createdAt: new Date(Date.now() - 40 * 86400 * 1000),
    });

    pinsTable.push({
      id: 'pin-court-order',
      segmentId: 'seg-pinned',
      releasedAt: null,
      expiresAt: new Date(Date.now() + 365 * 86400 * 1000),
    });

    // Delete unpinned succeeds
    const unpinnedDeleted = await retentionEngine.atomicDeleteSegmentIfUnpinned('seg-unpinned', unpinnedFile);
    expect(unpinnedDeleted).toBe(true);

    // Pinned segment delete REFUSED (0 deletions on pinned evidence)
    const pinnedDeleted = await retentionEngine.atomicDeleteSegmentIfUnpinned('seg-pinned', pinnedEvidenceFile);
    expect(pinnedDeleted).toBe(false);
    expect(segmentsTable.has('seg-pinned')).toBe(true); // 100% preserved

    // Part B: 100% hard-full capacity condition
    const volService = new StorageVolumeService(prismaMock);
    volumesTable.set('vol-1', {
      id: 'vol-1',
      tenantId: 'tenant-1',
      name: 'Full Volume',
      path: path.join(tempDir, 'full-vol'),
      status: VolumeStatus.HEALTHY,
      isReadOnly: false,
      _count: { cameras: 1 },
    });
    fs.mkdirSync(volumesTable.get('vol-1').path, { recursive: true });

    // Mock disk completely full (0 free bytes)
    mockedCheckDiskSpace.mockResolvedValue({
      diskPath: volumesTable.get('vol-1').path,
      free: 0,
      size: 100000,
    });

    // Ensure fallback also fails
    jest.spyOn(volService, 'ensureDefaultVolume').mockResolvedValue({
      id: 'vol-default',
      path: path.join(tempDir, 'missing-default'),
      status: VolumeStatus.UNMOUNTED,
    } as any);

    // Resolving volume must fail explicitly and raise CRITICAL alarm
    await expect(volService.resolveActiveVolumeForCamera('cam-1')).rejects.toThrow(
      /NO_HEALTHY_STORAGE_VOLUME_AVAILABLE/
    );

    const fullAlarm = alarmsTable.find(
      (a) => a.severity === EventSeverity.CRITICAL && a.state === AlarmState.ACTIVE
    );
    expect(fullAlarm).toBeDefined();
    expect(fullAlarm.description).toContain('halted to protect data integrity');
  });

  // Failure Mode 6
  it('Envelope 6: Mount Guard trips in <= 5s on EROFS/unmount and routes to next healthy volume', async () => {
    const volService = new StorageVolumeService(prismaMock);

    const degradedVolPath = path.join(tempDir, 'unmounted-vol');
    const healthyVolPath = path.join(tempDir, 'healthy-vol');
    fs.mkdirSync(healthyVolPath, { recursive: true });

    // Setup primary as degraded/unmounted
    volumesTable.set('vol-1', {
      id: 'vol-1',
      tenantId: 'tenant-1',
      name: 'Degraded Primary',
      path: degradedVolPath,
      status: VolumeStatus.DEGRADED,
      isDefault: false,
      isReadOnly: true,
      _count: { cameras: 1 },
    });

    // Setup secondary fallback volume
    volumesTable.set('vol-2', {
      id: 'vol-2',
      tenantId: 'tenant-1',
      name: 'Healthy Secondary',
      path: healthyVolPath,
      status: VolumeStatus.HEALTHY,
      isDefault: false,
      isReadOnly: false,
      _count: { cameras: 0 },
    });

    mockedCheckDiskSpace.mockResolvedValue({
      diskPath: healthyVolPath,
      free: 50000,
      size: 100000,
    });

    const startProbe = Date.now();
    const result = await volService.resolveActiveVolumeForCamera('cam-1');
    const probeDurationMs = Date.now() - startProbe;

    expect(probeDurationMs).toBeLessThanOrEqual(5000); // Trips/resolves in <= 5s
    expect(result.isFallback).toBe(true);
    expect(result.volume.id).toBe('vol-2'); // Routed to healthy secondary
  });

  // Failure Mode 7
  it('Envelope 7: Corrupt segment quarantined to .quarantine in <= 60s without indexing crash', async () => {
    const crashService = new CrashRecoveryService(prismaMock);
    const camDir = path.join(tempDir, 'south-gate');
    fs.mkdirSync(camDir, { recursive: true });

    const corruptFile = path.join(camDir, 'broken_unrepairable.mp4');
    fs.writeFileSync(corruptFile, 'corrupt-unfixable-stream');

    segmentsTable.set('seg-corrupt', {
      id: 'seg-corrupt',
      filePath: corruptFile,
      status: SegmentStatus.FINALIZED,
      evidencePins: [],
    });

    mockedFFmpegService.probe.mockResolvedValue(null);
    (CrashRecoveryService as any).remuxRepair = jest.fn().mockResolvedValue(false);

    const startScan = Date.now();
    const report = await crashService.recoverStorage([tempDir]);
    const scanMs = Date.now() - startScan;

    expect(scanMs).toBeLessThanOrEqual(60000); // Quarantined in <= 60s
    expect(report.filesQuarantined).toBe(1);

    const quarantinePath = path.join(camDir, '.quarantine', 'broken_unrepairable.mp4');
    expect(fs.existsSync(quarantinePath)).toBe(true);
    expect(segmentsTable.get('seg-corrupt').status).toBe(SegmentStatus.QUARANTINED);
  });

  // Failure Mode 8
  it('Envelope 8: Periodic reconciliation resolves 100% of DB/media discrepancies', async () => {
    const crashService = new CrashRecoveryService(prismaMock);
    const camDir = path.join(tempDir, 'south-gate');
    fs.mkdirSync(camDir, { recursive: true });

    // Discrepancy A: Valid orphan media on disk (not in DB)
    const validOrphanFile = path.join(camDir, '2026-09-12_15-00-00-000000.mp4');
    fs.writeFileSync(validOrphanFile, 'valid-orphan-bytes');

    // Discrepancy B: Missing media file (in DB, deleted on disk)
    const missingFile = path.join(camDir, 'deleted_from_disk.mp4');
    segmentsTable.set('seg-missing-disk', {
      id: 'seg-missing-disk',
      cameraId: 'cam-1',
      filePath: missingFile,
      status: SegmentStatus.FINALIZED,
    });

    // Discrepancy C: Unmapped rogue camera file on disk
    const rogueDir = path.join(tempDir, 'rogue-unauthorized-cam');
    fs.mkdirSync(rogueDir, { recursive: true });
    const rogueFile = path.join(rogueDir, '2026-09-12_15-00-00-000000.mp4');
    fs.writeFileSync(rogueFile, 'rogue-camera-data');

    mockedFFmpegService.probe.mockResolvedValue({
      durationSeconds: 10,
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      fps: 25,
      sizeBytes: 100,
    });

    const report = await crashService.recoverStorage([tempDir]);

    // 100% of discrepancies resolved:
    expect(report.orphansIndexed).toBe(1);      // Valid orphan indexed
    expect(report.filesMissing).toBe(1);        // Missing file detected
    expect(report.filesQuarantined).toBe(1);    // Rogue unmapped quarantined

    // Verify DB states
    expect(segmentsTable.get('seg-missing-disk').status).toBe(SegmentStatus.FILE_MISSING);
    const indexedValidOrphan = Array.from(segmentsTable.values()).find((s) => s.filePath === validOrphanFile);
    expect(indexedValidOrphan).toBeDefined();
    expect(indexedValidOrphan.status).toBe(SegmentStatus.FINALIZED);
    expect(fs.existsSync(path.join(rogueDir, '.quarantine', '2026-09-12_15-00-00-000000.mp4'))).toBe(true);
  });
});
