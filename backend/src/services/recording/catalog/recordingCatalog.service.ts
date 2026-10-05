import fs from 'fs';
import path from 'path';
import { PrismaClient, RecordingSegment, EvidencePin, SegmentStatus } from '@prisma/client';
import { StorageAdapter, LocalStorageAdapter } from './storageAdapter';
import { MediaProbeAdapter, FfprobeMediaAdapter } from './mediaProbeAdapter';
import { SegmentIndexer } from './segmentIndexer';
import { SegmentRepository } from './segmentRepository';
import { CoverageIndex, CoverageReport } from './coverageIndex';
import { EvidencePinRegistry } from './evidencePinRegistry';
import { RetentionPolicyEngine, RetentionPolicyConfig, PruneReport } from './retentionPolicy';
import { computeFileSha256 } from '../../../utils/crypto';
import { parseSegmentFilenameTimestamp } from '../../../utils/segmentPath';
import { isWithinActiveWriteGrace } from '../../reconciliation/crashRecovery.service';
import { setting } from '../../../config/settings';

export interface RegisterSegmentInput {
  tenantId?: string;
  cameraId: string;
  filePath: string;
  startTime?: Date;
  endTime?: Date;
  durationMs?: number;
  sizeBytes?: bigint;
  sha256Hash?: string;
  codec?: string | null;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  startPts?: bigint;
  endPts?: bigint;
  timebaseNumerator?: number;
  timebaseDenominator?: number;
  keyframeIndexJson?: any;
  storageLocation?: string;
  storageVolumeId?: string;
  storageEpochId?: string;
}

export interface SeekTargetResult {
  status: 'READY' | 'NO_RECORDING';
  segmentId?: string;
  segmentUri?: string;
  targetPts?: bigint;
  currentPts?: bigint;
  nearestKeyframePts?: bigint;
  offsetMs?: number;
  /** null = the segment has no recorded value; nothing is assumed (no h264, no 25 fps). */
  codec?: string | null;
  fps?: number | null;
  gapDurationMs?: number | null;
}

/**
 * A frame step needs the segment's frame rate (or a real keyframe to step to). When neither is known the step is
 * refused with this error instead of assuming 25 fps. HTTP 409, code FRAME_RATE_UNKNOWN.
 */
export class FrameStepUnavailableError extends Error {
  readonly code = 'FRAME_RATE_UNKNOWN';
  readonly statusCode = 409;
  constructor(detail: string) {
    super(`FRAME_RATE_UNKNOWN: ${detail}`);
  }
}

export interface StepFrameResult {
  segmentId: string;
  newPts: bigint;
  frameDeltaPts: bigint;
}

export class RecordingCatalog {
  private prisma: PrismaClient;
  private storageAdapter: StorageAdapter;
  private mediaProbeAdapter: MediaProbeAdapter;
  private segmentRepo: SegmentRepository;
  private pinRegistry: EvidencePinRegistry;
  private retentionEngine: RetentionPolicyEngine;

  private reconcilerTimer: NodeJS.Timeout | null = null;
  private retentionTimer: NodeJS.Timeout | null = null;
  private isReconciling = false;

  constructor(
    prisma: PrismaClient,
    storageAdapter?: StorageAdapter,
    mediaProbeAdapter?: MediaProbeAdapter
  ) {
    this.prisma = prisma;
    this.storageAdapter = storageAdapter || new LocalStorageAdapter();
    this.mediaProbeAdapter = mediaProbeAdapter || new FfprobeMediaAdapter();
    this.segmentRepo = new SegmentRepository(prisma);
    this.pinRegistry = new EvidencePinRegistry(prisma);
    this.retentionEngine = new RetentionPolicyEngine(
      prisma,
      this.segmentRepo,
      this.pinRegistry,
      this.storageAdapter
    );
  }

