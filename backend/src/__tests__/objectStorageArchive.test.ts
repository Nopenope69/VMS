import {
  ObjectStorageArchiveService,
  ArchiveJobRequest,
} from '../services/storage/objectStorageArchive.service';
import { ArchiveJobStatus } from '@prisma/client';
import crypto from 'crypto';

describe('ObjectStorageArchiveService (Content-Addressed Archival & Priority Gating)', () => {
  let service: ObjectStorageArchiveService;
  let mockPrisma: any;
  const tenantId = 'tenant_archive_01';
  const cameraId = 'cam_vault_01';

  beforeEach(() => {
    mockPrisma = {
      archiveJob: {
        upsert: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    service = new ObjectStorageArchiveService(mockPrisma);
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

  describe('Queue Archive Job', () => {
    it('should upsert archive job with content-addressed object key', async () => {
      const checksum = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
      const req: ArchiveJobRequest = {
        tenantId,
        cameraId,
        segmentPath: '/recordings/cam_01/segment_001.mp4',
        sha256Checksum: checksum,
        sizeBytes: 10485760n,
        priority: false,
      };

      mockPrisma.archiveJob.upsert.mockResolvedValue({
        id: 'job_001',
        ...req,
        objectKey: `archive/${tenantId}/${cameraId}/${checksum}.fmp4`,
        status: ArchiveJobStatus.QUEUED,
      });

      const job = await service.queueArchiveJob(req);

      expect(job.status).toBe(ArchiveJobStatus.QUEUED);
      expect(mockPrisma.archiveJob.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            tenantId_segmentPath: {
              tenantId,
              segmentPath: req.segmentPath,
            },
          },
          create: expect.objectContaining({
            sha256Checksum: checksum,
            objectKey: `archive/${tenantId}/${cameraId}/${checksum}.fmp4`,
          }),
        })
      );
    });
  });

  describe('Pre-Flight HEAD Check & Priority Gating', () => {
    const mockConfig = {
      enabled: true,
      offPeakStartUtc: '01:00',
      offPeakEndUtc: '05:00',
      rateLimitBps: 5000000,
    };

    it('should reject non-priority job during peak business hours', async () => {
      const peakTime = new Date('2026-09-07T15:00:00Z');
      mockPrisma.archiveJob.findUnique.mockResolvedValue({
        id: 'job_peak_01',
        objectKey: 'archive/tenant/cam/hash.fmp4',
        sha256Checksum: 'hash123',
        priority: false,
        tenant: { objectStorageConfig: mockConfig },
      });

      const result = await service.processArchiveJob('job_peak_01', undefined, peakTime);

      expect(result.status).toBe('FAILED');
      expect(result.error).toContain('outside configured off-peak archival window');
      expect(mockPrisma.archiveJob.update).not.toHaveBeenCalled();
    });

    it('should bypass off-peak window check for high-priority EvidencePin jobs', async () => {
      const peakTime = new Date('2026-09-07T15:00:00Z');
      const testBuffer = Buffer.from('pinned_legal_evidence_video_content');
      const checksum = crypto.createHash('sha256').update(testBuffer).digest('hex');

      mockPrisma.archiveJob.findUnique.mockResolvedValue({
        id: 'job_priority_01',
        objectKey: `archive/tenant/cam/${checksum}.fmp4`,
        sha256Checksum: checksum,
        sizeBytes: BigInt(testBuffer.length),
        priority: true, // Legal evidence pin priority!
        tenant: { objectStorageConfig: mockConfig },
      });

      const result = await service.processArchiveJob('job_priority_01', testBuffer, peakTime);

      expect(result.status).toBe('COMPLETED');
      expect(result.skippedDuplicate).toBe(false);
      expect(mockPrisma.archiveJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'job_priority_01' },
          data: expect.objectContaining({ status: ArchiveJobStatus.COMPLETED }),
        })
      );
    });

    it('should skip duplicate upload via content-addressed pre-flight HEAD check', async () => {
      const testBuffer = Buffer.from('duplicated_video_content');
      const checksum = crypto.createHash('sha256').update(testBuffer).digest('hex');
      const offPeakTime = new Date('2026-09-07T03:00:00Z');

      const jobData = {
        id: 'job_dup_01',
        objectKey: `archive/tenant/cam/${checksum}.fmp4`,
        sha256Checksum: checksum,
        sizeBytes: BigInt(testBuffer.length),
        priority: false,
        tenant: { objectStorageConfig: mockConfig },
      };

      mockPrisma.archiveJob.findUnique.mockResolvedValue(jobData);

      // 1. First upload succeeds
      const res1 = await service.processArchiveJob('job_dup_01', testBuffer, offPeakTime);
      expect(res1.status).toBe('COMPLETED');
      expect(res1.skippedDuplicate).toBe(false);

      // 2. Second upload with same object key and hash is detected via HEAD check
      const res2 = await service.processArchiveJob('job_dup_01', testBuffer, offPeakTime);
      expect(res2.status).toBe('COMPLETED');
      expect(res2.skippedDuplicate).toBe(true);
    });

    it('should reject and mark FAILED when segment checksum is corrupted', async () => {
      const offPeakTime = new Date('2026-09-07T03:00:00Z');
      const realBuffer = Buffer.from('actual_file_bytes');
      const badChecksum = 'incorrect_sha256_hash_here';

      mockPrisma.archiveJob.findUnique.mockResolvedValue({
        id: 'job_corrupted',
        objectKey: 'archive/tenant/cam/corrupted.fmp4',
        sha256Checksum: badChecksum,
        sizeBytes: BigInt(realBuffer.length),
        priority: true,
        tenant: { objectStorageConfig: mockConfig },
      });

      const result = await service.processArchiveJob('job_corrupted', realBuffer, offPeakTime);

      expect(result.status).toBe('FAILED');
      expect(result.error).toContain('SHA-256 checksum verification failed');
      expect(mockPrisma.archiveJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'job_corrupted' },
          data: expect.objectContaining({
            status: ArchiveJobStatus.FAILED,
            error: 'Corrupted segment: SHA-256 checksum mismatch',
          }),
        })
      );
    });
  });
});
