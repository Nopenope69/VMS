import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface VideoProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
  fps: number;
  sizeBytes: number;
}

export class FFmpegService {
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

          // Parse framerate (e.g. "25/1" or "30000/1001")
          let fps = 25.0;
          if (videoStream.r_frame_rate) {
            const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
            if (num && den && den !== 0) {
              fps = Math.round((num / den) * 100) / 100;
            }
          }

          resolve({
            durationSeconds: duration,
            width: videoStream.width || 1280,
            height: videoStream.height || 720,
            videoCodec: videoStream.codec_name || 'h264',
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
