import { BoundedFrameQueue, ResourceGovernor } from '../frameQueue';
import { VideoFrame } from '../types';

function createDummyFrame(cameraId: string, sequenceNumber: number): VideoFrame {
  return {
    cameraId,
    tenantId: 'tenant-test',
    streamPath: `cam_${cameraId}`,
    streamSessionId: 'session-xyz',
    sequenceNumber,
    sampledAt: new Date(),
    receivedAt: new Date(),
    width: 640,
    height: 480,
    channels: 3,
    data: Buffer.alloc(100),
  };
}

describe('BoundedFrameQueue & Resource Governor', () => {
  describe('1. BoundedFrameQueue: Real-time Drop-Oldest Policy', () => {
    it('enqueues frames up to capacity without dropping', () => {
      const queue = new BoundedFrameQueue('cam-01', 3);

      queue.enqueue(createDummyFrame('cam-01', 1));
      queue.enqueue(createDummyFrame('cam-01', 2));
      queue.enqueue(createDummyFrame('cam-01', 3));

      const stats = queue.getStats();
      expect(stats.queueDepth).toBe(3);
      expect(stats.receivedCount).toBe(3);
      expect(stats.droppedCount).toBe(0);
    });

    it('drops the oldest frame when capacity is exceeded and emits drop event', (done) => {
      const queue = new BoundedFrameQueue('cam-01', 3);

      queue.enqueue(createDummyFrame('cam-01', 1));
      queue.enqueue(createDummyFrame('cam-01', 2));
      queue.enqueue(createDummyFrame('cam-01', 3));

      queue.once('drop', (event) => {
        expect(event.cameraId).toBe('cam-01');
        expect(event.droppedSequence).toBe(1); // Oldest frame dropped
        expect(event.totalDropped).toBe(1);

        const stats = queue.getStats();
        expect(stats.queueDepth).toBe(3); // Stays bounded at capacity
        expect(stats.droppedCount).toBe(1);

        // Dequeuing should now yield frame 2, then 3, then 4
        expect(queue.dequeue()?.sequenceNumber).toBe(2);
        expect(queue.dequeue()?.sequenceNumber).toBe(3);
        expect(queue.dequeue()?.sequenceNumber).toBe(4);
        expect(queue.isEmpty()).toBe(true);

        done();
      });

      // Frame 4 causes frame 1 to be dropped
      queue.enqueue(createDummyFrame('cam-01', 4));
    });

    it('guarantees per-camera queue isolation (overflowing Cam A does not affect Cam B)', () => {
      const queueA = new BoundedFrameQueue('cam-A', 2);
      const queueB = new BoundedFrameQueue('cam-B', 5);

      // Saturate and overflow Cam A
      queueA.enqueue(createDummyFrame('cam-A', 1));
      queueA.enqueue(createDummyFrame('cam-A', 2));
      queueA.enqueue(createDummyFrame('cam-A', 3)); // drops frame 1
      queueA.enqueue(createDummyFrame('cam-A', 4)); // drops frame 2

      // Enqueue healthy frames into Cam B
      queueB.enqueue(createDummyFrame('cam-B', 101));
      queueB.enqueue(createDummyFrame('cam-B', 102));

      expect(queueA.getStats().droppedCount).toBe(2);
      expect(queueA.getStats().queueDepth).toBe(2);

      // Cam B is completely unaffected
      expect(queueB.getStats().droppedCount).toBe(0);
      expect(queueB.getStats().queueDepth).toBe(2);
      expect(queueB.dequeue()?.sequenceNumber).toBe(101);
      expect(queueB.dequeue()?.sequenceNumber).toBe(102);
    });

    it('clears queue completely on clear()', () => {
      const queue = new BoundedFrameQueue('cam-01', 5);
      queue.enqueue(createDummyFrame('cam-01', 1));
      queue.enqueue(createDummyFrame('cam-01', 2));

      queue.clear();
      expect(queue.size()).toBe(0);
      expect(queue.isEmpty()).toBe(true);
      expect(queue.dequeue()).toBeUndefined();
    });
  });

  describe('2. ResourceGovernor: Appliance Ceilings', () => {
    it('clamps excessive FPS to maxFps limit', () => {
      const governor = new ResourceGovernor({ maxFps: 5 });

      const sanitized = governor.sanitizeStreamConfig({
        cameraId: 'cam-01',
        tenantId: 'tenant-1',
        streamPath: 'cam_path',
        fps: 30, // Way too high for edge AI sampling
      });

      expect(sanitized.fps).toBe(5);
    });

    it('clamps excessive resolution to maxWidth and maxHeight', () => {
      const governor = new ResourceGovernor({ maxWidth: 1280, maxHeight: 720 });

      const sanitized = governor.sanitizeStreamConfig({
        cameraId: 'cam-01',
        tenantId: 'tenant-1',
        streamPath: 'cam_path',
        width: 1920,
        height: 1080,
      });

      expect(sanitized.width).toBe(1280);
      expect(sanitized.height).toBe(720);
    });

    it('enforces maximum concurrent streams ceiling', () => {
      const governor = new ResourceGovernor({ maxConcurrentStreams: 2 });

      governor.registerStream('cam-01');
      governor.registerStream('cam-02');
      expect(governor.getActiveStreamCount()).toBe(2);

      // 3rd stream must be rejected
      expect(() => governor.registerStream('cam-03')).toThrow(/Resource ceiling exceeded/);

      // Releasing a stream permits another
      governor.releaseStream('cam-01');
      expect(governor.getActiveStreamCount()).toBe(1);

      expect(() => governor.registerStream('cam-03')).not.toThrow();
      expect(governor.getActiveStreamCount()).toBe(2);
    });
  });
});
