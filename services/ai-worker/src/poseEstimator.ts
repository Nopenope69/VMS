/**
 * Body pose for confirmed person detections (person down and fence climbing).
 *
 * Top-down RTMPose-s (SimCC head): the person's box, widened by 25 % and fitted to the model's 192x256 aspect, is
 * resampled from the RGB24 canvas the worker already holds, normalised, and run through the model. The two outputs are
 * 1-D classifications over x and y for each of the 17 COCO keypoints; the keypoint is the argmax of each, and its score
 * is the smaller of the two peak values. Coordinates are returned normalised to the SOURCE image (like every box in
 * this worker), so they can be compared with the detection's own box and with zones drawn on the picture.
 *
 * What this is not: a measurement of a person's real posture. The picture is a perspective view, the canvas is a
 * reduced copy of the frame, and weak keypoints are reported with their low scores rather than hidden. Whether the
 * model is good enough on real camera views is not measured here; the rules that use it are advisory.
 */
import { FrameGeometry } from './types';
import { OrtSession } from './anpr/ortSession';

export const POSE_METHOD = 'rtmpose-s-body7-simcc-v1';
export const POSE_INPUT_WIDTH = 192;
export const POSE_INPUT_HEIGHT = 256;
/** The box is widened by this factor before it is fitted to the input aspect (the model's own training setting). */
export const POSE_BOX_PADDING = 1.25;
/** SimCC resolution: each input pixel is split into this many bins. */
export const SIMCC_SPLIT = 2;
export const NUM_KEYPOINTS = 17;

export const KEYPOINT_NAMES = [
  'nose',
  'left_eye',
  'right_eye',
  'left_ear',
  'right_ear',
  'left_shoulder',
  'right_shoulder',
  'left_elbow',
  'right_elbow',
  'left_wrist',
  'right_wrist',
  'left_hip',
  'right_hip',
  'left_knee',
  'right_knee',
  'left_ankle',
  'right_ankle',
] as const;
export type KeypointName = (typeof KEYPOINT_NAMES)[number];

const MEAN = [123.675, 116.28, 103.53];
const STD = [58.395, 57.12, 57.375];

/** A boxes smaller than this (in canvas pixels, either side) is not run: there is nothing to read. */
export const MIN_POSE_BOX_PX = 24;

export interface PoseKeypoint {
  /** Normalised to the source image (0..1); may fall slightly outside it for a person cut by the frame edge. */
  x: number;
  y: number;
  /** 0..1, the weaker of the x and y peaks. */
  score: number;
}

export interface PoseResult {
  method: typeof POSE_METHOD;
  /** In KEYPOINT_NAMES order. */
  keypoints: PoseKeypoint[];
  /** Mean score over all 17 keypoints. */
  meanScore: number;
}

export interface NormBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The model-input window (in canvas pixels) for a person box: centre and size at the model's aspect. */
export function poseWindow(box: NormBox, g: FrameGeometry): { cx: number; cy: number; w: number; h: number } | null {
  const activeW = g.scaledWidth ?? g.modelWidth - g.padX * 2;
  const activeH = g.scaledHeight ?? g.modelHeight - g.padY * 2;
  if (!(activeW > 0 && activeH > 0)) throw new Error('FrameGeometry is inconsistent: no active image area');
  const bw = box.width * activeW;
  const bh = box.height * activeH;
  if (bw < MIN_POSE_BOX_PX || bh < MIN_POSE_BOX_PX) return null;
  const cx = g.padX + (box.x + box.width / 2) * activeW;
  const cy = g.padY + (box.y + box.height / 2) * activeH;
  const aspect = POSE_INPUT_WIDTH / POSE_INPUT_HEIGHT;
  let w = bw * POSE_BOX_PADDING;
  let h = bh * POSE_BOX_PADDING;
  if (w > h * aspect) h = w / aspect;
  else w = h * aspect;
  return { cx, cy, w, h };
}

