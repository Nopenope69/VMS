import { Prisma, PrismaClient, RecordingSegment, SegmentStatus } from '@prisma/client';

/**
 * Only a FINALIZED segment is footage that can be played, counted as coverage or seeked to. A corrupt, quarantined,
 * missing or pruned file is not (audit finding F9, docs/audits/RECORDING_CATALOG_AUDIT_2026-10-05.md).
 */
const SERVABLE = SegmentStatus.FINALIZED;

/**
 * Reasons the integrity check (`segmentIntegrity.ts`) gives when a file no longer matches what was recorded. A row
 * marked CORRUPTED with one of them is held: re-registration (crawler, segment-complete job, API) never returns it to
 * FINALIZED or replaces its hash or size. Returning it to service is a human decision, or boot recovery's repair, which
 * keeps the original hash and records `repairedSha256`.
 */
export const INTEGRITY_FAILURE = { HASH_MISMATCH: 'HASH_MISMATCH', SIZE_CHANGED: 'SIZE_CHANGED' } as const;
export const INTEGRITY_FAILURE_REASONS: string[] = Object.values(INTEGRITY_FAILURE);

/**
 * Rows registration may update: everything except CORRUPTED with an integrity-failure reason. Written as an OR so a
 * CORRUPTED row with no reason (SQL NULL) is still updatable.
 */
export const NOT_HELD_BY_INTEGRITY_FINDING: Prisma.RecordingSegmentWhereInput[] = [
  { status: { not: SegmentStatus.CORRUPTED } },
  { quarantineReason: null },
  { quarantineReason: { notIn: INTEGRITY_FAILURE_REASONS } },
];

/** True for a row the integrity check marked CORRUPTED because its file changed: its size and hash must not be refreshed. */
export const isHeldByIntegrityFinding = (row: { status: SegmentStatus; quarantineReason: string | null }): boolean =>
  row.status === SegmentStatus.CORRUPTED && row.quarantineReason !== null && INTEGRITY_FAILURE_REASONS.includes(row.quarantineReason);

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
  storageVolumeId?: string;
  storageEpochId?: string;
}

export class SegmentRepository {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Idempotently upserts a recording segment, one row per file path.
   *
   * A row the integrity check marked CORRUPTED because its file changed (`INTEGRITY_FAILURE_REASONS`) is held: it is
   * returned unchanged, never set back to FINALIZED and never given the changed file's hash or size. Without this the
   * crawler re-registered such a file a few minutes later and the finding was silently undone (audit F13). The
   * update is conditional in one statement, so an integrity failure recorded concurrently is not overwritten either.
   */
  async upsertSegment(input: UpsertSegmentInput): Promise<RecordingSegment> {
    for (let attempt = 0; ; attempt++) {
      const updated = await this.prisma.recordingSegment.updateMany({
        where: { filePath: input.filePath, OR: NOT_HELD_BY_INTEGRITY_FINDING },
        data: {
          endTime: input.endTime,
          durationMs: input.durationMs,
          sizeBytes: input.sizeBytes,
          sha256Hash: input.sha256Hash ?? undefined,
          endPts: input.endPts ?? undefined,
          keyframeIndexJson: input.keyframeIndexJson ?? undefined,
          status: input.status ?? undefined,
          storageVolumeId: input.storageVolumeId,
          storageEpochId: input.storageEpochId,
          // A file that could not be read earlier and can now (or the reverse) takes the new picture details and reason.
          codec: input.codec ?? null,
          width: input.width ?? null,
          height: input.height ?? null,
          fps: input.fps ?? null,
          quarantineReason: input.quarantineReason ?? null,
        },
      });
      if (updated.count > 0) return this.prisma.recordingSegment.findUniqueOrThrow({ where: { filePath: input.filePath } });

      const existing = await this.prisma.recordingSegment.findUnique({ where: { filePath: input.filePath } });
      if (existing) {
        console.warn(
          `[SegmentRepository] ${input.filePath}: not re-registered, segment ${existing.id} is held by an integrity finding (${existing.quarantineReason})`
        );
        return existing;
      }

      try {
        return await this.prisma.recordingSegment.create({
          data: {
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
            storageVolumeId: input.storageVolumeId,
            storageEpochId: input.storageEpochId,
          },
        });
      } catch (err) {
        // Another registration created the row between the update and the create: go round once more to update it.
        if (attempt === 0 && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
        throw err;
      }
    }
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

  /**
   * The FINALIZED segment that follows (or precedes) this one on the same camera, if it starts (ends) within
   * `maxGapMs` of this one's end (start): a frame step crosses a segment boundary, never a recording gap.
   */
  async findAdjacentSegment(segment: RecordingSegment, direction: 'FORWARD' | 'BACKWARD', maxGapMs: number): Promise<RecordingSegment | null> {
    if (direction === 'FORWARD') {
      return this.prisma.recordingSegment.findFirst({
        where: {
          cameraId: segment.cameraId,
          status: SERVABLE,
          id: { not: segment.id },
          startTime: { gte: new Date(segment.endTime.getTime() - maxGapMs), lte: new Date(segment.endTime.getTime() + maxGapMs) },
        },
        orderBy: { startTime: 'asc' },
      });
    }
    return this.prisma.recordingSegment.findFirst({
      where: {
        cameraId: segment.cameraId,
        status: SERVABLE,
        id: { not: segment.id },
        endTime: { gte: new Date(segment.startTime.getTime() - maxGapMs), lte: new Date(segment.startTime.getTime() + maxGapMs) },
      },
      orderBy: { endTime: 'desc' },
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
