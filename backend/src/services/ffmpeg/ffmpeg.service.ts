import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface VideoProbeResult {
  durationSeconds: number;
  /** null = ffprobe did not report it. Nothing is assumed (no 25 fps, 1280x720 or h264). */
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  fps: number | null;
  sizeBytes: number;
}

/** One real keyframe: its presentation time in the 90 kHz clock, counted from the file's first presented frame. */
export interface KeyframeProbeResult {
  timebaseNumerator: 1;
  timebaseDenominator: 90000;
  keyframePts90k: bigint[];
}

export class FFmpegService {
  /** First line of `ffmpeg -version` (the build that actually ran), or null if ffmpeg is missing. */
  static version(): Promise<string | null> {
    return new Promise((resolve) => {
      const p = spawn('ffmpeg', ['-version']);
      let out = '';
      p.stdout.on('data', (d) => (out += d.toString()));
      p.on('error', () => resolve(null));
      p.on('close', (code) => resolve(code === 0 ? out.split('\n')[0].trim() : null));
    });
  }

  /**
   * Probes video file metadata using ffprobe CLI.
   * Returns null if file is corrupt or unreadable.
   */
  static async probe(filePath: string): Promise<VideoProbeResult | null> {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    return new Promise((resolve) => {
      const args = [
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        filePath,
      ];

      const proc = spawn('ffprobe', args);
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('error', () => {
        resolve(null);
      });

      proc.on('close', (code) => {
        if (code !== 0 || !stdout.trim()) {
          resolve(null);
          return;
        }

        try {
          const parsed = JSON.parse(stdout);
          const videoStream = parsed.streams?.find(
            (s: any) => s.codec_type === 'video'
          );

          if (!videoStream) {
            resolve(null);
            return;
          }

          const duration =
            parseFloat(parsed.format?.duration) ||
            parseFloat(videoStream.duration) ||
            0;

          // Parse framerate (e.g. "25/1" or "30000/1001"); unknown stays null
          let fps: number | null = null;
          if (videoStream.r_frame_rate) {
            const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
            if (num && den && den !== 0) {
              fps = Math.round((num / den) * 100) / 100;
            }
          }

          resolve({
            durationSeconds: duration,
            width: videoStream.width || null,
            height: videoStream.height || null,
            videoCodec: videoStream.codec_name || null,
            fps,
            sizeBytes: parseInt(parsed.format?.size || '0', 10),
          });
        } catch {
          resolve(null);
        }
      });
    });
  }

