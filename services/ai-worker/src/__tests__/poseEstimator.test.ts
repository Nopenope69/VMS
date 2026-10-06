import {
  decodeSimcc,
  buildPoseInput,
  poseWindow,
  PoseEstimator,
  POSE_INPUT_WIDTH,
  POSE_INPUT_HEIGHT,
  SIMCC_SPLIT,
  NUM_KEYPOINTS,
  KEYPOINT_NAMES,
  MIN_POSE_BOX_PX,
} from '../poseEstimator';
import { FrameGeometry } from '../types';

const geo = (over: Partial<FrameGeometry> = {}): FrameGeometry => ({
  sourceWidth: 1920,
  sourceHeight: 1080,
  modelWidth: 416,
  modelHeight: 416,
  scale: 416 / 1920,
  padX: 0,
  padY: 0,
  scaledWidth: 416,
  scaledHeight: 234,
  letterbox: true,
  padPosition: 'top-left',
  ...over,
});

/** SimCC tensors with one planted peak per keypoint: bins (bx, by) and peak values. */
function planted(peaks: Array<{ bx: number; by: number; vx?: number; vy?: number }>) {
  const nx = POSE_INPUT_WIDTH * SIMCC_SPLIT;
  const ny = POSE_INPUT_HEIGHT * SIMCC_SPLIT;
  const sx = new Float32Array(NUM_KEYPOINTS * nx);
  const sy = new Float32Array(NUM_KEYPOINTS * ny);
  peaks.forEach((p, k) => {
    sx[k * nx + p.bx] = p.vx ?? 0.9;
    sy[k * ny + p.by] = p.vy ?? 0.9;
  });
  return { sx, sy };
}

describe('poseWindow', () => {
  it('widens the box by 25 % and fits the 192:256 aspect around the same centre', () => {
    const g = geo({ modelWidth: 400, modelHeight: 400, scaledWidth: 400, scaledHeight: 400 });
    const w = poseWindow({ x: 0.4, y: 0.2, width: 0.2, height: 0.6 }, g)!;
    expect(w.cx).toBeCloseTo(200, 5);
    expect(w.cy).toBeCloseTo(200, 5);
    expect(w.h).toBeCloseTo(240 * 1.25, 5); // tall box: height decides
    expect(w.w / w.h).toBeCloseTo(POSE_INPUT_WIDTH / POSE_INPUT_HEIGHT, 5);
  });

  it('a wide box (person lying down) widens the window instead', () => {
    const g = geo({ modelWidth: 400, modelHeight: 400, scaledWidth: 400, scaledHeight: 400 });
    const w = poseWindow({ x: 0.1, y: 0.4, width: 0.8, height: 0.2 }, g)!;
    expect(w.w).toBeCloseTo(320 * 1.25, 5);
    expect(w.w / w.h).toBeCloseTo(POSE_INPUT_WIDTH / POSE_INPUT_HEIGHT, 5);
  });

  it('refuses a box too small to read, and accounts for letterbox padding', () => {
    expect(poseWindow({ x: 0.5, y: 0.5, width: 0.01, height: 0.01 }, geo())).toBeNull();
    const g = geo({ padX: 0, padY: 91, scaledWidth: 416, scaledHeight: 234, padPosition: 'center' as any });
    const w = poseWindow({ x: 0, y: 0, width: 1, height: 1 }, g)!;
    expect(w.cy).toBeCloseTo(91 + 117, 5);
    expect(MIN_POSE_BOX_PX).toBe(24);
  });

  it('rejects an inconsistent geometry', () => {
    expect(() => poseWindow({ x: 0, y: 0, width: 1, height: 1 }, geo({ scaledWidth: 0, scaledHeight: 0, padX: 300 }))).toThrow(/inconsistent/);
  });
});

describe('decodeSimcc', () => {
  it('maps bins back to source-normalised coordinates, with score = the weaker peak', () => {
    const g = geo({ modelWidth: 400, modelHeight: 400, scaledWidth: 400, scaledHeight: 400, sourceWidth: 400, sourceHeight: 400 });
    const win = { cx: 200, cy: 200, w: 192, h: 256 }; // 1 input pixel = 1 canvas pixel
    const peaks: Array<{ bx: number; by: number; vx?: number; vy?: number }> = Array.from({ length: NUM_KEYPOINTS }, () => ({ bx: 0, by: 0 }));
    peaks[0] = { bx: 96 * SIMCC_SPLIT, by: 128 * SIMCC_SPLIT, vx: 0.8, vy: 0.6 }; // window centre
    peaks[5] = { bx: 0, by: 0 }; // window top-left corner
    const { sx, sy } = planted(peaks);
    const r = decodeSimcc(sx, sy, win, g);
    expect(r.keypoints).toHaveLength(17);
    expect(r.keypoints[0].x).toBeCloseTo(0.5, 5);
    expect(r.keypoints[0].y).toBeCloseTo(0.5, 5);
    expect(r.keypoints[0].score).toBeCloseTo(0.6, 5);
    expect(r.keypoints[5].x).toBeCloseTo((200 - 96) / 400, 5);
    expect(r.keypoints[5].y).toBeCloseTo((200 - 128) / 400, 5);
  });

  it('removes letterbox padding and scales by the active image area', () => {
    const g = geo({ padX: 0, padY: 91, scaledWidth: 416, scaledHeight: 234 });
    const win = { cx: 208, cy: 208, w: 192, h: 256 };
    const peaks = Array.from({ length: NUM_KEYPOINTS }, () => ({ bx: 96 * SIMCC_SPLIT, by: 128 * SIMCC_SPLIT }));
    const { sx, sy } = planted(peaks);
    const k = decodeSimcc(sx, sy, win, g).keypoints[0];
    expect(k.x).toBeCloseTo(208 / 416, 5);
    expect(k.y).toBeCloseTo((208 - 91) / 234, 5);
  });

  it('clamps scores to 0..1 and rejects wrong tensor sizes', () => {
    const g = geo();
    const win = { cx: 200, cy: 200, w: 192, h: 256 };
    const { sx, sy } = planted(Array.from({ length: NUM_KEYPOINTS }, () => ({ bx: 1, by: 1, vx: 5, vy: 7 })));
    expect(decodeSimcc(sx, sy, win, g).keypoints[0].score).toBe(1);
    expect(() => decodeSimcc(new Float32Array(10), sy, win, g)).toThrow(/unexpected pose output sizes/);
  });

  it('has the 17 COCO keypoint names in order', () => {
    expect(KEYPOINT_NAMES).toHaveLength(17);
    expect(KEYPOINT_NAMES[0]).toBe('nose');
    expect(KEYPOINT_NAMES[5]).toBe('left_shoulder');
    expect(KEYPOINT_NAMES[16]).toBe('right_ankle');
  });
});

