import fs from 'fs';
import { PrismaClient, JobStatus, SegmentStatus } from '@prisma/client';
import { FFmpegService } from '../ffmpeg/ffmpeg.service';
import { computeFileSha256 } from '../../utils/crypto';
import StorageVolumeService from './storageVolume.service';
import StorageEpochService from './storageEpoch.service';

export class SegmentJobWorkerService {
  private static prisma = new PrismaClient();
  private static isRunning = false;
  private static activeWorkers = 0;
  private static readonly MAX_CONCURRENCY = 2;
  private static loopInterval: NodeJS.Timeout | null = null;

  public static start(intervalMs: number = 2000) {
    if (this.isRunning) return;
    this.isRunning = true;

    this.loopInterval = setInterval(() => {
      this.processNextJobs().catch((err) => {
        console.error('SegmentJobWorker loop error:', err);
      });
    }, intervalMs);
  }

  public static stop() {
    this.isRunning = false;
    if (this.loopInterval) {
      clearInterval(this.loopInterval);
      this.loopInterval = null;
    }
  }

  public static async processNextJobs(): Promise<number> {
    if (this.activeWorkers >= this.MAX_CONCURRENCY) {
      return 0;
    }

    const availableSlots = this.MAX_CONCURRENCY - this.activeWorkers;

    // Fetch pending jobs
    const jobs = await this.prisma.segmentJob.findMany({
      where: { status: JobStatus.PENDING },
      orderBy: { createdAt: 'asc' },
      take: availableSlots,
    });

    if (jobs.length === 0) return 0;

    const promises: Promise<void>[] = [];
    for (const job of jobs) {
      this.activeWorkers++;
      const p = this.processSingleJob(job.id).finally(() => {
        this.activeWorkers--;
      });
      promises.push(p);
    }

    await Promise.all(promises);
    return jobs.length;
  }

  public static async processSingleJob(jobId: string): Promise<void> {
    // Atomically claim job
    const claimed = await this.prisma.segmentJob.updateMany({
      where: { id: jobId, status: JobStatus.PENDING },
      data: { status: JobStatus.PROCESSING },
    });

    if (claimed.count === 0) return;

    const job = await this.prisma.segmentJob.findUnique({
      where: { id: jobId },
    });

    if (!job) return;

    const filePath = job.segmentPath;

    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`Segment file not found on disk: ${filePath}`);
      }

      const stats = fs.statSync(filePath);
      if (stats.size === 0) {
        throw new Error(`Segment file is 0 bytes: ${filePath}`);
      }

      // 1. Probe segment via native FFmpeg subprocess
      const probe = await FFmpegService.probe(filePath);
      if (!probe || !probe.durationSeconds || probe.durationSeconds <= 0) {
        throw new Error(`FFprobe failed to inspect media streams for ${filePath}`);
      }

      // 2. Compute streaming SHA-256
      const sha256 = await computeFileSha256(filePath);

      // 3. Determine start and end time
      const durationMs = Math.round(probe.durationSeconds * 1000);
      const endTime = stats.mtime;
      const startTime = new Date(endTime.getTime() - durationMs);

      // 4. Resolve active storage volume and epoch for provenance
      let activeVolumeId: string | undefined = undefined;
      let activeEpochId: string | undefined = undefined;

      try {
        const volumeService = StorageVolumeService.getInstance(this.prisma);
        const epochService = new StorageEpochService(this.prisma);
        const resolved = await volumeService.resolveActiveVolumeForCamera(job.cameraId);
        activeVolumeId = resolved?.volume?.id;

        if (activeVolumeId && job.tenantId) {
          const epoch = await epochService.getOrCreateActiveEpoch(job.tenantId, job.cameraId, activeVolumeId);
          activeEpochId = epoch?.id;
        }
      } catch (err: any) {
        console.warn(`[SegmentJobWorker] Non-blocking epoch resolution note:`, err.message);
      }

      // 5. Atomically insert or update RecordingSegment
      await this.prisma.recordingSegment.upsert({
        where: { filePath },
        update: {
          endTime,
          durationMs,
          sizeBytes: BigInt(stats.size),
          sha256Hash: sha256,
          codec: probe.videoCodec || 'h264',
          width: probe.width || 1920,
          height: probe.height || 1080,
          fps: probe.fps || 25,
          status: SegmentStatus.FINALIZED,
          storageVolumeId: activeVolumeId,
          storageEpochId: activeEpochId,
        },
        create: {
          tenantId: job.tenantId,
          cameraId: job.cameraId,
          filePath,
          startTime,
          endTime,
          durationMs,
          sizeBytes: BigInt(stats.size),
          sha256Hash: sha256,
          codec: probe.videoCodec || 'h264',
          width: probe.width || 1920,
          height: probe.height || 1080,
          fps: probe.fps || 25,
          status: SegmentStatus.FINALIZED,
          storageVolumeId: activeVolumeId,
          storageEpochId: activeEpochId,
        },
      });

      // 5. Mark job COMPLETED
      await this.prisma.segmentJob.update({
        where: { id: job.id },
        data: {
          status: JobStatus.COMPLETED,
          processedAt: new Date(),
          lastError: null,
        },
      });
    } catch (err: any) {
      console.error(`Failed to process segment job ${job.id}:`, err.message);

      const nextAttempts = job.attempts + 1;
      const willFail = nextAttempts >= job.maxAttempts;

      await this.prisma.segmentJob.update({
        where: { id: job.id },
        data: {
          attempts: nextAttempts,
          status: willFail ? JobStatus.FAILED : JobStatus.PENDING,
          lastError: err.message,
        },
      });
    }
  }
}

export default SegmentJobWorkerService;
