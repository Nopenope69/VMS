import fs from 'fs';
import path from 'path';
import { decodeRfdetr, decodeYolox, yoloxAnchorCount, decodeModelOutputs } from '../decoders';
import { fillPlanarTensor } from '../preprocess';
import { CoordinateTransformer } from '../coordinateTransformer';
import { coco80ClassMapping, coco91ClassMapping, toVigilOneClass, eventTypeForClass } from '../classMap';
import { ModelSignature } from '../types';

describe('RF-DETR decoder matches upstream decode_detections', () => {
  const ref = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'rfdetr', 'decode.reference.json'), 'utf8')
  );

  for (const c of ref.cases) {
    it(`${c.name}: same query/class pairs, order, scores and boxes`, () => {
      const mapping: Record<string, string> = {};
      for (let i = 0; i < c.numClasses; i++) mapping[String(i)] = `c${i}`;
      const got = decodeRfdetr(
        Float32Array.from(c.boxes),
        Float32Array.from(c.logits),
        mapping,
        { default: c.threshold },
        { numQueries: c.numQueries, numClasses: c.numClasses, backgroundClassId: c.backgroundClassId }
      );
      expect(got.map((d) => d.classId)).toEqual(c.expected.map((e: any) => e.classId));
      got.forEach((d, i) => {
        const e = c.expected[i];
        expect(d.confidence).toBeCloseTo(e.confidence, 5);
        expect(d.box.x).toBeCloseTo(e.xyxy[0], 5);
        expect(d.box.y).toBeCloseTo(e.xyxy[1], 5);
        expect(d.box.x + d.box.width).toBeCloseTo(e.xyxy[2], 5);
        expect(d.box.y + d.box.height).toBeCloseTo(e.xyxy[3], 5);
      });
    });
  }

  it('keeps both classes when one query scores above threshold on two (no argmax collapse)', () => {
    const c = ref.cases[0];
    const q3 = c.expected.filter((e: any) => e.queryIndex === 3).map((e: any) => e.classId).sort();
    expect(q3).toEqual([1, 3]);
    const got = decodeRfdetr(Float32Array.from(c.boxes), Float32Array.from(c.logits), coco91ClassMapping(), { default: c.threshold }, {
      numQueries: c.numQueries,
      numClasses: c.numClasses,
      backgroundClassId: null,
    });
    const labels = got.map((d) => d.label);
    expect(labels).toEqual(expect.arrayContaining(['person', 'car']));
  });

  it('rejects tensors whose sizes do not match the declared query/class counts', () => {
    expect(() =>
      decodeRfdetr(new Float32Array(10), new Float32Array(10), {}, {}, { numQueries: 3, numClasses: 2 })
    ).toThrow(/boxes length mismatch/);
  });
});