  /**
   * Idempotently registers a recorded segment into the catalog.
   * Probes metadata when missing and maps media presentation timestamps (PTS).
   */
  async registerSegment(input: RegisterSegmentInput): Promise<RecordingSegment> {
    const fileStat = await this.storageAdapter.stat(input.filePath);
    const sizeBytes = input.sizeBytes ?? BigInt(fileStat.size);

    let durationMs = input.durationMs;
    let codec: string | null | undefined = input.codec;
    let width: number | null | undefined = input.width;
    let height: number | null | undefined = input.height;
    let fps: number | null | undefined = input.fps;
    let timebaseNum = input.timebaseNumerator ?? 1;
    let timebaseDen = input.timebaseDenominator ?? 90000;
    let keyframeIndex = input.keyframeIndexJson;

    // Probe file if critical metadata is missing
    let probeFailed = false;
    if (fileStat.exists && fileStat.size > 0 && (!durationMs || !codec || !fps)) {
      const probe = await this.mediaProbeAdapter.probeMedia(input.filePath);
      if (probe) {
        durationMs = durationMs ?? probe.durationMs;
        codec = codec ?? probe.codec;
        width = width ?? probe.width;
        height = height ?? probe.height;
        fps = fps ?? probe.fps;
        timebaseNum = probe.timebaseNumerator;
        timebaseDen = probe.timebaseDenominator;
        keyframeIndex = keyframeIndex ?? probe.keyframeIndex;
      } else {
        probeFailed = true;
      }
    }

    // The same classes boot recovery uses: a file that is missing, empty or unreadable is not a recorded segment.
    // It is kept as a row so it can be found and recovered, but it never counts as footage and nothing about it is
    // invented (no duration, size of picture, frame rate or codec). A caller-supplied duration (the recorder's own
    // figure) is the one thing that makes an unprobed file usable.
    let unusable: { status: SegmentStatus; reason: string } | null = null;
    if (!fileStat.exists) unusable = { status: SegmentStatus.FILE_MISSING, reason: 'FILE_NOT_FOUND_AT_REGISTRATION' };
    else if (fileStat.size === 0) unusable = { status: SegmentStatus.CORRUPTED, reason: 'ZERO_BYTE' };
    else if (probeFailed && !input.durationMs) unusable = { status: SegmentStatus.CORRUPTED, reason: 'UNREADABLE_MEDIA' };

    // The real keyframes, read once per file. No index (null) when they cannot be read; seek then uses the
    // segment start and says nothing finer.
    if (!unusable && !keyframeIndex && this.mediaProbeAdapter.probeKeyframes) {
      keyframeIndex = (await this.mediaProbeAdapter.probeKeyframes(input.filePath)) ?? undefined;
    }

    const safeDurationMs = unusable ? 0 : durationMs ?? 0;
    let startTime = input.startTime;
    if (!startTime) {
      try {
        startTime = parseSegmentFilenameTimestamp(input.filePath);
      } catch {
        startTime = new Date(fileStat.mtime.getTime() - safeDurationMs);
      }
    }
    const endTime = unusable ? startTime : input.endTime ?? new Date(startTime.getTime() + safeDurationMs);

    // Compute presentation timestamps
    const startPts = input.startPts ?? 0n;
    const ptsDelta = SegmentIndexer.calculatePtsDelta(safeDurationMs, timebaseNum, timebaseDen);
    const endPts = unusable ? startPts : input.endPts ?? (startPts + ptsDelta);

    let sha256 = input.sha256Hash;
    if (!sha256 && fileStat.exists && fileStat.size > 0) {
      try {
        sha256 = await computeFileSha256(input.filePath);
      } catch {
        sha256 = undefined;
      }
    }

    return this.segmentRepo.upsertSegment({
      tenantId: input.tenantId,
      cameraId: input.cameraId,
      filePath: input.filePath,
      startTime,
      endTime,
      durationMs: safeDurationMs,
      sizeBytes,
      sha256Hash: sha256,
      codec: codec ?? null,
      width: width ?? null,
      height: height ?? null,
      fps: fps ?? null,
      status: unusable ? unusable.status : SegmentStatus.FINALIZED,
      quarantineReason: unusable ? unusable.reason : null,
      startPts,
      endPts,
      timebaseNumerator: timebaseNum,
      timebaseDenominator: timebaseDen,
      keyframeIndexJson: unusable ? null : keyframeIndex || null,
      storageLocation: input.storageLocation || 'LOCAL',
      storageVolumeId: input.storageVolumeId,
      storageEpochId: input.storageEpochId,
    });
  }

