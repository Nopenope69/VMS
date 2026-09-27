#!/usr/bin/env bash
# Fine-tunes the plate OCR (fast-plate-ocr CCT-S v2) on a prepared dataset (P4.3).
#
#   tools/anpr/finetune/finetune.sh PREPARED_DIR OUT_DIR [--epochs 40] [--batch-size 64] [--lr 0.0005]
#
# PREPARED_DIR comes from prepare_dataset.py. Steps:
#   1. venv with requirements-train.txt (VENV, default .cache/anpr-finetune-venv)
#   2. download the base Keras weights/configs and verify every SHA-256 (base-model.lock.json)
#   3. fast-plate-ocr train from the base weights (train.csv / val.csv only; test.csv is never used)
#   4. export ONNX in the runtime's input format (uint8, NHWC 64x128x3) and print its SHA-256
#
# The result is an UNPINNED model. Evaluate it against the pinned one with
#   node services/ai-worker/dist/tools/evalPlates.js --dataset <held-out dataset> --split test \
#     --train-hashes PREPARED_DIR/train-image-hashes.txt --ocr-model OUT_DIR/<model>.onnx \
#     --ocr-config OUT_DIR/plate_config.yaml
# Promoting it into models.lock.json is a human decision (weights trained on site data carry the
# site's data-protection obligations; see docs/ai/ANPR_EVALUATION.md).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
PREP="${1:?usage: finetune.sh PREPARED_DIR OUT_DIR [--epochs N] [--batch-size N] [--lr X]}"
OUT="${2:?usage: finetune.sh PREPARED_DIR OUT_DIR}"
shift 2
EPOCHS=40
BATCH=64
LR=0.0005
while [[ $# -gt 0 ]]; do
  case "$1" in
    --epochs) EPOCHS="$2"; shift 2 ;;
    --batch-size) BATCH="$2"; shift 2 ;;
    --lr) LR="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

for f in train.csv val.csv prepare-report.json; do
  [[ -f "$PREP/$f" ]] || { echo "DATASET_INVALID: $PREP/$f missing (run prepare_dataset.py)" >&2; exit 2; }
done

VENV="${VENV:-$REPO/.cache/anpr-finetune-venv}"
if [[ ! -x "$VENV/bin/fast-plate-ocr" ]]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q -r "$HERE/requirements-train.txt"
fi
PY="$VENV/bin/python"

BASE="${BASE_DIR:-$REPO/.cache/anpr-finetune-base}"
mkdir -p "$BASE" "$OUT"
"$PY" - "$HERE/base-model.lock.json" "$BASE" <<'EOF'
import hashlib, json, os, sys, urllib.request
lock, base = json.load(open(sys.argv[1])), sys.argv[2]
for f in lock["files"]:
    p = os.path.join(base, f["fileName"])
    if not os.path.exists(p):
        urllib.request.urlretrieve(f["url"], p + ".part")
        os.replace(p + ".part", p)
    got = hashlib.sha256(open(p, "rb").read()).hexdigest()
    if got != f["sha256"]:
        os.remove(p)
        sys.exit(f"MODEL_INTEGRITY_FAILED: {f['fileName']} has {got}, expected {f['sha256']}")
print("base model verified", file=sys.stderr)
EOF

"$VENV/bin/fast-plate-ocr" train \
  --model-config-file "$BASE/cct_s_v2_global_model_config.yaml" \
  --plate-config-file "$BASE/cct_s_v2_global_plate_config.yaml" \
  --annotations "$PREP/train.csv" \
  --val-annotations "$PREP/val.csv" \
  --weights-path "$BASE/cct_s_v2_global.keras" \
  --epochs "$EPOCHS" --batch-size "$BATCH" --lr "$LR" --seed 7 \
  --output-dir "$OUT/runs"

RUN="$(ls -td "$OUT"/runs/*/ | head -1)"
MODEL="$(ls -t "$RUN"/*.keras | head -1)"
"$VENV/bin/fast-plate-ocr" export --model "$MODEL" --format onnx \
  --plate-config-file "$BASE/cct_s_v2_global_plate_config.yaml" \
  --onnx-input-dtype uint8 --onnx-data-format channels_last --save-dir "$OUT"
ONNX="$(ls -t "$OUT"/*.onnx | head -1)"
cp "$BASE/cct_s_v2_global_plate_config.yaml" "$OUT/plate_config.yaml"

"$PY" - "$ONNX" "$OUT" "$PREP/prepare-report.json" "$HERE/base-model.lock.json" "$EPOCHS" "$BATCH" "$LR" <<'EOF'
import hashlib, json, os, sys, datetime
onnx, out, prep, lock, epochs, batch, lr = sys.argv[1:]
h = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
card = {
    "status": "UNPINNED_FINE_TUNE",
    "onnx": os.path.basename(onnx),
    "onnxSha256": h(onnx),
    "plateConfigSha256": h(os.path.join(out, "plate_config.yaml")),
    "base": json.load(open(lock))["key"],
    "dataset": json.load(open(prep)),
    "hyperparameters": {"epochs": int(epochs), "batchSize": int(batch), "lr": float(lr), "seed": 7},
    "trainedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
json.dump(card, open(os.path.join(out, "finetune-card.json"), "w"), indent=1)
print(json.dumps({"onnx": onnx, "sha256": card["onnxSha256"], "kind": card["dataset"]["kind"]}))
EOF
