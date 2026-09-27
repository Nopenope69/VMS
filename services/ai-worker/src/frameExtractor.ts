import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import { buildLoopbackRtspUrl } from './rtspUrlBuilder';
import { VideoFrame, CameraStreamConfig, FrameGeometry } from './types';
import { CoordinateTransformer } from './coordinateTransformer';

export interface FrameExtractorOptions extends CameraStreamConfig {
  rtspPort?: number;
}

/**
 * Lightweight, Memory-Bounded Frame Extractor.
 *
 * STRICT INVARIANTS:
 * 1. Pulls EXCLUSIVELY from MediaMTX localhost relay via TCP.
 * 2. Employs filter-level decimation (fps=1 default) and aspect-ratio preserving scaling inside FFmpeg.
 * 3. Never allows stdout accumulator to grow unbounded; accumulator is capped at 2x frame size.
 * 4. Explicitly purges accumulator buffer on any disconnect or session reset, preventing frame boundary misalignment.
 */
export class FrameExtractor extends EventEmitter {
  private config: FrameExtractorOptions;
  private process: ChildProcess | null = null;
  private accumulator: Buffer = Buffer.alloc(0);
  private sequenceNumber: number = 0;
  private currentSessionId: string = '';
  private isRunning: boolean = false;
  private lastStderrLine: string = '';

  public readonly width: number;
  public readonly height: number;
  public readonly fps: number;
  public readonly frameByteSize: number;
  public readonly maxAccumulatorBytes: number;
  /** Null until the source resolution is known (configured, or probed from the loopback stream). */
  public geometry: FrameGeometry | null = null;
  private readonly sourceConfigured: boolean;

  constructor(options: FrameExtractorOptions) {
    super();
    this.config = options;
    this.width = options.width || 640;
    this.height = options.height || 640;
    this.fps = options.fps && options.fps > 0 && options.fps <= 5 ? options.fps : 1;
    this.frameByteSize = this.width * this.height * 3; // RGB24
    this.maxAccumulatorBytes = this.frameByteSize * 2;

    // Never guess the source resolution: it is either configured or probed before decoding starts.
    this.sourceConfigured = !!(options.sourceWidth && options.sourceHeight);
    if (this.sourceConfigured) {
      this.geometry = this.computeGeometryFor(options.sourceWidth!, options.sourceHeight!);
    }
  }

  private computeGeometryFor(sourceWidth: number, sourceHeight: number): FrameGeometry {
    return CoordinateTransformer.computeGeometry(
      sourceWidth,
      sourceHeight,
      this.width,
      this.height,
      this.config.letterbox !== false,
      this.config.padPosition ?? 'center'
    );
  }

  /**
   * Builds the safe FFmpeg argument array. The scale and pad sizes come from the computed
   * geometry (integers), so the reverse coordinate transform matches the pixels exactly.
   */
  public buildFfmpegArgs(rtspUrl: string): string[] {
    if (!this.geometry) {
      throw new Error('Cannot build ffmpeg arguments before the source resolution is known');
    }
    return [
      '-nostats',
      '-loglevel', 'error',
      '-rtsp_transport', 'tcp',
      '-i', rtspUrl,
      '-an', // strictly disable audio decode
      '-vf', buildVideoFilter(this.geometry, this.fps, this.config.padValue ?? 0),
      '-pix_fmt', 'rgb24',
      '-f', 'rawvideo',
      '-',
    ];
  }

  /**
   * Resets and purges the frame chunk accumulator.
   * INVARIANT: Guarantees that partial or corrupted bytes from previous sessions
   * do not misalign RGB frame boundaries on reconnect.
   */
  public resetAccumulator(): void {
    this.accumulator = Buffer.alloc(0);
  }

  /**
   * Starts frame extraction from the MediaMTX loopback relay.
   */
  public start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.resetAccumulator();
    this.currentSessionId = crypto.randomUUID();

