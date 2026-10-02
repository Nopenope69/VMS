/**
 * P4.3 evaluation harness: metrics, dataset declaration rules and the train/test leakage refusal.
 * The CLI tests run the compiled tool on the SYNTHETIC fixtures when the candidate models exist.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { parseCsv, levenshtein, wilson95, classify, summarise, loadEvalDataset, EvalDatasetError, datasetDigest, SampleOutcome, calibration, operatingPoints, verdict, MIN_SITE_POSITIVES } from '../anpr/plateEval';
import { artifactPathFor, findCandidateEntry } from '../modelCatalog';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'plateeval-'));
const FIX = path.join(__dirname, 'fixtures', 'anpr');

describe('plate evaluation metrics', () => {
  it('parses quoted CSV fields and CRLF', () => {
    expect(parseCsv('a,b\r\n"x,1","say ""hi"""\n\n')).toEqual([['a', 'b'], ['x,1', 'say "hi"']]);
  });

  it('levenshtein and Wilson interval', () => {
    expect(levenshtein('MH12AB1234', 'MH12AB1234')).toBe(0);
    expect(levenshtein('MH12AB1234', 'MH12A81234')).toBe(1);
    expect(levenshtein('', 'KA01')).toBe(4);
    expect(wilson95(0, 0)).toBeNull();
    const [lo, hi] = wilson95(6, 6)!;
    expect(lo).toBeCloseTo(0.6097, 3);
    expect(hi).toBe(1);
    const [l2, h2] = wilson95(48, 60)!;
    expect(l2).toBeCloseTo(0.6818, 3);
    expect(h2).toBeCloseTo(0.8818, 3);
  });

  it('classifies outcomes, including negatives', () => {
    expect(classify({ expected: 'KA05C7788', reads: ['KA05C7788'] })).toBe('correct');
    expect(classify({ expected: 'KA05C7788', reads: ['KA05C7738'] })).toBe('misread');
    expect(classify({ expected: 'KA05C7788', reads: [] })).toBe('no_read');
    expect(classify({ expected: '', reads: [] })).toBe('true_negative');
    expect(classify({ expected: '', reads: ['KA05C7788'] })).toBe('false_read');
  });

  it('summarises accuracy, misreads, CER and false reads with nulls where undefined', () => {
    const o = (expected: string, reads: string[], condition = 'day'): SampleOutcome => ({ file: expected || 'neg', expected, reads, rawTexts: reads, lines: reads.map(() => 1), latencyMs: 10, camera: 'c1', condition });
    const s = summarise([o('MH12AB1234', ['MH12AB1234']), o('KA05C7788', ['KA05C7738'], 'night'), o('DL3CAB4521', [], 'night'), o('', [])]);
    expect(s.positives).toBe(3);
    expect(s.plateAccuracy).toBeCloseTo(1 / 3);
    expect(s.misreadRate).toBeCloseTo(1 / 3);
    expect(s.noReadRate).toBeCloseTo(1 / 3);
    expect(s.characterErrorRate).toBeCloseTo((0 + 1 + 10) / (10 + 9 + 10));
    expect(s.falseReadRate).toBe(0);
    expect(s.byCondition.night.positives).toBe(2);
    expect(s.byCondition.night.plateAccuracy).toBe(0);
    expect(summarise([o('', [])]).plateAccuracy).toBeNull();
  });

  const read = (expected: string, top: string | null, confidence = 0.9, extra: Partial<SampleOutcome> = {}): SampleOutcome => ({
    file: `${expected || 'neg'}-${Math.random()}`,
    expected,
    reads: top ? [top] : [],
    confidences: top ? [confidence] : [],
    rawTexts: top ? [top] : [],
    lines: top ? [1] : [],
    latencyMs: 5,
    camera: 'c1',
    condition: 'day',
    ...extra,
  });

  it('breaks results down by vehicle and plate type, and flags groups too small to compare', () => {
    const s = summarise([
      ...Array.from({ length: 30 }, () => read('MH12AB1234', 'MH12AB1234', 0.9, { vehicleType: 'car', plateType: 'standard' })),
      read('22BH1234AA', '22BH1234AB', 0.9, { vehicleType: 'motorcycle', plateType: 'bh' }),
      read('22BH5678AA', '22BH5678AA', 0.9, { vehicleType: 'motorcycle', plateType: 'bh' }),
    ]);
    expect(s.byVehicleType.car).toMatchObject({ positives: 30, plateAccuracy: 1, fewSamples: false });
    expect(s.byPlateType.bh).toMatchObject({ positives: 2, plateAccuracy: 0.5, misreadRate: 0.5, fewSamples: true });
  });

  it('measures calibration: confident wrong reads show as a gap between confidence and accuracy', () => {
    // 10 reads at 0.95: 5 right, 4 misread, 1 on a frame without a plate. 10 reads at 0.55: all right.
    const outs = [
      ...Array.from({ length: 5 }, () => read('KA01AB1111', 'KA01AB1111', 0.95)),
      ...Array.from({ length: 4 }, () => read('KA01AB1111', 'KA01AB1117', 0.95)),
      read('', 'KA01AB9999', 0.95),
      ...Array.from({ length: 10 }, () => read('KA01AB2222', 'KA01AB2222', 0.55)),
      read('KA01AB3333', null),
    ];
    const c = calibration(outs)!;
    expect(c.reads).toBe(20);
    const high = c.bins.find((b) => b.from === 0.9)!;
    const low = c.bins.find((b) => b.from === 0.5)!;
    expect(high).toMatchObject({ reads: 10, accuracy: 0.5 });
    expect(high.meanConfidence).toBeCloseTo(0.95);
    expect(low).toMatchObject({ reads: 10, accuracy: 1 });
    // ECE = 0.5 * |0.5 - 0.95| + 0.5 * |1 - 0.55| = 0.45
    expect(c.expectedCalibrationError).toBeCloseTo(0.45);
    expect(c.bins.find((b) => b.from === 0.7)).toMatchObject({ reads: 0, accuracy: null });
  });

  it('reports what each confidence threshold keeps and costs', () => {
    const outs = [
      read('KA01AB1111', 'KA01AB1111', 0.97),
      read('KA01AB2222', 'KA01AB2222', 0.65),
      read('KA01AB3333', 'KA01AB3338', 0.75),
      read('KA01AB4444', null),
      read('', 'MH01AA0001', 0.55),
      read('', null),
    ];
    const ops = operatingPoints(outs)!;
    const at = (t: number) => ops.find((o) => o.threshold === t)!;
    expect(at(0.5)).toMatchObject({ readRate: 0.5, misreadRate: 0.25, falseReadRate: 0.5 });
    expect(at(0.7)).toMatchObject({ readRate: 0.25, misreadRate: 0.25, falseReadRate: 0 });
    expect(at(0.8)).toMatchObject({ readRate: 0.25, misreadRate: 0, falseReadRate: 0 });
    expect(at(0.95)).toMatchObject({ readRate: 0.25 });
  });

  it('gives no calibration when reads carry no confidences', () => {
    const o = { ...read('KA01AB1111', 'KA01AB1111'), confidences: undefined };
    expect(calibration([o])).toBeNull();
    expect(operatingPoints([o])).toBeNull();
    expect(summarise([o]).calibration).toBeNull();
  });

  it('calls a report evaluated only for SITE data with enough plate frames', () => {
    expect(verdict('SYNTHETIC', 5000)).toMatchObject({ evaluated: false, reason: expect.stringMatching(/not declared as SITE/) });
    expect(verdict('SITE', MIN_SITE_POSITIVES - 1)).toMatchObject({ evaluated: false, reason: expect.stringMatching(/fewer than the 300/) });
    expect(verdict('SITE', MIN_SITE_POSITIVES).evaluated).toBe(true);
  });

  it('dataset digest ignores order and file names', () => {
    const a = [{ imageSha256: 'a'.repeat(64), expected: 'X1' }, { imageSha256: 'b'.repeat(64), expected: 'Y2' }];
    expect(datasetDigest(a)).toBe(datasetDigest([...a].reverse()));
    expect(datasetDigest(a)).not.toBe(datasetDigest([{ ...a[0], expected: 'X2' }, a[1]]));
  });
});

describe('dataset declaration', () => {
  it('requires dataset.json with kind SITE or SYNTHETIC', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'labels.csv'), 'image_path,plate_text\n');
    expect(() => loadEvalDataset(d)).toThrow(EvalDatasetError);
    fs.writeFileSync(path.join(d, 'dataset.json'), JSON.stringify({ kind: 'REAL', name: 'x' }));
    expect(() => loadEvalDataset(d)).toThrow(/kind must be/);
  });

  it('loads labels, filters the split and refuses missing images and duplicates', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'dataset.json'), JSON.stringify({ kind: 'SITE', name: 'gate 1' }));
    fs.copyFileSync(path.join(FIX, 'SYNTHETIC_commercial.png'), path.join(d, 'a.png'));
    fs.writeFileSync(path.join(d, 'labels.csv'), 'image_path,plate_text,split,condition,vehicle_type,plate_type\na.png,ka 05 c 7788,test,night,truck,commercial\n');
    const ds = loadEvalDataset(d, { split: 'test' });
    expect(ds.kind).toBe('SITE');
    expect(ds.samples[0]).toMatchObject({ expected: 'KA05C7788', condition: 'night', vehicleType: 'truck', plateType: 'commercial' });
    expect(() => loadEvalDataset(d, { split: 'val' })).toThrow(/no samples/);
    fs.writeFileSync(path.join(d, 'labels.csv'), 'image_path,plate_text\na.png,X\na.png,Y\n');
    expect(() => loadEvalDataset(d)).toThrow(/duplicate/);
    fs.writeFileSync(path.join(d, 'labels.csv'), 'image_path,plate_text\nmissing.png,X\n');
    expect(() => loadEvalDataset(d)).toThrow(/does not exist/);
  });

  it('reads the SYNTHETIC fixture manifest as a SYNTHETIC dataset', () => {
    const ds = loadEvalDataset(FIX);
    expect(ds.kind).toBe('SYNTHETIC');
    expect(ds.samples).toHaveLength(6);
  });
});

const tool = path.join(__dirname, '..', '..', 'dist', 'tools', 'evalPlates.js');
const modelsPresent = ['ppocrv4-det', 'fast-plate-ocr-cct-s-v2'].every((k) => fs.existsSync(artifactPathFor(findCandidateEntry(k))));
(modelsPresent && fs.existsSync(tool) ? describe : describe.skip)('evalPlates CLI (compiled, SYNTHETIC fixtures)', () => {
  jest.setTimeout(120000);

  it('reports SYNTHETIC kind, pipeline hashes and metrics', () => {
    const out = path.join(tmp(), 'r.json');
    const r = spawnSync('node', [tool, '--dataset', FIX, '--out', out], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    const rep = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(rep.kind).toBe('SYNTHETIC');
    expect(rep.label).toMatch(/not a measurement of site accuracy/);
    expect(rep.pipeline.components.map((c: any) => c.key)).toEqual(['ppocrv4-det', 'fast-plate-ocr-cct-s-v2']);
    expect(rep.dataset.samples).toBe(6);
    expect(rep.metrics.positives).toBe(6);
    expect(rep.verdict).toMatchObject({ evaluated: false });
    expect(rep.metrics.calibration.reads).toBeGreaterThan(0);
    expect(rep.metrics.operatingPoints).toHaveLength(7);
  });

  it('exits 3 when an evaluated image is in the training set', () => {
    const hashes = path.join(tmp(), 'train.txt');
    const sha = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(FIX, 'SYNTHETIC_ev_green.png'))).digest('hex');
    fs.writeFileSync(hashes, `# train\n${sha}  x.png\n`);
    const r = spawnSync('node', [tool, '--dataset', FIX, '--train-hashes', hashes], { encoding: 'utf8' });
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/TRAIN_TEST_LEAKAGE: 1 .*SYNTHETIC_ev_green\.png/);
  });

  it('exits 2 for an undeclared dataset', () => {
    const r = spawnSync('node', [tool, '--dataset', tmp()], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/DATASET_INVALID/);
  });
});
