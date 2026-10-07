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
import { SegmentIntegrityVerifier } from './segmentIntegrity';
import { SegmentSealer } from './segmentSeal';
import { FeatureFlag, isFeatureEnabled } from '../../../config/featureFlags';
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

/** A segment is only compared with its file clock while the file is this fresh (a restore from backup resets mtimes). */
const CLOCK_CHECK_FRESH_MS = 3600_000;
/** Segment end per its file name versus the file's last write: more than this apart means a clock or time zone problem. */
const CLOCK_TOLERANCE_MS = 5 * 60_000;
const CLOCK_WARNING_TITLE = 'Segment time does not match the file clock';
/** Integrity failures that already said a sealed segment's content changed (ADR 0018). */
const SEAL_CONFLICT_REASONS = new Set(['DIFFERS_FROM_SEAL', 'DB_HASH_DIFFERS_FROM_SEAL', 'HASH_MISMATCH']);

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
  /** The segment the new frame is in: the next or previous one when the step crosses a segment boundary. */
  segmentId: string;
  newPts: bigint;
  frameDeltaPts: bigint;
  /** Wall-clock time of the new frame, rounded UP to the millisecond so a seek to it lands on that frame. */
  utc: Date;
  /** EXACT: the next real frame in the file. APPROXIMATE: estimated from the frame rate (the file could not be read). */
  precision: 'EXACT' | 'APPROXIMATE';
  /** True when there is no further frame in that direction (start or end of the recording): the position did not move. */
  clamped: boolean;
}

/** Frame times are read this far (seconds) either side of the position; widened for a very low frame rate. */
const FRAME_WINDOW_SECONDS = [2, 8, 30];
/** A step crosses into a neighbouring segment only when the recording is continuous (no gap longer than this). */
const SEGMENT_JOIN_GAP_MS = 2000;
const utcOfFrame = (segment: RecordingSegment, pts: bigint): Date =>
  new Date(segment.startTime.getTime() + Math.ceil(Number(pts - segment.startPts) / 90));

export class RecordingCatalog {
  private prisma: PrismaClient;
  private storageAdapter: StorageAdapter;
  private mediaProbeAdapter: MediaProbeAdapter;
  private segmentRepo: SegmentRepository;
  private pinRegistry: EvidencePinRegistry;
  private retentionEngine: RetentionPolicyEngine;
  private sealer: SegmentSealer;

  private reconcilerTimer: NodeJS.Timeout | null = null;
  private retentionTimer: NodeJS.Timeout | null = null;
  private integrityTimer: NodeJS.Timeout | null = null;
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
    this.sealer = new SegmentSealer(prisma);
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

    // A segment that has just finished should end about when its file was last written. A big difference means the
    // recorder's clock or time zone is wrong. It is reported, never corrected: nothing may rewrite the evidence clock.
    if (!unusable && fileStat.exists && Date.now() - fileStat.mtime.getTime() < CLOCK_CHECK_FRESH_MS) {
      const driftMs = fileStat.mtime.getTime() - endTime.getTime();
      if (Math.abs(driftMs) > CLOCK_TOLERANCE_MS) {
        await this.noteClockMismatch(input.cameraId, input.filePath, endTime, fileStat.mtime, driftMs);
      }
    }

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

    // Checked whenever a seal exists, even with sealing switched off since: a sealed segment keeps its first hash.
    const sealConflict = unusable ? null : await this.findSealConflict(input.filePath, sha256);

