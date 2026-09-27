import { ModelClassMapping, ModelThresholds } from '../types';
import { CanvasCandidate, canvasBoxFromXyxy, labelFor, minThreshold, thresholdFor } from './common';

export interface YoloxDecodeOptions {
  modelWidth: number;
  modelHeight: number;
  numClasses: number;
  strides?: number[];
}

/**
 * Number of anchor points a YOLOX head produces for a given input size and strides
 * (416x416 with [8,16,32] -> 52*52 + 26*26 + 13*13 = 3549).
 */
export function yoloxAnchorCount(modelWidth: number, modelHeight: number, strides: number[] = [8, 16, 32]): number {
  return strides.reduce((n, s) => n + Math.floor(modelHeight / s) * Math.floor(modelWidth / s), 0);
}

/**
 * YOLOX grid decoder for the official ONNX exports (Megvii-BaseDetection/YOLOX, Apache-2.0).
 *
 * The exported graph ends before box decoding (`decode_in_inference=False`), so each of the N rows
 * is [tx, ty, tw, th, obj, cls_0 .. cls_{C-1}] with sigmoid already applied to obj and cls. This is
 * the TypeScript port of `demo_postprocess` in yolox/utils/demo_utils.py:
 *
 *   cx = (tx + grid_x) * stride,  cy = (ty + grid_y) * stride
 *   w  = exp(tw) * stride,        h  = exp(th) * stride
 *   score(c) = obj * cls_c
 *
 * Class-aware like `multiclass_nms(class_agnostic=False)`: every class whose score clears its
 * threshold yields a candidate, so a box that is both 'car' and 'truck' is not silently collapsed
 * to one class. NMS is applied by the caller (class-scoped).
 */
export function decodeYolox(
  output: Float32Array,
  classMapping: ModelClassMapping,
  thresholds: ModelThresholds,
  opts: YoloxDecodeOptions
): CanvasCandidate[] {
  const strides = opts.strides && opts.strides.length > 0 ? opts.strides : [8, 16, 32];
  const numClasses = opts.numClasses;
  const rowLen = 5 + numClasses;
  const expectedRows = yoloxAnchorCount(opts.modelWidth, opts.modelHeight, strides);

  if (output.length !== expectedRows * rowLen) {
    throw new Error(
      `YOLOX output length mismatch: expected ${expectedRows} x ${rowLen} = ${expectedRows * rowLen} ` +
        `for ${opts.modelWidth}x${opts.modelHeight} with strides [${strides.join(',')}], got ${output.length}`
    );
  }

  const floor = minThreshold(thresholds);
  const candidates: CanvasCandidate[] = [];
  let row = 0;

  for (const stride of strides) {
    const hsize = Math.floor(opts.modelHeight / stride);
    const wsize = Math.floor(opts.modelWidth / stride);
    // Row-major over (y, x), matching np.meshgrid(arange(wsize), arange(hsize)).reshape(1, -1, 2).
    for (let gy = 0; gy < hsize; gy++) {
      for (let gx = 0; gx < wsize; gx++, row++) {
        const off = row * rowLen;
        const obj = output[off + 4];
        if (obj < floor) continue; // score = obj * cls <= obj

        let boxComputed = false;
        let box: CanvasCandidate['box'] | null = null;

        for (let c = 0; c < numClasses; c++) {
          const score = obj * output[off + 5 + c];
          if (score < floor) continue;
          const label = labelFor(classMapping, c);
          if (score < thresholdFor(thresholds, label)) continue;

          if (!boxComputed) {
            const cx = (output[off] + gx) * stride;
            const cy = (output[off + 1] + gy) * stride;
            const w = Math.exp(output[off + 2]) * stride;
            const h = Math.exp(output[off + 3]) * stride;
            box = canvasBoxFromXyxy(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, opts.modelWidth, opts.modelHeight);
            boxComputed = true;
          }
          if (!box) break;

          candidates.push({ classId: c, label, confidence: score, box: { ...box } });
        }
      }
    }
  }

  return candidates;
}
