#!/usr/bin/env python3
"""
Reference ANPR pipeline for golden tests (test tooling only, never shipped):

  PP-OCRv4 text detection exactly as RapidOCR runs it (its own DetPreProcess / DBPostProcess,
  Apache-2.0) -> plate candidates (text boxes grouped into lines; vertically stacked lines of a
  two-line plate merged) -> fast-plate-ocr recognition exactly as fast_plate_ocr does it
  (cv2.resize INTER_LINEAR to the config size, uint8 RGB, argmax per slot, trailing pad removed).

    anpr_reference.py --det DET.onnx --ocr OCR.onnx --ocr-config CFG.yaml --rapidocr-dir DIR IMG...

Prints JSON: per image the raw detector boxes, the candidates and the OCR result per candidate.
"""
import argparse
import json
import sys

import cv2
import numpy as np
import onnxruntime as ort
import yaml


def load_rapid_det(rapid_dir):
    sys.path.insert(0, rapid_dir)
    from rapidocr_onnxruntime.ch_ppocr_det.utils import DBPostProcess, DetPreProcess  # noqa
    return DetPreProcess, DBPostProcess


def detect(sess, img_bgr, DetPreProcess, DBPostProcess, limit_side_len=736, limit_type="min"):
    h, w = img_bgr.shape[:2]
    pre = DetPreProcess(limit_side_len, limit_type, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5])
    x = pre(img_bgr)
    out = sess.run(None, {sess.get_inputs()[0].name: x})[0]
    post = DBPostProcess(thresh=0.3, box_thresh=0.5, max_candidates=1000, unclip_ratio=1.6, use_dilation=True, score_mode="fast")
    boxes, scores = post(out, (h, w))
    return [b.tolist() for b in boxes], [float(s) for s in scores], list(x.shape)


def aabb(box):
    xs = [p[0] for p in box]
    ys = [p[1] for p in box]
    return [min(xs), min(ys), max(xs), max(ys)]


def group_candidates(boxes, min_h=8):
    """Line boxes -> plate candidates. Same rules as services/ai-worker/src/anpr/plateCandidates.ts."""
    rects = [aabb(b) for b in boxes]
    rects = [r for r in rects if (r[3] - r[1]) >= min_h and (r[2] - r[0]) >= (r[3] - r[1]) * 1.2]
    rects.sort(key=lambda r: (r[1], r[0]))
    used = [False] * len(rects)
    cands = []
    for i, a in enumerate(rects):
        if used[i]:
            continue
        used[i] = True
        group = [a]
        for j in range(i + 1, len(rects)):
            if used[j]:
                continue
            b = rects[j]
            last = group[-1]
            h = last[3] - last[1]
            ov = min(last[2], b[2]) - max(last[0], b[0])
            gap = b[1] - last[3]
            similar_h = 0.6 <= (b[3] - b[1]) / h <= 1.6
            if ov > 0.5 * min(last[2] - last[0], b[2] - b[0]) and -0.3 * h <= gap <= 0.6 * h and similar_h and len(group) < 2:
                group.append(b)
                used[j] = True
        x1 = min(r[0] for r in group); y1 = min(r[1] for r in group)
        x2 = max(r[2] for r in group); y2 = max(r[3] for r in group)
        cands.append({"box": [x1, y1, x2, y2], "lines": len(group), "lineBoxes": group})
    return cands


def crop_pad(img, box, pad=0.08):
    x1, y1, x2, y2 = box
    ph = (y2 - y1) * pad
    x1 = int(max(0, np.floor(x1 - ph))); y1 = int(max(0, np.floor(y1 - ph)))
    x2 = int(min(img.shape[1], np.ceil(x2 + ph))); y2 = int(min(img.shape[0], np.ceil(y2 + ph)))
    return img[y1:y2, x1:x2], [x1, y1, x2, y2]


def ocr(sess, cfg, crop_rgb):
    x = cv2.resize(crop_rgb, (cfg["img_width"], cfg["img_height"]), interpolation=cv2.INTER_LINEAR)
    x = np.expand_dims(x, 0).astype(np.uint8)
    out = sess.run(None, {sess.get_inputs()[0].name: x})
    plate = out[0].reshape((-1, cfg["max_plate_slots"], len(cfg["alphabet"])))[0]
    idx = plate.argmax(-1)
    text = "".join(cfg["alphabet"][i] for i in idx).rstrip(cfg["pad_char"])
    return text, [float(v) for v in plate.max(-1)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--det", required=True)
    ap.add_argument("--ocr", required=True)
    ap.add_argument("--ocr-config", required=True)
    ap.add_argument("--rapidocr-dir", required=True)
    ap.add_argument("images", nargs="+")
    a = ap.parse_args()
    DetPre, DBPost = load_rapid_det(a.rapidocr_dir)
    det = ort.InferenceSession(a.det, providers=["CPUExecutionProvider"])
    rec = ort.InferenceSession(a.ocr, providers=["CPUExecutionProvider"])
    cfg = yaml.safe_load(open(a.ocr_config))
    results = {}
    for path in a.images:
        bgr = cv2.imread(path, cv2.IMREAD_COLOR)
        boxes, scores, shape = detect(det, bgr, DetPre, DBPost)
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        cands = []
        for c in group_candidates(boxes):
            crop, cbox = crop_pad(rgb, c["box"])
            text, probs = ocr(rec, cfg, crop)
            per_line = []
            if c["lines"] == 2:
                for lb in c["lineBoxes"]:
                    lc, _ = crop_pad(rgb, lb)
                    per_line.append(ocr(rec, cfg, lc)[0])
            cands.append({**c, "cropBox": cbox, "text": text, "charProbs": probs, "perLineText": per_line})
        results[path.split("/")[-1]] = {"inputShape": shape, "boxes": boxes, "scores": scores, "candidates": cands}
    print(json.dumps(results, indent=1))


if __name__ == "__main__":
    main()
