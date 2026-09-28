/**
 * Plate-level evaluation (P4.3): pure metric code shared by the eval CLI and its tests.
 *
 * A dataset is a labels CSV (image_path,plate_text[,split,camera,condition]) next to a
 * dataset.json header that declares what the data is: { "kind": "SITE" | "SYNTHETIC", "name": … }.
 * The kind is never inferred: SITE accuracy is only reported for data a person declared as site
 * footage. An empty plate_text is a negative (no plate expected; any read is a false read).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { cleanPlateText } from './indianPlate.v1';

export type DatasetKind = 'SITE' | 'SYNTHETIC';

export interface EvalSample {
  file: string;
  /** Absolute path of the image. */
  imagePath: string;
  /** Normalised expected plate ('' = negative sample). */
  expected: string;
  split: string;
  camera: string;
  condition: string;
}

export interface EvalDataset {
  kind: DatasetKind;
  name: string;
  meta: Record<string, unknown>;
  samples: EvalSample[];
}

export class EvalDatasetError extends Error {}

/** Normalised label: upper-case alphanumerics (the same form as VehicleObservation.normalizedPlate). */
export const normalizeLabel = (s: string) => cleanPlateText(s || '');

/** Minimal RFC 4180 CSV reader (quoted fields, doubled quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

/**
 * Loads a dataset directory: dataset.json + labels.csv. The SYNTHETIC fixture manifest
 * (SYNTHETIC_manifest.json with images[].file/plateText) is accepted too.
 */
export function loadEvalDataset(dir: string, opts: { split?: string } = {}): EvalDataset {
  const synth = path.join(dir, 'SYNTHETIC_manifest.json');
  if (!fs.existsSync(path.join(dir, 'dataset.json')) && fs.existsSync(synth)) {
    const m = JSON.parse(fs.readFileSync(synth, 'utf8'));
    if (m.kind !== 'SYNTHETIC') throw new EvalDatasetError(`${synth}: kind must be SYNTHETIC`);
    const samples = (m.images as any[]).map((im) => ({
      file: im.file,
      imagePath: path.join(dir, im.file),
      expected: normalizeLabel(im.plateText),
      split: 'test',
      camera: 'synthetic',
      condition: String(im.format ?? ''),
    }));
    return { kind: 'SYNTHETIC', name: `synthetic fixtures (${m.generator}, seed ${m.seed})`, meta: { generator: m.generator, seed: m.seed }, samples };
  }
  const headerPath = path.join(dir, 'dataset.json');
  if (!fs.existsSync(headerPath)) throw new EvalDatasetError(`${headerPath} is missing: declare the dataset kind (SITE or SYNTHETIC) and name`);
  const header = JSON.parse(fs.readFileSync(headerPath, 'utf8'));
  if (header.kind !== 'SITE' && header.kind !== 'SYNTHETIC') throw new EvalDatasetError(`${headerPath}: kind must be "SITE" or "SYNTHETIC"`);
  if (typeof header.name !== 'string' || !header.name.trim()) throw new EvalDatasetError(`${headerPath}: name is required`);
  const labelsPath = path.join(dir, header.labels || 'labels.csv');
  const rows = parseCsv(fs.readFileSync(labelsPath, 'utf8'));
  if (rows.length < 2) throw new EvalDatasetError(`${labelsPath} has no samples`);
  const cols = rows[0].map((c) => c.trim());
  const ix = (n: string) => cols.indexOf(n);
  if (ix('image_path') < 0 || ix('plate_text') < 0) throw new EvalDatasetError(`${labelsPath}: columns image_path and plate_text are required`);
  const get = (r: string[], n: string, d = '') => (ix(n) >= 0 ? (r[ix(n)] ?? d).trim() : d);
  const samples: EvalSample[] = [];
  const seen = new Set<string>();
  for (const r of rows.slice(1)) {
    const file = get(r, 'image_path');
    if (!file) throw new EvalDatasetError(`${labelsPath}: empty image_path`);
    if (seen.has(file)) throw new EvalDatasetError(`${labelsPath}: duplicate image_path ${file}`);
    seen.add(file);
    const imagePath = path.resolve(dir, file);
    if (!fs.existsSync(imagePath)) throw new EvalDatasetError(`${imagePath} (listed in ${labelsPath}) does not exist`);
    const s: EvalSample = { file, imagePath, expected: normalizeLabel(get(r, 'plate_text')), split: get(r, 'split', 'test') || 'test', camera: get(r, 'camera', ''), condition: get(r, 'condition', '') };
    if (!opts.split || s.split === opts.split) samples.push(s);
  }
  if (samples.length === 0) throw new EvalDatasetError(`${labelsPath}: no samples in split '${opts.split}'`);
  return { kind: header.kind, name: header.name, meta: header, samples };
}

