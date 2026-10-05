import { PrismaClient, RecordingSegment, SegmentStatus } from '@prisma/client';

/**
 * Only a FINALIZED segment is footage that can be played, counted as coverage or seeked to. A corrupt, quarantined,
 * missing or pruned file is not (audit finding F9, docs/audits/RECORDING_CATALOG_AUDIT_2026-10-05.md).
 */
const SERVABLE = SegmentStatus.FINALIZED;

export interface UpsertSegmentInput {
  tenantId?: string;
  cameraId: string;
  filePath: string;
  startTime: Date;
  endTime: Date;
  durationMs: number;
  sizeBytes: bigint;
  sha256Hash?: string | null;
  /** null = unknown. Nothing is invented for a file that could not be read. */
  codec?: string | null;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  status?: SegmentStatus;
  quarantineReason?: string | null;
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
        codec: input.codec ?? null,
        width: input.width ?? null,
        height: input.height ?? null,
        fps: input.fps ?? null,
        status: input.status || SegmentStatus.FINALIZED,
        quarantineReason: input.quarantineReason ?? null,
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
        // A file that could not be read earlier and can now (or the reverse) takes the new picture details and reason.
        codec: input.codec ?? null,
        width: input.width ?? null,
        height: input.height ?? null,
        fps: input.fps ?? null,
        quarantineReason: input.quarantineReason ?? null,
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
        status: SERVABLE,
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
        status: SERVABLE,
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
        status: SERVABLE,
        endTime: { lte: targetUtc },
      },
      orderBy: { endTime: 'desc' },
    });

    if (preceding) return preceding;

    // Fall back to first succeeding segment
    return this.prisma.recordingSegment.findFirst({
      where: {
        cameraId,
        status: SERVABLE,
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