describe('YOLOX grid decoder', () => {
  const W = 64; // strides 8/16/32 -> 64 + 16 + 4 = 84 anchors
  const numClasses = 3;
  const rowLen = 5 + numClasses;

  function emptyOutput(): Float32Array {
    return new Float32Array(yoloxAnchorCount(W, W) * rowLen);
  }

  it('computes the anchor count of the official exports', () => {
    expect(yoloxAnchorCount(416, 416)).toBe(3549);
    expect(yoloxAnchorCount(640, 640)).toBe(8400);
  });

  it('decodes (t + grid) * stride and exp(t) * stride, with score = obj * cls', () => {
    const out = emptyOutput();
    // Stride-8 grid is 8x8; anchor at gy=2, gx=3 -> row 2*8+3 = 19.
    const row = 19;
    const o = row * rowLen;
    out[o] = 0.5; // cx = (0.5 + 3) * 8 = 28
    out[o + 1] = 0.25; // cy = (0.25 + 2) * 8 = 18
    out[o + 2] = Math.log(2); // w = 2 * 8 = 16
    out[o + 3] = Math.log(3); // h = 3 * 8 = 24
    out[o + 4] = 0.9; // obj
    out[o + 5 + 1] = 0.8; // class 1 -> 0.72
    const got = decodeYolox(out, { '0': 'a', '1': 'b', '2': 'c' }, { default: 0.3 }, { modelWidth: W, modelHeight: W, numClasses });
    expect(got).toHaveLength(1);
    expect(got[0].label).toBe('b');
    expect(got[0].confidence).toBeCloseTo(0.72, 6);
    expect(got[0].box.x * W).toBeCloseTo(20, 4); // 28 - 8
    expect(got[0].box.y * W).toBeCloseTo(6, 4); // 18 - 12
    expect(got[0].box.width * W).toBeCloseTo(16, 4);
    expect(got[0].box.height * W).toBeCloseTo(24, 4);
  });

  it('indexes the stride-16 and stride-32 grids after stride 8', () => {
    const out = emptyOutput();
    const row = 64 + 16 + 0; // first stride-32 anchor
    const o = row * rowLen;
    out[o + 2] = 0; // w = 32
    out[o + 3] = 0; // h = 32
    out[o + 4] = 1;
    out[o + 5] = 0.9;
    const got = decodeYolox(out, { '0': 'a' }, { default: 0.3 }, { modelWidth: W, modelHeight: W, numClasses });
    expect(got).toHaveLength(1);
    // cx = cy = 0 * 32 -> box from -16..16 clipped to 0..16
    expect(got[0].box).toEqual({ x: 0, y: 0, width: 16 / W, height: 16 / W });
  });

  it('is class-aware: one anchor above threshold on two classes yields two candidates', () => {
    const out = emptyOutput();
    const o = 5 * rowLen;
    out[o + 2] = 1;
    out[o + 3] = 1;
    out[o + 4] = 1;
    out[o + 5] = 0.7;
    out[o + 7] = 0.6;
    const got = decodeYolox(out, { '0': 'car', '2': 'truck' }, { default: 0.5 }, { modelWidth: W, modelHeight: W, numClasses });
    expect(got.map((d) => d.label).sort()).toEqual(['car', 'truck']);
  });

  it('applies per-class thresholds from the manifest', () => {
    const out = emptyOutput();
    const o = 7 * rowLen;
    out[o + 2] = 1;
    out[o + 3] = 1;
    out[o + 4] = 1;
    out[o + 5] = 0.45;
    const mapping = { '0': 'person' };
    expect(decodeYolox(out, mapping, { person: 0.5 }, { modelWidth: W, modelHeight: W, numClasses })).toHaveLength(0);
    expect(decodeYolox(out, mapping, { person: 0.4 }, { modelWidth: W, modelHeight: W, numClasses })).toHaveLength(1);
  });

  it('fails loudly when the tensor does not match the declared input size', () => {
    expect(() =>
      decodeYolox(new Float32Array(10), {}, {}, { modelWidth: W, modelHeight: W, numClasses })
    ).toThrow(/YOLOX output length mismatch/);
  });

  it('decodeModelOutputs rejects an unknown decoder instead of guessing', () => {
    const sig = {
      input: { name: 'images', shape: [1, 3, 64, 64], dtype: 'float32' },
      output: { name: 'output', shape: [1, 84, 8], dtype: 'float32' },
      coordinateFormat: 'cxcywh',
      hasObjectness: true,
      classCount: 3,
      decoder: 'mystery',
    } as unknown as ModelSignature;
    expect(() =>
      decodeModelOutputs({ signature: sig, classMapping: {}, thresholds: {}, outputs: { output: emptyOutput() } })
    ).toThrow(/UNSUPPORTED_DECODER/);
  });

  it('decodeModelOutputs fails when the named output tensor is missing', () => {
    const sig: ModelSignature = {
      input: { name: 'images', shape: [1, 3, 64, 64], dtype: 'float32' },
      output: { name: 'output', shape: [1, 84, 8], dtype: 'float32' },
      coordinateFormat: 'cxcywh',
      hasObjectness: true,
      classCount: 3,
      decoder: 'yolox',
    };
    expect(() => decodeModelOutputs({ signature: sig, classMapping: {}, thresholds: {}, outputs: {} })).toThrow(
      /expected output tensor 'output'/
    );
  });
});

