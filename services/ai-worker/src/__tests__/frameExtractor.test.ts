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
    sourceWidth: 1920,
    sourceHeight: 1080,
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
      // 1920x1080 into 64x48: scale 1/30 -> 64x36, centred with 6 px bands top and bottom.
      expect(vf).toBe('fps=1,scale=64:36:flags=bilinear,format=rgb24,pad=64:48:0:6:color=0x000000');
      expect(extractor.geometry).toMatchObject({ scaledWidth: 64, scaledHeight: 36, padX: 0, padY: 6 });
    });

    it('uses the model pad value and position (YOLOX: grey 114, top-left)', () => {
      const extractor = new FrameExtractor({ ...sampleConfig, padValue: 114, padPosition: 'top-left' });
      const vf = extractor.buildFfmpegArgs('rtsp://127.0.0.1:8554/cam_test_stream')[
        extractor.buildFfmpegArgs('rtsp://127.0.0.1:8554/cam_test_stream').indexOf('-vf') + 1
      ];
      expect(vf).toBe('fps=1,scale=64:36:flags=bilinear,format=rgb24,pad=64:48:0:0:color=0x727272');
    });

    it('does not guess a source resolution: no geometry until configured or probed', () => {
      const { sourceWidth, sourceHeight, ...unknownSource } = sampleConfig;
      const extractor = new FrameExtractor(unknownSource);
      expect(extractor.geometry).toBeNull();
      expect(() => extractor.buildFfmpegArgs('rtsp://127.0.0.1:8554/x')).toThrow(/source resolution is known/);
      // Bytes that arrive without geometry are dropped, never emitted as frames.
      const frames: any[] = [];
      extractor.on('frame', (f) => frames.push(f));
      extractor.handleStdoutData(Buffer.alloc(64 * 48 * 3));
      expect(frames).toHaveLength(0);
    });

    it('constructs plain scaling filter when letterbox is explicitly disabled', () => {
      const extractor = new FrameExtractor({ ...sampleConfig, letterbox: false });
      const args = extractor.buildFfmpegArgs('rtsp://127.0.0.1:8554/cam_test_stream');

      const vfIndex = args.indexOf('-vf');
      const vf = args[vfIndex + 1];
      expect(vf).toBe('fps=1,scale=64:48:flags=bilinear,format=rgb24');
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

describe('FrameExtractor geometry against real ffmpeg output', () => {
  const { execFileSync } = require('child_process');
  const { buildVideoFilter } = require('../frameExtractor');
  const { CoordinateTransformer } = require('../coordinateTransformer');

  // Source 1280x720 (black) with a white rectangle at x 320..640, y 360..540 (normalized 0.25, 0.5, 0.25, 0.25).
  const cases: Array<[string, boolean, 'center' | 'top-left']> = [
    ['centred letterbox', true, 'center'],
    ['top-left letterbox', true, 'top-left'],
    ['stretch', false, 'center'],
  ];

  for (const [name, letterbox, padPosition] of cases) {
    it(`${name}: the white box maps back to its source coordinates within one model pixel`, () => {
      const W = 416;
      const g = CoordinateTransformer.computeGeometry(1280, 720, W, W, letterbox, padPosition);
      const vf = buildVideoFilter(g, 1, 114);
      const raw: Buffer = execFileSync(
        'ffmpeg',
        [
          '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:d=1,drawbox=x=320:y=360:w=320:h=180:color=white:t=fill',
          '-frames:v', '1', '-vf', vf, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-',
        ],
        { maxBuffer: 16 * 1024 * 1024 }
      );
      expect(raw.length).toBe(W * W * 3);
      let x1 = W, y1 = W, x2 = -1, y2 = -1;
      for (let y = 0; y < W; y++) {
        for (let x = 0; x < W; x++) {
          if (raw[(y * W + x) * 3] > 200) {
            x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y);
          }
        }
      }
      const box = CoordinateTransformer.reverseTransformBox(
        { x: x1 / W, y: y1 / W, width: (x2 + 1 - x1) / W, height: (y2 + 1 - y1) / W },
        g
      );
      const tolX = 1.5 / 1280 + 1 / (g.scaledWidth as number);
      const tolY = 1.5 / 720 + 1 / (g.scaledHeight as number);
      expect(Math.abs(box.x - 0.25)).toBeLessThanOrEqual(tolX);
      expect(Math.abs(box.y - 0.5)).toBeLessThanOrEqual(tolY);
      expect(Math.abs(box.width - 0.25)).toBeLessThanOrEqual(2 * tolX);
      expect(Math.abs(box.height - 0.25)).toBeLessThanOrEqual(2 * tolY);
    });
  }
});

describe('FrameExtractor probe failures never crash the process', () => {
  it('stop() while the resolution probe is in flight: the late probe failure is swallowed', async () => {
    const extractor = new FrameExtractor({ cameraId: 'c', tenantId: 't', streamPath: 'no_such_stream', rtspPort: 1, probeTimeoutMs: 3000 });
    extractor.start(); // probes rtsp://127.0.0.1:1/..., which is refused
    extractor.removeAllListeners(); // what StreamManager.stop() does
    await extractor.stop();
    await new Promise((r) => setTimeout(r, 500)); // the probe fails after stop; nothing may throw
    expect(extractor.geometry).toBeNull();
  });

  it('a probe failure while running is reported as an error event', async () => {
    const extractor = new FrameExtractor({ cameraId: 'c', tenantId: 't', streamPath: 'no_such_stream', rtspPort: 1, probeTimeoutMs: 3000 });
    const err = await new Promise<Error>((resolve) => {
      extractor.on('error', resolve);
      extractor.start();
    });
    expect(err.message).toMatch(/ffprobe/);
  });
});
