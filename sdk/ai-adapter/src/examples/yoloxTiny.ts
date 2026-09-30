/**
 * Example: a real object detector (YOLOX-tiny, Apache-2.0, Megvii) served as a VigilOne AI adapter in about a
 * hundred lines. Pre- and post-processing follow the official YOLOX demo (yolox/data/data_augment.py preproc,
 * yolox/utils/demo_utils.py demo_postprocess and class-aware multiclass_nms); the test compares its output
 * with the official Python reference on the repository's golden images.
 *
 *   node dist/examples/yoloxTiny.js /path/to/yolox_tiny.onnx 7020
 *
 * Needs onnxruntime-node (npm install onnxruntime-node). The model file is checked against its SHA-256 before
 * it is loaded. Fetch it with scripts/models/fetch-model.sh yolox-tiny.
 */
import { AdapterError, AdapterModel, createAdapter, Detection, Frame, verifyFileSha256 } from '../index';

export const YOLOX_TINY_SHA256 = '427cc366d34e27ff7a03e2899b5e3671425c262ea2291f88bb942bc1cc70b0f7';
const SIZE = 416;
const STRIDES = [8, 16, 32];

export const COCO80 = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat', 'traffic light',
  'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow',
  'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee',
  'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard',
  'tennis racket', 'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
  'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch',
  'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard',
  'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase',
  'scissors', 'teddy bear', 'hair drier', 'toothbrush',
];

/**
 * Official YOLOX preproc: resize keeping the aspect ratio (bilinear), paste top-left on a 416x416 canvas of
 * value 114, BGR channel order, raw 0..255 values, NCHW.
 */
export function preprocess(frame: Frame): { tensor: Float32Array; scale: number } {
  const { width: w, height: h, data } = frame;
  const scale = Math.min(SIZE / w, SIZE / h);
  const nw = Math.round(w * scale);
  const nh = Math.round(h * scale);
  const out = new Float32Array(3 * SIZE * SIZE).fill(114);
  const [b, g, r] = frame.format === 'bgr24' ? [0, 1, 2] : [2, 1, 0]; // source byte offset of B, G, R
  for (let y = 0; y < nh; y++) {
    // Bilinear sampling with pixel centres aligned (what cv2.INTER_LINEAR does).
    const sy = Math.min(Math.max((y + 0.5) / scale - 0.5, 0), h - 1);
    const y0 = Math.floor(sy);
    const y1 = Math.min(y0 + 1, h - 1);
    const fy = sy - y0;
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(Math.max((x + 0.5) / scale - 0.5, 0), w - 1);
      const x0 = Math.floor(sx);
      const x1 = Math.min(x0 + 1, w - 1);
      const fx = sx - x0;
      const i00 = (y0 * w + x0) * 3, i01 = (y0 * w + x1) * 3, i10 = (y1 * w + x0) * 3, i11 = (y1 * w + x1) * 3;
      const at = y * SIZE + x;
      for (const [plane, off] of [[0, b], [1, g], [2, r]]) {
        const v = (data[i00 + off] * (1 - fx) + data[i01 + off] * fx) * (1 - fy) + (data[i10 + off] * (1 - fx) + data[i11 + off] * fx) * fy;
        out[plane * SIZE * SIZE + at] = scale === 1 ? data[(y * w + x) * 3 + off] : Math.round(v);
      }
    }
  }
  return { tensor: out, scale };
}

/** demo_postprocess + multiclass_nms(class_agnostic=False), boxes in the 416 canvas as x1, y1, x2, y2. */
export function postprocess(output: Float32Array, scoreThr: number, nmsThr: number) {
  const rowLen = 5 + COCO80.length;
  const perClass = new Map<number, { box: number[]; score: number }[]>();
  let row = 0;
  for (const s of STRIDES) {
    const n = SIZE / s;
    for (let gy = 0; gy < n; gy++) {
      for (let gx = 0; gx < n; gx++, row++) {
        const o = row * rowLen;
        const obj = output[o + 4];
        if (obj < scoreThr) continue;
        const cx = (output[o] + gx) * s, cy = (output[o + 1] + gy) * s;
        const bw = Math.exp(output[o + 2]) * s, bh = Math.exp(output[o + 3]) * s;
        for (let c = 0; c < COCO80.length; c++) {
          const score = obj * output[o + 5 + c];
          if (score <= scoreThr) continue;
          const list = perClass.get(c) ?? [];
          list.push({ box: [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], score });
          perClass.set(c, list);
        }
      }
    }
  }
  const kept: { classId: number; score: number; box: number[] }[] = [];
  for (const [classId, list] of perClass) {
    list.sort((p, q) => q.score - p.score);
    const alive = list.map(() => true);
    const area = (b: number[]) => (b[2] - b[0] + 1) * (b[3] - b[1] + 1);
    for (let i = 0; i < list.length; i++) {
      if (!alive[i]) continue;
      kept.push({ classId, ...list[i] });
      const a = list[i].box;
      for (let j = i + 1; j < list.length; j++) {
        if (!alive[j]) continue;
        const c = list[j].box;
        const iw = Math.max(0, Math.min(a[2], c[2]) - Math.max(a[0], c[0]) + 1);
        const ih = Math.max(0, Math.min(a[3], c[3]) - Math.max(a[1], c[1]) + 1);
        const inter = iw * ih;
        if (inter / (area(a) + area(c) - inter) > nmsThr) alive[j] = false;
      }
    }
  }
  return kept;
}

