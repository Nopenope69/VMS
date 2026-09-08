import { PrismaClient, RecordingSegment } from '@prisma/client';
import { RecordingCatalog, SeekTargetResult } from './catalog/recordingCatalog.service';

export { RecordingCatalog } from './catalog/recordingCatalog.service';

export interface KeyframeMetadata {
  pts: number;
  offsetMs: number;
  isKeyframe: boolean;
}

export interface IndexSegmentInput {
  tenantId: string;
  cameraId: string;
  segmentUri: string;
  startUtc: Date;
  endUtc: Date;
  startPts?: bigint;
  endPts?: bigint;
  timebaseNumerator?: number;
  timebaseDenominator?: number;
  codec?: string;
  width?: number;
  height?: number;
  fps?: number;
  keyframeIndexJson?: KeyframeMetadata[];
  storageLocation?: string;
}

/**
 * @deprecated Use RecordingCatalog from ./catalog/recordingCatalog.service instead.
 */
export class RecordingIndexService {
  private catalog: RecordingCatalog;

  constructor(prisma: PrismaClient, catalog?: RecordingCatalog) {
    this.catalog = catalog || new RecordingCatalog(prisma);
  }

  public async indexSegment(input: IndexSegmentInput): Promise<RecordingSegment> {
    if (input.endUtc.getTime() < input.startUtc.getTime()) {
      throw new Error('endUtc cannot be earlier than startUtc');
    }

    return this.catalog.registerSegment({
      tenantId: input.tenantId,
      cameraId: input.cameraId,
      filePath: input.segmentUri,
      startTime: input.startUtc,
      endTime: input.endUtc,
      startPts: input.startPts,
      endPts: input.endPts,
      timebaseNumerator: input.timebaseNumerator,
      timebaseDenominator: input.timebaseDenominator,
      codec: input.codec,
      width: input.width,
      height: input.height,
      fps: input.fps,
      keyframeIndexJson: input.keyframeIndexJson,
      storageLocation: input.storageLocation,
    });
  }

  public async findSeekTarget(tenantId: string, cameraId: string, targetUtc: Date): Promise<{
    found: boolean;
    isGap: boolean;
    segment?: any;
    targetPts?: bigint;
    nearestKeyframePts?: bigint;
    deltaMsFromStart?: number;
    gapDurationMs?: number | null;
  }> {
    const res: SeekTargetResult = await this.catalog.findSeekTarget(cameraId, targetUtc);
    return {
      found: res.status === 'READY',
      isGap: res.status === 'NO_RECORDING',
      segment: res.segmentId
        ? {
            id: res.segmentId,
            segmentUri: res.segmentUri,
            filePath: res.segmentUri,
            codec: res.codec,
            fps: res.fps,
          }
        : undefined,
      targetPts: res.targetPts,
      nearestKeyframePts: res.nearestKeyframePts,
      deltaMsFromStart: res.offsetMs,
      gapDurationMs: res.gapDurationMs,
    };
  }

  public async findSegments(
    tenantId: string,
    cameraId: string,
    startUtc: Date,
    endUtc: Date
  ): Promise<RecordingSegment[]> {
    return this.catalog.findSegments(cameraId, startUtc, endUtc);
  }

  public async getRecordingCoverage(
    tenantId: string,
    cameraId: string,
    startUtc: Date,
    endUtc: Date,
    gapThresholdMs = 2000
  ): Promise<any> {
    return this.catalog.getCoverage(cameraId, startUtc, endUtc, gapThresholdMs);
  }

  public async stepFrame(
    segmentId: string,
    currentPts: bigint,
    direction: 'FORWARD' | 'BACKWARD',
    cameraId = 'default'
  ): Promise<{
    segmentId: string;
    newPts: bigint;
    direction: 'FORWARD' | 'BACKWARD';
    clamped: boolean;
    frameDeltaPts: bigint;
  }> {
    const res = await this.catalog.stepToAdjacentFrame(cameraId, segmentId, currentPts, direction);
    return {
      segmentId: res.segmentId,
      newPts: res.newPts,
      direction,
      clamped: false,
      frameDeltaPts: res.frameDeltaPts,
    };
  }
}

export default RecordingIndexService;
