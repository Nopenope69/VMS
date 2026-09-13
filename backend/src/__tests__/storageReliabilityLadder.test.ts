import fs from 'fs';
import path from 'path';
import os from 'os';
import checkDiskSpace from 'check-disk-space';
import { SegmentStatus, VolumeStatus, EventSeverity, AlarmState, EventType } from '@prisma/client';
import { CrashRecoveryService } from '../services/reconciliation/crashRecovery.service';
import { StorageVolumeService } from '../services/storage/storageVolume.service';
import { FFmpegService } from '../services/ffmpeg/ffmpeg.service';
import { formatSegmentFilename } from '../utils/segmentPath';

jest.mock('../services/ffmpeg/ffmpeg.service');
jest.mock('check-disk-space');

const mockedFFmpegService = FFmpegService as jest.Mocked<typeof FFmpegService>;
const mockedCheckDiskSpace = checkDiskSpace as jest.MockedFunction<typeof checkDiskSpace>;

describe('Task 2.4: Storage Reliability & 4-State Reconciliation Ladder (C-018)', () => {
  let tempDir: string;
  let prismaMock: any;
  let segmentsTable: Map<string, any>;
  let camerasTable: Map<string, any>;
  let volumesTable: Map<string, any>;
  let eventsTable: any[];
  let alarmsTable: any[];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigilone-storage-ladder-test-'));
    segmentsTable = new Map();
    camerasTable = new Map();
    volumesTable = new Map();
    eventsTable = [];
    alarmsTable = [];

    // Setup standard mock camera
    camerasTable.set('cam-1', {
      id: 'cam-1',
      tenantId: 'tenant-alpha',
      name: 'North Gate Camera',
      streamPath: 'north-gate',
      storageVolumeId: 'vol-primary',
      storageVolume: null,
    });

    prismaMock = {
      storageVolume: {
        findMany: jest.fn().mockImplementation(({ where }) => {
          let list = Array.from(volumesTable.values());
          if (where?.tenantId) list = list.filter((v) => v.tenantId === where.tenantId);
          if (where?.status) list = list.filter((v) => v.status === where.status);
          if (where?.isReadOnly !== undefined) list = list.filter((v) => v.isReadOnly === where.isReadOnly);
          return Promise.resolve(list);
        }),
        findFirst: jest.fn().mockImplementation(({ where }) => {
          for (const v of volumesTable.values()) {
            if (where.tenantId && v.tenantId !== where.tenantId) continue;
            if (where.isDefault !== undefined && v.isDefault !== where.isDefault) continue;
            if (where.path && v.path !== where.path) continue;
            return Promise.resolve(v);
          }
          return Promise.resolve(null);
        }),
        findUnique: jest.fn().mockImplementation(({ where }) => {
          return Promise.resolve(volumesTable.get(where.id) || null);
        }),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const v = volumesTable.get(where.id);
          const updated = { ...v, ...data };
          volumesTable.set(where.id, updated);
          return Promise.resolve(updated);
        }),
        upsert: jest.fn().mockImplementation(({ where, create, update }) => {
          let existing = null;
          for (const v of volumesTable.values()) {
            if (where.path && v.path === where.path) existing = v;
          }
          if (existing) {
            const updated = { ...existing, ...update };
            volumesTable.set(existing.id, updated);
            return Promise.resolve(updated);
          }
          const created = { id: 'vol-default', ...create };
          volumesTable.set(created.id, created);
          return Promise.resolve(created);
        }),
      },
      camera: {
        findFirst: jest.fn().mockImplementation(({ where }) => {
          for (const c of camerasTable.values()) {
            if (where.OR) {
              const matched = where.OR.some((clause: any) => {
                if (clause.id && c.id === clause.id) return true;
                if (clause.streamPath && c.streamPath === clause.streamPath) return true;
                return false;
              });
              if (matched) return Promise.resolve(c);
            } else if (where.id && c.id === where.id) {
              return Promise.resolve(c);
            }
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
        update: jest.fn().mockImplementation(({ where, data }) => {
          const c = camerasTable.get(where.id);
          const updated = { ...c, ...data };
          camerasTable.set(where.id, updated);
          return Promise.resolve(updated);
        }),
      },
      recordingSegment: {
        findMany: jest.fn().mockImplementation(({ where }) => {
          let list = Array.from(segmentsTable.values());
          if (where?.status) list = list.filter((s) => s.status === where.status);
          if (where?.filePath?.in) {
            list = list.filter((s) => where.filePath.in.includes(s.filePath));
          }
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
      },
      tenant: {
        findFirst: jest.fn().mockResolvedValue({ id: 'tenant-alpha' }),
        findMany: jest.fn().mockResolvedValue([{ id: 'tenant-alpha' }]),
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

  describe('4-State Reconciliation Ladder', () => {
    it('State 1: quarantines unmapped orphan files that fail path admission control', async () => {
      const crashService = new CrashRecoveryService(prismaMock);
      const rogueCamDir = path.join(tempDir, 'unknown-unauthorized-camera');
      fs.mkdirSync(rogueCamDir, { recursive: true });

      const rogueFile = path.join(rogueCamDir, '2026-09-04_12-00-00-000000.mp4');
      fs.writeFileSync(rogueFile, 'rogue-camera-payload');

      mockedFFmpegService.probe.mockResolvedValueOnce({
        durationSeconds: 15,
        width: 1920,
        height: 1080,
        videoCodec: 'h264',
        fps: 25,
        sizeBytes: 100,
      });

      const report = await crashService.recoverStorage([tempDir]);

      expect(report.filesQuarantined).toBe(1);
      expect(report.orphansIndexed).toBe(0);
      expect(fs.existsSync(rogueFile)).toBe(false);

      const quarantinedPath = path.join(rogueCamDir, '.quarantine', '2026-09-04_12-00-00-000000.mp4');
      expect(fs.existsSync(quarantinedPath)).toBe(true);

      const warningEvent = eventsTable.find((e) => e.type === EventType.STORAGE_CORRUPT_SEGMENT_QUARANTINED);
      expect(warningEvent).toBeDefined();
      expect(warningEvent.title).toBe('Unmapped Recording Quarantined');
    });

    it('State 1: indexes valid orphan files on disk with filename-derived timestamps', async () => {
      const crashService = new CrashRecoveryService(prismaMock);
      const camDir = path.join(tempDir, 'north-gate');
      fs.mkdirSync(camDir, { recursive: true });

      const validTimestamp = new Date('2026-09-04T12:00:00.000Z');
      const filename = formatSegmentFilename(validTimestamp, 'mp4');
      const orphanFile = path.join(camDir, filename);
      fs.writeFileSync(orphanFile, 'valid-orphan-stream-bytes');

      // Tamper with mtime to confirm mtime is ignored
      const spoofedMtime = new Date('1999-01-01T00:00:00.000Z');
      fs.utimesSync(orphanFile, spoofedMtime, spoofedMtime);

      mockedFFmpegService.probe.mockResolvedValueOnce({
        durationSeconds: 10.0,
        width: 1920,
        height: 1080,
        videoCodec: 'h264',
        fps: 30,
        sizeBytes: 500,
      });

      const report = await crashService.recoverStorage([tempDir]);

      expect(report.orphansIndexed).toBe(1);
      expect(report.filesQuarantined).toBe(0);

      const createdSegment = Array.from(segmentsTable.values()).find((s) => s.filePath === orphanFile);
      expect(createdSegment).toBeDefined();
      expect(createdSegment.cameraId).toBe('cam-1');
      expect(createdSegment.tenantId).toBe('tenant-alpha');
      expect(createdSegment.startTime.getTime()).toBe(validTimestamp.getTime());
      expect(createdSegment.endTime.getTime()).toBe(validTimestamp.getTime() + 10000);
      expect(createdSegment.durationMs).toBe(10000);
      expect(createdSegment.status).toBe(SegmentStatus.FINALIZED);
      expect(createdSegment.sha256Hash).toBeDefined();
    });

    it('State 2: marks segments FILE_MISSING and raises warning when physical file is gone', async () => {
      const crashService = new CrashRecoveryService(prismaMock);
      const ghostPath = path.join(tempDir, 'north-gate', 'missing.mp4');

      segmentsTable.set('seg-ghost', {
        id: 'seg-ghost',
        cameraId: 'cam-1',
        tenantId: 'tenant-alpha',
        filePath: ghostPath,
        status: SegmentStatus.FINALIZED,
      });

      const report = await crashService.recoverStorage([tempDir]);

      expect(report.filesMissing).toBe(1);
      const seg = segmentsTable.get('seg-ghost');
      expect(seg.status).toBe(SegmentStatus.FILE_MISSING);
      expect(seg.quarantineReason).toBe('PHYSICAL_FILE_MISSING_ON_RECONCILE');

      const warningEvent = eventsTable.find(
        (e) => e.type === EventType.RECORDING_FAILURE && e.title === 'Recording Segment Missing from Disk'
      );
      expect(warningEvent).toBeDefined();
      expect(warningEvent.cameraId).toBe('cam-1');
    });

    it('State 3: preserves pinned original file upon non-destructive repair', async () => {
      const crashService = new CrashRecoveryService(prismaMock);
      const camDir = path.join(tempDir, 'north-gate');
      fs.mkdirSync(camDir, { recursive: true });

      const corruptFile = path.join(camDir, 'pinned_corrupt.mp4');
      fs.writeFileSync(corruptFile, 'corrupt-bytes-but-pinned');

      segmentsTable.set('seg-pinned-corrupt', {
        id: 'seg-pinned-corrupt',
        cameraId: 'cam-1',
        filePath: corruptFile,
        status: SegmentStatus.FINALIZED,
        evidencePins: [{ id: 'pin-123', releasedAt: null }],
      });

      mockedFFmpegService.probe
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          durationSeconds: 12.5,
          width: 1920,
          height: 1080,
          videoCodec: 'h264',
          fps: 25,
          sizeBytes: 1000,
        });

      (CrashRecoveryService as any).remuxRepair = jest
        .fn()
        .mockImplementation((_src: string, out: string) => {
          fs.writeFileSync(out, 'repaired-clean-fmp4');
          return Promise.resolve(true);
        });

      const report = await crashService.recoverStorage([tempDir]);

      expect(report.filesRecovered).toBe(1);
      // Pinned file: original must be preserved at .orig_corrupted
      expect(fs.existsSync(`${corruptFile}.orig_corrupted`)).toBe(true);
      expect(fs.readFileSync(`${corruptFile}.orig_corrupted`, 'utf8')).toBe('corrupt-bytes-but-pinned');
      // Repaired file is in place
      expect(fs.existsSync(corruptFile)).toBe(true);
      expect(fs.readFileSync(corruptFile, 'utf8')).toBe('repaired-clean-fmp4');

      const seg = segmentsTable.get('seg-pinned-corrupt');
      expect(seg.status).toBe(SegmentStatus.FINALIZED);
      expect(seg.originalSha256).toBeDefined();
      expect(seg.repairedSha256).toBeDefined();
      expect(seg.repairedAt).toBeDefined();
    });

    it('State 4: confirms valid DB/Media pairs and backfills missing hashes', async () => {
      const crashService = new CrashRecoveryService(prismaMock);
      const camDir = path.join(tempDir, 'north-gate');
      fs.mkdirSync(camDir, { recursive: true });

      const validFile = path.join(camDir, 'valid_existing.mp4');
      fs.writeFileSync(validFile, 'valid-media-payload-123');

      segmentsTable.set('seg-existing', {
        id: 'seg-existing',
        cameraId: 'cam-1',
        filePath: validFile,
        sizeBytes: BigInt(0), // Out of sync size
        sha256Hash: null,     // Missing hash
        status: SegmentStatus.FINALIZED,
        evidencePins: [],
      });

      mockedFFmpegService.probe.mockResolvedValueOnce({
        durationSeconds: 20,
        width: 1920,
        height: 1080,
        videoCodec: 'h264',
        fps: 30,
        sizeBytes: 23,
      });

      const report = await crashService.recoverStorage([tempDir]);

      expect(report.validPairsConfirmed).toBe(1);
      const seg = segmentsTable.get('seg-existing');
      expect(seg.sha256Hash).toBeDefined();
      expect(seg.sizeBytes).toBe(BigInt(Buffer.byteLength('valid-media-payload-123')));
    });
  });

  describe('Quarantine Accounting & 5% Volume Cap Invariant', () => {
    it('prunes unpinned quarantine files when cap is exceeded, but strictly protects pinned evidence', async () => {
      const crashService = new CrashRecoveryService(prismaMock);
      const qDir = path.join(tempDir, '.quarantine');
      fs.mkdirSync(qDir, { recursive: true });

      // Mock disk size = 10,000 bytes. 5% cap = 500 bytes.
      mockedCheckDiskSpace.mockResolvedValue({
        diskPath: tempDir,
        free: 5000,
        size: 10000,
      });

      // Create an unpinned quarantined file of 400 bytes (older)
      const unpinnedFile = path.join(qDir, 'old_unpinned.mp4');
      fs.writeFileSync(unpinnedFile, Buffer.alloc(400, 'u'));

      // Create a pinned quarantined file of 300 bytes (newer)
      const pinnedFile = path.join(qDir, 'evidence_pinned.mp4');
      fs.writeFileSync(pinnedFile, Buffer.alloc(300, 'p'));

      segmentsTable.set('seg-q-unpinned', {
        id: 'seg-q-unpinned',
        filePath: unpinnedFile,
        status: SegmentStatus.QUARANTINED,
        evidencePins: [],
      });

      segmentsTable.set('seg-q-pinned', {
        id: 'seg-q-pinned',
        filePath: pinnedFile,
        status: SegmentStatus.QUARANTINED,
        evidencePins: [{ id: 'pin-legal-1', releasedAt: null }],
      });

      // Total quarantine = 700 bytes > 500 bytes cap!
      const report = await crashService.recoverStorage([tempDir]);

      expect(report.quarantineCapExceeded).toBe(true);
      // The unpinned file must be pruned to reduce usage
      expect(fs.existsSync(unpinnedFile)).toBe(false);
      // The pinned file must NEVER be pruned
      expect(fs.existsSync(pinnedFile)).toBe(true);
      // Pinned file usage is 300 bytes, which is now <= 500 bytes cap, so no critical alarm needed
      expect(alarmsTable.length).toBe(0);
    });

    it('raises CRITICAL alarm when quarantine cap is exceeded and remaining items are pinned evidence', async () => {
      const crashService = new CrashRecoveryService(prismaMock);
      const qDir = path.join(tempDir, '.quarantine');
      fs.mkdirSync(qDir, { recursive: true });

      // Mock disk size = 10,000 bytes. 5% cap = 500 bytes.
      mockedCheckDiskSpace.mockResolvedValue({
        diskPath: tempDir,
        free: 2000,
        size: 10000,
      });

      // Create a pinned quarantined file of 700 bytes > 500 bytes cap
      const pinnedHugeFile = path.join(qDir, 'huge_evidence_pinned.mp4');
      fs.writeFileSync(pinnedHugeFile, Buffer.alloc(700, 'x'));

      segmentsTable.set('seg-q-huge', {
        id: 'seg-q-huge',
        filePath: pinnedHugeFile,
        status: SegmentStatus.QUARANTINED,
        evidencePins: [{ id: 'pin-murder-trial-evidence', releasedAt: null }],
      });

      const report = await crashService.recoverStorage([tempDir]);

      expect(report.quarantineCapExceeded).toBe(true);
      // Pinned file must NOT be deleted
      expect(fs.existsSync(pinnedHugeFile)).toBe(true);

      // Critical alarm must be raised
      const criticalAlarm = alarmsTable.find(
        (a) => a.severity === EventSeverity.CRITICAL && a.state === AlarmState.ACTIVE
      );
      expect(criticalAlarm).toBeDefined();
      expect(criticalAlarm.title).toBe('Quarantine Storage Cap Exceeded with Pinned Evidence');
    });
  });

  describe('StorageVolumeService & Mount Guard Trip Envelopes', () => {
    it('trips Mount Guard on read-only filesystem (EROFS) or unmounted directory', async () => {
      const volService = new StorageVolumeService(prismaMock);

      // Test 1: Non-existent path returns UNMOUNTED
      const nonExistentPath = path.join(tempDir, 'does-not-exist');
      const unmountedHealth = await volService.verifyMountHealth(nonExistentPath);
      expect(unmountedHealth.status).toBe(VolumeStatus.UNMOUNTED);

      // Test 2: Read-only simulation via chmod
      const roMountPath = path.join(tempDir, 'simulated-ro-mount');
      fs.mkdirSync(roMountPath, { recursive: true });
      fs.chmodSync(roMountPath, 0o444); // Read-only

      const roHealth = await volService.verifyMountHealth(roMountPath);
      expect([VolumeStatus.READ_ONLY, VolumeStatus.DEGRADED]).toContain(roHealth.status);

      // Restore permissions for cleanup
      fs.chmodSync(roMountPath, 0o777);
    });

    it('falls back to secondary healthy volume when primary volume is degraded', async () => {
      const volService = new StorageVolumeService(prismaMock);

      const primaryPath = path.join(tempDir, 'vol-primary-degraded');
      // Primary is not created -> unmounted/degraded
      volumesTable.set('vol-primary', {
        id: 'vol-primary',
        tenantId: 'tenant-alpha',
        name: 'Primary Degrading Volume',
        path: primaryPath,
        status: VolumeStatus.DEGRADED,
        isDefault: false,
        isReadOnly: true,
        _count: { cameras: 1 },
      });

      const fallbackPath = path.join(tempDir, 'vol-secondary-healthy');
      fs.mkdirSync(fallbackPath, { recursive: true });
      volumesTable.set('vol-secondary', {
        id: 'vol-secondary',
        tenantId: 'tenant-alpha',
        name: 'Secondary Fallback Volume',
        path: fallbackPath,
        status: VolumeStatus.HEALTHY,
        isDefault: false,
        isReadOnly: false,
        _count: { cameras: 0 },
      });

      mockedCheckDiskSpace.mockResolvedValue({
        diskPath: fallbackPath,
        free: 50000,
        size: 100000,
      });

      const result = await volService.resolveActiveVolumeForCamera('cam-1');

      expect(result.isFallback).toBe(true);
      expect(result.volume.id).toBe('vol-secondary');
    });

    it('fails closed and raises CRITICAL alarm when all volumes are unavailable', async () => {
      const volService = new StorageVolumeService(prismaMock);

      // Camera has no primary volume and no secondary volumes exist in tenant
      // Default volume path will fail mount check
      jest.spyOn(volService, 'ensureDefaultVolume').mockResolvedValue({
        id: 'vol-bad-default',
        tenantId: 'tenant-alpha',
        name: 'Bad Default',
        path: path.join(tempDir, 'bad-default-missing'),
        isDefault: true,
        isReadOnly: false,
        status: VolumeStatus.UNMOUNTED,
      } as any);

      await expect(volService.resolveActiveVolumeForCamera('cam-1')).rejects.toThrow(
        /NO_HEALTHY_STORAGE_VOLUME_AVAILABLE/
      );

      const criticalAlarm = alarmsTable.find(
        (a) => a.severity === EventSeverity.CRITICAL && a.title.includes('Storage Volume Failure')
      );
      expect(criticalAlarm).toBeDefined();
    });
  });
});