    const segment = await this.segmentRepo.upsertSegment({
      tenantId: input.tenantId,
      cameraId: input.cameraId,
      filePath: input.filePath,
      startTime,
      endTime,
      durationMs: safeDurationMs,
      sizeBytes,
      sha256Hash: sealConflict ? undefined : sha256,
      codec: codec ?? null,
      width: width ?? null,
      height: height ?? null,
      fps: fps ?? null,
      status: unusable ? unusable.status : sealConflict ? SegmentStatus.CORRUPTED : SegmentStatus.FINALIZED,
      quarantineReason: unusable ? unusable.reason : sealConflict ? 'DIFFERS_FROM_SEAL' : null,
      startPts,
      endPts,
      timebaseNumerator: timebaseNum,
      timebaseDenominator: timebaseDen,
      keyframeIndexJson: unusable ? null : keyframeIndex || null,
      storageLocation: input.storageLocation || 'LOCAL',
      storageVolumeId: input.storageVolumeId,
      storageEpochId: input.storageEpochId,
    });
    if (sealConflict) {
      if (!sealConflict.alreadyReported) await this.reportSealConflict(segment, sha256!, sealConflict);
    } else if (isFeatureEnabled(FeatureFlag.FOOTAGE_SEALING)) {
      // Never throws: recording does not depend on sealing.
      await this.sealer.sealQuietly(segment);
    }
    return segment;
  }

  /**
   * A file registered again whose hash differs from its segment's seal (ADR 0018). The first hash wins: the row keeps its
   * stored hash and becomes CORRUPTED instead of taking the new one. Reported once; the crawler re-registers unusable
   * files every pass and must not raise the alarm again each time. A file that matches its repaired hash is not a conflict.
   */
  private async findSealConflict(filePath: string, sha256: string | undefined): Promise<{ sealSha256: string; sealSequence: number; alreadyReported: boolean } | null> {
    if (!sha256 || typeof (this.prisma as any).segmentSeal?.findUnique !== 'function') return null;
    const existing = await this.prisma.recordingSegment.findUnique({
      where: { filePath },
      select: { id: true, status: true, quarantineReason: true, repairedSha256: true },
    });
    if (!existing || existing.repairedSha256 === sha256) return null;
    const seal = await this.prisma.segmentSeal.findUnique({ where: { segmentId: existing.id }, select: { mediaSha256: true, sequence: true } });
    if (!seal || seal.mediaSha256 === sha256) return null;
    const alreadyReported = existing.status === SegmentStatus.CORRUPTED && SEAL_CONFLICT_REASONS.has(existing.quarantineReason ?? '');
    return { sealSha256: seal.mediaSha256, sealSequence: seal.sequence, alreadyReported };
  }

  private async reportSealConflict(segment: RecordingSegment, foundSha256: string, conflict: { sealSha256: string; sealSequence: number }): Promise<void> {
    try {
      const camera = await this.prisma.camera.findUnique({ where: { id: segment.cameraId }, select: { tenantId: true } });
      await new SegmentIntegrityVerifier(this.prisma, this.storageAdapter).reportFailure(
        { ...segment, camera },
        SegmentStatus.CORRUPTED,
        'DIFFERS_FROM_SEAL',
        { sealedSha256: conflict.sealSha256, foundSha256, sealSequence: conflict.sealSequence },
      );
    } catch (err: any) {
      console.error(`[RecordingCatalog] segment ${segment.id} differs from its seal and could not be reported: ${err.message}`);
    }
  }

  /** One warning per camera per hour, however many segments are off. Never throws: indexing must not fail on a report. */
  private async noteClockMismatch(cameraId: string, filePath: string, endTime: Date, mtime: Date, driftMs: number): Promise<void> {
    const minutes = Math.round(Math.abs(driftMs) / 60000);
    console.warn(`[RecordingCatalog] ${filePath}: name says the segment ended ${endTime.toISOString()}, file last written ${mtime.toISOString()} (${minutes} min apart)`);
    try {
      if (typeof (this.prisma as any).event?.findFirst !== 'function') return;
      const recent = await this.prisma.event.findFirst({
        where: { cameraId, type: 'RECORDING_FAILURE', title: CLOCK_WARNING_TITLE, firstDetectedAt: { gte: new Date(Date.now() - 3600_000) } },
        select: { id: true },
      });
      if (recent) return;
      await this.prisma.event.create({
        data: {
          cameraId,
          type: 'RECORDING_FAILURE',
          severity: 'WARNING',
          title: CLOCK_WARNING_TITLE,
          description:
            `The file name says this segment ended at ${endTime.toISOString()} (read as UTC) but the file was last written at ${mtime.toISOString()}, ` +
            `${minutes} minutes ${driftMs > 0 ? 'later' : 'earlier'}. The recorder's time zone or clock may be wrong: check that the MediaMTX container runs ` +
            `with TZ=UTC and that the appliance clock is correct. Recorded times have not been changed. ${filePath}`,
          metadata: { filePath, nameEndUtc: endTime.toISOString(), fileWrittenUtc: mtime.toISOString(), driftMs } as any,
        },
      });
    } catch (err: any) {
      console.error('[RecordingCatalog] could not raise the clock warning:', err.message);
    }
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
   * Steps to the neighbouring frame, forward or backward, from the real frame times in the file: exact on constant
   * and variable frame rate. "Current frame" is the last frame at or before `currentPts` (what is on screen).
   * At the end of a segment the step continues into the next one when the recording is continuous; at the start or
   * end of the recording it stays put with `clamped: true`. If the file cannot be read it estimates from the frame
   * rate and says APPROXIMATE; with no frame rate it refuses (FRAME_RATE_UNKNOWN).
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

    const exact = await this.exactStep(segment, currentPts, direction);
    if (exact) return exact;

    const fpsKnown = segment.fps != null && segment.fps > 0;
    if (!fpsKnown) {
      throw new FrameStepUnavailableError(`segment ${segment.id} cannot be read and has no recorded frame rate`);
    }
    const delta = SegmentIndexer.calculateFallbackFrameDelta(segment.fps as number, segment.timebaseNumerator, segment.timebaseDenominator);
    const raw = direction === 'FORWARD' ? currentPts + delta : currentPts - delta;
    const newPts = raw < segment.startPts ? segment.startPts : raw > segment.endPts ? segment.endPts : raw;
    return {
      segmentId: segment.id,
      newPts,
      frameDeltaPts: newPts > currentPts ? newPts - currentPts : currentPts - newPts,
      utc: utcOfFrame(segment, newPts),
      precision: 'APPROXIMATE',
      clamped: newPts === currentPts,
    };
  }

  /** The real frames of a segment around a position, widening the window until a frame on the needed side is found. */
  private async framesAround(segment: RecordingSegment, centerPts: bigint, direction: 'FORWARD' | 'BACKWARD'): Promise<bigint[] | null> {
    if (!this.mediaProbeAdapter.probeFrameTimes) return null;
    if (!(await this.storageAdapter.stat(segment.filePath)).exists) return null;
    let frames: bigint[] | null = null;
    for (const span of FRAME_WINDOW_SECONDS) {
      frames = await this.mediaProbeAdapter.probeFrameTimes(segment.filePath, centerPts, span);
      if (!frames) return null;
      const idx = frames.reduce((n, f, i) => (f <= centerPts ? i : n), -1);
      if (direction === 'FORWARD' ? idx >= 0 && idx + 1 < frames.length : idx >= 1) return frames;
    }
    return frames;
  }

  private async exactStep(segment: RecordingSegment, currentPts: bigint, direction: 'FORWARD' | 'BACKWARD'): Promise<StepFrameResult | null> {
    const frames = await this.framesAround(segment, currentPts, direction);
    if (!frames || frames.length === 0) return null;
    const idx = frames.reduce((n, f, i) => (f <= currentPts ? i : n), -1);
    const currentFrame = idx >= 0 ? frames[idx] : currentPts;
    const target = direction === 'FORWARD' ? frames[idx + 1] : idx >= 1 ? frames[idx - 1] : undefined;

    if (target !== undefined && target !== currentFrame) {
      return {
        segmentId: segment.id,
        newPts: target,
        frameDeltaPts: target > currentFrame ? target - currentFrame : currentFrame - target,
        utc: utcOfFrame(segment, target),
        precision: 'EXACT',
        clamped: false,
      };
    }

    // No further frame in this segment: continue into the neighbouring one when the recording is continuous.
    const next = await this.segmentRepo.findAdjacentSegment(segment, direction, SEGMENT_JOIN_GAP_MS);
    if (next) {
      let newPts: bigint | undefined;
      if (direction === 'FORWARD') {
        newPts = next.startPts;
      } else {
        const endFrames = await this.framesAround(next, next.endPts, 'BACKWARD');
        newPts = endFrames && endFrames.length > 0 ? endFrames[endFrames.length - 1] : undefined;
      }
      if (newPts !== undefined) {
        return {
          segmentId: next.id,
          newPts,
          frameDeltaPts: 0n,
          utc: utcOfFrame(next, newPts),
          precision: 'EXACT',
          clamped: false,
        };
      }
    }

    return {
      segmentId: segment.id,
      newPts: currentFrame,
      frameDeltaPts: 0n,
      utc: utcOfFrame(segment, currentFrame),
      precision: 'EXACT',
      clamped: true,
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
   * Starts the periodic integrity check of recorded segments (presence and size every run, content hash within a
   * byte budget). `intervalMs` 0 turns it off. Settings: INTEGRITY_PRESENCE_BATCH, INTEGRITY_HASH_MB_PER_RUN.
   */
  startIntegrityChecks(intervalMs = setting('INTEGRITY_CHECK_INTERVAL_SECONDS') * 1000): void {
    if (this.integrityTimer || intervalMs <= 0) return;
    const verifier = new SegmentIntegrityVerifier(this.prisma, this.storageAdapter);
    this.integrityTimer = setInterval(() => {
      verifier
        .runCycle({ presenceBatch: setting('INTEGRITY_PRESENCE_BATCH'), hashBudgetBytes: setting('INTEGRITY_HASH_MB_PER_RUN') * 1_000_000 })
        .catch((err) => console.error('[RecordingCatalog] Integrity check error:', err.message));
    }, intervalMs);
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
    if (this.integrityTimer) {
      clearInterval(this.integrityTimer);
      this.integrityTimer = null;
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
