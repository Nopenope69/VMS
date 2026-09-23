import { EventEmitter } from 'events';
import { VideoFrame, ResourceLimits, CameraStreamConfig } from './types';

export interface FrameQueueStats {
  capacity: number;
  queueDepth: number;
  receivedCount: number;
  processedCount: number;
  droppedCount: number;
}

/**
 * Per-Camera Bounded FIFO Frame Queue with Real-Time Drop-Oldest Policy.
 *
 * STRICT INVARIANTS:
 * 1. Each camera stream maintains its own independent queue instance (isolation).
 * 2. When capacity (default 10) is reached, the oldest frame is dropped immediately,
 *    preventing memory starvation and unbounded latency lag.
 * 3. Dropped frames are tracked and emitted in telemetry.
 */
export class BoundedFrameQueue extends EventEmitter {
  public readonly cameraId: string;
  public readonly capacity: number;
  private queue: VideoFrame[] = [];
  private receivedCount: number = 0;
  private processedCount: number = 0;
  private droppedCount: number = 0;

  constructor(cameraId: string, capacity: number = 10) {
    super();
    this.cameraId = cameraId;
    this.capacity = capacity > 0 ? capacity : 10;
  }

  /**
   * Enqueues a new video frame.
   * If the queue is at capacity, the OLDEST frame is evicted and counted as dropped.
   */
  public enqueue(frame: VideoFrame): boolean {
    this.receivedCount++;

    if (this.queue.length >= this.capacity) {
      const dropped = this.queue.shift();
      this.droppedCount++;
      this.queue.push(frame);

      if (dropped) {
        this.emit('drop', {
          cameraId: this.cameraId,
          droppedSequence: dropped.sequenceNumber,
          queueDepth: this.queue.length,
          totalDropped: this.droppedCount,
        });
      }
      return true;
    }

    this.queue.push(frame);
    return true;
  }

  /**
   * Dequeues the next frame for inference processing.
   */
  public dequeue(): VideoFrame | undefined {
    const frame = this.queue.shift();
    if (frame) {
      this.processedCount++;
    }
    return frame;
  }

  /**
   * Peeks at the next frame without removing it.
   */
  public peek(): VideoFrame | undefined {
    return this.queue[0];
  }

  /**
   * Empties all frames in the queue (e.g. on stream disconnect or restart).
   */
  public clear(): void {
    this.queue = [];
  }

  public size(): number {
    return this.queue.length;
  }

  public isEmpty(): boolean {
    return this.queue.length === 0;
  }

  public getStats(): FrameQueueStats {
    return {
      capacity: this.capacity,
      queueDepth: this.queue.length,
      receivedCount: this.receivedCount,
      processedCount: this.processedCount,
      droppedCount: this.droppedCount,
    };
  }
}

/**
 * Appliance Resource Governor.
 * Enforces per-stream and global resource ceilings to prevent CPU/memory melt.
 */
export class ResourceGovernor {
  public static readonly DEFAULT_LIMITS: ResourceLimits = {
    maxConcurrentStreams: 16,
    maxFps: 5,
    maxWidth: 1280,
    maxHeight: 720,
  };

  private limits: ResourceLimits;
  private activeStreams: Set<string> = new Set();

  constructor(customLimits?: Partial<ResourceLimits>) {
    this.limits = {
      ...ResourceGovernor.DEFAULT_LIMITS,
      ...(customLimits || {}),
    };
  }

  /**
   * Validates and bounds a requested camera stream configuration.
   */
  public sanitizeStreamConfig(config: CameraStreamConfig): CameraStreamConfig {
    const fps = Math.min(Math.max(config.fps || 1, 1), this.limits.maxFps);
    const width = Math.min(Math.max(config.width || 640, 64), this.limits.maxWidth);
    const height = Math.min(Math.max(config.height || 640, 64), this.limits.maxHeight);
    const queueCapacity = Math.min(Math.max(config.queueCapacity || 10, 1), 50);

    return {
      ...config,
      fps,
      width,
      height,
      queueCapacity,
      letterbox: config.letterbox !== false,
    };
  }

  /**
   * Checks if an additional camera stream can be admitted under the concurrency ceiling.
   */
  public canAdmitStream(cameraId: string): boolean {
    if (this.activeStreams.has(cameraId)) {
      return true; // Already admitted
    }
    return this.activeStreams.size < this.limits.maxConcurrentStreams;
  }

  public registerStream(cameraId: string): void {
    if (!this.canAdmitStream(cameraId)) {
      throw new Error(
        `Resource ceiling exceeded: Maximum concurrent streams (${this.limits.maxConcurrentStreams}) reached.`
      );
    }
    this.activeStreams.add(cameraId);
  }

  public releaseStream(cameraId: string): void {
    this.activeStreams.delete(cameraId);
  }

  public getActiveStreamCount(): number {
    return this.activeStreams.size;
  }

  public getLimits(): ResourceLimits {
    return { ...this.limits };
  }
}