/** Resamples the window into the model's CHW float tensor (bilinear; outside the canvas is black, as in training). */
export function buildPoseInput(frame: Buffer, g: FrameGeometry, win: { cx: number; cy: number; w: number; h: number }): Float32Array {
  const W = g.modelWidth;
  const H = g.modelHeight;
  if (frame.length !== W * H * 3) {
    throw new Error(`frame is ${frame.length} bytes, the ${W}x${H} RGB24 canvas is ${W * H * 3}`);
  }
  const out = new Float32Array(3 * POSE_INPUT_HEIGHT * POSE_INPUT_WIDTH);
  const plane = POSE_INPUT_HEIGHT * POSE_INPUT_WIDTH;
  const x0 = win.cx - win.w / 2;
  const y0 = win.cy - win.h / 2;
  const sx = win.w / POSE_INPUT_WIDTH;
  const sy = win.h / POSE_INPUT_HEIGHT;
  const px = (x: number, y: number, c: number) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : frame[(y * W + x) * 3 + c]);
  for (let v = 0; v < POSE_INPUT_HEIGHT; v++) {
    const fy = y0 + (v + 0.5) * sy - 0.5;
    const iy = Math.floor(fy);
    const ty = fy - iy;
    for (let u = 0; u < POSE_INPUT_WIDTH; u++) {
      const fx = x0 + (u + 0.5) * sx - 0.5;
      const ix = Math.floor(fx);
      const tx = fx - ix;
      for (let c = 0; c < 3; c++) {
        const top = px(ix, iy, c) * (1 - tx) + px(ix + 1, iy, c) * tx;
        const bottom = px(ix, iy + 1, c) * (1 - tx) + px(ix + 1, iy + 1, c) * tx;
        out[c * plane + v * POSE_INPUT_WIDTH + u] = (top * (1 - ty) + bottom * ty - MEAN[c]) / STD[c];
      }
    }
  }
  return out;
}

/** SimCC decode: per keypoint, argmax over x and over y; coordinates mapped back to the source image. */
export function decodeSimcc(
  simccX: Float32Array,
  simccY: Float32Array,
  win: { cx: number; cy: number; w: number; h: number },
  g: FrameGeometry
): PoseResult {
  const nx = POSE_INPUT_WIDTH * SIMCC_SPLIT;
  const ny = POSE_INPUT_HEIGHT * SIMCC_SPLIT;
  if (simccX.length !== NUM_KEYPOINTS * nx || simccY.length !== NUM_KEYPOINTS * ny) {
    throw new Error(`unexpected pose output sizes: x ${simccX.length} (want ${NUM_KEYPOINTS * nx}), y ${simccY.length} (want ${NUM_KEYPOINTS * ny})`);
  }
  const activeW = g.scaledWidth ?? g.modelWidth - g.padX * 2;
  const activeH = g.scaledHeight ?? g.modelHeight - g.padY * 2;
  const x0 = win.cx - win.w / 2;
  const y0 = win.cy - win.h / 2;
  const keypoints: PoseKeypoint[] = [];
  let sum = 0;
  for (let k = 0; k < NUM_KEYPOINTS; k++) {
    let bx = 0;
    let vx = -Infinity;
    for (let i = 0; i < nx; i++) {
      const v = simccX[k * nx + i];
      if (v > vx) {
        vx = v;
        bx = i;
      }
    }
    let by = 0;
    let vy = -Infinity;
    for (let i = 0; i < ny; i++) {
      const v = simccY[k * ny + i];
      if (v > vy) {
        vy = v;
        by = i;
      }
    }
    const score = Math.max(0, Math.min(1, Math.min(vx, vy)));
    // Bin to input pixel, then to canvas pixel, then to the source image.
    const canvasX = x0 + (bx / SIMCC_SPLIT / POSE_INPUT_WIDTH) * win.w;
    const canvasY = y0 + (by / SIMCC_SPLIT / POSE_INPUT_HEIGHT) * win.h;
    keypoints.push({ x: (canvasX - g.padX) / activeW, y: (canvasY - g.padY) / activeH, score });
    sum += score;
  }
  return { method: POSE_METHOD, keypoints, meanScore: sum / NUM_KEYPOINTS };
}

export class PoseEstimator {
  constructor(private readonly session: OrtSession) {
    if (session.inputNames.length !== 1 || !session.outputNames.includes('simcc_x') || !session.outputNames.includes('simcc_y')) {
      throw new Error(`pose model must have one input and outputs simcc_x and simcc_y; this has inputs [${session.inputNames}] and outputs [${session.outputNames}]`);
    }
  }

  /** Pose of one person box, or null when the box is too small to read. Throws on a malformed model output. */
  async estimate(frame: Buffer, g: FrameGeometry, box: NormBox): Promise<PoseResult | null> {
    const win = poseWindow(box, g);
    if (!win) return null;
    const input = buildPoseInput(frame, g, win);
    const out = await this.session.run({
      [this.session.inputNames[0]]: { type: 'float32', data: input, dims: [1, 3, POSE_INPUT_HEIGHT, POSE_INPUT_WIDTH] },
    });
    const sx = out.simcc_x;
    const sy = out.simcc_y;
    if (!sx || !sy) throw new Error('pose model returned no simcc outputs');
    return decodeSimcc(sx.data, sy.data, win, g);
  }
}
