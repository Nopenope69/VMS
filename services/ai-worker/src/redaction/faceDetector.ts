/**
 * YuNet face detection (opencv_zoo face_detection_yunet_2023mar), for redaction masks (P4.4).
 *
 * Port of OpenCV's FaceDetectorYN post-processing (modules/objdetect/src/face_detect.cpp):
 * per stride s in {8,16,32} and anchor (r, c):
 *   score = sqrt(clamp(cls) * clamp(obj))
 *   cx = (c + dx) * s, cy = (r + dy) * s, w = exp(dw) * s, h = exp(dh) * s
 * then score threshold and greedy NMS. The model input is a fixed 640x640 BGR float tensor of raw
 * 0..255 values (no mean/scale). Frames are scaled to fit, keeping the aspect ratio, and padded
 * right/bottom with zeros (tools/reference/yunet_reference.py does the same with cv2).
 */
import { OrtSession } from '../anpr/ortSession';
import { Image3, resizeBilinear } from '../anpr/imageOps';

export const YUNET_SIZE = 640;
const STRIDES = [8, 16, 32];

export interface FaceBox {
  /** [x1, y1, x2, y2] in frame pixels. */
  box: [number, number, number, number];
  score: number;
}

export interface FaceDetectorOptions {
  scoreThreshold: number;
  nmsThreshold: number;
  topK: number;
}

export const DEFAULT_FACE_OPTIONS: FaceDetectorOptions = { scoreThreshold: 0.5, nmsThreshold: 0.3, topK: 5000 };

export function preprocessYunet(rgb: Image3): { tensor: Float32Array; scale: number } {
  const scale = Math.min(YUNET_SIZE / rgb.width, YUNET_SIZE / rgb.height);
  const nw = Math.round(rgb.width * scale);
  const nh = Math.round(rgb.height * scale);
  const r = nw === rgb.width && nh === rgb.height ? rgb : resizeBilinear(rgb, nw, nh);
  const plane = YUNET_SIZE * YUNET_SIZE;
  const t = new Float32Array(3 * plane);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const si = (y * nw + x) * 3;
      const di = y * YUNET_SIZE + x;
      t[di] = r.data[si + 2]; // B
      t[plane + di] = r.data[si + 1]; // G
      t[2 * plane + di] = r.data[si]; // R
    }
  }
  return { tensor: t, scale };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function iou(a: number[], b: number[]): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return u > 0 ? inter / u : 0;
}

/** Decodes the 12 YuNet outputs into boxes in 640x640 input pixels. */
export function decodeYunet(out: Record<string, { data: Float32Array }>, opts: FaceDetectorOptions = DEFAULT_FACE_OPTIONS): FaceBox[] {
  const cands: FaceBox[] = [];
  for (const s of STRIDES) {
    const cols = YUNET_SIZE / s;
    const rows = YUNET_SIZE / s;
    const cls = out[`cls_${s}`].data;
    const obj = out[`obj_${s}`].data;
    const bbox = out[`bbox_${s}`].data;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const score = Math.sqrt(clamp01(cls[i]) * clamp01(obj[i]));
        if (score < opts.scoreThreshold) continue;
        const cx = (c + bbox[i * 4]) * s;
        const cy = (r + bbox[i * 4 + 1]) * s;
        const w = Math.exp(bbox[i * 4 + 2]) * s;
        const h = Math.exp(bbox[i * 4 + 3]) * s;
        cands.push({ box: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], score });
      }
    }
  }
  cands.sort((a, b) => b.score - a.score);
  const keep: FaceBox[] = [];
  for (const c of cands.slice(0, opts.topK)) {
    if (keep.every((k) => iou(k.box, c.box) <= opts.nmsThreshold)) keep.push(c);
  }
  return keep;
}

export class FaceDetector {
  constructor(private session: OrtSession, private opts: FaceDetectorOptions = DEFAULT_FACE_OPTIONS) {}

  async detect(rgb: Image3, opts: Partial<FaceDetectorOptions> = {}): Promise<FaceBox[]> {
    const o = { ...this.opts, ...opts };
    const { tensor, scale } = preprocessYunet(rgb);
    const out = await this.session.run({ input: { type: 'float32', data: tensor, dims: [1, 3, YUNET_SIZE, YUNET_SIZE] } });
    return decodeYunet(out, o).map((f) => ({
      box: [
        Math.max(0, f.box[0] / scale),
        Math.max(0, f.box[1] / scale),
        Math.min(rgb.width, f.box[2] / scale),
        Math.min(rgb.height, f.box[3] / scale),
      ],
      score: f.score,
    }));
  }
}
