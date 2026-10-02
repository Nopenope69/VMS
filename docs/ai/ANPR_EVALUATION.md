# ANPR evaluation and fine-tuning (P4.3)

**Status:** the tools are implemented and have been run end to end on SYNTHETIC data only.
Plate-level accuracy on real Indian site footage is **not measured**. That needs labelled site
data, which only a person can supply (HUMAN-REQUIRED). No number in this repository describes
real-world accuracy.

## 1. What a person needs to supply

A dataset directory:

```
site-gate1/
  dataset.json      {"kind": "SITE", "name": "Gate 1 LPR, Mar–Apr 2027", "site": "...",
                     "collectedBy": "...", "consent": "...", "cameras": ["..."]}
  labels.csv        image_path,plate_text,split,camera,condition,vehicle_type,plate_type,x,y,w,h
  frames/…          the images (frames from the LPR camera; JPEG or PNG)
```

* `kind` is declared by the person who collected the data. The tools never infer it. A report
  says SITE only when `dataset.json` says so.
* `plate_text`: what the plate reads. Spaces and hyphens are ignored. Leave it empty for a frame
  with no plate (a negative); negatives measure false reads.
* `split`: `train`, `val` or `test`. Held-out means: `test` frames come from days and vehicles
  that are not in `train`/`val`. Without a split column, `prepare_dataset.py` splits by a hash of
  the plate text, so each vehicle lands in one split only.
* `condition`, `vehicle_type`, `plate_type`: used for breakdowns. Use the values listed in
  `docs/operations/PILOT_MEASUREMENT.md` (section 2) so that sites can be compared.
* `x,y,w,h`: the plate box in pixels. It is needed for fine-tuning; evaluation does not use it.
* Suggested minimum: 1,000 labelled test frames per site, covering night and two-line plates. A
  95% interval of about ±3 points needs roughly 1,000 frames.
* Site footage is personal data under the DPDP Act. Keep it on the appliance or on an approved
  workstation, record the purpose, and delete it when the evaluation is done.

## 2. Evaluate the pinned pipeline

```
npm --prefix services/ai-worker run build
scripts/models/fetch-model.sh ppocrv4-det && scripts/models/fetch-model.sh fast-plate-ocr-cct-s-v2
node services/ai-worker/dist/tools/evalPlates.js --dataset site-gate1 --split test \
     --out docs/ai/anpr-eval/<date>_SITE_<site>_baseline.json
```

The tool runs the same code as the anpr-worker: pipeline `anpr-india-v1`, whose model hashes are
verified. It runs in evaluation mode, so no licence approval is needed because nothing leaves the
process. The report contains:

| Field | Meaning |
| :--- | :--- |
| `plateAccuracy`, `plateAccuracyCi95` | Share of plate frames where a read equals the label exactly; Wilson 95% interval |
| `misreadRate` | A plate was read but wrongly. This is the dangerous error, because it can trigger or miss a watchlist alarm |
| `noReadRate` | No valid plate was read |
| `characterErrorRate` | Edit distance of the best read, divided by label length |
| `falseReadRate` | Reads on negative frames |
| `byCondition`, `byCamera`, `byExpectedLength`, `byVehicleType`, `byPlateType` | The same metrics per group; `fewSamples` marks a group with fewer than 30 plate frames |
| `calibration` | Reads binned by confidence, with each bin's accuracy and mean confidence, and `expectedCalibrationError` (the read-weighted gap). A read on a frame with no plate counts as wrong |
| `operatingPoints` | Read rate, misread rate and false-read rate at confidence thresholds 0.5 to 0.95, counting the top read of each frame; use it to choose the camera's minimum confidence |
| `verdict` | `evaluated: true` only for SITE data with at least 300 plate frames; otherwise NOT EVALUATED and why |
| `dataset.contentSha256` | Hash over (image SHA-256, label) pairs, which identifies the exact set evaluated |
| `pipeline.*` | Pipeline definition SHA-256, component model hashes, and any OCR override |

Exit codes: 2 for an invalid or undeclared dataset, 3 for train/test leakage, 4 when the pipeline is refused (hash mismatch or missing file).

## 3. Fine-tune the plate OCR

```
python3 tools/anpr/finetune/prepare_dataset.py --dataset site-gate1 --out work/prep
tools/anpr/finetune/finetune.sh work/prep work/ft --epochs 40
node services/ai-worker/dist/tools/evalPlates.js --dataset site-gate1 --split test \
     --train-hashes work/prep/train-image-hashes.txt \
     --ocr-model work/ft/last.onnx --ocr-config work/ft/plate_config.yaml \
     --out docs/ai/anpr-eval/<date>_SITE_<site>_finetune.json
```

* The run starts from the published Keras weights of the pinned OCR. Their hashes are in
  `tools/anpr/finetune/base-model.lock.json` and are verified before training.
* The training stack (TensorFlow, Keras, fast-plate-ocr[train]) is pinned in
  `requirements-train.txt`. It runs on a workstation and is never shipped in the appliance.
* `prepare_dataset.py` refuses a plate that appears in both the training splits and the test
  split. `evalPlates --train-hashes` refuses any test image that was used in training.
* Crops for training come from the labelled plate box. At run time the OCR sees the padded box
  of the detected text group instead, so crops may differ a little from what the model sees in
  production.
* The fine-tune is **unpinned**. Before it can run in the product, a person must:
  1. compare the baseline and fine-tuned reports on the same held-out test set;
  2. add the model to `models.lock.json` as a candidate model;
  3. record an approval. Weights trained on site data are derived from personal data.

## 4. What has been run (SYNTHETIC smoke only)

Dataset: 300 random, format-valid plates from `tools/anpr/synth_plates.py --random 300 --seed 7`,
split 180 train / 60 val / 60 test.

| Run | Plate accuracy (test, n = 60) | 95% CI | Misread | No-read | CER |
| :--- | ---: | :--- | ---: | ---: | ---: |
| Pinned pipeline | 80.0% | 68.2–88.2% | 8.3% | 11.7% | 12.6% |
| Fine-tuned, 2 epochs (CPU) | 88.3% | 77.8–94.2% | 3.3% | 8.3% | 9.0% |

Reports: `docs/ai/anpr-eval/2026-09-27_SYNTHETIC-SMOKE_*`. The two confidence intervals overlap,
and the data is rendered text on flat backgrounds. These runs show that the tools work end to
end: data preparation, verified base weights, training, ONNX export in the runtime format,
evaluation with a leakage check. **They say nothing about accuracy on Indian roads.**
