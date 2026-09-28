#!/usr/bin/env python3
"""
Reference for the ai-worker RF-DETR decoder (P2.4). Loads the upstream torch-free decode modules
from an RF-DETR checkout (roboflow/rf-detr, Apache-2.0) and runs `decode_detections` on seeded
synthetic tensors, writing inputs and expected outputs for
services/ai-worker/src/__tests__/rfdetrDecoder.test.ts.

  git clone --depth 1 https://github.com/roboflow/rf-detr /tmp/rfdetr
  python3 tools/reference/rfdetr_decode_reference.py --rfdetr /tmp/rfdetr --out <fixture.json>
"""
import argparse, importlib.util, json, logging, os, subprocess, sys, types

import numpy as np


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--rfdetr', required=True)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()
    src = os.path.join(args.rfdetr, 'src', 'rfdetr')
    commit = subprocess.check_output(['git', '-C', args.rfdetr, 'rev-parse', 'HEAD']).decode().strip()

    # Minimal package skeleton so the upstream modules import without torch.
    for pkg in ['rfdetr', 'rfdetr.export', 'rfdetr.utilities']:
        sys.modules[pkg] = types.ModuleType(pkg)
    logger_mod = types.ModuleType('rfdetr.utilities.logger')
    logger_mod.get_logger = lambda: logging.getLogger('rfdetr')
    sys.modules['rfdetr.utilities.logger'] = logger_mod
    load('rfdetr.export._class_layout', os.path.join(src, 'export', '_class_layout.py'))
    load('rfdetr.export._topk', os.path.join(src, 'export', '_topk.py'))
    decode = load('rfdetr.export._runtime.decode', os.path.join(src, 'export', '_runtime', 'decode.py'))

    rng = np.random.default_rng(20260927)
    cases = []
    for name, Q, C, bg, thr, planted in [
        ('coco91_sparse_no_background', 300, 91, None, 0.5, [(3, 1, 4.0), (3, 3, 2.5), (10, 8, 3.0), (11, 8, 0.1)]),
        ('custom_last_slot_background', 100, 7, -1, 0.3, [(0, 2, 2.0), (5, 6, 9.0), (6, 0, 1.0)]),
    ]:
        logits = rng.normal(-6.0, 1.5, size=(Q, C)).astype(np.float32)
        for q, c, v in planted:  # a few confident query/class pairs, incl. one query on two classes
            logits[q, c] = v
        cxcy = rng.uniform(0.1, 0.9, size=(Q, 2))
        wh = rng.uniform(0.05, 0.4, size=(Q, 2))
        boxes = np.concatenate([cxcy, wh], 1).astype(np.float32)
        d = decode.decode_detections(boxes, logits, (1, 1), threshold=thr, background_class_id=bg)
        cases.append({
            'name': name, 'numQueries': Q, 'numClasses': C, 'backgroundClassId': bg, 'threshold': thr,
            'boxes': [round(float(v), 7) for v in boxes.reshape(-1)],
            'logits': [round(float(v), 7) for v in logits.reshape(-1)],
            'expected': [
                {'classId': int(c), 'queryIndex': int(q), 'confidence': float(s),
                 'xyxy': [float(v) for v in xy]}
                for xy, s, c, q in zip(d.xyxy, d.confidence, d.class_id, d.query_index)
            ],
        })
    doc = {'generator': 'tools/reference/rfdetr_decode_reference.py',
           'upstream': 'roboflow/rf-detr src/rfdetr/export/_runtime/decode.py::decode_detections (Apache-2.0)',
           'upstreamCommit': commit, 'cases': cases}
    json.dump(doc, open(args.out, 'w'))
    print('wrote', args.out, [(c['name'], len(c['expected'])) for c in cases])


if __name__ == '__main__':
    main()
