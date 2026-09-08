import { KeyframeIndexEntry } from './mediaProbeAdapter';

export class SegmentIndexer {
  /**
   * Calculates media presentation timestamp delta from duration and timebase:
   * ΔPTS = Math.round((durationMs * timebaseDen) / (1000 * timebaseNum))
   */
  static calculatePtsDelta(
    durationMs: number,
    timebaseNumerator: number,
    timebaseDenominator: number
  ): bigint {
    const num = BigInt(timebaseNumerator);
    const den = BigInt(timebaseDenominator);
    const ms = BigInt(Math.max(0, Math.round(durationMs)));
    return (ms * den) / (1000n * num);
  }

  /**
   * Calculates fallback frame delta if exact packet timestamps are unavailable
   */
  static calculateFallbackFrameDelta(
    fps: number,
    timebaseNumerator: number,
    timebaseDenominator: number
  ): bigint {
    const safeFps = fps > 0 ? fps : 25.0;
    const den = BigInt(timebaseDenominator);
    const num = BigInt(timebaseNumerator);
    const delta = den / (BigInt(Math.round(safeFps)) * num);
    return delta > 0n ? delta : 1n;
  }

  /**
   * Binary search for nearest keyframe preceding or equal to targetPts
   */
  static findNearestPrecedingKeyframe(
    keyframes: KeyframeIndexEntry[] | undefined,
    targetPts: bigint,
    segmentStartPts: bigint = 0n
  ): bigint {
    if (!keyframes || keyframes.length === 0) {
      return segmentStartPts;
    }

    let low = 0;
    let high = keyframes.length - 1;
    let candidate = segmentStartPts;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const kfPts = BigInt(keyframes[mid].pts);

      if (kfPts <= targetPts) {
        candidate = kfPts;
        low = mid + 1; // Look for a closer preceding keyframe
      } else {
        high = mid - 1;
      }
    }

    return candidate;
  }

  /**
   * Steps to the adjacent frame (previous or next) based on discrete keyframe/frame sequence
   * or clamped delta without assuming uniform constant frame rate
   */
  static calculateAdjacentFramePts(
    keyframes: KeyframeIndexEntry[] | undefined,
    currentPts: bigint,
    direction: 'FORWARD' | 'BACKWARD',
    segmentStartPts: bigint,
    segmentEndPts: bigint,
    fallbackFrameDelta: bigint
  ): { newPts: bigint; frameDeltaPts: bigint } {
    // If discrete keyframe index has packets, seek through discrete points
    if (keyframes && keyframes.length > 1) {
      const sortedPts = keyframes.map((k) => BigInt(k.pts)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

      if (direction === 'FORWARD') {
        const next = sortedPts.find((p) => p > currentPts);
        if (next !== undefined && next <= segmentEndPts) {
          return { newPts: next, frameDeltaPts: next - currentPts };
        }
      } else {
        const prev = [...sortedPts].reverse().find((p) => p < currentPts);
        if (prev !== undefined && prev >= segmentStartPts) {
          return { newPts: prev, frameDeltaPts: currentPts - prev };
        }
      }
    }

    // Fallback step using computed timebase delta clamped strictly within segment boundaries
    if (direction === 'FORWARD') {
      const rawTarget = currentPts + fallbackFrameDelta;
      const clamped = rawTarget > segmentEndPts ? segmentEndPts : rawTarget;
      return { newPts: clamped, frameDeltaPts: clamped - currentPts };
    } else {
      const rawTarget = currentPts - fallbackFrameDelta;
      const clamped = rawTarget < segmentStartPts ? segmentStartPts : rawTarget;
      return { newPts: clamped, frameDeltaPts: currentPts - clamped };
    }
  }
}
