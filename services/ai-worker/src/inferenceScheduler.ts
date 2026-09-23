import { InferenceSchedulerTelemetry } from './types';

export class InferenceTimeoutError extends Error {
  constructor(message: string = 'Inference timed out exceeding deadline') {
    super(message);
    this.name = 'InferenceTimeoutError';
  }
}

export class StaleFrameDroppedError extends Error {
  constructor(message: string = 'Frame dropped in favor of newer frame') {
    super(message);
    this.name = 'StaleFrameDroppedError';
  }
}

export interface InferenceSchedulerOptions {
  maxConcurrency?: number;
  timeoutMs?: number;
}

interface QueuedTask<T> {
  cameraId: string;
  sequenceNumber: number;
  taskFn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: any) => void;
  enqueuedAt: number;
}

/**
 * InferenceScheduler
 *
 * Concurrency arbiter and deadline governor for object detection inference.
 *
 * STRICT INVARIANTS:
 * 1. Bounded Concurrency: Maximum `maxConcurrency` (default 2) simultaneous inference tasks.
 * 2. Hard Deadline: Rejects and aborts after `timeoutMs` (default 1000ms).
 * 3. Newest-Frame Preference: When slots are saturated, older waiting frames for the same
 *    camera are discarded to avoid an aging backlog and minimize latency.
 * 4. Telemetry: Tracks counts, durations, timeouts, and stale frame drops.
 */
export class InferenceScheduler {
  public readonly maxConcurrency: number;
  public readonly timeoutMs: number;

  private activeConcurrent: number = 0;
  private queue: QueuedTask<any>[] = [];

  private inferenceCount: number = 0;
  private successCount: number = 0;
  private errorCount: number = 0;
  private timeoutCount: number = 0;
  private droppedStaleCount: number = 0;
  private totalInferenceMs: number = 0;
  private maxInferenceMs: number = 0;

  constructor(options: InferenceSchedulerOptions = {}) {
    this.maxConcurrency = options.maxConcurrency ?? 2;
    this.timeoutMs = options.timeoutMs ?? 1000;
  }

  /**
   * Schedules an inference task.
   */
  public async schedule<T>(
    cameraId: string,
    sequenceNumber: number,
    taskFn: () => Promise<T>
  ): Promise<T> {
    this.inferenceCount++;

    return new Promise<T>((resolve, reject) => {
      // Check if there is an existing pending task for this camera in the queue
      const existingIdx = this.queue.findIndex((item) => item.cameraId === cameraId);
      if (existingIdx !== -1) {
        // Discard the older waiting task in favor of this newer frame
        const staleItem = this.queue.splice(existingIdx, 1)[0];
        this.droppedStaleCount++;
        staleItem.reject(
          new StaleFrameDroppedError(
            `Frame seq=${staleItem.sequenceNumber} for camera=${cameraId} superseded by newer frame seq=${sequenceNumber}`
          )
        );
      }

      this.queue.push({
        cameraId,
        sequenceNumber,
        taskFn,
        resolve,
        reject,
        enqueuedAt: Date.now(),
      });

      this.processNext();
    });
  }

  /**
   * Checks if an execution slot is available and runs the next queued task.
   */
  private processNext(): void {
    if (this.activeConcurrent >= this.maxConcurrency || this.queue.length === 0) {
      return;
    }

    const task = this.queue.shift();
    if (!task) {
      return;
    }

    this.activeConcurrent++;
    const startTime = Date.now();

    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        this.timeoutCount++;
        reject(
          new InferenceTimeoutError(
            `Inference pass for camera=${task.cameraId} seq=${task.sequenceNumber} timed out after ${this.timeoutMs}ms deadline`
          )
        );
      }, this.timeoutMs);
    });

    const executionPromise = (async () => {
      return await task.taskFn();
    })();

    Promise.race([executionPromise, timeoutPromise])
      .then((result) => {
        if (timer) clearTimeout(timer);
        const elapsed = Date.now() - startTime;
        this.recordTiming(elapsed);
        this.successCount++;
        task.resolve(result);
      })
      .catch((err) => {
        if (timer) clearTimeout(timer);
        const elapsed = Date.now() - startTime;
        this.recordTiming(elapsed);
        if (!timedOut) {
          this.errorCount++;
        }
        task.reject(err);
      })
      .finally(() => {
        this.activeConcurrent--;
        this.processNext();
      });
  }

  private recordTiming(elapsedMs: number): void {
    this.totalInferenceMs += elapsedMs;
    if (elapsedMs > this.maxInferenceMs) {
      this.maxInferenceMs = elapsedMs;
    }
  }

  /**
   * Returns current scheduler telemetry.
   */
  public getTelemetry(): InferenceSchedulerTelemetry {
    const totalFinished = this.successCount + this.errorCount + this.timeoutCount;
    const avgInferenceMs =
      totalFinished > 0 ? Math.round((this.totalInferenceMs / totalFinished) * 10) / 10 : 0;

    return {
      inferenceCount: this.inferenceCount,
      successCount: this.successCount,
      errorCount: this.errorCount,
      timeoutCount: this.timeoutCount,
      droppedStaleCount: this.droppedStaleCount,
      avgInferenceMs,
      maxInferenceMs: this.maxInferenceMs,
      activeConcurrent: this.activeConcurrent,
    };
  }

  public getQueueDepth(): number {
    return this.queue.length;
  }

  public getActiveConcurrent(): number {
    return this.activeConcurrent;
  }
}
