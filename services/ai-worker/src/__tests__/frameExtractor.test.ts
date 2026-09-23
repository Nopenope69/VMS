import crypto from 'crypto';
import { FrameExtractor } from '../frameExtractor';
import { VideoFrame } from '../types';

describe('FrameExtractor: Filter Decimation & Memory-Bounded Extraction', () => {
  const sampleConfig = {
    cameraId: 'cam-test-01',
    tenantId: 'tenant-test',
    streamPath: 'cam_test_stream',
    width: 64,
    height: 48,
    fps: 1,
    letterbox: true,
  };

  const expectedFrameBytes = 64 * 48 * 3; // 9,216 bytes

  describe('1. Safe FFmpeg Argument Construction & Filter Bounding', () => {
    it('constructs argument array with aspect-ratio preserving letterbox filter by default', () => {
      const extractor = new FrameExtractor(sampleConfig);
      const args = extractor.buildFfmpegArgs('rtsp://127.0.0.1:8554/cam_test_stream');

      expect(args).toContain('-rtsp_transport');
      expect(args).toContain('tcp');
      expect(args).toContain('-an'); // audio disabled
      expect(args).toContain('-pix_fmt');
      expect(args).toContain('rgb24');
      expect(args).toContain('-f');
      expect(args).toContain('rawvideo');

      const vfIndex = args.indexOf('-vf');
      expect(vfIndex).toBeGreaterThan(-1);
      const vf = args[vfIndex + 1];
      expect(vf).toContain('fps=1');
      expect(vf).toContain('scale=64:48:force_original_aspect_ratio=decrease');
      expect(vf).toContain('pad=64:48:(ow-iw)/2:(oh-ih)/2');
    });

    it('constructs plain scaling filter when letterbox is explicitly disabled', () => {
      const extractor = new FrameExtractor({ ...sampleConfig, letterbox: false });
      const args = extractor.buildFfmpegArgs('rtsp://127.0.0.1:8554/cam_test_stream');

      const vfIndex = args.indexOf('-vf');
      const vf = args[vfIndex + 1];
      expect(vf).toBe('fps=1,scale=64:48');
    });
  });

  describe('2. Memory-Bounded Stream Parsing & Chunk Assembly', () => {
    it('slices an exact frame when single chunk arrives with exact byte size', (done) => {
      const extractor = new FrameExtractor(sampleConfig);
      const testBytes = crypto.randomBytes(expectedFrameBytes);

      extractor.once('frame', (frame: VideoFrame) => {
        expect(frame.cameraId).toBe('cam-test-01');
        expect(frame.sequenceNumber).toBe(1);
        expect(frame.width).toBe(64);
        expect(frame.height).toBe(48);
        expect(frame.channels).toBe(3);
        expect(frame.data.length).toBe(expectedFrameBytes);
        expect(frame.data.equals(testBytes)).toBe(true);
        expect(frame.sampledAt).toBeInstanceOf(Date);
        expect(frame.receivedAt).toBeInstanceOf(Date);
        expect(extractor.getAccumulatorLength()).toBe(0);
        done();
      });

      extractor.handleStdoutData(testBytes);
    });

    it('assembles fragmented chunks over multiple arrivals without leaking bytes', (done) => {
      const extractor = new FrameExtractor(sampleConfig);
      const testBytes = crypto.randomBytes(expectedFrameBytes);

      const part1 = testBytes.subarray(0, 3000);
      const part2 = testBytes.subarray(3000, 7000);
      const part3 = testBytes.subarray(7000);

      extractor.once('frame', (frame: VideoFrame) => {
        expect(frame.sequenceNumber).toBe(1);
        expect(frame.data.length).toBe(expectedFrameBytes);
        expect(frame.data.equals(testBytes)).toBe(true);
        expect(extractor.getAccumulatorLength()).toBe(0);
        done();
      });

      extractor.handleStdoutData(part1);
      expect(extractor.getAccumulatorLength()).toBe(3000);

      extractor.handleStdoutData(part2);
      expect(extractor.getAccumulatorLength()).toBe(7000);

      extractor.handleStdoutData(part3);
    });

    it('extracts multiple consecutive frames from a single concatenated chunk', () => {
      const extractor = new FrameExtractor(sampleConfig);
      const frame1Bytes = crypto.randomBytes(expectedFrameBytes);
      const frame2Bytes = crypto.randomBytes(expectedFrameBytes);
      const combined = Buffer.concat([frame1Bytes, frame2Bytes]);

      const receivedFrames: VideoFrame[] = [];
      extractor.on('frame', (frame: VideoFrame) => {
        receivedFrames.push(frame);
      });

      extractor.handleStdoutData(combined);

      expect(receivedFrames).toHaveLength(2);
      expect(receivedFrames[0].sequenceNumber).toBe(1);
      expect(receivedFrames[0].data.equals(frame1Bytes)).toBe(true);
      expect(receivedFrames[1].sequenceNumber).toBe(2);
      expect(receivedFrames[1].data.equals(frame2Bytes)).toBe(true);
      expect(extractor.getAccumulatorLength()).toBe(0);
    });
  });

  describe('3. Accumulator Purge on Reconnect & Overrun Protection', () => {
    it('purges accumulator on resetAccumulator to prevent boundary misalignment', () => {
      const extractor = new FrameExtractor(sampleConfig);
      const garbageBytes = crypto.randomBytes(1500);

      extractor.handleStdoutData(garbageBytes);
      expect(extractor.getAccumulatorLength()).toBe(1500);

      // Simulate reconnect / reset
      extractor.resetAccumulator();
      expect(extractor.getAccumulatorLength()).toBe(0);

      // Now feed a clean full frame; should emit cleanly without offset
      const cleanFrameBytes = crypto.randomBytes(expectedFrameBytes);
      let emitted: VideoFrame | null = null;
      extractor.once('frame', (f) => {
        emitted = f;
      });

      extractor.handleStdoutData(cleanFrameBytes);
      expect(emitted).not.toBeNull();
      expect(emitted!.data.equals(cleanFrameBytes)).toBe(true);
      expect(extractor.getAccumulatorLength()).toBe(0);
    });

    it('discards buffer and warns on accumulator overrun (exceeding 2x frame size)', () => {
      const extractor = new FrameExtractor(sampleConfig);
      const hugeOverrun = crypto.randomBytes(extractor.maxAccumulatorBytes + 100);

      let warningReceived = false;
      extractor.on('warn', (msg) => {
        if (msg.includes('Accumulator overrun')) {
          warningReceived = true;
        }
      });

      extractor.handleStdoutData(hugeOverrun);
      expect(warningReceived).toBe(true);
      expect(extractor.getAccumulatorLength()).toBe(0);
    });
  });
});
