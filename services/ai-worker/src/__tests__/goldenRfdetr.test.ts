/**
 * P2.4 golden check on a real RF-DETR Nano export (scripts/models/export-rfdetr.sh nano): this
 * engine (ImageNet preprocessing, onnxruntime-node, RF-DETR decoder, stretch geometry) must match
 * upstream rfdetr decode_detections on the same inputs (tools/reference/rfdetr_reference.py).
 *
 * The export is not hosted anywhere CI can fetch it, so the suite runs only where the file exists
 * ($VIGILONE_RFDETR_ONNX or .cache/models/rfdetr-nano/rfdetr-nano.onnx).
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { OnnxInferenceEngine } from '../inferenceEngine';
import { computeIoU } from '../classScopedNms';
import { CoordinateTransformer } from '../coordinateTransformer';
import { coco91ClassMapping } from '../classMap';
import { ModelManifestRecord } from '../types';

const GOLDEN = path.join(__dirname, 'fixtures', 'golden');
const ONNX =
  process.env.VIGILONE_RFDETR_ONNX || path.resolve(__dirname, '../../../../.cache/models/rfdetr-nano/rfdetr-nano.onnx');
const reference = JSON.parse(fs.readFileSync(path.join(GOLDEN, 'rfdetr-nano.reference.json'), 'utf8'));

const suite = fs.existsSync(ONNX) ? describe : describe.skip;

suite('golden: RF-DETR Nano export matches upstream decode_detections', () => {
  const manifest: ModelManifestRecord = {
    id: 'golden-rfdetr-nano',
    name: 'rfdetr-nano-coco',
    version: '1.11.0',
    sha256: reference.modelSha256,
    codeLicense: 'Apache-2.0',
    weightLicense: 'Apache-2.0',
    isActive: true,
    runtimeConfigJson: {
      runtime: 'onnxruntime',
      inputWidth: 384,
      inputHeight: 384,
      colorSpace: 'RGB',
      normalization: { type: 'mean_std', mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] },
      letterbox: false,
      modelFormat: 'ONNX',
    },
    modelSignatureJson: {
      input: { name: 'input', shape: [1, 3, 384, 384], dtype: 'float32' },
      output: { name: 'dets', shape: [1, 300, 4], dtype: 'float32' },
      logitsOutputName: 'labels',
      coordinateFormat: 'cxcywh',
      hasObjectness: false,
      classCount: 91,
      decoder: 'rfdetr',
      backgroundClassId: null,
    },
    classesJson: coco91ClassMapping(),
    thresholdsJson: { default: reference.threshold },
  };
  const engine = new OnnxInferenceEngine();

  beforeAll(async () => {
    await engine.load(fs.readFileSync(ONNX), manifest.runtimeConfigJson, manifest);
  });

  for (const name of Object.keys(reference.detections)) {
    it(`${name}: same classes, boxes and confidences`, async () => {
      const rgb = execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(GOLDEN, 'inputs', name), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
      const g = CoordinateTransformer.computeGeometry(384, 384, 384, 384, false);
      const got = await engine.infer(rgb, { imageWidth: 384, imageHeight: 384, geometry: g });
      const want: any[] = reference.detections[name];
      expect(got.length).toBe(want.length);
      for (const w of want) {
        const d = got.find((x) => x.classId === w.classId && computeIoU(x.box, w.box) >= 0.99);
        expect({ want: w, found: !!d }).toEqual({ want: w, found: true });
        expect(Math.abs(d!.confidence - w.confidence)).toBeLessThanOrEqual(0.002);
      }
      expect(got.map((d) => d.label)).toEqual(expect.arrayContaining(want.map((w) => coco91ClassMapping()[String(w.classId)])));
    });
  }
});