export function yoloxTinyModel(modelPath: string, opts: { scoreThreshold?: number; nmsThreshold?: number } = {}): AdapterModel {
  // Loaded lazily so the SDK itself does not need onnxruntime-node.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ort = require('onnxruntime-node') as typeof import('onnxruntime-node');
  const scoreThr = opts.scoreThreshold ?? 0.3;
  const nmsThr = opts.nmsThreshold ?? 0.45;
  let session: import('onnxruntime-node').InferenceSession | null = null;
  return {
    card: {
      modelId: 'yolox-tiny-coco',
      name: 'yolox-tiny-coco',
      version: '0.1.1rc0',
      sha256: YOLOX_TINY_SHA256,
      task: 'object_detection',
      classes: COCO80,
      codeLicense: 'Apache-2.0',
      weightsLicense: 'Apache-2.0',
      weightsSource: 'https://github.com/Megvii-BaseDetection/YOLOX/releases/tag/0.1.1rc0',
      runtime: 'onnxruntime',
      input: { width: SIZE, height: SIZE, colorSpace: 'BGR', letterbox: true },
      evaluation: null, // not evaluated on site footage: accuracy is published, not asserted
    },
    executionProvider: 'cpu',
    async load() {
      const bytes = await verifyFileSha256(modelPath, YOLOX_TINY_SHA256);
      session = await ort.InferenceSession.create(bytes, { executionProviders: ['cpu'] });
    },
    async infer(frame: Frame) {
      if (!session) throw new AdapterError('MODEL_NOT_LOADED', 'model not loaded');
      if (frame.format === 'jpeg') throw new AdapterError('INVALID_FRAME', 'this example takes rgb24 or bgr24 frames');
      const { tensor, scale } = preprocess(frame);
      const input = new ort.Tensor('float32', tensor, [1, 3, SIZE, SIZE]);
      const result = await session.run({ [session.inputNames[0]]: input });
      const output = result[session.outputNames[0]].data as Float32Array;
      const detections: Detection[] = [];
      for (const k of postprocess(output, scoreThr, nmsThr)) {
        // Back to frame pixels, clipped, then normalised to the frame.
        const x1 = Math.max(0, Math.min(frame.width, k.box[0] / scale));
        const y1 = Math.max(0, Math.min(frame.height, k.box[1] / scale));
        const x2 = Math.max(0, Math.min(frame.width, k.box[2] / scale));
        const y2 = Math.max(0, Math.min(frame.height, k.box[3] / scale));
        if (x2 <= x1 || y2 <= y1) continue;
        detections.push({
          objectClass: COCO80[k.classId],
          classId: k.classId,
          confidence: Math.min(1, k.score),
          bbox: { x: x1 / frame.width, y: y1 / frame.height, width: (x2 - x1) / frame.width, height: (y2 - y1) / frame.height },
        });
      }
      return { detections };
    },
  };
}

if (require.main === module) {
  const [modelPath, port] = process.argv.slice(2);
  if (!modelPath) {
    console.error('usage: node dist/examples/yoloxTiny.js <yolox_tiny.onnx> [port]');
    process.exit(2);
  }
  const adapter = createAdapter({ adapterId: 'example-yolox-tiny', adapterVersion: '0.1.0', models: [yoloxTinyModel(modelPath)], log: console.log });
  adapter.listen(Number(port || 7020)).then(() => console.log(`example adapter listening on ${port || 7020}`));
}
