import { ModelClassMapping, ModelThresholds } from '../types';
import { CanvasCandidate, labelFor, minThreshold, thresholdFor } from './common';

export interface RfdetrDecodeOptions {
  numQueries: number;
  numClasses: number;
  /** Exported class slot that is background; null keeps every slot (sparse COCO checkpoints). */
  backgroundClassId?: number | null;
  /** Maximum query/class pairs kept before thresholding. Defaults to the query count. */
  numSelect?: number;
}

function sigmoid(x: number): number {
  const c = Math.max(-88, Math.min(88, x));
  return 1 / (1 + Math.exp(-c));
}

/**
 * RF-DETR set-prediction decoder (roboflow/rf-detr, Apache-2.0), a port of
 * `rfdetr/export/_runtime/decode.py::decode_detections`:
 *
 *  - `boxes` [Q, 4] are normalized cxcywh relative to the (stretched, not letterboxed) model input;
 *  - `logits` [Q, C] are independent per-class logits: sigmoid, not softmax;
 *  - the Q*C score grid is ranked globally and the top `numSelect` pairs kept, then thresholded.
 *    A per-query argmax would drop the extra classes a query scores on.
 *
 * DETR models need no NMS; the caller must not apply it.
 */
export function decodeRfdetr(
  boxes: Float32Array,
  logits: Float32Array,
  classMapping: ModelClassMapping,
  thresholds: ModelThresholds,
  opts: RfdetrDecodeOptions
): CanvasCandidate[] {
  const Q = opts.numQueries;
  const C = opts.numClasses;
  if (boxes.length !== Q * 4) {
    throw new Error(`RF-DETR boxes length mismatch: expected ${Q} x 4 = ${Q * 4}, got ${boxes.length}`);
  }
  if (logits.length !== Q * C) {
    throw new Error(`RF-DETR logits length mismatch: expected ${Q} x ${C} = ${Q * C}, got ${logits.length}`);
  }

  const bg =
    opts.backgroundClassId === undefined || opts.backgroundClassId === null
      ? -1
      : ((opts.backgroundClassId % C) + C) % C;
  const floor = minThreshold(thresholds);

  // Only pairs above the lowest threshold can survive, so rank just those.
  const pairs: Array<{ q: number; c: number; score: number }> = [];
  for (let q = 0; q < Q; q++) {
    for (let c = 0; c < C; c++) {
      if (c === bg) continue;
      const score = sigmoid(logits[q * C + c]);
      if (score > floor) pairs.push({ q, c, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const selected = pairs.slice(0, opts.numSelect ?? Q);

  const out: CanvasCandidate[] = [];
  for (const { q, c, score } of selected) {
    const label = labelFor(classMapping, c);
    if (score <= thresholdFor(thresholds, label)) continue;
    const cx = boxes[q * 4];
    const cy = boxes[q * 4 + 1];
    const w = boxes[q * 4 + 2];
    const h = boxes[q * 4 + 3];
    const x1 = Math.max(0, Math.min(1, cx - w / 2));
    const y1 = Math.max(0, Math.min(1, cy - h / 2));
    const x2 = Math.max(0, Math.min(1, cx + w / 2));
    const y2 = Math.max(0, Math.min(1, cy + h / 2));
    if (x2 - x1 <= 0 || y2 - y1 <= 0) continue;
    out.push({ classId: c, label, confidence: score, box: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } });
  }
  return out;
}
