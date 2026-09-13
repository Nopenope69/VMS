import { PrismaClient, ArchiveJobStatus } from '@prisma/client';
import crypto from 'crypto';

export interface ArchiveJobRequest {
  tenantId: string;
  cameraId: string;
  segmentPath: string;
  sha256Checksum: string;
  sizeBytes: bigint;
  priority?: boolean;
}

export interface UploadResult {
  jobId: string;
  objectKey: string;
  sha256Checksum: string;
  skippedDuplicate: boolean;
  status: 'COMPLETED' | 'FAILED';
  error?: string;
}

export class ObjectStorageArchiveService {
  private prisma: PrismaClient;
  private s3Store: Map<string, { checksum: string; sizeBytes: bigint; data?: Buffer }> = new Map();

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Evaluates if the current UTC time falls within the configured off-peak sync window
   */
  public isOffPeakNow(startUtc: string, endUtc: string, now: Date = new Date()): boolean {
    const currentMins = now.getUTCHours() * 60 + now.getUTCMinutes();
    const [startH, startM] = startUtc.split(':').map(Number);
    const [endH, endM] = endUtc.split(':').map(Number);
    const startTotal = startH * 60 + startM;
    const endTotal = endH * 60 + endM;

    if (startTotal <= endTotal) {
      return currentMins >= startTotal && currentMins <= endTotal;
    } else {
      // Midnight crossover window (e.g. 23:00 to 05:00)
      return currentMins >= startTotal || currentMins <= endTotal;
    }
  }

  /**
   * Queues a video segment or evidence package for offsite object storage archival
   */
  public async queueArchiveJob(req: ArchiveJobRequest) {
    const objectKey = `archive/${req.tenantId}/${req.cameraId}/${req.sha256Checksum}.fmp4`;

    const job = await this.prisma.archiveJob.upsert({
      where: {
        tenantId_segmentPath: {
          tenantId: req.tenantId,
          segmentPath: req.segmentPath,
        },
      },
      create: {
        tenantId: req.tenantId,
        segmentPath: req.segmentPath,
        sha256Checksum: req.sha256Checksum,
        sizeBytes: req.sizeBytes,
        objectKey,
        priority: req.priority ?? false,
        status: ArchiveJobStatus.QUEUED,
      },
      update: {
        priority: req.priority ?? false,
        status: ArchiveJobStatus.QUEUED,
      },
    });

    return job;
  }

  /**
   * Processes a single archive job with pre-flight content-addressed HEAD check & priority gating
   */
  public async processArchiveJob(
    jobId: string,
    fileBuffer?: Buffer,
    now: Date = new Date()
  ): Promise<UploadResult> {
    const job = await this.prisma.archiveJob.findUnique({
      where: { id: jobId },
      include: { tenant: { include: { objectStorageConfig: true } } },
    });

    if (!job) {
      throw new Error(`Archive job ${jobId} not found`);
    }

    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'FEATURE_DEFERRED_FOR_V1: Offsite S3 object storage archival is deferred for v1 edge NVR release. In-memory store is prohibited in production.'
      );
    }

    const config = job.tenant.objectStorageConfig;
    if (!config || !config.enabled) {
      throw new Error('Object storage archival is not configured or disabled for this tenant');
    }

    // 1. Off-peak window gating (EvidencePin priority jobs bypass window check!)
    if (!job.priority) {
      const isOffPeak = this.isOffPeakNow(config.offPeakStartUtc, config.offPeakEndUtc, now);
      if (!isOffPeak) {
        return {
          jobId,
          objectKey: job.objectKey,
          sha256Checksum: job.sha256Checksum,
          skippedDuplicate: false,
          status: 'FAILED',
          error: 'Current time is outside configured off-peak archival window (non-priority job queued)',
        };
      }
    }

    // 2. Content-Addressed Pre-Flight HEAD Check (Idempotency)
    const existing = this.s3Store.get(job.objectKey);
    if (existing && existing.checksum === job.sha256Checksum) {
      // Already uploaded with matching checksum, skip duplicate upload!
      await this.prisma.archiveJob.update({
        where: { id: jobId },
        data: {
          status: ArchiveJobStatus.COMPLETED,
          uploadedAt: new Date(),
        },
      });

      return {
        jobId,
        objectKey: job.objectKey,
        sha256Checksum: job.sha256Checksum,
        skippedDuplicate: true,
        status: 'COMPLETED',
      };
    }

    // 3. Upload & Checksum Integrity Verification
    if (fileBuffer) {
      const calculatedHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
      if (calculatedHash !== job.sha256Checksum) {
        await this.prisma.archiveJob.update({
          where: { id: jobId },
          data: {
            status: ArchiveJobStatus.FAILED,
            error: 'Corrupted segment: SHA-256 checksum mismatch',
          },
        });
        return {
          jobId,
          objectKey: job.objectKey,
          sha256Checksum: job.sha256Checksum,
          skippedDuplicate: false,
          status: 'FAILED',
          error: 'SHA-256 checksum verification failed before upload',
        };
      }
    }

    // Commit to store
    this.s3Store.set(job.objectKey, {
      checksum: job.sha256Checksum,
      sizeBytes: job.sizeBytes,
      data: fileBuffer,
    });

    await this.prisma.archiveJob.update({
      where: { id: jobId },
      data: {
        status: ArchiveJobStatus.COMPLETED,
        uploadedAt: new Date(),
      },
    });

    return {
      jobId,
      objectKey: job.objectKey,
      sha256Checksum: job.sha256Checksum,
      skippedDuplicate: false,
      status: 'COMPLETED',
    };
  }
}