describe('model-driven preprocessing', () => {
  // 2x1 image: pixel0 = (10, 20, 30), pixel1 = (40, 50, 60)
  const rgb = Buffer.from([10, 20, 30, 40, 50, 60]);

  it('BGR + no normalization gives raw planar B, G, R (YOLOX)', () => {
    const out = new Float32Array(6);
    fillPlanarTensor(rgb, out, 2, 1, {
      runtime: 'onnxruntime', inputWidth: 2, inputHeight: 1, colorSpace: 'BGR', normalization: { type: 'none' }, modelFormat: 'ONNX',
    });
    expect(Array.from(out)).toEqual([30, 60, 20, 50, 10, 40]);
  });

  it('RGB + ImageNet mean/std (RF-DETR)', () => {
    const out = new Float32Array(6);
    fillPlanarTensor(rgb, out, 2, 1, {
      runtime: 'onnxruntime', inputWidth: 2, inputHeight: 1, colorSpace: 'RGB', normalization: { type: 'mean_std' }, modelFormat: 'ONNX',
    });
    expect(out[0]).toBeCloseTo((10 / 255 - 0.485) / 0.229, 5);
    expect(out[3]).toBeCloseTo((50 / 255 - 0.456) / 0.224, 5);
    expect(out[5]).toBeCloseTo((60 / 255 - 0.406) / 0.225, 5);
  });

  it('legacy config without a normalization block divides by 255', () => {
    const out = new Float32Array(6);
    fillPlanarTensor(rgb, out, 2, 1, { runtime: 'onnxruntime', inputWidth: 2, inputHeight: 1, colorSpace: 'RGB', modelFormat: 'ONNX' });
    expect(out[0]).toBeCloseTo(10 / 255, 6);
  });

  it('rejects a frame whose byte size does not match the model input', () => {
    expect(() =>
      fillPlanarTensor(rgb, new Float32Array(12), 2, 2, { runtime: 'onnxruntime', inputWidth: 2, inputHeight: 2, colorSpace: 'RGB', modelFormat: 'ONNX' })
    ).toThrow(/INVALID_FRAME/);
  });
});

describe('geometry: top-left letterbox and stretch', () => {
  it('top-left padding (YOLOX layout) keeps the image at the origin', () => {
    const g = CoordinateTransformer.computeGeometry(600, 400, 416, 416, true, 'top-left');
    expect(g).toMatchObject({ padX: 0, padY: 0, scaledWidth: 416, scaledHeight: 277 });
    // A box covering the bottom padding band maps to the bottom edge of the image, clipped.
    const r = CoordinateTransformer.reverseTransformBox({ x: 0, y: 200 / 416, width: 1, height: 216 / 416 }, g);
    expect(r.y).toBeCloseTo(200 / 277, 3);
    expect(r.y + r.height).toBeCloseTo(1, 3);
  });

  it('stretch geometry reverses per axis (a non-square source is not distorted)', () => {
    const g = CoordinateTransformer.computeGeometry(1920, 1080, 384, 384, false);
    const r = CoordinateTransformer.reverseTransformBox({ x: 0.25, y: 0.5, width: 0.5, height: 0.25 }, g);
    expect(r).toEqual({ x: 0.25, y: 0.5, width: 0.5, height: 0.25 });
  });

  it('clips a box that starts inside the padding band to the visible part', () => {
    const g = CoordinateTransformer.computeGeometry(1920, 1080, 640, 640, true); // padY = 140
    const r = CoordinateTransformer.reverseTransformBox({ x: 0, y: 50 / 640, width: 100 / 640, height: 150 / 640 }, g);
    expect(r.y).toBe(0);
    // Visible part is 140..200 model px = 60 px of 360 -> 0.1667 of the source height.
    expect(r.height).toBeCloseTo(60 / 360, 3);
  });
});

describe('COCO -> VigilOne v1 classes', () => {
  it('maps the six v1 classes and the three bag classes, and drops everything else', () => {
    const coco = coco80ClassMapping();
    const v1 = Object.values(coco).map(toVigilOneClass).filter(Boolean);
    expect(new Set(v1)).toEqual(new Set(['person', 'bicycle', 'motorcycle', 'car', 'bus', 'truck', 'backpack', 'handbag', 'suitcase']));
    expect(toVigilOneClass('dining table')).toBeNull();
    expect(eventTypeForClass('person')).toBe('PERSON_DETECTED');
    expect(eventTypeForClass('truck')).toBe('VEHICLE_DETECTED');
    // Bags feed the unattended-object rule, never the person or vehicle triggers.
    expect(eventTypeForClass('suitcase')).toBe('OBJECT_DETECTED');
    expect(toVigilOneClass('knife')).toBeNull();
  });

  it('COCO91 category ids follow the official sparse layout', () => {
    const m = coco91ClassMapping();
    expect(m['1']).toBe('person');
    expect(m['3']).toBe('car');
    expect(m['8']).toBe('truck');
    expect(m['12']).toBeUndefined();
    expect(m['90']).toBe('toothbrush');
  });
});
