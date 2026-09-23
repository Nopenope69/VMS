import { TensorBufferPool } from '../tensorPool';

describe('TensorBufferPool', () => {
  it('pre-allocates the configured number of Float32Array buffers with exact dimensions', () => {
    const pool = new TensorBufferPool({
      capacity: 4,
      channels: 3,
      width: 640,
      height: 640,
    });

    const stats = pool.getStats();
    expect(stats.capacity).toBe(4);
    expect(stats.poolAvailable).toBe(4);
    expect(stats.inUse).toBe(0);
    expect(stats.totalAllocations).toBe(4);
    expect(stats.elementCount).toBe(3 * 640 * 640); // 1,228,800
    expect(stats.byteSizePerBuffer).toBe(1228800 * 4); // ~4.91 MB
  });

  it('acquires and releases buffers without memory leaks or unbounded growth', () => {
    const pool = new TensorBufferPool({ capacity: 2, channels: 3, width: 640, height: 640 });

    const buf1 = pool.acquire();
    expect(buf1).toBeInstanceOf(Float32Array);
    expect(buf1.length).toBe(1228800);
    expect(pool.getStats().poolAvailable).toBe(1);
    expect(pool.getStats().inUse).toBe(1);

    const buf2 = pool.acquire();
    expect(pool.getStats().poolAvailable).toBe(0);
    expect(pool.getStats().inUse).toBe(2);

    // Write distinctive values to verify reuse
    buf1[0] = 42.5;
    buf2[0] = 99.1;

    // Release buf1 back to pool
    pool.release(buf1);
    expect(pool.getStats().poolAvailable).toBe(1);
    expect(pool.getStats().inUse).toBe(1);

    // Re-acquire should give back buf1
    const reused = pool.acquire();
    expect(reused).toBe(buf1);
    expect(reused[0]).toBe(42.5);
    expect(pool.getStats().inUse).toBe(2);

    pool.release(buf2);
    pool.release(reused);
    expect(pool.getStats().poolAvailable).toBe(2);
    expect(pool.getStats().inUse).toBe(0);
  });

  it('allocates extra buffers if pool is temporarily exhausted and tracks allocations', () => {
    const pool = new TensorBufferPool({ capacity: 2, channels: 3, width: 10, height: 10 });
    const b1 = pool.acquire();
    const b2 = pool.acquire();
    const b3 = pool.acquire(); // exceeds capacity=2

    expect(pool.getStats().totalAllocations).toBe(3);
    expect(pool.getStats().inUse).toBe(3);
    expect(pool.getStats().poolAvailable).toBe(0);

    // When releasing all 3, pool caps at capacity=2 and discards excess
    pool.release(b1);
    pool.release(b2);
    pool.release(b3);

    expect(pool.getStats().poolAvailable).toBe(2);
    expect(pool.getStats().inUse).toBe(0);
  });

  it('ignores invalid or mismatched buffer releases', () => {
    const pool = new TensorBufferPool({ capacity: 2, channels: 3, width: 10, height: 10 });
    const wrongBuffer = new Float32Array(50); // wrong size

    pool.release(wrongBuffer);
    expect(pool.getStats().poolAvailable).toBe(2);
  });

  it('handles high-frequency cycling cleanly', () => {
    const pool = new TensorBufferPool({ capacity: 4, channels: 3, width: 64, height: 64 });

    for (let i = 0; i < 1000; i++) {
      const buf = pool.acquire();
      buf[0] = i;
      pool.release(buf);
    }

    const stats = pool.getStats();
    expect(stats.totalAllocations).toBe(4);
    expect(stats.poolAvailable).toBe(4);
    expect(stats.inUse).toBe(0);
  });

  it('drains pool completely on teardown', () => {
    const pool = new TensorBufferPool({ capacity: 3, channels: 3, width: 10, height: 10 });
    expect(pool.getStats().poolAvailable).toBe(3);

    pool.drain();
    expect(pool.getStats().poolAvailable).toBe(0);
    expect(pool.getStats().inUse).toBe(0);
  });
});
