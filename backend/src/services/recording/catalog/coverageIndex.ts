import { RecordingSegment } from '@prisma/client';

export interface CoverageBlock {
  startUtc: Date;
  endUtc: Date;
  segmentIds: string[];
}

export interface RecordingGap {
  startUtc: Date;
  endUtc: Date;
  durationMs: number;
  expectedDurationMs?: number;
  reason?: string;
}

export interface CoverageReport {
  cameraId: string;
  rangeStart: Date;
  rangeEnd: Date;
  coverageBlocks: CoverageBlock[];
  gaps: RecordingGap[];
}

export class CoverageIndex {
  /**
   * Computes wall-clock coverage blocks and detects gaps across ordered segments
   */
  static calculateCoverage(
    cameraId: string,
    segments: RecordingSegment[],
    rangeStart: Date,
    rangeEnd: Date,
    gapThresholdMs = 2000
  ): CoverageReport {
    if (!segments || segments.length === 0) {
      return {
        cameraId,
        rangeStart,
        rangeEnd,
        coverageBlocks: [],
        gaps: [
          {
            startUtc: rangeStart,
            endUtc: rangeEnd,
            durationMs: Math.max(0, rangeEnd.getTime() - rangeStart.getTime()),
            reason: 'NO_RECORDING_DATA',
          },
        ],
      };
    }

    // Sort by startTime ascending
    const sorted = [...segments].sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime()
    );

    const coverageBlocks: CoverageBlock[] = [];
    const gaps: RecordingGap[] = [];

    // Check for leading gap before first segment
    const firstStart = sorted[0].startTime;
    if (firstStart.getTime() - rangeStart.getTime() > gapThresholdMs) {
      gaps.push({
        startUtc: rangeStart,
        endUtc: firstStart,
        durationMs: firstStart.getTime() - rangeStart.getTime(),
        reason: 'LEADING_GAP',
      });
    }

    let currentBlock: CoverageBlock = {
      startUtc: sorted[0].startTime,
      endUtc: sorted[0].endTime,
      segmentIds: [sorted[0].id],
    };

    for (let i = 1; i < sorted.length; i++) {
      const seg = sorted[i];
      const prevEnd = currentBlock.endUtc.getTime();
      const nextStart = seg.startTime.getTime();
      const deltaMs = nextStart - prevEnd;

      if (deltaMs <= gapThresholdMs) {
        // Continuous or overlapping segment - extend current block
        if (seg.endTime.getTime() > prevEnd) {
          currentBlock.endUtc = seg.endTime;
        }
        currentBlock.segmentIds.push(seg.id);
      } else {
        // Gap detected!
        coverageBlocks.push({ ...currentBlock });
        gaps.push({
          startUtc: currentBlock.endUtc,
          endUtc: seg.startTime,
          durationMs: deltaMs,
          reason: 'INTER_SEGMENT_GAP',
        });

        // Start new block
        currentBlock = {
          startUtc: seg.startTime,
          endUtc: seg.endTime,
          segmentIds: [seg.id],
        };
      }
    }

    coverageBlocks.push(currentBlock);

    // Check for trailing gap after last segment
    const lastEnd = currentBlock.endUtc;
    if (rangeEnd.getTime() - lastEnd.getTime() > gapThresholdMs) {
      gaps.push({
        startUtc: lastEnd,
        endUtc: rangeEnd,
        durationMs: rangeEnd.getTime() - lastEnd.getTime(),
        reason: 'TRAILING_GAP',
      });
    }

    return {
      cameraId,
      rangeStart,
      rangeEnd,
      coverageBlocks,
      gaps,
    };
  }
}
