#!/usr/bin/env python3
"""
Independent reference for the ai-worker YOLOX pipeline (P2.4 golden fixtures).

Runs the official ONNX export with the *official* YOLOX post-processing
(`demo_postprocess` + `multiclass_nms(class_agnostic=False)`, copied below from
Megvii-BaseDetection/YOLOX yolox/utils/demo_utils.py, Apache-2.0) on the committed
letterboxed model-input PNGs, then maps boxes back to normalized source coordinates with the
committed geometry. The TypeScript engine must reproduce these detections
(services/ai-worker/src/__tests__/goldenYolox.test.ts).

Usage:
  python3 -m venv .venv && .venv/bin/pip install -r tools/reference/requirements.txt
  .venv/bin/python tools/reference/yolox_reference.py --model .cache/models/yolox_nano.onnx \
      --key yolox-nano --out services/ai-worker/src/__tests__/fixtures/golden/yolox-nano.reference.json
"""
import argparse
import hashlib
import json
import os

import cv2
import numpy as np
import onnxruntime

HERE = os.path.dirname(os.path.abspath(__file__))
GOLDEN = os.path.join(HERE, '..', '..', 'services', 'ai-worker', 'src', '__tests__', 'fixtures', 'golden')

# ---- Begin: copied from YOLOX yolox/utils/demo_utils.py (Apache-2.0, Megvii Inc.) ----


def nms(boxes, scores, nms_thr):
    """Single class NMS implemented in Numpy."""
    x1 = boxes[:, 0]
    y1 = boxes[:, 1]
    x2 = boxes[:, 2]
    y2 = boxes[:, 3]

    areas = (x2 - x1 + 1) * (y2 - y1 + 1)
    order = scores.argsort()[::-1]

    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(i)
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])

        w = np.maximum(0.0, xx2 - xx1 + 1)
        h = np.maximum(0.0, yy2 - yy1 + 1)
        inter = w * h
        ovr = inter / (areas[i] + areas[order[1:]] - inter)

        inds = np.where(ovr <= nms_thr)[0]
        order = order[inds + 1]

    return keep


def multiclass_nms_class_aware(boxes, scores, nms_thr, score_thr):
    """Multiclass NMS implemented in Numpy. Class-aware version."""
    final_dets = []
    num_classes = scores.shape[1]
    for cls_ind in range(num_classes):
        cls_scores = scores[:, cls_ind]
        valid_score_mask = cls_scores > score_thr
        if valid_score_mask.sum() == 0:
            continue
        else:
            valid_scores = cls_scores[valid_score_mask]
            valid_boxes = boxes[valid_score_mask]
            keep = nms(valid_boxes, valid_scores, nms_thr)
            if len(keep) > 0:
                cls_inds = np.ones((len(keep), 1)) * cls_ind
                dets = np.concatenate(
                    [valid_boxes[keep], valid_scores[keep, None], cls_inds], 1
                )
                final_dets.append(dets)
    if len(final_dets) == 0:
        return None
    return np.concatenate(final_dets, 0)


def demo_postprocess(outputs, img_size, p6=False):
    grids = []
    expanded_strides = []
    strides = [8, 16, 32] if not p6 else [8, 16, 32, 64]

    hsizes = [img_size[0] // stride for stride in strides]
    wsizes = [img_size[1] // stride for stride in strides]

    for hsize, wsize, stride in zip(hsizes, wsizes, strides):
        xv, yv = np.meshgrid(np.arange(wsize), np.arange(hsize))
        grid = np.stack((xv, yv), 2).reshape(1, -1, 2)
        grids.append(grid)
        shape = grid.shape[:2]
        expanded_strides.append(np.full((*shape, 1), stride))

    grids = np.concatenate(grids, 1)
    expanded_strides = np.concatenate(expanded_strides, 1)
    outputs[..., :2] = (outputs[..., :2] + grids) * expanded_strides
    outputs[..., 2:4] = np.exp(outputs[..., 2:4]) * expanded_strides

    return outputs

# ---- End: copied from YOLOX ----


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', required=True)
    ap.add_argument('--key', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--score-thr', type=float, default=0.3)
    ap.add_argument('--nms-thr', type=float, default=0.45)
    args = ap.parse_args()

    geometry = json.load(open(os.path.join(GOLDEN, 'inputs', 'geometry.json')))
    session = onnxruntime.InferenceSession(args.model, providers=['CPUExecutionProvider'])
    inp = session.get_inputs()[0]
    size = inp.shape[2]

    results = {}
    for name, entry in sorted(geometry.items()):
        g = entry['geometry']
        if g['modelWidth'] != size:
            continue
        # cv2.imread returns BGR uint8, which is exactly what the YOLOX preproc feeds the model.
        img = cv2.imread(os.path.join(GOLDEN, 'inputs', name), cv2.IMREAD_COLOR)
        assert img.shape == (size, size, 3), img.shape
        tensor = np.ascontiguousarray(img.transpose(2, 0, 1), dtype=np.float32)[None]
        output = session.run(None, {inp.name: tensor})[0]
        pred = demo_postprocess(output, (size, size))[0]
        boxes = pred[:, :4]
        scores = pred[:, 4:5] * pred[:, 5:]
        xyxy = np.ones_like(boxes)
        xyxy[:, 0] = boxes[:, 0] - boxes[:, 2] / 2.0
        xyxy[:, 1] = boxes[:, 1] - boxes[:, 3] / 2.0
        xyxy[:, 2] = boxes[:, 0] + boxes[:, 2] / 2.0
        xyxy[:, 3] = boxes[:, 1] + boxes[:, 3] / 2.0
        dets = multiclass_nms_class_aware(xyxy, scores, args.nms_thr, args.score_thr)

        out = []
        if dets is not None:
            sw, sh = g['scaledWidth'], g['scaledHeight']
            for x1, y1, x2, y2, score, cls in dets.tolist():
                # Remove padding offset, clip to the active image, normalize by its size.
                ax1 = min(max(x1 - g['padX'], 0), sw)
                ay1 = min(max(y1 - g['padY'], 0), sh)
                ax2 = min(max(x2 - g['padX'], 0), sw)
                ay2 = min(max(y2 - g['padY'], 0), sh)
                if ax2 - ax1 <= 0 or ay2 - ay1 <= 0:
                    continue
                out.append({
                    'classId': int(cls),
                    'confidence': round(float(score), 5),
                    'box': {
                        'x': round(ax1 / sw, 5),
                        'y': round(ay1 / sh, 5),
                        'width': round((ax2 - ax1) / sw, 5),
                        'height': round((ay2 - ay1) / sh, 5),
                    },
                })
        out.sort(key=lambda d: (-d['confidence'], d['classId']))
        results[name] = out

    doc = {
        'generator': 'tools/reference/yolox_reference.py',
        'reference': 'official YOLOX demo_postprocess + multiclass_nms_class_aware (Apache-2.0)',
        'modelKey': args.key,
        'modelSha256': sha256(args.model),
        'onnxruntimePython': onnxruntime.__version__,
        'scoreThreshold': args.score_thr,
        'nmsThreshold': args.nms_thr,
        'detections': results,
    }
    with open(args.out, 'w') as f:
        json.dump(doc, f, indent=2)
        f.write('\n')
    print(f'wrote {args.out}: ' + ', '.join(f'{k}={len(v)}' for k, v in results.items()))


if __name__ == '__main__':
    main()
