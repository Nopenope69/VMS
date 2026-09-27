/**
 * P2.4 golden fixtures: the real YOLOX ONNX models, run through the ai-worker engine (preprocess,
 * onnxruntime-node, grid decoder, class-scoped NMS, letterbox reversal), must reproduce the
 * detections of the official YOLOX Python post-processing on the same inputs
 * (tools/reference/yolox_reference.py -> fixtures/golden/<model>.reference.json).
 *
 * Needs the model files (scripts/models/fetch-model.sh). When they are absent the suite is skipped,
 * unless VIGILONE_REQUIRE_MODEL_TESTS=1 (set in CI), in which case it fails.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { OnnxInferenceEngine } from '../inferenceEngine';
import { computeIoU } from '../classScopedNms';
import { artifactPathFor, findLockEntry, manifestFromLockEntry } from '../modelCatalog';
import { FrameGeometry } from '../types';

const GOLDEN = path.join(__dirname, 'fixtures', 'golden');
const geometry: Record<string, { geometry: FrameGeometry }> = JSON.parse(
  fs.readFileSync(path.join(GOLDEN, 'inputs', 'geometry.json'), 'utf8')
);

function decodePngToRgb(file: string): Buffer {
  return execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
    maxBuffer: 64 * 1024 * 1024,
  });
}

const requireModels = process.env.VIGILONE_REQUIRE_MODEL_TESTS === '1';

for (const key of ['yolox-nano', 'yolox-tiny']) {
  const entry = findLockEntry(key);
  const artifact = artifactPathFor(entry);
  const present = fs.existsSync(artifact);
  const reference = JSON.parse(fs.readFileSync(path.join(GOLDEN, `${key}.reference.json`), 'utf8'));

  if (!present && requireModels) {
    test(`${key}: model artefact required (VIGILONE_REQUIRE_MODEL_TESTS=1)`, () => {
      throw new Error(`Model file ${artifact} missing; run scripts/models/fetch-model.sh ${key}`);
    });
    continue;
  }

  const suite = present ? describe : describe.skip;
  suite(`golden: ${key} matches the official YOLOX post-processing`, () => {
    const engine = new OnnxInferenceEngine();
    const manifest = manifestFromLockEntry(entry, `golden-${key}`);
    // Same score floor as the reference run, for every class.
    manifest.thresholdsJson = { default: reference.scoreThreshold };
    manifest.nmsConfigJson = { iouThreshold: reference.nmsThreshold };

    beforeAll(async () => {
      expect(reference.modelSha256).toBe(entry.sha256);
      await engine.load(fs.readFileSync(artifact), manifest.runtimeConfigJson, manifest);
    });

    for (const name of Object.keys(reference.detections)) {
      it(`${name}: same classes, boxes (IoU >= 0.98) and confidences (|d| <= 0.002)`, async () => {
        const g = geometry[name].geometry;
        const rgb = decodePngToRgb(path.join(GOLDEN, 'inputs', name));
        const got = await engine.infer(rgb, { imageWidth: g.modelWidth, imageHeight: g.modelHeight, geometry: g });
        const want: Array<{ classId: number; confidence: number; box: any }> = reference.detections[name];

        expect(got.length).toBe(want.length);
        const unmatched = [...got];
        for (const w of want) {
          const idx = unmatched.findIndex(
            (d) => d.classId === w.classId && computeIoU(d.box, w.box) >= 0.98
          );
          expect({ reference: w, matched: idx >= 0 }).toEqual({ reference: w, matched: true });
          const d = unmatched.splice(idx, 1)[0];
          expect(Math.abs(d.confidence - w.confidence)).toBeLessThanOrEqual(0.002);
          expect(d.label).toBe(manifest.classesJson![String(w.classId)]);
        }
      });
    }
  });
}
