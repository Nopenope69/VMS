import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { evaluate } from '../coco-eval.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ref = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'pycocotools-reference.json'), 'utf8'));

test('mAP, mAP50 and per-class AP equal pycocotools COCOeval on the reference set', () => {
  const r = evaluate(ref.gt, ref.dets);
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-5, `${a} vs ${b}`);
  close(r.mAP, ref.pycocotools.mAP);
  close(r.mAP50, ref.pycocotools.mAP50);
  for (const [name, v] of Object.entries(ref.pycocotools.perClass)) {
    close(r.perClass[name].ap, v.ap);
    close(r.perClass[name].ap50, v.ap50);
  }
});

test('operating-point counts: TP, FP, FN, precision, recall and FP per hour', () => {
  const gt = {
    images: [{ id: 1 }, { id: 2 }],
    categories: [{ id: 1, name: 'person' }],
    annotations: [
      { image_id: 1, category_id: 1, bbox: [0, 0, 100, 100] },
      { image_id: 2, category_id: 1, bbox: [0, 0, 100, 100] },
    ],
  };
  const dets = [
    { image_id: 1, category_id: 1, bbox: [2, 2, 100, 100], score: 0.9 }, // TP
    { image_id: 1, category_id: 1, bbox: [500, 500, 50, 50], score: 0.8 }, // FP
    { image_id: 2, category_id: 1, bbox: [0, 0, 100, 100], score: 0.2 }, // below threshold -> FN
  ];
  const r = evaluate(gt, dets, { scoreThreshold: 0.5, durationHours: 2 });
  assert.deepEqual(
    { tp: r.perClass.person.tp, fp: r.perClass.person.fp, fn: r.perClass.person.fn, p: r.perClass.person.precision, rc: r.perClass.person.recall, fph: r.perClass.person.fpPerHour },
    { tp: 1, fp: 1, fn: 1, p: 0.5, rc: 0.5, fph: 0.5 }
  );
});

test('a class with no ground truth has no AP (never reported as 0 or 1)', () => {
  const r = evaluate({ images: [{ id: 1 }], categories: [{ id: 3, name: 'car' }], annotations: [] }, []);
  assert.equal(r.perClass.car.ap, null);
  assert.equal(r.mAP, null);
});
