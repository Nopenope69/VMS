#!/usr/bin/env node
/**
 * Runs a pinned model through the ai-worker engine (same preprocessing, ffmpeg letterbox and
 * decoder as the stream pipeline) on every image of a COCO annotation file and writes COCO
 * results for coco-eval.mjs.
 *
 *   node tools/eval/detect-images.mjs --gt annotations.json --model yolox-tiny --out dets.json \
 *        [--images DIR] [--min-score 0.05]
 *
 * Needs services/ai-worker built (npm run build) and the model fetched (fetch-model.sh).
 * Category ids are mapped by class name onto the ground truth's categories; classes the ground
 * truth does not contain are dropped.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const require = createRequire(path.join(REPO, 'services/ai-worker/package.json'));
const dist = (m) => require(path.join(REPO, 'services/ai-worker/dist', m));
const { OnnxInferenceEngine } = dist('inferenceEngine');
const { CoordinateTransformer } = dist('coordinateTransformer');
const { buildVideoFilter } = dist('frameExtractor');
const { findLockEntry, artifactPathFor, manifestFromLockEntry } = dist('modelCatalog');

const args = process.argv.slice(2);
const get = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const gtPath = get('--gt');
const out = get('--out');
const key = get('--model', 'yolox-tiny');
if (!gtPath || !out) {
  console.error('usage: detect-images.mjs --gt annotations.json --model <lock key> --out dets.json [--images DIR] [--min-score 0.05]');
  process.exit(2);
}
const gt = JSON.parse(fs.readFileSync(gtPath, 'utf8'));
const imageDir = path.resolve(REPO, get('--images', gt.info?.imageDir || path.dirname(gtPath)));
const minScore = Number(get('--min-score', '0.05'));

const entry = findLockEntry(key);
const artifact = artifactPathFor(entry);
if (!fs.existsSync(artifact)) {
  console.error(`model artefact ${artifact} missing: scripts/models/fetch-model.sh ${key}`);
  process.exit(1);
}
const manifest = manifestFromLockEntry(entry, `${entry.name}@${entry.version}`);
manifest.thresholdsJson = { default: minScore }; // low floor: AP needs the full score range
const engine = new OnnxInferenceEngine();
await engine.load(fs.readFileSync(artifact), manifest.runtimeConfigJson, manifest);
const rc = manifest.runtimeConfigJson;
const catByName = new Map(gt.categories.map((c) => [c.name, c.id]));

const results = [];
let totalMs = 0;
for (const img of gt.images) {
  const file = path.join(imageDir, img.file_name);
  const g = CoordinateTransformer.computeGeometry(img.width, img.height, rc.inputWidth, rc.inputHeight, rc.letterbox !== false, rc.padPosition ?? 'center');
  // The stream pipeline's scale/pad chain; the fps stage is dropped for still images (it would
  // emit no frame for a single-frame input).
  const vf = buildVideoFilter(g, 1, rc.padValue ?? 0).replace(/^fps=[^,]+,/, '');
  const rgb = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', vf, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const t0 = Date.now();
  const dets = await engine.infer(rgb, { imageWidth: rc.inputWidth, imageHeight: rc.inputHeight, geometry: g });
  totalMs += Date.now() - t0;
  for (const d of dets) {
    const cat = catByName.get(d.label);
    if (cat === undefined) continue;
    results.push({
      image_id: img.id,
      category_id: cat,
      bbox: [d.box.x * img.width, d.box.y * img.height, d.box.width * img.width, d.box.height * img.height].map((v) => Math.round(v * 100) / 100),
      score: d.confidence,
    });
  }
}
fs.writeFileSync(out, JSON.stringify(results, null, 1) + '\n');
console.log(JSON.stringify({ model: `${entry.name}:${entry.version}`, sha256: entry.sha256, images: gt.images.length, detections: results.length, meanInferenceMs: Math.round(totalMs / gt.images.length) }));
