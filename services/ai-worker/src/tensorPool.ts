/**
 * TensorBufferPool
 *
 * Pre-allocated pool of planar Float32Array buffers for model inference.
 * Standard input shape: [1, 3, 640, 640] = 1,228,800 float32 elements (~4.91 MB).
 *
 * INVARIANT:
 * Reduces predictable GC churn and memory fragmentation under high-frame-rate multi-stream load.
 */
export interface TensorPoolOptions {
  capacity?: number;
  channels?: number;
  width?: number;
  height?: number;
}

export interface TensorPoolStats {
  capacity: number;
  poolAvailable: number;
  inUse: number;
  totalAllocations: number;
  elementCount: number;
  byteSizePerBuffer: number;
}

export class TensorBufferPool {
  private pool: Float32Array[] = [];
  public readonly capacity: number;
  public readonly elementCount: number;
  public readonly byteSizePerBuffer: number;
  private inUseCount: number = 0;
  private totalAllocations: number = 0;

  constructor(options: TensorPoolOptions = {}) {
    this.capacity = options.capacity ?? 4;
    const channels = options.channels ?? 3;
    const width = options.width ?? 640;
    const height = options.height ?? 640;

    this.elementCount = channels * width * height;
    this.byteSizePerBuffer = this.elementCount * Float32Array.BYTES_PER_ELEMENT;

    // Pre-allocate the initial pool buffers
    for (let i = 0; i < this.capacity; i++) {
      this.pool.push(new Float32Array(this.elementCount));
      this.totalAllocations++;
    }
  }

  /**
   * Acquires a Float32Array buffer from the pool.
   * If the pool is temporarily exhausted, a new buffer is allocated to avoid blocking,
   * but tracked in totalAllocations.
   */
  public acquire(): Float32Array {
    let buffer = this.pool.pop();
    if (!buffer) {
      buffer = new Float32Array(this.elementCount);
      this.totalAllocations++;
    }
    this.inUseCount++;
    return buffer;
  }

  /**
   * Releases a previously acquired buffer back into the pool.
   * If the buffer does not match the expected element count, it is discarded.
   */
  public release(buffer: Float32Array): void {
    if (!buffer || buffer.length !== this.elementCount) {
      return;
    }

    if (this.inUseCount > 0) {
      this.inUseCount--;
    }

    // Only return to pool if we have not exceeded pool capacity
    if (this.pool.length < this.capacity) {
      this.pool.push(buffer);
    }
  }

  /**
   * Returns runtime statistics for monitoring and leak detection.
   */
  public getStats(): TensorPoolStats {
    return {
      capacity: this.capacity,
      poolAvailable: this.pool.length,
      inUse: this.inUseCount,
      totalAllocations: this.totalAllocations,
      elementCount: this.elementCount,
      byteSizePerBuffer: this.byteSizePerBuffer,
    };
  }

  /**
   * Drains the pool and resets state.
   */
  public drain(): void {
    this.pool = [];
    this.inUseCount = 0;
  }
}
