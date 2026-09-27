/**
 * vigilone-eval-plates (P4.3): plate-level accuracy of the ANPR pipeline on a labelled dataset.
 *
 *   node dist/tools/evalPlates.js --dataset <dir> [--split test] [--out report.json]
 *        [--train-hashes train-image-hashes.txt] [--ocr-model m.onnx --ocr-config cfg.yaml]
 *        [--min-confidence 0.5] [--no-require-valid-format] [--max-errors 50]
 *
 * Runs the pinned pipeline (anpr-india-v1) in evaluation mode: the models' hashes are verified but
 * no licence approval is needed, because nothing leaves this process. --ocr-model evaluates an
 * unpinned OCR (a fine-tune) with the same detector; the report records its SHA-256.
 *
 * The report's kind comes from the dataset's own declaration (dataset.json), so a SYNTHETIC run can
 * never be reported as site accuracy. With --train-hashes, any evaluated image whose SHA-256 is in
 * the training set aborts the run (exit 3): held-out means held out.
 *
 * Exit codes: 0 ok, 2 bad input, 3 train/test leakage, 4 pipeline refused.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { loadAnprPipeline, AnprLoadError } from '../anpr/anprService';
import { Image3 } from '../anpr/imageOps';
import { loadEvalDataset, EvalDatasetError, sha256File, datasetDigest, readHashList, summarise, classify, SampleOutcome } from '../anpr/plateEval';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function fail(code: number, msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

function loadImage(file: string): Image3 {
  const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim();
  const [width, height] = probe.split(',').map(Number);
  if (!width || !height) throw new Error(`${file}: not a decodable image`);
  const data = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 256 << 20 });
  if (data.length !== width * height * 3) throw new Error(`${file}: decoded ${data.length} bytes, expected ${width * height * 3}`);
  return { data: new Uint8Array(data), width, height };
}

async function main() {
  const dir = arg('dataset');
  if (!dir) fail(2, 'usage: evalPlates --dataset <dir> [--split test] [--out report.json] [--train-hashes file] [--ocr-model m.onnx --ocr-config cfg.yaml]');
  const split = arg('split') ?? 'test';
  let ds;
  try {
    ds = loadEvalDataset(path.resolve(dir), { split });
  } catch (e: any) {
    if (e instanceof EvalDatasetError) fail(2, `DATASET_INVALID: ${e.message}`);
    throw e;
  }

  const hashes = ds.samples.map((s) => sha256File(s.imagePath));
  const trainHashesFile = arg('train-hashes');
  if (trainHashesFile) {
    const train = readHashList(trainHashesFile);
    const leaked = ds.samples.filter((_, i) => train.has(hashes[i])).map((s) => s.file);
    if (leaked.length) fail(3, `TRAIN_TEST_LEAKAGE: ${leaked.length} evaluated image(s) are in the training set: ${leaked.slice(0, 10).join(', ')}`);
  }

  const ocrModel = arg('ocr-model');
  const ocrConfig = arg('ocr-config');
  if (Boolean(ocrModel) !== Boolean(ocrConfig)) fail(2, '--ocr-model and --ocr-config go together');
  let loaded;
  try {
    loaded = await loadAnprPipeline({ evaluationOnly: true, plateOcrOverride: ocrModel ? { modelPath: path.resolve(ocrModel), configPath: path.resolve(ocrConfig!) } : undefined });
  } catch (e: any) {
    if (e instanceof AnprLoadError) fail(4, e.message);
    throw e;
  }
  const opts = {
    minConfidence: Number(arg('min-confidence') ?? loaded.definition.recognition.minConfidence),
    requireValidFormat: flag('no-require-valid-format') ? false : loaded.definition.recognition.requireValidFormat,
  };

  const outcomes: SampleOutcome[] = [];
  for (const s of ds.samples) {
    const img = loadImage(s.imagePath);
    const t0 = process.hrtime.bigint();
    const r = await loaded.pipeline.read(img, opts);
    const latencyMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const plates = [...r.plates].sort((a, b) => b.confidence - a.confidence);
    outcomes.push({
      file: s.file,
      expected: s.expected,
      reads: plates.map((p) => p.plate.normalized),
      rawTexts: plates.map((p) => p.rawText),
      lines: plates.map((p) => p.lines),
      latencyMs,
      camera: s.camera,
      condition: s.condition,
    });
  }

  const maxErrors = Number(arg('max-errors') ?? 50);
  const report = {
    tool: 'vigilone-eval-plates',
    reportVersion: 1,
    kind: ds.kind,
    label: ds.kind === 'SYNTHETIC' ? 'SYNTHETIC: not a measurement of site accuracy' : 'SITE (declared in dataset.json)',
    dataset: {
      name: ds.name,
      split,
      samples: ds.samples.length,
      contentSha256: datasetDigest(ds.samples.map((s, i) => ({ imageSha256: hashes[i], expected: s.expected }))),
      declared: ds.meta,
      leakageChecked: Boolean(trainHashesFile),
    },
    pipeline: {
      name: loaded.definition.name,
      version: loaded.definition.version,
      definitionSha256: loaded.definitionSha256,
      components: loaded.components.map((c) => ({ role: c.role, key: c.entry.key, sha256: c.entry.sha256 })),
      plateOcrOverride: loaded.plateOcrOverride ?? null,
      options: opts,
    },
    host: { node: process.version, platform: `${process.platform}-${process.arch}` },
    generatedAt: new Date().toISOString(),
    metrics: summarise(outcomes),
    errors: outcomes
      .filter((o) => !['correct', 'true_negative'].includes(classify(o)))
      .slice(0, maxErrors)
      .map((o) => ({ file: o.file, outcome: classify(o), expected: o.expected, reads: o.reads, rawTexts: o.rawTexts, lines: o.lines })),
  };

  const json = JSON.stringify(report, null, 2);
  const out = arg('out');
  if (out) fs.writeFileSync(out, json + '\n');
  const m = report.metrics;
  const pct = (x: number | null) => (x === null ? 'n/a' : `${(100 * x).toFixed(1)}%`);
  process.stderr.write(
    `[${report.kind}] ${ds.name} (${split}, ${m.samples} images): plate accuracy ${pct(m.plateAccuracy)} ` +
      `(95% CI ${m.plateAccuracyCi95 ? m.plateAccuracyCi95.map(pct).join('–') : 'n/a'}), misread ${pct(m.misreadRate)}, ` +
      `no-read ${pct(m.noReadRate)}, CER ${pct(m.characterErrorRate)}, false reads ${m.falseReads}/${m.negatives}` +
      `${out ? `; report ${out}` : ''}\n`
  );
  if (!out) process.stdout.write(json + '\n');
}

main().catch((e) => fail(1, e?.stack || String(e)));