  /**
   * Finds all segments for a camera overlapping a UTC time range
   */
  async findSegments(cameraId: string, startUtc: Date, endUtc: Date): Promise<RecordingSegment[]> {
    return this.segmentRepo.findSegments(cameraId, startUtc, endUtc);
  }

  /**
   * Finds authoritative seek target mapping UTC wall-clock time to media PTS and keyframe
   */
  async findSeekTarget(cameraId: string, targetUtc: Date): Promise<SeekTargetResult> {
    const containing = await this.segmentRepo.findContainingSegment(cameraId, targetUtc);

    if (containing) {
      const elapsedMs = Math.max(0, targetUtc.getTime() - containing.startTime.getTime());
      const ptsDelta = SegmentIndexer.calculatePtsDelta(
        elapsedMs,
        containing.timebaseNumerator,
        containing.timebaseDenominator
      );
      const targetPts = containing.startPts + ptsDelta;

      const keyframes = containing.keyframeIndexJson as any[] | undefined;
      const nearestKeyframePts = SegmentIndexer.findNearestPrecedingKeyframe(
        keyframes,
        targetPts,
        containing.startPts
      );

      return {
        status: 'READY',
        segmentId: containing.id,
        segmentUri: containing.filePath,
        targetPts,
        currentPts: targetPts,
        nearestKeyframePts,
        offsetMs: elapsedMs,
        codec: containing.codec ?? null,
        fps: containing.fps ?? null,
        gapDurationMs: null,
      };
    }

    // Target is in a gap: find nearest segment to determine boundary distance
    const nearest = await this.segmentRepo.findNearestSegment(cameraId, targetUtc);
    if (nearest) {
      const gapDurationMs =
        targetUtc.getTime() > nearest.endTime.getTime()
          ? targetUtc.getTime() - nearest.endTime.getTime()
          : Math.max(0, nearest.startTime.getTime() - targetUtc.getTime());
      return {
        status: 'NO_RECORDING',
        segmentId: nearest.id,
        segmentUri: nearest.filePath,
        targetPts: nearest.startPts,
        currentPts: nearest.startPts,
        nearestKeyframePts: nearest.startPts,
        offsetMs: 0,
        codec: nearest.codec ?? null,
        fps: nearest.fps ?? null,
        gapDurationMs,
      };
    }

    return {
      status: 'NO_RECORDING',
      gapDurationMs: null,
    };
  }

  /**
   * Steps to the adjacent frame forward or backward without assuming constant frame rate
   */
  async stepToAdjacentFrame(
    cameraId: string,
    segmentId: string,
    currentPts: bigint,
    direction: 'FORWARD' | 'BACKWARD'
  ): Promise<StepFrameResult> {
    const segment = await this.segmentRepo.findById(segmentId);
    if (!segment) {
      throw new Error(`Segment not found: ${segmentId}`);
    }

    const keyframes = segment.keyframeIndexJson as any[] | undefined;
    const fpsKnown = segment.fps != null && segment.fps > 0;
    if (!fpsKnown && !(keyframes && keyframes.length > 1)) {
      throw new FrameStepUnavailableError(`segment ${segment.id} has no recorded frame rate and no keyframe index`);
    }
    const fallbackDelta = fpsKnown
      ? SegmentIndexer.calculateFallbackFrameDelta(segment.fps as number, segment.timebaseNumerator, segment.timebaseDenominator)
      : 0n;

    const step = SegmentIndexer.calculateAdjacentFramePts(
      keyframes,
      currentPts,
      direction,
      segment.startPts,
      segment.endPts,
      fallbackDelta
    );

    return {
      segmentId: segment.id,
      newPts: step.newPts,
      frameDeltaPts: step.frameDeltaPts,
    };
  }

