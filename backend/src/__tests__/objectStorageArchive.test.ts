/**
 * Archive scheduling rules with a SIMULATED store (an in-memory object map) and a mocked database. Real uploads
 * to an S3-compatible server are tested in archiveS3RealDb.test.ts.
 */
import { ObjectStorageArchiveService, ArchiveStore } from '../services/storage/objectStorageArchive.service';
import { ArchiveJobStatus } from '@prisma/client';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('ObjectStorageArchiveService (Content-Addressed Archival & Priority Gating)', () => {
  let service: ObjectStorageArchiveService;
  let mockPrisma: any;
  const tenantId = 'tenant_archive_01';
  const cameraId = 'cam_vault_01';
  const objects = new Map<string, { sha256: string; size: number }>();
  let putOverride: ((key: string) => void) | null = null;
  const store: ArchiveStore = {
    head: async (key) => (objects.has(key) ? { sizeBytes: objects.get(key)!.size, sha256: objects.get(key)!.sha256, etag: null } : null),
    putFile: async (key, file, sha256, size) => {
      putOverride?.(key);
      if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== sha256) throw new Error('XAmzContentSHA256Mismatch');
      objects.set(key, { sha256, size });
    },
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-unit-'));
  const file = (content: string) => {
    const f = path.join(tmp, `${crypto.randomUUID()}.fmp4`);
    fs.writeFileSync(f, content);
    return { f, sha: crypto.createHash('sha256').update(content).digest('hex'), size: Buffer.byteLength(content) };
  };
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  beforeEach(() => {
    mockPrisma = {
      archiveJob: {
        upsert: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    objects.clear();
    service = new ObjectStorageArchiveService(mockPrisma, () => store);
  });

  describe('Off-Peak Window Evaluation', () => {
    it('should correctly evaluate standard daytime/evening off-peak windows', () => {
      // 02:00 to 06:00 UTC
      const offPeakStart = '02:00';
      const offPeakEnd = '06:00';

      const inside = new Date('2026-09-07T03:30:00Z');
      const outside = new Date('2026-09-07T14:00:00Z');

      expect(service.isOffPeakNow(offPeakStart, offPeakEnd, inside)).toBe(true);
      expect(service.isOffPeakNow(offPeakStart, offPeakEnd, outside)).toBe(false);
    });

    it('should correctly evaluate midnight crossover off-peak windows (22:00 to 04:00 UTC)', () => {
      const offPeakStart = '22:00';
      const offPeakEnd = '04:00';

      const lateNight = new Date('2026-09-07T23:15:00Z');
      const earlyMorning = new Date('2026-09-07T02:30:00Z');
      const midday = new Date('2026-09-07T12:00:00Z');

      expect(service.isOffPeakNow(offPeakStart, offPeakEnd, lateNight)).toBe(true);
      expect(service.isOffPeakNow(offPeakStart, offPeakEnd, earlyMorning)).toBe(true);
      expect(service.isOffPeakNow(offPeakStart, offPeakEnd, midday)).toBe(false);
    });
  });

  describe('Processing a job', () => {
    const cfg = { enabled: true, offPeakStartUtc: '01:00', offPeakEndUtc: '05:00', bandwidthLimitKbps: 0 };
    const job = (over: Record<string, unknown>) => ({ id: 'job_1', status: ArchiveJobStatus.QUEUED, attempts: 0, maxAttempts: 3, priority: false, tenant: { objectStorageConfig: cfg }, ...over });
    const peak = new Date('2026-09-07T15:00:00Z');
    const offPeak = new Date('2026-09-07T03:00:00Z');
    afterEach(() => {
      putOverride = null;
    });

    it('defers a non-priority job outside the off-peak window without touching it', async () => {
      const f = file('normal');
      mockPrisma.archiveJob.findUnique.mockResolvedValue(job({ segmentPath: f.f, sha256Checksum: f.sha, sizeBytes: BigInt(f.size), objectKey: `k/${f.sha}` }));
      const r = await service.processArchiveJob('job_1', peak);
      expect(r.status).toBe('DEFERRED');
      expect(mockPrisma.archiveJob.update).not.toHaveBeenCalled();
      expect(objects.size).toBe(0);
    });

    it('uploads pinned evidence (priority) at any time, then verifies it by HEAD', async () => {
      const f = file('pinned legal evidence');
      mockPrisma.archiveJob.findUnique.mockResolvedValue(job({ priority: true, segmentPath: f.f, sha256Checksum: f.sha, sizeBytes: BigInt(f.size), objectKey: `k/${f.sha}` }));
      const r = await service.processArchiveJob('job_1', peak);
      expect(r).toMatchObject({ status: 'COMPLETED', skippedDuplicate: false });
      expect(objects.get(`k/${f.sha}`)).toEqual({ sha256: f.sha, size: f.size });
      expect(mockPrisma.archiveJob.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: ArchiveJobStatus.COMPLETED }) }));
    });

    it('skips an object already stored with the same SHA-256 and size', async () => {
      const f = file('same content');
      objects.set(`k/${f.sha}`, { sha256: f.sha, size: f.size });
      mockPrisma.archiveJob.findUnique.mockResolvedValue(job({ segmentPath: f.f, sha256Checksum: f.sha, sizeBytes: BigInt(f.size), objectKey: `k/${f.sha}` }));
      expect(await service.processArchiveJob('job_1', offPeak)).toMatchObject({ status: 'COMPLETED', skippedDuplicate: true });
    });

    it('refuses a local file whose SHA-256 differs from the index, without uploading', async () => {
      const f = file('actual bytes');
      mockPrisma.archiveJob.findUnique.mockResolvedValue(job({ segmentPath: f.f, sha256Checksum: 'a'.repeat(64), sizeBytes: BigInt(f.size), objectKey: 'k/x' }));
      const r = await service.processArchiveJob('job_1', offPeak);
      expect(r.status).toBe('FAILED');
      expect(objects.size).toBe(0);
    });

    it('retries when the store does not show the uploaded object, and fails after the last attempt', async () => {
      const f = file('vanishes');
      putOverride = () => undefined;
      const lost: ArchiveStore = { head: async () => null, putFile: async () => undefined };
      const s2 = new ObjectStorageArchiveService(mockPrisma, () => lost);
      mockPrisma.archiveJob.findUnique.mockResolvedValue(job({ segmentPath: f.f, sha256Checksum: f.sha, sizeBytes: BigInt(f.size), objectKey: 'k/v' }));
      expect((await s2.processArchiveJob('job_1', offPeak)).status).toBe('RETRY');
      mockPrisma.archiveJob.findUnique.mockResolvedValue(job({ attempts: 2, segmentPath: f.f, sha256Checksum: f.sha, sizeBytes: BigInt(f.size), objectKey: 'k/v' }));
      const r = await s2.processArchiveJob('job_1', offPeak);
      expect(r.status).toBe('FAILED');
      expect(r.error).toMatch(/after upload the store reports no object/);
    });
  });
});