export const sha256File = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** Content hash of the evaluated set: sorted "imageSha expected" lines, so file renames do not change it. */
export function datasetDigest(samples: Array<{ imageSha256: string; expected: string }>): string {
  const lines = samples.map((s) => `${s.imageSha256} ${s.expected}`).sort();
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** Hashes listed in a training manifest (one SHA-256 per line, # comments allowed). */
export function readHashList(file: string): Set<string> {
  return new Set(
    fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/)[0])
      .filter((h) => /^[a-f0-9]{64}$/.test(h))
  );
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = new Array(b.length + 1).fill(0).map((_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Wilson score interval (95 %) for k successes in n trials. */
export function wilson95(k: number, n: number): [number, number] | null {
  if (n === 0) return null;
  const z = 1.959963984540054;
  const p = k / n;
  const den = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export interface SampleOutcome {
  file: string;
  expected: string;
  /** Normalised reads, best first. */
  reads: string[];
  rawTexts: string[];
  lines: number[];
  latencyMs: number;
  camera: string;
  condition: string;
}

export type OutcomeClass = 'correct' | 'misread' | 'no_read' | 'true_negative' | 'false_read';

export function classify(o: Pick<SampleOutcome, 'expected' | 'reads'>): OutcomeClass {
  if (!o.expected) return o.reads.length ? 'false_read' : 'true_negative';
  if (o.reads.includes(o.expected)) return 'correct';
  return o.reads.length ? 'misread' : 'no_read';
}

const quantile = (xs: number[], q: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
};

interface Group {
  positives: number;
  correct: number;
  misread: number;
  noRead: number;
}

function summariseGroup(g: Group) {
  return {
    positives: g.positives,
    correct: g.correct,
    plateAccuracy: g.positives ? g.correct / g.positives : null,
    plateAccuracyCi95: wilson95(g.correct, g.positives),
    misreadRate: g.positives ? g.misread / g.positives : null,
    noReadRate: g.positives ? g.noRead / g.positives : null,
  };
}

/** Aggregates per-sample outcomes into the report's metrics (all ratios over counted samples; null when undefined). */
export function summarise(outcomes: SampleOutcome[]) {
  const total: Group = { positives: 0, correct: 0, misread: 0, noRead: 0 };
  const by: Record<string, Record<string, Group>> = { camera: {}, condition: {}, expectedLength: {} };
  let negatives = 0;
  let falseReads = 0;
  let editSum = 0;
  let charSum = 0;
  for (const o of outcomes) {
    const c = classify(o);
    if (!o.expected) {
      negatives++;
      if (c === 'false_read') falseReads++;
      continue;
    }
    const keys: Record<string, string> = { camera: o.camera || '(none)', condition: o.condition || '(none)', expectedLength: String(o.expected.length) };
    for (const g of [total, ...Object.entries(keys).map(([k, v]) => (by[k][v] ||= { positives: 0, correct: 0, misread: 0, noRead: 0 }))]) {
      g.positives++;
      if (c === 'correct') g.correct++;
      else if (c === 'misread') g.misread++;
      else g.noRead++;
    }
    // Character error rate against the best read (an empty read costs every character).
    const best = c === 'correct' ? o.expected : o.reads[0] ?? '';
    editSum += levenshtein(best, o.expected);
    charSum += o.expected.length;
  }
  const lat = outcomes.map((o) => o.latencyMs);
  const groups = (m: Record<string, Group>) => Object.fromEntries(Object.entries(m).sort().map(([k, g]) => [k, summariseGroup(g)]));
  return {
    samples: outcomes.length,
    ...summariseGroup(total),
    characterErrorRate: charSum ? editSum / charSum : null,
    negatives,
    falseReads,
    falseReadRate: negatives ? falseReads / negatives : null,
    latencyMs: { p50: quantile(lat, 0.5), p95: quantile(lat, 0.95), max: lat.length ? Math.max(...lat) : null },
    byCamera: groups(by.camera),
    byCondition: groups(by.condition),
    byExpectedLength: groups(by.expectedLength),
  };
}
