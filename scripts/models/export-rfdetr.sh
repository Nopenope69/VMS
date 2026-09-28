#!/usr/bin/env bash
# Exports an RF-DETR detector (roboflow/rf-detr, Apache-2.0) to ONNX for the ai-worker and prints
# the models.lock.json entry to review. Upgrade path from YOLOX (action plan, section 3).
#
#   scripts/models/export-rfdetr.sh [nano|small] [--out DIR] [--venv DIR]
#
# Only RF-DETR Nano and Small are allowed. XL / 2XL ("Plus", rfdetr_plus) weights are under the
# proprietary PML 1.0 licence and must never be exported for the product.
#
# Steps: create a Python venv, install the pinned rfdetr release with its [onnx] extra, download
# the COCO checkpoint (rfdetr verifies its MD5), export with rfdetr's own exporter, then record the
# SHA-256 of the ONNX file. The exported file is NOT added to models.lock.json automatically: a
# human reviews the printed entry (licence, weights source, evaluation status) and commits it.
# Needs network access to PyPI and storage.googleapis.com (checkpoint host). CPU is enough.
set -euo pipefail

VARIANT="${1:-nano}"
shift || true
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$REPO_ROOT/.cache/models/rfdetr-$VARIANT"
VENV="$REPO_ROOT/.cache/rfdetr-venv"
RFDETR_VERSION="1.11.0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --venv) VENV="$2"; shift 2 ;;
    *) echo "export-rfdetr: unknown argument $1" >&2; exit 1 ;;
  esac
done

case "$VARIANT" in
  nano) CLS="RFDETRNano"; RES=384 ;;
  small) CLS="RFDETRSmall"; RES=512 ;;
  *) echo "export-rfdetr: only 'nano' or 'small' are allowed (XL/2XL weights are proprietary PML 1.0)" >&2; exit 1 ;;
esac

command -v python3 >/dev/null || { echo "export-rfdetr: python3 is required" >&2; exit 1; }
if [[ ! -x "$VENV/bin/python" ]]; then
  python3 -m venv "$VENV"
fi
"$VENV/bin/pip" install -q "rfdetr[onnx]==$RFDETR_VERSION"

mkdir -p "$OUT"
"$VENV/bin/python" - "$CLS" "$OUT" <<'PY'
import sys, rfdetr
cls, out = sys.argv[1], sys.argv[2]
model = getattr(rfdetr, cls)()
model.export(output_dir=out)
PY

ONNX="$(ls "$OUT"/*.onnx | head -1)"
[[ -f "$ONNX" ]] || { echo "export-rfdetr: exporter produced no .onnx file in $OUT" >&2; exit 2; }
SHA="$(sha256sum "$ONNX" | cut -d' ' -f1)"
SIZE="$(stat -c %s "$ONNX")"

"$VENV/bin/python" - "$ONNX" "$SHA" "$SIZE" "$VARIANT" "$RES" "$RFDETR_VERSION" <<'PY'
import json, sys, onnxruntime as ort
path, sha, size, variant, res, version = sys.argv[1:]
s = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
ins = {i.name: i.shape for i in s.get_inputs()}
outs = {o.name: o.shape for o in s.get_outputs()}
boxes = next(n for n in outs if "dets" in n)
logits = next(n for n in outs if "labels" in n)
inp = next(iter(ins))
entry = {
  "key": f"rfdetr-{variant}",
  "name": f"rfdetr-{variant}-coco",
  "version": version,
  "sha256": sha,
  "sizeBytes": int(size),
  "url": "LOCAL-EXPORT (host the file and put its URL here before committing)",
  "task": "object_detection",
  "codeLicense": "Apache-2.0",
  "weightLicense": "Apache-2.0",
  "weightsSource": f"rfdetr {version} {variant} COCO checkpoint exported with scripts/models/export-rfdetr.sh (Apache-designated weights per the rf-detr README)",
  "runtimeConfig": {"runtime": "onnxruntime", "executionProvider": "cpu", "inputWidth": int(res), "inputHeight": int(res),
                    "colorSpace": "RGB", "normalization": {"type": "mean_std", "mean": [0.485, 0.456, 0.406], "std": [0.229, 0.224, 0.225]},
                    "letterbox": False, "modelFormat": "ONNX"},
  "modelSignature": {"input": {"name": inp, "shape": ins[inp], "dtype": "float32"},
                     "output": {"name": boxes, "shape": outs[boxes], "dtype": "float32"},
                     "logitsOutputName": logits, "coordinateFormat": "cxcywh", "hasObjectness": False,
                     "classCount": outs[logits][-1], "decoder": "rfdetr", "backgroundClassId": None},
}
print(json.dumps(entry, indent=2))
print("\nReview the entry above (licence, trainingData, thresholds, classes: coco91ClassMapping for COCO checkpoints),",
      "host the ONNX file, then add it to scripts/models/models.lock.json.", file=sys.stderr)
PY