  /**
   * Computes wall-clock coverage blocks and detects gaps for a camera
   */
  async getCoverage(
    cameraId: string,
    startUtc: Date,
    endUtc: Date,
    gapThresholdMs = 2000
  ): Promise<CoverageReport> {
    const segments = await this.segmentRepo.findSegments(cameraId, startUtc, endUtc);
    return CoverageIndex.calculateCoverage(cameraId, segments, startUtc, endUtc, gapThresholdMs);
  }

  /**
   * Places an immutable hold on a segment
   */
  async pinSegment(
    tenantId: string,
    segmentId: string,
    exportJobId: string,
    reason: string,
    durationDays = 365,
    pinType = 'TEMPORARY_EXPORT'
  ): Promise<EvidencePin> {
    return this.pinRegistry.pinSegment(tenantId, segmentId, exportJobId, reason, durationDays, pinType);
  }

  /**
   * Releases temporary export pins associated with an export job.
   * INVARIANT: Never releases legal hold pins.
   */
  async releaseExportPins(exportJobId: string): Promise<number> {
    return this.pinRegistry.releaseExportPins(exportJobId);
  }

  /**
   * Releases legal hold pins for a manifest upon authorized release.
   */
  async releaseLegalHoldPins(tenantId: string, manifestId: string): Promise<number> {
    return this.pinRegistry.releaseLegalHoldPins(tenantId, manifestId);
  }

  /**
   * Explicitly releases a specific pin by ID.
   */
  async releasePin(pinId: string): Promise<void> {
    return this.pinRegistry.releasePin(pinId);
  }

  /**
   * Checks whether a segment is actively pinned
   */
  async isPinned(segmentId: string): Promise<boolean> {
    return this.pinRegistry.isPinned(segmentId);
  }

  /**
   * Returns a set of segment IDs that are actively pinned
   */
  async getPinnedSegmentIds(segmentIds: string[]): Promise<Set<string>> {
    return this.pinRegistry.getPinnedSegmentIds(segmentIds);
  }

  /**
   * Prunes expired or quota-exceeded footage respecting active evidence pins
   */
  async pruneRetention(tenantId: string, policy: RetentionPolicyConfig): Promise<PruneReport> {
    return this.retentionEngine.pruneRetention(tenantId, policy);
  }

  /**
   * Starts low-frequency filesystem reconciliation crawler
   */
  startReconciler(intervalMs = 300000): void {
    if (this.reconcilerTimer) return;
    this.reconcilerTimer = setInterval(() => {
      this.reconcileFilesystem().catch((err) => {
        console.error('[RecordingCatalog] Reconciler scan error:', err.message);
      });
    }, intervalMs);

    // Initial immediate scan
    this.reconcileFilesystem().catch(() => {});
  }

  /**
   * Starts periodic retention evaluation worker
   */
  startRetention(intervalMs = 3600000): void {
    if (this.retentionTimer) return;
    this.retentionTimer = setInterval(async () => {
      try {
        const tenants = await this.prisma.tenant.findMany({ select: { id: true } });
        for (const t of tenants) {
          await this.pruneRetention(t.id, { maxRetentionDays: 30 });
        }
      } catch (err: any) {
        console.error('[RecordingCatalog] Scheduled retention prune error:', err.message);
      }
    }, intervalMs);
  }

