import { PrismaClient, RecordingSegment, EvidencePin } from '@prisma/client';
import { StorageAdapter, LocalStorageAdapter } from './storageAdapter';
import { MediaProbeAdapter, FfprobeMediaAdapter } from './mediaProbeAdapter';
import { SegmentIndexer } from './segmentIndexer';
import { SegmentRepository } from './segmentRepository';
import { CoverageIndex, CoverageReport } from './coverageIndex';
import { EvidencePinRegistry } from './evidencePinRegistry';
import { RetentionPolicyEngine, RetentionPolicyConfig, PruneReport } from './retentionPolicy';
import { computeFileSha256 } from '../../../utils/crypto';
import config from '../../../config/env';

export interface RegisterSegmentInput {
  tenantId?: string;
  cameraId: string;
  filePath: string;
  startTime?: Date;
  endTime?: Date;
  durationMs?: number;
  sizeBytes?: bigint;
  sha256Hash?: string;
  codec?: string;
  width?: number;
  height?: number;
  fps?: number;
  startPts?: bigint;
  endPts?: bigint;
  timebaseNumerator?: number;
  timebaseDenominator?: number;
  keyframeIndexJson?: any;
  storageLocation?: string;
}

export interface SeekTargetResult {
  status: 'READY' | 'NO_RECORDING';
  segmentId?: string;
  segmentUri?: string;
  targetPts?: bigint;
  currentPts?: bigint;
  nearestKeyframePts?: bigint;
  offsetMs?: number;
  codec?: string;
  fps?: number;
  gapDurationMs?: number | null;
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
    let codec = input.codec;
    let width = input.width;
    let height = input.height;
    let fps = input.fps;
    let timebaseNum = input.timebaseNumerator ?? 1;
    let timebaseDen = input.timebaseDenominator ?? 90000;
    let keyframeIndex = input.keyframeIndexJson;

    // Probe file if critical metadata is missing
    if (!durationMs || !codec || !fps) {
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
      }
    }

    const safeDurationMs = durationMs ?? 1000;
    const startTime = input.startTime ?? new Date(fileStat.mtime.getTime() - safeDurationMs);
    const endTime = input.endTime ?? new Date(startTime.getTime() + safeDurationMs);

    // Compute presentation timestamps
    const startPts = input.startPts ?? 0n;
    const ptsDelta = SegmentIndexer.calculatePtsDelta(safeDurationMs, timebaseNum, timebaseDen);
    const endPts = input.endPts ?? (startPts + ptsDelta);

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
      codec: codec || 'h264',
      width: width || 1920,
      height: height || 1080,
      fps: fps || 25.0,
      startPts,
      endPts,
      timebaseNumerator: timebaseNum,
      timebaseDenominator: timebaseDen,
      keyframeIndexJson: keyframeIndex || null,
      storageLocation: input.storageLocation || 'LOCAL',
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
        codec: containing.codec || 'h264',
        fps: containing.fps || 25.0,
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
        codec: nearest.codec || 'h264',
        fps: nearest.fps || 25.0,
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
    const fallbackDelta = SegmentIndexer.calculateFallbackFrameDelta(
      segment.fps || 25.0,
      segment.timebaseNumerator,
      segment.timebaseDenominator
    );

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
   * Low-frequency self-healing crawler: reconciles disk files into catalog
   */
  async reconcileFilesystem(): Promise<number> {
    if (this.isReconciling) return 0;
    this.isReconciling = true;

    let indexedCount = 0;
    try {
      const recordingsDir = config.RECORDINGS_DIR || '/var/lib/vigilone/recordings';
      const files = await this.storageAdapter.scanDirectory(recordingsDir);

      for (const filePath of files) {
        // e.g. .../{cameraId}/2026-09-04_01-30-00-123456.mp4
        const parts = filePath.split('/');
        const fileName = parts[parts.length - 1];
        const candidateCamId = parts[parts.length - 2];

        const camera = await this.prisma.camera.findFirst({
          where: { OR: [{ id: candidateCamId }, { streamPath: candidateCamId }] },
          select: { id: true, tenantId: true },
        });

        if (!camera) continue;

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
