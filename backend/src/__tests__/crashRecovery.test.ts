import fs from 'fs';
import path from 'path';
import os from 'os';
import { SegmentStatus } from '@prisma/client';
import { CrashRecoveryService } from '../services/reconciliation/crashRecovery.service';
import { FFmpegService } from '../services/ffmpeg/ffmpeg.service';

jest.mock('../services/ffmpeg/ffmpeg.service');
const mockedFFmpegService = FFmpegService as jest.Mocked<typeof FFmpegService>;

describe('Phase 2: CrashRecoveryService & Power-Cut Resilience', () => {
  let tempDir: string;
  let prismaMock: any;
  let segmentsTable: Map<string, any>;
  let eventsTable: any[];
  let service: CrashRecoveryService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigilone-crash-test-'));
    segmentsTable = new Map();
    eventsTable = [];

    prismaMock = {
      storageVolume: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      recordingSegment: {
        findMany: jest.fn().mockImplementation(({ where }) => {
          let list = Array.from(segmentsTable.values());
          if (where?.status) list = list.filter((s) => s.status === where.status);
          return Promise.resolve(list);
        }),
        findUnique: jest.fn().mockImplementation(({ where }) => {
          for (const s of segmentsTable.values()) {
            if (where.filePath && s.filePath === where.filePath) return Promise.resolve(s);
          }
          return Promise.resolve(null);
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
        findMany: jest.fn().mockResolvedValue([{ id: 'tenant-1' }]),
      },
      event: {
        create: jest.fn().mockImplementation(({ data }) => {
          eventsTable.push(data);
          return Promise.resolve(data);
        }),
      },
    };

    service = new CrashRecoveryService(prismaMock);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('detects and unlinks 0-byte files left by sudden power cut, updating status to CORRUPTED', async () => {
    const zeroByteFile = path.join(tempDir, 'cam_0_byte.mp4');
    fs.writeFileSync(zeroByteFile, Buffer.alloc(0));

    segmentsTable.set('seg-zero', {
      id: 'seg-zero',
      filePath: zeroByteFile,
      status: 'RECORDING',
    });

    const report = await service.recoverStorage([tempDir]);

    expect(report.zeroBytePruned).toBe(1);
    expect(fs.existsSync(zeroByteFile)).toBe(false);

    const seg = segmentsTable.get('seg-zero');
    expect(seg.status).toBe(SegmentStatus.CORRUPTED);
    expect(seg.quarantineReason).toBe('ZERO_BYTE_POWER_CUT');
  });

  it('non-destructively repairs truncated video segment and updates provenance checksums', async () => {
    const truncatedFile = path.join(tempDir, 'truncated_chunk.mp4');
    fs.writeFileSync(truncatedFile, 'fake-truncated-video-payload');

    segmentsTable.set('seg-trunc', {
      id: 'seg-trunc',
      filePath: truncatedFile,
      status: 'FINALIZED',
      evidencePins: [],
    });

    // 1st probe on corrupt file returns null
    mockedFFmpegService.probe
      .mockResolvedValueOnce(null)
      // 2nd probe on repaired temp file succeeds
      .mockResolvedValueOnce({
        durationSeconds: 10.5,
        width: 1920,
        height: 1080,
        videoCodec: 'h264',
        fps: 25,
        sizeBytes: 2048,
      });

    // Mock remux repair to simulate successful ffmpeg output
    (CrashRecoveryService as any).remuxRepair = jest
      .fn()
      .mockImplementation((src: string, out: string) => {
        fs.writeFileSync(out, 'repaired-clean-fmp4-data');
        return Promise.resolve(true);
      });

    const report = await service.recoverStorage([tempDir]);

    expect(report.filesRecovered).toBe(1);

    const seg = segmentsTable.get('seg-trunc');
    expect(seg.status).toBe(SegmentStatus.FINALIZED);
    expect(seg.originalSha256).toBeDefined();
    expect(seg.repairedSha256).toBeDefined();
    expect(seg.repairedAt).toBeDefined();
    expect(seg.durationMs).toBe(10500);
  });

  it('quarantines unrecoverable media files into .quarantine directory without silent deletion', async () => {
    const irrecoverableFile = path.join(tempDir, 'broken.mp4');
    fs.writeFileSync(irrecoverableFile, 'completely-broken-bytes');

    segmentsTable.set('seg-broken', {
      id: 'seg-broken',
      filePath: irrecoverableFile,
      status: 'FINALIZED',
      evidencePins: [],
    });

    mockedFFmpegService.probe.mockResolvedValue(null);
    (CrashRecoveryService as any).remuxRepair = jest.fn().mockResolvedValue(false);

    const report = await service.recoverStorage([tempDir]);

    expect(report.filesQuarantined).toBe(1);

    const quarantinePath = path.join(tempDir, '.quarantine', 'broken.mp4');
    expect(fs.existsSync(quarantinePath)).toBe(true);

    const seg = segmentsTable.get('seg-broken');
    expect(seg.status).toBe(SegmentStatus.QUARANTINED);
    expect(seg.quarantineReason).toBe('TRUNCATED_CONTAINER_UNREPAIRABLE');
  });

  it('marks database records whose physical files are missing as FILE_MISSING instead of deleting', async () => {
    const missingFilePath = path.join(tempDir, 'ghost_file.mp4');

    segmentsTable.set('seg-missing', {
      id: 'seg-missing',
      filePath: missingFilePath,
      status: SegmentStatus.FINALIZED,
    });

    const report = await service.recoverStorage([tempDir]);

    expect(report.filesMissing).toBe(1);

    const seg = segmentsTable.get('seg-missing');
    expect(seg.status).toBe(SegmentStatus.FILE_MISSING);
    expect(seg.quarantineReason).toBe('PHYSICAL_FILE_MISSING_ON_RECONCILE');
  });
});
