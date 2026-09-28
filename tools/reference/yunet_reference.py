#!/usr/bin/env python3
"""
Reference face detections for the YuNet golden test (P4.4), using OpenCV's own FaceDetectorYN.

    python3 tools/reference/yunet_reference.py --model face_detection_yunet_2023mar.onnx \
        --images services/ai-worker/src/__tests__/fixtures/redaction/*.png --out reference.json

Preprocessing matches services/ai-worker/src/redaction/faceDetector.ts: scale the RGB frame to
fit 640x640 keeping the aspect ratio (cv2.INTER_LINEAR, sizes rounded), pad right/bottom with zeros,
then FaceDetectorYN on the 640x640 BGR image. Boxes are mapped back to frame pixels.
"""
import argparse
import json
import os

import cv2
import numpy as np

SIZE = 640


def detect(det, bgr, score_threshold):
    h, w = bgr.shape[:2]
    s = min(SIZE / w, SIZE / h)
    nw, nh = int(round(w * s)), int(round(h * s))
    resized = cv2.resize(bgr, (nw, nh), interpolation=cv2.INTER_LINEAR)
    canvas = np.zeros((SIZE, SIZE, 3), dtype=np.uint8)
    canvas[:nh, :nw] = resized
    det.setScoreThreshold(score_threshold)
    _, faces = det.detect(canvas)
    out = []
    for f in faces if faces is not None else []:
        x, y, bw, bh = (float(v) / s for v in f[:4])
        out.append({"box": [x, y, x + bw, y + bh], "score": float(f[14])})
    return sorted(out, key=lambda d: -d["score"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--images", nargs="+", required=True)
    ap.add_argument("--score-threshold", type=float, default=0.5)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    det = cv2.FaceDetectorYN.create(a.model, "", (SIZE, SIZE), a.score_threshold, 0.3, 5000)
    ref = {"opencv": cv2.__version__, "scoreThreshold": a.score_threshold, "nmsThreshold": 0.3, "images": {}}
    for p in a.images:
        ref["images"][os.path.basename(p)] = detect(det, cv2.imread(p, cv2.IMREAD_COLOR), a.score_threshold)
    with open(a.out, "w") as f:
        json.dump(ref, f, indent=1)
    print(json.dumps({k: len(v) for k, v in ref["images"].items()}))


if __name__ == "__main__":
    main()
