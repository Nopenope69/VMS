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
  public readonly geometry: FrameGeometry;

  constructor(options: FrameExtractorOptions) {
    super();
    this.config = options;
    this.width = options.width || 640;
    this.height = options.height || 640;
    this.fps = options.fps && options.fps > 0 && options.fps <= 5 ? options.fps : 1;
    this.frameByteSize = this.width * this.height * 3; // RGB24
    this.maxAccumulatorBytes = this.frameByteSize * 2;

    const sourceWidth = options.sourceWidth || 1920;
    const sourceHeight = options.sourceHeight || 1080;
    const letterbox = options.letterbox !== false;
    this.geometry = CoordinateTransformer.computeGeometry(
      sourceWidth,
      sourceHeight,
      this.width,
      this.height,
      letterbox
    );
  }

  /**
   * Builds the safe FFmpeg argument array.
   */
  public buildFfmpegArgs(rtspUrl: string): string[] {
    const letterbox = this.config.letterbox !== false;
    const vfFilter = letterbox
      ? `fps=${this.fps},scale=${this.width}:${this.height}:force_original_aspect_ratio=decrease,pad=${this.width}:${this.height}:(ow-iw)/2:(oh-ih)/2`
      : `fps=${this.fps},scale=${this.width}:${this.height}`;

    return [
      '-nostats',
      '-loglevel', 'error',
      '-rtsp_transport', 'tcp',
      '-i', rtspUrl,
      '-an', // strictly disable audio decode
      '-vf', vfFilter,
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
        geometry: this.geometry,
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
