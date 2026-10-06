import { FFmpegService, VideoProbeResult } from '../../ffmpeg/ffmpeg.service';

export interface KeyframeIndexEntry {
  pts: bigint;
  fileOffset?: number;
  utcTimestamp?: Date;
}

export interface MediaProbeResult {
  durationMs: number;
  width?: number;
  height?: number;
  codec?: string;
  fps?: number;
  timebaseNumerator: number;
  timebaseDenominator: number;
  keyframeIndex?: KeyframeIndexEntry[];
}

export interface MediaProbeAdapter {
  probeMedia(filePath: string): Promise<MediaProbeResult | null>;
}

export class FfprobeMediaAdapter implements MediaProbeAdapter {
  async probeMedia(filePath: string): Promise<MediaProbeResult | null> {
    const rawProbe = await FFmpegService.probe(filePath);
    if (!rawProbe) {
      return null;
    }

    const durationMs = Math.round(rawProbe.durationSeconds * 1000);
    const fps = rawProbe.fps > 0 ? rawProbe.fps : 25.0;
    const timebaseNumerator = 1;
    const timebaseDenominator = 90000;

    // Build synthetic keyframe entries for standard GOP (typically 1 keyframe every 2 seconds = 50 frames @ 25fps)
    const keyframeIndex: KeyframeIndexEntry[] = [];
    const gopDurationMs = 2000;
    const ptsPerMs = BigInt(timebaseDenominator) / BigInt(1000 * timebaseNumerator);

    for (let offsetMs = 0; offsetMs < durationMs; offsetMs += gopDurationMs) {
      keyframeIndex.push({
        pts: BigInt(offsetMs) * ptsPerMs,
      });
    }

    return {
      durationMs,
      width: rawProbe.width,
      height: rawProbe.height,
      codec: rawProbe.videoCodec,
      fps,
      timebaseNumerator,
      timebaseDenominator,
      keyframeIndex,
    };
  }
}