  /**
   * Reads the keyframes that are really in the file (packets flagged K) from the container index, without decoding.
   * Times are relative to the first presented frame and in the 90 kHz clock the catalog uses. Returns null when the
   * file cannot be read or has no timestamps: callers must then store "no index", never a guess.
   */
  static probeKeyframes(filePath: string, timeoutMs = 120_000): Promise<KeyframeProbeResult | null> {
    if (!fs.existsSync(filePath)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const proc = spawn('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=time_base:packet=pts,flags', '-of', 'json', filePath,
      ]);
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve(null);
      }, timeoutMs);
      proc.stdout.on('data', (d) => chunks.push(d));
      proc.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return resolve(null);
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const [num, den] = String(parsed.streams?.[0]?.time_base ?? '').split('/').map(Number);
          if (!num || !den) return resolve(null);
          const packets: Array<{ pts: number; key: boolean }> = (parsed.packets || [])
            .filter((p: any) => p.pts !== undefined && p.pts !== 'N/A' && Number.isFinite(Number(p.pts)))
            .map((p: any) => ({ pts: Number(p.pts), key: String(p.flags || '').includes('K') }));
          if (packets.length === 0) return resolve(null);
          const first = Math.min(...packets.map((p) => p.pts));
          const keyframePts90k = packets
            .filter((p) => p.key)
            .map((p) => BigInt(Math.round(((p.pts - first) * 90000 * num) / den)))
            .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
          if (keyframePts90k.length === 0) return resolve(null);
          resolve({ timebaseNumerator: 1, timebaseDenominator: 90000, keyframePts90k });
        } catch {
          resolve(null);
        }
      });
    });
  }

  /** Start time and clock of a file's video stream, cached (a file does not change once finalized). */
  private static streamTimingCache = new Map<string, { startPts: number; num: number; den: number }>();

  private static async streamTiming(filePath: string): Promise<{ startPts: number; num: number; den: number } | null> {
    let key = filePath;
    try {
      const st = fs.statSync(filePath);
      key = `${filePath}|${st.size}|${st.mtimeMs}`;
    } catch {
      return null;
    }
    const hit = this.streamTimingCache.get(key);
    if (hit) return hit;
    const out = await this.runProbeJson(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=start_pts,time_base', '-of', 'json', filePath], 20_000);
    const stream = out?.streams?.[0];
    const [num, den] = String(stream?.time_base ?? '').split('/').map(Number);
    const startPts = Number(stream?.start_pts);
    if (!num || !den || !Number.isFinite(startPts)) return null;
    if (this.streamTimingCache.size > 512) this.streamTimingCache.clear();
    const timing = { startPts, num, den };
    this.streamTimingCache.set(key, timing);
    return timing;
  }

  private static runProbeJson(args: string[], timeoutMs: number): Promise<any | null> {
    return new Promise((resolve) => {
      const proc = spawn('ffprobe', args);
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve(null);
      }, timeoutMs);
      proc.stdout.on('data', (d) => chunks.push(d));
      proc.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return resolve(null);
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          resolve(null);
        }
      });
    });
  }

  /**
   * The real frame times in a window around `centerPts90k` (90 kHz, from the first presented frame), read from the
   * container without decoding or reading the whole file. Sorted and de-duplicated; null when the file or its
   * timestamps cannot be read. Used for frame-exact stepping, on constant and variable frame rate alike.
   */
  static async probeFrameTimes(filePath: string, centerPts90k: bigint, spanSeconds: number): Promise<bigint[] | null> {
    const timing = await this.streamTiming(filePath);
    if (!timing) return null;
    const centerSec = Number(centerPts90k) / 90000;
    const startSec = Math.max(0, centerSec - spanSeconds);
    // Read intervals are in container time, which starts at the stream's first presented frame.
    const startAbs = (timing.startPts * timing.num) / timing.den + startSec;
    const out = await this.runProbeJson(
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts', '-read_intervals', `${startAbs.toFixed(6)}%+${(centerSec - startSec + spanSeconds).toFixed(6)}`, '-of', 'json', filePath],
      20_000
    );
    if (!out) return null;
    const times = new Set<string>();
    for (const p of out.packets || []) {
      const pts = Number(p.pts);
      if (p.pts === undefined || p.pts === 'N/A' || !Number.isFinite(pts)) continue;
      times.add(BigInt(Math.round(((pts - timing.startPts) * 90000 * timing.num) / timing.den)).toString());
    }
    return [...times].map((t) => BigInt(t)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /**
   * Lossless, fast, keyframe-aligned stream copy trimming (-c copy).
   */
  static async trimStreamCopy(
    inputPath: string,
    outputPath: string,
    startSec: number,
    durationSec: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        '-ss',
        startSec.toString(),
        '-i',
        inputPath,
        '-t',
        durationSec.toString(),
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        '-y',
        outputPath,
      ];

      const proc = spawn('ffmpeg', args);
      let stderr = '';

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('error', (err) => reject(err));
      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputPath)) {
          resolve();
        } else {
          reject(new Error(`FFmpeg stream copy trim failed (code ${code}): ${stderr}`));
        }
      });
    });
  }

  /**
   * Exact frame-level re-encoded trimming via libx264.
   */
  static async trimFrameAccurate(
    inputPath: string,
    outputPath: string,
    startSec: number,
    durationSec: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        '-ss',
        startSec.toString(),
        '-i',
        inputPath,
        '-t',
        durationSec.toString(),
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        '20',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
        '-y',
        outputPath,
      ];

      const proc = spawn('ffmpeg', args);
      let stderr = '';

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('error', (err) => reject(err));
      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputPath)) {
          resolve();
        } else {
          reject(new Error(`FFmpeg frame-accurate trim failed (code ${code}): ${stderr}`));
        }
      });
    });
  }

  /**
   * Concatenates multiple consecutive video segments using FFmpeg's concat demuxer.
   */
  static async concatSegments(
    segmentPaths: string[],
    outputPath: string,
    mode: 'STREAM_COPY' | 'FRAME_ACCURATE' = 'STREAM_COPY'
  ): Promise<void> {
    if (segmentPaths.length === 0) {
      throw new Error('No segments provided for concatenation');
    }

    if (segmentPaths.length === 1) {
      fs.copyFileSync(segmentPaths[0], outputPath);
      return;
    }

    // Create temporary concat demuxer file list
    const tempConcatList = path.join(
      os.tmpdir(),
      `vigilone_concat_${Date.now()}_${Math.random().toString(36).substring(7)}.txt`
    );

    const fileContent = segmentPaths.map((p) => `file '${path.resolve(p)}'`).join('\n');
    fs.writeFileSync(tempConcatList, fileContent, 'utf8');

    return new Promise((resolve, reject) => {
      const args = ['-f', 'concat', '-safe', '0', '-i', tempConcatList];

      if (mode === 'STREAM_COPY') {
        args.push('-c', 'copy', '-movflags', '+faststart', '-y', outputPath);
      } else {
        args.push(
          '-c:v',
          'libx264',
          '-preset',
          'fast',
          '-crf',
          '20',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-movflags',
          '+faststart',
          '-y',
          outputPath
        );
      }

      const proc = spawn('ffmpeg', args);
      let stderr = '';

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('error', (err) => {
        try {
          fs.unlinkSync(tempConcatList);
        } catch {}
        reject(err);
      });

      proc.on('close', (code) => {
        try {
          fs.unlinkSync(tempConcatList);
        } catch {}

        if (code === 0 && fs.existsSync(outputPath)) {
          resolve();
        } else {
          reject(new Error(`FFmpeg concat failed (code ${code}): ${stderr}`));
        }
      });
    });
  }
}
