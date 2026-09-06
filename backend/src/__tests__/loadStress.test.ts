import { runLoadStressBenchmark } from '../scripts/loadStressProfiler';

describe('Multi-Camera Load Stress & Event Loop Profiler Test', () => {
  it('should maintain p99 event loop delay under 50ms during 32-camera burst operations', async () => {
    const report = await runLoadStressBenchmark(32, 2);

    expect(report.passed).toBe(true);
    expect(report.cameraCount).toBe(32);
    expect(report.eventLoopDelay.p99Ms).toBeLessThan(50);
    // Heap growth should remain bounded under 15 MB for this microbenchmark
    expect(report.memory.heapGrowthMb).toBeLessThan(15);
  });
});
