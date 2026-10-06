import { FFmpegService } from '../../ffmpeg/ffmpeg.service';

export interface KeyframeIndexEntry {
  pts: bigint;
  fileOffset?: number;
  utcTimestamp?: Date;
}

export interface MediaProbeResult {
  durationMs: number;
  width?: number | null;
  height?: number | null;
  codec?: string | null;
  fps?: number | null;
  timebaseNumerator: number;
  timebaseDenominator: number;
  keyframeIndex?: KeyframeIndexEntry[];
}

export interface MediaProbeAdapter {
  probeMedia(filePath: string): Promise<MediaProbeResult | null>;
  /**
   * The keyframes that are really in the file (90 kHz, from the first presented frame), or null when they cannot
   * be read. Optional: an adapter without it yields no index, never a guessed one.
   */
  probeKeyframes?(filePath: string): Promise<KeyframeIndexEntry[] | null>;
  /**
   * The real frame times (90 kHz, from the first presented frame) in a window of `spanSeconds` either side of a time,
   * or null when they cannot be read. Optional: without it a frame step can only be estimated.
   */
  probeFrameTimes?(filePath: string, centerPts90k: bigint, spanSeconds: number): Promise<bigint[] | null>;
}

export class FfprobeMediaAdapter implements MediaProbeAdapter {
  async probeMedia(filePath: string): Promise<MediaProbeResult | null> {
    const rawProbe = await FFmpegService.probe(filePath);
    if (!rawProbe) {
      return null;
    }

    const durationMs = Math.round(rawProbe.durationSeconds * 1000);
    const timebaseNumerator = 1;
    const timebaseDenominator = 90000;

    return {
      durationMs,
      width: rawProbe.width,
      height: rawProbe.height,
      codec: rawProbe.videoCodec,
      fps: rawProbe.fps,
      timebaseNumerator,
      timebaseDenominator,
    };
  }

  /** The real keyframes, or null: never a guessed one-keyframe-every-2-seconds list (audit finding F1). */
  async probeKeyframes(filePath: string): Promise<KeyframeIndexEntry[] | null> {
    const real = await FFmpegService.probeKeyframes(filePath);
    return real ? real.keyframePts90k.map((pts) => ({ pts })) : null;
  }

  async probeFrameTimes(filePath: string, centerPts90k: bigint, spanSeconds: number): Promise<bigint[] | null> {
    return FFmpegService.probeFrameTimes(filePath, centerPts90k, spanSeconds);
  }
}
