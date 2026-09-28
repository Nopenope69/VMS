import { OrtSession } from './ortSession';
import { Image3, resizeBilinear } from './imageOps';
import { minAreaRect, orderBox, rectCorners, inside, Pt } from './geometry';

/**
 * PP-OCRv4 text detection (Differentiable Binarization) as RapidOCR runs it: resize so the
 * shorter side reaches limitSideLen (limitType 'min') or the longer side stays within it
 * ('max'), both rounded to multiples of 32; normalise (x/255 - 0.5)/0.5 in BGR order; threshold
 * the probability map, dilate 2x2, take connected regions, fit minimum-area rectangles, score
 * them by the mean probability inside, expand by area*unclip/perimeter and scale back.
 *
 * Deviation from RapidOCR, documented and bounded by the golden tests: regions come from
 * 8-connected components (outer boundaries only; cv2.findContours RETR_LIST would also return
 * hole contours) and the unclip is computed analytically for the rectangle instead of with
 * pyclipper's integer polygon offset.
 */
export interface DbConfig {
  limitSideLen: number;
  limitType: 'min' | 'max';
  thresh: number;
  boxThresh: number;
  unclipRatio: number;
  maxCandidates: number;
  minSize: number;
}

export const DEFAULT_DB_CONFIG: DbConfig = { limitSideLen: 736, limitType: 'min', thresh: 0.3, boxThresh: 0.5, unclipRatio: 1.6, maxCandidates: 1000, minSize: 3 };

export interface TextBox {
  /** tl, tr, br, bl in source pixels (rounded like RapidOCR). */
  points: Pt[];
  score: number;
}

export function dbResizeDims(w: number, h: number, cfg: Pick<DbConfig, 'limitSideLen' | 'limitType'>): { w: number; h: number } {
  let ratio = 1;
  if (cfg.limitType === 'max') {
    if (Math.max(h, w) > cfg.limitSideLen) ratio = cfg.limitSideLen / Math.max(h, w);
  } else if (Math.min(h, w) < cfg.limitSideLen) {
    ratio = cfg.limitSideLen / Math.min(h, w);
  }
  const rh = Math.trunc(h * ratio);
  const rw = Math.trunc(w * ratio);
  // Python round() is banker's rounding; x/32 never lands exactly on .5 for the sizes that
  // matter in practice, but keep the semantics.
  const r32 = (v: number) => {
    const q = v / 32;
    const f = Math.floor(q);
    const d = q - f;
    const n = d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1;
    return n * 32;
  };
  return { w: r32(rw), h: r32(rh) };
}

export function preprocessDb(rgb: Image3, cfg: DbConfig): { tensor: Float32Array; w: number; h: number } {
  const { w, h } = dbResizeDims(rgb.width, rgb.height, cfg);
  if (w <= 0 || h <= 0) throw new Error(`image ${rgb.width}x${rgb.height} too small for text detection`);
  const r = resizeBilinear(rgb, w, h);
  const plane = w * h;
  const t = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    // BGR planes, (v/255 - 0.5)/0.5
    t[i] = (r.data[i * 3 + 2] / 255 - 0.5) / 0.5;
    t[plane + i] = (r.data[i * 3 + 1] / 255 - 0.5) / 0.5;
    t[2 * plane + i] = (r.data[i * 3] / 255 - 0.5) / 0.5;
  }
  return { tensor: t, w, h };
}

export function dbPostprocess(pred: Float32Array, W: number, H: number, srcW: number, srcH: number, cfg: DbConfig): TextBox[] {
  const bin = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) bin[i] = pred[i] > cfg.thresh ? 1 : 0;
  // cv2.dilate with a 2x2 kernel (anchor at 1,1): dst(x,y) = max over x-1..x, y-1..y.
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      mask[i] = bin[i] | (x > 0 ? bin[i - 1] : 0) | (y > 0 ? bin[i - W] : 0) | (x > 0 && y > 0 ? bin[i - W - 1] : 0);
    }
  }
  const seen = new Uint8Array(W * H);
  const boxes: TextBox[] = [];
  const stack: number[] = [];
  let regions = 0;
  for (let start = 0; start < W * H && regions < cfg.maxCandidates; start++) {
    if (!mask[start] || seen[start]) continue;
    regions++;
    const boundary: Pt[] = [];
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % W;
      const y = (i - x) / W;
      let edge = x === 0 || y === 0 || x === W - 1 || y === H - 1;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (!mask[j]) {
            if (!dx || !dy) edge = true;
            continue;
          }
          if (!seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
      if (edge) boundary.push([x, y]);
    }
    const r = minAreaRect(boundary);
    if (Math.min(r.w, r.h) < cfg.minSize) continue;
    const pts = orderBox(rectCorners(r));
    const score = boxScoreFast(pred, W, H, pts);
    if (score < cfg.boxThresh) continue;
    const area = r.w * r.h;
    const perim = 2 * (r.w + r.h);
    const d = perim > 0 ? (area * cfg.unclipRatio) / perim : 0;
    const ex = { ...r, w: r.w + 2 * d, h: r.h + 2 * d };
    if (Math.min(ex.w, ex.h) < cfg.minSize + 2) continue;
    const out = orderBox(rectCorners(ex)).map(([px, py]) => [
      Math.min(srcW, Math.max(0, Math.round((px / W) * srcW))),
      Math.min(srcH, Math.max(0, Math.round((py / H) * srcH))),
    ]) as Pt[];
    boxes.push({ points: out, score });
  }
  return boxes;
}

function boxScoreFast(pred: Float32Array, W: number, H: number, box: Pt[]): number {
  const xs = box.map((p) => p[0]);
  const ys = box.map((p) => p[1]);
  const xmin = Math.max(0, Math.min(W - 1, Math.floor(Math.min(...xs))));
  const xmax = Math.max(0, Math.min(W - 1, Math.ceil(Math.max(...xs))));
  const ymin = Math.max(0, Math.min(H - 1, Math.floor(Math.min(...ys))));
  const ymax = Math.max(0, Math.min(H - 1, Math.ceil(Math.max(...ys))));
  const poly = box.map(([x, y]) => [Math.trunc(x), Math.trunc(y)] as Pt);
  let sum = 0;
  let n = 0;
  for (let y = ymin; y <= ymax; y++) {
    for (let x = xmin; x <= xmax; x++) {
      if (inside(x + 0.5, y + 0.5, poly) || onEdge(x, y, poly)) {
        sum += pred[y * W + x];
        n++;
      }
    }
  }
  return n ? sum / n : 0;
}

function onEdge(x: number, y: number, poly: Pt[]): boolean {
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (Math.abs(cross) > Math.hypot(bx - ax, by - ay) * 0.5) continue;
    if (x >= Math.min(ax, bx) - 0.5 && x <= Math.max(ax, bx) + 0.5 && y >= Math.min(ay, by) - 0.5 && y <= Math.max(ay, by) + 0.5) return true;
  }
  return false;
}

export class TextDetector {
  constructor(private session: OrtSession, private cfg: DbConfig = DEFAULT_DB_CONFIG) {}

  async detect(rgb: Image3): Promise<TextBox[]> {
    const { tensor, w, h } = preprocessDb(rgb, this.cfg);
    const out = await this.session.run({ [this.session.inputNames[0]]: { type: 'float32', data: tensor, dims: [1, 3, h, w] } });
    const pred = out[this.session.outputNames[0]];
    const [, , ph, pw] = pred.dims;
    return dbPostprocess(pred.data, pw, ph, rgb.width, rgb.height, this.cfg);
  }
}
