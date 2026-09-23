import { EventEmitter } from 'events';
import { FrameExtractor } from './frameExtractor';
import { BoundedFrameQueue } from './frameQueue';
import {
  VideoFrame,
  StreamLifecycleState,
  CameraStreamConfig,
  StreamTelemetry,
} from './types';

export interface StreamManagerOptions extends CameraStreamConfig {
  rtspPort?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  jitterMs?: number;
}

/**
 * Stream Manager with 8-State Lifecycle & Exponential Backoff Reconnection.
 *
 * STRICT INVARIANTS:
 * 1. Coordinates single-stream lifecycle: DISCOVERED -> CONNECTING -> CONNECTED -> RUNNING -> DISCONNECTED -> BACKOFF.
 * 2. Purges accumulator buffer on any disconnect or error to prevent byte misalignment.
 * 3. Backoff doubles exponentially up to maxBackoffMs with randomized jitter.
 */
export class StreamManager extends EventEmitter {
  private config: StreamManagerOptions;
  private state: StreamLifecycleState = 'DISCOVERED';
  private extractor: FrameExtractor | null = null;
  private queue: BoundedFrameQueue;

  private reconnectAttempt: number = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastSampledAt?: Date;
  private lastError?: string;
  private shouldRun: boolean = false;

  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly jitterMs: number;

  constructor(options: StreamManagerOptions) {
    super();
    this.config = options;
    this.queue = new BoundedFrameQueue(options.cameraId, options.queueCapacity || 10);
    this.baseBackoffMs = options.baseBackoffMs || 1000;
    this.maxBackoffMs = options.maxBackoffMs || 30000;
    this.jitterMs = options.jitterMs || 500;
  }

  public getState(): StreamLifecycleState {
    return this.state;
  }

  public getQueue(): BoundedFrameQueue {
    return this.queue;
  }

  public getTelemetry(): StreamTelemetry {
    const queueStats = this.queue.getStats();
    return {
      cameraId: this.config.cameraId,
      state: this.state,
      lastSampledAt: this.lastSampledAt,
      lastError: this.lastError,
      reconnectCount: this.reconnectAttempt,
      queueDepth: queueStats.queueDepth,
      droppedFrames: queueStats.droppedCount,
      processedFrames: queueStats.processedCount,
    };
  }

  /**
   * Starts the stream connection.
   */
  public start(): void {
    if (this.shouldRun && this.state !== 'STOPPED' && this.state !== 'FAILED') {
      return;
    }

    this.shouldRun = true;
    this.reconnectAttempt = 0;
    this.connect();
  }

  private setState(newState: StreamLifecycleState): void {
    const previous = this.state;
    this.state = newState;
    this.emit('stateChange', {
      cameraId: this.config.cameraId,
      previous,
      current: newState,
    });
  }

  private connect(): void {
    if (!this.shouldRun) {
      this.setState('STOPPED');
      return;
    }

    this.setState('CONNECTING');

    this.extractor = new FrameExtractor(this.config);

    this.extractor.on('frame', (frame: VideoFrame) => {
      if (this.state === 'CONNECTING' || this.state === 'CONNECTED') {
        this.setState('RUNNING');
        this.reconnectAttempt = 0; // Reset backoff upon healthy frame flow
      }
      this.lastSampledAt = frame.sampledAt;
      this.queue.enqueue(frame);
      this.emit('frame', frame);
    });

    this.extractor.on('error', (err: Error) => {
      this.lastError = err.message;
      this.emit('error', err);
      this.handleDisconnection();
    });

    this.extractor.on('exit', ({ code, signal, lastError }) => {
      if (lastError) {
        this.lastError = lastError;
      }
      this.handleDisconnection();
    });

    try {
      this.extractor.start();
      this.setState('CONNECTED');
    } catch (err: any) {
      this.lastError = err.message;
      this.handleDisconnection();
    }
  }

  private handleDisconnection(): void {
    if (this.extractor) {
      this.extractor.resetAccumulator();
      this.extractor.removeAllListeners();
      this.extractor = null;
    }

    if (!this.shouldRun) {
      this.setState('STOPPED');
      return;
    }

    this.setState('DISCONNECTED');
    this.scheduleReconnect();
  }

  /**
   * Calculates exponential backoff with jitter and schedules next reconnection attempt.
   */
  public calculateBackoffDelay(attempt: number): number {
    const exponential = Math.min(
      this.baseBackoffMs * Math.pow(2, attempt),
      this.maxBackoffMs
    );
    const jitter = Math.floor(Math.random() * this.jitterMs);
    return exponential + jitter;
  }

  private scheduleReconnect(): void {
    if (!this.shouldRun) return;

    this.setState('BACKOFF');
    const delay = this.calculateBackoffDelay(this.reconnectAttempt);
    this.reconnectAttempt++;

    this.emit('backoff', {
      cameraId: this.config.cameraId,
      attempt: this.reconnectAttempt,
      delayMs: delay,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldRun) {
        this.connect();
      }
    }, delay);
  }

  /**
   * Gracefully stops the stream and cancels any pending reconnection timers.
   */
  public async stop(): Promise<void> {
    this.shouldRun = false;
    this.setState('STOPPING');

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.extractor) {
      const ext = this.extractor;
      this.extractor = null;
      ext.removeAllListeners();
      await ext.stop();
    }

    this.queue.clear();
    this.setState('STOPPED');
  }
}
