import fs from 'fs';
import path from 'path';
import { JobStatus, SegmentStatus } from '@prisma/client';
import SegmentJobWorkerService from '../services/storage/segmentJobWorker.service';
import { FFmpegService } from '../services/ffmpeg/ffmpeg.service';

describe('Durable Segment Job Queue & Bounded Worker Pool', () => {
  const testTenantId = 'tenant_queue_test_01';
  const testCameraId = 'cam_queue_test_01';
  const dummyFilePath = path.join(__dirname, 'dummy_test_segment.mp4');

  // In-memory stores
  const jobsStore: any[] = [];
  const segmentsStore: any[] = [];

  beforeAll(() => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || 'postgresql://vigilone:vigilone_dev@localhost:5432/vigilone_db';

    // Create a real mini dummy MP4 file for probing
    fs.writeFileSync(dummyFilePath, Buffer.from('mock video content for queue test'));

    // Mock FFmpegService.probe for this test
    jest.spyOn(FFmpegService, 'probe').mockResolvedValue({
      durationSeconds: 10,
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      fps: 25,
      sizeBytes: 1024,
    });

    // Mock Prisma inside SegmentJobWorkerService
    const mockPrisma = (SegmentJobWorkerService as any).prisma;

    jest.spyOn(mockPrisma.segmentJob, 'findMany').mockImplementation(async (query: any) => {
      let filtered = jobsStore.filter((j) => {
        if (query?.where?.status && j.status !== query.where.status) return false;
        return true;
      });
      if (query?.take) {
        filtered = filtered.slice(0, query.take);
      }
      return filtered;
    });

    jest.spyOn(mockPrisma.segmentJob, 'findUnique').mockImplementation(async (query: any) => {
      return jobsStore.find((j) => j.id === query.where.id) || null;
    });

    jest.spyOn(mockPrisma.segmentJob, 'updateMany').mockImplementation(async (query: any) => {
      let count = 0;
      for (const j of jobsStore) {
        if (query.where.id && j.id !== query.where.id) continue;
        if (query.where.status && j.status !== query.where.status) continue;
        Object.assign(j, query.data);
        count++;
      }
      return { count };
    });

    jest.spyOn(mockPrisma.segmentJob, 'update').mockImplementation(async (query: any) => {
      const j = jobsStore.find((item) => item.id === query.where.id);
      if (j) Object.assign(j, query.data);
      return j;
    });

    jest.spyOn(mockPrisma.recordingSegment, 'upsert').mockImplementation(async (query: any) => {
      let seg = segmentsStore.find((s) => s.filePath === query.where.filePath);
      if (!seg) {
        seg = { id: `seg_${Date.now()}`, ...query.create };
        segmentsStore.push(seg);
      } else {
        Object.assign(seg, query.update);
      }
      return seg;
    });
  });

  afterAll(async () => {
    // Wait for any remaining microtasks to settle
    await new Promise((r) => setTimeout(r, 50));
    if (fs.existsSync(dummyFilePath)) {
      fs.unlinkSync(dummyFilePath);
    }
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jobsStore.length = 0;
    segmentsStore.length = 0;
  });

  it('should process pending jobs via worker and finalize recording segments', async () => {
    // Insert a pending job into the store
    const job = {
      id: 'job_001',
      tenantId: testTenantId,
      cameraId: testCameraId,
      streamPath: 'cam_stream_01',
      segmentPath: dummyFilePath,
      status: JobStatus.PENDING,
      attempts: 0,
      maxAttempts: 3,
      createdAt: new Date(),
    };
    jobsStore.push(job);

    // Process pending jobs
    const processedCount = await SegmentJobWorkerService.processNextJobs();
    expect(processedCount).toBe(1);

    expect(job.status).toBe(JobStatus.COMPLETED);
    expect(segmentsStore.length).toBe(1);
    expect(segmentsStore[0].status).toBe(SegmentStatus.FINALIZED);
    expect(segmentsStore[0].width).toBe(1920);
    expect(segmentsStore[0].sha256Hash).toBeDefined();
  });

  it('should enforce concurrency limit of 2 worker jobs', async () => {
    // Insert 5 pending jobs
    for (let i = 0; i < 5; i++) {
      jobsStore.push({
        id: `job_batch_${i}`,
        tenantId: testTenantId,
        cameraId: testCameraId,
        streamPath: 'cam_stream_01',
        segmentPath: dummyFilePath,
        status: JobStatus.PENDING,
        attempts: 0,
        maxAttempts: 3,
        createdAt: new Date(Date.now() + i * 1000),
      });
    }

    // First cycle should pull max 2 jobs
    const claimed = await SegmentJobWorkerService.processNextJobs();
    expect(claimed).toBeLessThanOrEqual(2);
  });
});
