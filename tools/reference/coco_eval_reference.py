#!/usr/bin/env python3
"""
Reference for tools/eval/coco-eval.mjs (P2.8): a seeded synthetic detection set evaluated with
pycocotools COCOeval (BSD-2-Clause). Writes tools/eval/__tests__/fixtures/pycocotools-reference.json
with the inputs and pycocotools' numbers (mAP, mAP50, per-class AP and AP50).

  python3 tools/reference/coco_eval_reference.py
"""
import contextlib
import io
import json
import os

import numpy as np
from pycocotools.coco import COCO
from pycocotools.cocoeval import COCOeval

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'eval', '__tests__', 'fixtures', 'pycocotools-reference.json')

rng = np.random.default_rng(7)
cats = [{'id': 1, 'name': 'person'}, {'id': 3, 'name': 'car'}, {'id': 8, 'name': 'truck'}]
images, anns, dets = [], [], []
aid = 1
for img in range(1, 31):
    images.append({'id': img, 'width': 1000, 'height': 1000, 'file_name': f'{img}.jpg'})
    for _ in range(rng.integers(0, 5)):
        c = cats[rng.integers(0, 3)]['id']
        w, h = rng.uniform(40, 300, 2)
        x, y = rng.uniform(0, 1000 - w), rng.uniform(0, 1000 - h)
        anns.append({'id': aid, 'image_id': img, 'category_id': c, 'bbox': [float(x), float(y), float(w), float(h)],
                     'area': float(w * h), 'iscrowd': 0})
        aid += 1
        if rng.random() < 0.8:  # detected, with localisation noise
            j = rng.normal(0, 0.08, 4) * [w, h, w, h]
            dets.append({'image_id': img, 'category_id': c, 'bbox': [float(x + j[0]), float(y + j[1]), float(max(5, w + j[2])), float(max(5, h + j[3]))],
                         'score': float(rng.uniform(0.3, 0.99))})
        if rng.random() < 0.15:  # duplicate
            dets.append({'image_id': img, 'category_id': c, 'bbox': [float(x + 10), float(y + 10), float(w), float(h)], 'score': float(rng.uniform(0.05, 0.5))})
    for _ in range(rng.integers(0, 3)):  # false positives
        w, h = rng.uniform(40, 200, 2)
        dets.append({'image_id': img, 'category_id': cats[rng.integers(0, 3)]['id'],
                     'bbox': [float(rng.uniform(0, 1000 - w)), float(rng.uniform(0, 1000 - h)), float(w), float(h)],
                     'score': float(rng.uniform(0.05, 0.9))})

gt = {'images': images, 'annotations': anns, 'categories': cats}
with contextlib.redirect_stdout(io.StringIO()):
    coco = COCO()
    coco.dataset = gt
    coco.createIndex()
    cdt = coco.loadRes(dets)
    ev = COCOeval(coco, cdt, 'bbox')
    ev.evaluate()
    ev.accumulate()
    ev.summarize()
prec = ev.eval['precision']  # [T, R, K, A, M]
per = {}
for k, c in enumerate(cats):
    p_all = prec[:, :, k, 0, 2]
    p50 = prec[0, :, k, 0, 2]
    per[c['name']] = {'ap': float(np.mean(p_all[p_all > -1])), 'ap50': float(np.mean(p50[p50 > -1]))}
doc = {'generator': 'tools/reference/coco_eval_reference.py', 'gt': gt, 'dets': dets,
       'pycocotools': {'mAP': float(ev.stats[0]), 'mAP50': float(ev.stats[1]), 'perClass': per}}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump(doc, open(OUT, 'w'))
print(doc['pycocotools'])