    const rtspUrl = buildLoopbackRtspUrl(this.config.streamPath, this.config.rtspPort);
    if (!this.geometry) {
      probeStreamResolution(rtspUrl, this.config.probeTimeoutMs ?? 10000).then(
        ({ width, height }) => {
          if (!this.isRunning) return;
          try {
            this.geometry = this.computeGeometryFor(width, height);
            this.spawnDecoder(rtspUrl);
          } catch (err: any) {
            this.failStart(err);
          }
        },
        (err: Error) => this.failStart(err)
      );
      return;
    }
    this.spawnDecoder(rtspUrl);
  }

  private failStart(err: Error): void {
    // stop() may have run while the probe was in flight: a stopped extractor reports nothing.
    if (!this.isRunning) return;
    this.isRunning = false;
    this.resetAccumulator();
    // An 'error' event without listeners would throw and take the whole worker down.
    if (this.listenerCount('error') > 0) this.emit('error', err);
  }

  private spawnDecoder(rtspUrl: string): void {
    const args = this.buildFfmpegArgs(rtspUrl);

    this.process = spawn('ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.handleStdoutData(chunk);
    });

    this.process.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').trim();
      if (line) {
        this.lastStderrLine = line;
      }
    });

    this.process.on('error', (err: Error) => {
      this.resetAccumulator();
      this.emit('error', err);
    });

    this.process.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.resetAccumulator();
      this.isRunning = false;
      this.process = null;
      // The camera may come back at another resolution: probe again on the next start.
      if (!this.sourceConfigured) this.geometry = null;
      this.emit('exit', { code, signal, lastError: this.lastStderrLine });
    });
  }

  /**
   * Processes incoming stdout chunks and slices exact RGB frames.
   */
  public handleStdoutData(chunk: Buffer): void {
    if (!chunk || chunk.length === 0) {
      return;
    }
    if (!this.geometry) {
      // Bytes without a known geometry cannot be mapped back to the camera: drop them.
      this.resetAccumulator();
      return;
    }

    this.accumulator = Buffer.concat([this.accumulator, chunk]);

    // Check for potential buffer overrun / desync
    if (this.accumulator.length > this.maxAccumulatorBytes) {
      this.emit('warn', 'Accumulator overrun: Discarding corrupted buffer to realign stream boundaries');
      this.resetAccumulator();
      return;
    }

    // Drain complete frames
    while (this.accumulator.length >= this.frameByteSize) {
      const frameBuffer = Buffer.from(this.accumulator.subarray(0, this.frameByteSize));
      this.accumulator = this.accumulator.subarray(this.frameByteSize);

      const frame: VideoFrame = {
        cameraId: this.config.cameraId,
        tenantId: this.config.tenantId,
        streamPath: this.config.streamPath,
        streamSessionId: this.currentSessionId,
        sequenceNumber: ++this.sequenceNumber,
        sampledAt: new Date(),
        receivedAt: new Date(),
        width: this.width,
        height: this.height,
        channels: 3,
        data: frameBuffer,
        geometry: this.geometry!,
      };

      this.emit('frame', frame);
    }
  }

  /**
   * Stops frame extraction gracefully.
   */
  public async stop(): Promise<void> {
    this.isRunning = false;
    this.resetAccumulator();

    if (!this.process) {
      return;
    }

    const proc = this.process;
    this.process = null;

    return new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {}
        resolve();
      }, 2000);

      proc.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });

      try {
        proc.kill('SIGTERM');
      } catch {
        clearTimeout(killTimer);
        resolve();
      }
    });
  }

  public getSessionId(): string {
    return this.currentSessionId;
  }

  public getSequenceNumber(): number {
    return this.sequenceNumber;
  }

  public getAccumulatorLength(): number {
    return this.accumulator.length;
  }

  public getIsRunning(): boolean {
    return this.isRunning;
  }

  public getLastError(): string {
    return this.lastStderrLine;
  }
}

/** ffmpeg -vf chain for a geometry: decimate, scale to the exact integer size, pad if letterboxed. */
export function buildVideoFilter(g: FrameGeometry, fps: number, padValue: number = 0): string {
  const sw = g.scaledWidth ?? g.modelWidth;
  const sh = g.scaledHeight ?? g.modelHeight;
  const chain = [`fps=${fps}`, `scale=${sw}:${sh}:flags=bilinear`, 'format=rgb24'];
  if (g.letterbox !== false && (sw !== g.modelWidth || sh !== g.modelHeight)) {
    const v = Math.max(0, Math.min(255, Math.round(padValue)));
    const hex = v.toString(16).padStart(2, '0');
    chain.push(`pad=${g.modelWidth}:${g.modelHeight}:${g.padX}:${g.padY}:color=0x${hex}${hex}${hex}`);
  }
  return chain.join(',');
}

/**
 * Reads the video resolution of the loopback stream with ffprobe (argument array, no shell).
 * Rejects on timeout, non-zero exit or a stream without a video track.
 */
export function probeStreamResolution(
  rtspUrl: string,
  timeoutMs: number = 10000
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'ffprobe',
      ['-v', 'error', '-rtsp_transport', 'tcp', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', rtspUrl],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`ffprobe timed out after ${timeoutMs}ms probing ${rtspUrl}`));
    }, timeoutMs);
    proc.stdout.on('data', (c) => (out += c));
    proc.stderr.on('data', (c) => (err += c));
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`ffprobe exited ${code} probing ${rtspUrl}: ${err.trim()}`));
      try {
        const s = JSON.parse(out).streams?.[0];
        if (!s?.width || !s?.height) throw new Error('no video stream');
        resolve({ width: s.width, height: s.height });
      } catch (e: any) {
        reject(new Error(`ffprobe returned no video resolution for ${rtspUrl}: ${e.message}`));
      }
    });
  });
}
