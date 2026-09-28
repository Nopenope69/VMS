#!/usr/bin/env python3
"""
Prepares a labelled plate dataset for fine-tuning the plate OCR (P4.3).

    python3 tools/anpr/finetune/prepare_dataset.py --dataset DIR --out OUT [--pad 0.06]
        [--val-fraction 0.1] [--test-fraction 0.1] [--allow-plate-overlap]

Input: the evaluation dataset layout (see docs/ai/ANPR_EVALUATION.md): dataset.json declaring
kind SITE or SYNTHETIC, and labels.csv with image_path,plate_text and optionally
split,camera,condition,x,y,w,h. With x,y,w,h (pixels, the plate) the plate is cropped from the
frame; without them each image is taken to be a plate crop already.

Output in OUT:
  crops/                 plate crops (PNG)
  train.csv, val.csv     fast-plate-ocr annotations (image_path relative to the csv, plate_text,
                         plate_region = "Unknown": the base model's region head has no India class)
  test.csv               the held-out split; never passed to training
  train-image-hashes.txt SHA-256 of every SOURCE image used for train/val (for the eval tool's
                         --train-hashes leakage check)
  prepare-report.json    counts, the dataset's declared kind, rejected labels and split method

Splits: an explicit split column (train/val/test) wins. Otherwise rows are split by a hash of the
normalised plate text, so every image of one vehicle lands in the same split. With explicit splits,
a plate text that appears in both train/val and test is refused unless --allow-plate-overlap.
"""
import argparse
import csv
import hashlib
import json
import os
import re
import sys

from PIL import Image

ALPHABET = set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ")
MAX_SLOTS = 10


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def normalise(text):
    return re.sub(r"[^A-Z0-9]", "", (text or "").upper())


def hash_split(plate, val_fraction, test_fraction):
    u = int(hashlib.sha256(plate.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
    if u < test_fraction:
        return "test"
    if u < test_fraction + val_fraction:
        return "val"
    return "train"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--pad", type=float, default=0.06, help="padding around the plate box, fraction of its height")
    ap.add_argument("--val-fraction", type=float, default=0.1)
    ap.add_argument("--test-fraction", type=float, default=0.1)
    ap.add_argument("--allow-plate-overlap", action="store_true")
    a = ap.parse_args()

    header_path = os.path.join(a.dataset, "dataset.json")
    if not os.path.exists(header_path):
        sys.exit(f"DATASET_INVALID: {header_path} missing (declare kind SITE or SYNTHETIC)")
    header = json.load(open(header_path))
    if header.get("kind") not in ("SITE", "SYNTHETIC"):
        sys.exit("DATASET_INVALID: dataset.json kind must be SITE or SYNTHETIC")
    labels = os.path.join(a.dataset, header.get("labels", "labels.csv"))
    rows = list(csv.DictReader(open(labels, newline="")))
    if not rows or "image_path" not in rows[0] or "plate_text" not in rows[0]:
        sys.exit(f"DATASET_INVALID: {labels} needs image_path and plate_text columns")

    os.makedirs(os.path.join(a.out, "crops"), exist_ok=True)
    explicit = "split" in rows[0] and all((r.get("split") or "").strip() for r in rows)
    out_rows = {"train": [], "val": [], "test": []}
    rejected = []
    train_hashes = []
    plates_by_split = {"train": set(), "val": set(), "test": set()}
    for i, r in enumerate(rows):
        plate = normalise(r["plate_text"])
        src = os.path.join(a.dataset, r["image_path"])
        if not plate:
            rejected.append({"row": i + 2, "reason": "negative sample (no plate) is not an OCR training example"})
            continue
        if len(plate) > MAX_SLOTS or not set(plate) <= ALPHABET:
            rejected.append({"row": i + 2, "reason": f"label {plate!r} does not fit {MAX_SLOTS} slots of 0-9A-Z"})
            continue
        if not os.path.exists(src):
            sys.exit(f"DATASET_INVALID: {src} (row {i + 2}) does not exist")
        split = r["split"].strip() if explicit else hash_split(plate, a.val_fraction, a.test_fraction)
        if split not in out_rows:
            sys.exit(f"DATASET_INVALID: row {i + 2} split {split!r} (use train, val or test)")
        img = Image.open(src).convert("RGB")
        if all((r.get(k) or "").strip() for k in ("x", "y", "w", "h")):
            x, y, w, h = (float(r[k]) for k in ("x", "y", "w", "h"))
            p = a.pad * h
            img = img.crop((max(0, round(x - p)), max(0, round(y - p)), min(img.width, round(x + w + p)), min(img.height, round(y + h + p))))
        name = f"{i:06d}_{plate}.png"
        img.save(os.path.join(a.out, "crops", name))
        out_rows[split].append({"image_path": f"crops/{name}", "plate_text": plate, "plate_region": "Unknown"})
        plates_by_split[split].add(plate)
        if split != "test":
            train_hashes.append(f"{sha256(src)}  {r['image_path']}")

    overlap = sorted((plates_by_split["train"] | plates_by_split["val"]) & plates_by_split["test"])
    if overlap and not a.allow_plate_overlap:
        sys.exit(f"PLATE_OVERLAP: {len(overlap)} plate(s) are in both training and test splits, e.g. {overlap[:5]}; "
                 "move them or pass --allow-plate-overlap")
    if not out_rows["train"] or not out_rows["val"]:
        sys.exit("DATASET_INVALID: train and val splits must both be non-empty")

    for split, items in out_rows.items():
        with open(os.path.join(a.out, f"{split}.csv"), "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=["image_path", "plate_text", "plate_region"])
            w.writeheader()
            w.writerows(items)
    with open(os.path.join(a.out, "train-image-hashes.txt"), "w") as f:
        f.write("# SHA-256 of source images used for train/val; pass to evalPlates --train-hashes\n")
        f.write("\n".join(train_hashes) + "\n")
    report = {
        "kind": header["kind"],
        "dataset": header.get("name"),
        "splitMethod": "explicit" if explicit else f"plate-hash (val {a.val_fraction}, test {a.test_fraction})",
        "counts": {k: len(v) for k, v in out_rows.items()},
        "plateOverlapTrainTest": len(overlap),
        "rejected": rejected,
    }
    json.dump(report, open(os.path.join(a.out, "prepare-report.json"), "w"), indent=1)
    print(json.dumps({k: report[k] for k in ("kind", "splitMethod", "counts")}))


if __name__ == "__main__":
    main()
