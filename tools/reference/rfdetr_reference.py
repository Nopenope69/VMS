#!/usr/bin/env python3
"""
Reference for the ai-worker RF-DETR path on a real export (scripts/models/export-rfdetr.sh).
Runs the ONNX file with ImageNet normalisation on the committed stretched 384x384 inputs and
decodes with upstream rfdetr.export._runtime.decode.decode_detections (the installed rfdetr
package). Output: fixtures/golden/rfdetr-nano.reference.json, consumed by goldenRfdetr.test.ts.

  .cache/rfdetr-venv/bin/python tools/reference/rfdetr_reference.py --model .cache/models/rfdetr-nano/rfdetr-nano.onnx
"""
import argparse, hashlib, json, os
import numpy as np, onnxruntime as ort
from PIL import Image
import rfdetr
from rfdetr.export._runtime.decode import decode_detections

HERE = os.path.dirname(os.path.abspath(__file__))
GOLDEN = os.path.join(HERE, '..', '..', 'services', 'ai-worker', 'src', '__tests__', 'fixtures', 'golden')

ap = argparse.ArgumentParser()
ap.add_argument('--model', required=True)
ap.add_argument('--threshold', type=float, default=0.5)
args = ap.parse_args()
s = ort.InferenceSession(args.model, providers=['CPUExecutionProvider'])
mean = np.array([0.485, 0.456, 0.406], np.float32)[:, None, None]
std = np.array([0.229, 0.224, 0.225], np.float32)[:, None, None]
out = {}
for name in sorted(os.listdir(os.path.join(GOLDEN, 'inputs'))):
    if not name.endswith('_384_stretch.png'):
        continue
    img = np.asarray(Image.open(os.path.join(GOLDEN, 'inputs', name)).convert('RGB'), np.float32) / 255.0
    x = ((img.transpose(2, 0, 1) - mean) / std)[None].astype(np.float32)
    res = dict(zip([o.name for o in s.get_outputs()], s.run(None, {s.get_inputs()[0].name: x})))
    d = decode_detections(res['dets'][0], res['labels'][0], (1, 1), threshold=args.threshold, background_class_id=None)
    out[name] = [{'classId': int(c), 'confidence': round(float(sc), 5),
                  'box': {'x': round(float(b[0]), 5), 'y': round(float(b[1]), 5),
                          'width': round(float(b[2] - b[0]), 5), 'height': round(float(b[3] - b[1]), 5)}}
                 for b, sc, c in zip(d.xyxy, d.confidence, d.class_id)]
sha = hashlib.sha256(open(args.model, 'rb').read()).hexdigest()
doc = {'generator': 'tools/reference/rfdetr_reference.py', 'rfdetrVersion': rfdetr.__version__ if hasattr(rfdetr, '__version__') else 'unknown',
       'modelSha256': sha, 'threshold': args.threshold, 'detections': out}
json.dump(doc, open(os.path.join(GOLDEN, 'rfdetr-nano.reference.json'), 'w'), indent=2)
print({k: [(e['classId'], e['confidence']) for e in v] for k, v in out.items()})