  /**
   * Stops all active background workers
   */
  stop(): void {
    if (this.reconcilerTimer) {
      clearInterval(this.reconcilerTimer);
      this.reconcilerTimer = null;
    }
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = null;
    }
  }

  /**
   * Rows already in the catalog for these files, loaded in batches (one query per few thousand files, not per file).
   */
  private async knownSegments(files: string[]): Promise<Map<string, { status: SegmentStatus; sizeBytes: bigint }>> {
    const known = new Map<string, { status: SegmentStatus; sizeBytes: bigint }>();
    if (typeof (this.prisma as any).recordingSegment?.findMany !== 'function') return known;
    const CHUNK = 2000;
    for (let i = 0; i < files.length; i += CHUNK) {
      const rows = await this.prisma.recordingSegment.findMany({
        where: { filePath: { in: files.slice(i, i + CHUNK) } },
        select: { filePath: true, status: true, sizeBytes: true },
      });
      for (const r of rows) known.set(r.filePath, { status: r.status, sizeBytes: r.sizeBytes });
    }
    return known;
  }

  /**
   * Low-frequency self-healing crawler: reconciles disk files into catalog.
   *
   * It is cheap on a healthy disk (audit finding F2): a file whose row is already FINALIZED with the same size is
   * not probed or hashed again. Only new files, files that changed size, and files not yet usable (corrupt,
   * missing) are read, so the crawl does not compete with recording for disk time. Re-checking the content hash of
   * old files is a separate, slower job and is not done here.
   */
  async reconcileFilesystem(): Promise<number> {
    if (this.isReconciling) return 0;
    this.isReconciling = true;

    let indexedCount = 0;
    try {
      const recordingsDir = setting('RECORDINGS_DIR');
      const files = await this.storageAdapter.scanDirectory(recordingsDir);
      const known = await this.knownSegments(files);
      const cameraByDir = new Map<string, { id: string; tenantId: string } | null>();

      for (const filePath of files) {
        // e.g. .../{cameraId}/2026-09-04_01-30-00-123456.mp4
        const parts = filePath.split('/');
        const fileName = parts[parts.length - 1];
        const candidateCamId = parts[parts.length - 2];

        const existing = known.get(filePath);
        if (existing?.status === SegmentStatus.FINALIZED) {
          const st = await this.storageAdapter.stat(filePath);
          if (st.exists && BigInt(st.size) === existing.sizeBytes) continue;
        }

        let camera = cameraByDir.get(candidateCamId);
        if (camera === undefined) {
          camera = await this.prisma.camera.findFirst({
            where: { OR: [{ id: candidateCamId }, { streamPath: candidateCamId }] },
            select: { id: true, tenantId: true },
          });
          cameraByDir.set(candidateCamId, camera);
        }

        if (!camera) {
          // Admission Control (C-018): unmappable files must be isolated to .quarantine and never indexed.
          // Never move a file the recorder may still be writing (same grace as crash recovery).
          try {
            if (isWithinActiveWriteGrace(fs.statSync(filePath).mtimeMs)) continue;
          } catch {
            continue;
          }
          const dir = path.dirname(filePath);
          const qDir = path.join(dir, '.quarantine');
          if (!fs.existsSync(qDir)) {
            try { fs.mkdirSync(qDir, { recursive: true }); } catch {}
          }
          try {
            fs.renameSync(filePath, path.join(qDir, fileName));
          } catch {}
          continue;
        }

        // A file modified inside the active-write grace may still be open in the recorder (the same rule boot
        // recovery uses). It is indexed on a later pass, or by the segment-complete job, once it is finished.
        try {
          if (isWithinActiveWriteGrace((await this.storageAdapter.stat(filePath)).mtime.getTime())) continue;
        } catch {
          continue;
        }

        await this.registerSegment({
          tenantId: camera.tenantId,
          cameraId: camera.id,
          filePath,
        });
        indexedCount++;
      }
    } finally {
      this.isReconciling = false;
    }

    return indexedCount;
  }
}

export default RecordingCatalog;