describe('buildPoseInput', () => {
  it('is normalised CHW, black outside the canvas, and checks the frame size', () => {
    const g = geo({ modelWidth: 8, modelHeight: 8, scaledWidth: 8, scaledHeight: 8, sourceWidth: 8, sourceHeight: 8 });
    const frame = Buffer.alloc(8 * 8 * 3, 255);
    const win = { cx: 4, cy: 4, w: 192, h: 256 }; // a huge window: nearly all of it is outside the 8x8 canvas
    const t = buildPoseInput(frame, g, win);
    expect(t.length).toBe(3 * POSE_INPUT_HEIGHT * POSE_INPUT_WIDTH);
    expect(t[0]).toBeCloseTo((0 - 123.675) / 58.395, 4); // corner: outside, black
    expect(() => buildPoseInput(Buffer.alloc(10), g, win)).toThrow(/RGB24 canvas/);
  });

  it('samples a uniform frame to the normalised constant', () => {
    const g = geo({ modelWidth: 400, modelHeight: 400, scaledWidth: 400, scaledHeight: 400, sourceWidth: 400, sourceHeight: 400 });
    const frame = Buffer.alloc(400 * 400 * 3);
    for (let i = 0; i < frame.length; i += 3) {
      frame[i] = 124;
      frame[i + 1] = 116;
      frame[i + 2] = 103;
    }
    const t = buildPoseInput(frame, g, { cx: 200, cy: 200, w: 96, h: 128 });
    const mid = 128 * POSE_INPUT_WIDTH + 96;
    expect(Math.abs(t[mid])).toBeLessThan(0.01); // R near its mean
  });
});

describe('PoseEstimator', () => {
  const session = (inputs: string[], outputs: string[], run: any) => ({ inputNames: inputs, outputNames: outputs, run }) as any;

  it('runs the session on the window and decodes the planted peaks', async () => {
    const peaks = Array.from({ length: NUM_KEYPOINTS }, (_, k) => ({ bx: 2 * (k + 10), by: 2 * (k + 20) }));
    const { sx, sy } = planted(peaks);
    let dims: number[] = [];
    const est = new PoseEstimator(
      session(['input'], ['simcc_x', 'simcc_y'], async (feeds: any) => {
        dims = feeds.input.dims;
        return { simcc_x: { data: sx, dims: [1, 17, 384] }, simcc_y: { data: sy, dims: [1, 17, 512] } };
      })
    );
    const g = geo({ modelWidth: 400, modelHeight: 400, scaledWidth: 400, scaledHeight: 400, sourceWidth: 400, sourceHeight: 400 });
    const r = await est.estimate(Buffer.alloc(400 * 400 * 3), g, { x: 0.3, y: 0.2, width: 0.3, height: 0.6 });
    expect(dims).toEqual([1, 3, 256, 192]);
    expect(r!.keypoints[3].score).toBeCloseTo(0.9, 5);
  });

  it('returns null for a tiny box without running the model', async () => {
    const run = jest.fn();
    const est = new PoseEstimator(session(['input'], ['simcc_x', 'simcc_y'], run));
    expect(await est.estimate(Buffer.alloc(416 * 416 * 3), geo(), { x: 0.5, y: 0.5, width: 0.005, height: 0.005 })).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a model with the wrong outputs and surfaces a model failure', async () => {
    expect(() => new PoseEstimator(session(['input'], ['heatmap'], jest.fn()))).toThrow(/simcc_x and simcc_y/);
    const est = new PoseEstimator(session(['input'], ['simcc_x', 'simcc_y'], async () => ({})));
    await expect(est.estimate(Buffer.alloc(416 * 416 * 3), geo(), { x: 0.2, y: 0.2, width: 0.3, height: 0.6 })).rejects.toThrow(/no simcc outputs/);
  });
});
