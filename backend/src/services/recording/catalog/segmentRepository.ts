import { PrismaClient, RecordingSegment, SegmentStatus } from '@prisma/client';

export interface UpsertSegmentInput {
  tenantId?: string;
  cameraId: string;
  filePath: string;
  startTime: Date;
  endTime: Date;
  durationMs: number;
  sizeBytes: bigint;
  sha256Hash?: string | null;
  codec?: string;
  width?: number;
  height?: number;
  fps?: number;
  status?: SegmentStatus;
  startPts?: bigint;
  endPts?: bigint;
  timebaseNumerator?: number;
  timebaseDenominator?: number;
  keyframeIndexJson?: any;
  storageLocation?: string;
}

export class SegmentRepository {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Idempotently upserts a recording segment.
   * If a record with the same filePath exists, validates and updates temporal/hash fields without duplicating.
   */
  async upsertSegment(input: UpsertSegmentInput): Promise<RecordingSegment> {
    return this.prisma.recordingSegment.upsert({
      where: {
        filePath: input.filePath,
      },
      create: {
        tenantId: input.tenantId,
        cameraId: input.cameraId,
        filePath: input.filePath,
        startTime: input.startTime,
        endTime: input.endTime,
        durationMs: input.durationMs,
        sizeBytes: input.sizeBytes,
        sha256Hash: input.sha256Hash,
        codec: input.codec || 'h264',
        width: input.width || 1920,
        height: input.height || 1080,
        fps: input.fps || 25.0,
        status: input.status || SegmentStatus.FINALIZED,
        startPts: input.startPts ?? 0n,
        endPts: input.endPts ?? 0n,
        timebaseNumerator: input.timebaseNumerator ?? 1,
        timebaseDenominator: input.timebaseDenominator ?? 90000,
        keyframeIndexJson: input.keyframeIndexJson,
        storageLocation: input.storageLocation || 'LOCAL',
      },
      update: {
        endTime: input.endTime,
        durationMs: input.durationMs,
        sizeBytes: input.sizeBytes,
        sha256Hash: input.sha256Hash ?? undefined,
        endPts: input.endPts ?? undefined,
        keyframeIndexJson: input.keyframeIndexJson ?? undefined,
        status: input.status ?? undefined,
      },
    });
  }

  /**
   * Finds all segments overlapping a target time window
   */
  async findSegments(cameraId: string, startUtc: Date, endUtc: Date): Promise<RecordingSegment[]> {
    return this.prisma.recordingSegment.findMany({
      where: {
        cameraId,
        startTime: { lte: endUtc },
        endTime: { gte: startUtc },
      },
      orderBy: { startTime: 'asc' },
    });
  }

  /**
   * Finds the exact segment containing targetUtc (startTime <= targetUtc <= endTime)
   */
  async findContainingSegment(cameraId: string, targetUtc: Date): Promise<RecordingSegment | null> {
    return this.prisma.recordingSegment.findFirst({
      where: {
        cameraId,
        startTime: { lte: targetUtc },
        endTime: { gte: targetUtc },
      },
      orderBy: { startTime: 'desc' },
    });
  }

  /**
   * Finds the nearest preceding or succeeding segment when in a recording gap
   */
  async findNearestSegment(cameraId: string, targetUtc: Date): Promise<RecordingSegment | null> {
    // Check preceding first
    const preceding = await this.prisma.recordingSegment.findFirst({
      where: {
        cameraId,
        endTime: { lte: targetUtc },
      },
      orderBy: { endTime: 'desc' },
    });

    if (preceding) return preceding;

    // Fall back to first succeeding segment
    return this.prisma.recordingSegment.findFirst({
      where: {
        cameraId,
        startTime: { gte: targetUtc },
      },
      orderBy: { startTime: 'asc' },
    });
  }

  async findById(segmentId: string): Promise<RecordingSegment | null> {
    return this.prisma.recordingSegment.findUnique({
      where: { id: segmentId },
    });
  }

  async deleteSegment(segmentId: string): Promise<void> {
    await this.prisma.recordingSegment.delete({
      where: { id: segmentId },
    });
  }

  /**
   * Finds retention candidates older than cutoff date, sorted oldest first
   */
  async findRetentionCandidates(
    tenantId: string,
    beforeDate: Date,
    limit = 100
  ): Promise<RecordingSegment[]> {
    return this.prisma.recordingSegment.findMany({
      where: {
        tenantId,
        endTime: { lt: beforeDate },
      },
      orderBy: { startTime: 'asc' },
      take: limit,
    });
  }

  /**
   * Finds all segments for a tenant sorted oldest first for quota reclamation
   */
  async findSegmentsForQuota(tenantId: string, limit = 200): Promise<RecordingSegment[]> {
    return this.prisma.recordingSegment.findMany({
      where: { tenantId },
      orderBy: { startTime: 'asc' },
      take: limit,
    });
  }
}
