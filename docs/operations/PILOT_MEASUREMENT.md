# Pilot measurement guide

Status: **the tools exist and are tested. No measurement from a real site exists yet.** Every number below is
something the pilot has to produce. Nothing in this repository is a site measurement until a report built from
site data says `evaluated: true`.

This is North Star Bucket 5 (`docs/strategy/00-north-star-v0.1-and-v1.0-plan-2026-09-29.md`, section 5). The V0.1
exit gate needs four numbers from a real pilot: detector precision and recall, ANPR accuracy, search recall@k, and
time to answer. One page per measurement:

| Measurement | Tool | Minimum before it counts | Detailed procedure |
| --- | --- | --- | --- |
| Detector precision and recall | `tools/eval/detect-images.mjs`, `coco-eval.mjs`, `model-card.mjs` | 500 labelled instances per class, SITE data | `tools/eval/README.md` |
| ANPR (the India benchmark) | `services/ai-worker/dist/tools/evalPlates.js` | 300 plate frames, SITE data (1,000 per site recommended) | `docs/ai/ANPR_EVALUATION.md` |
| Search recall@k | `tools/eval/retrieval-collect.mjs`, `retrieval-eval.mjs` | 100 labelled queries, SITE data | `RETRIEVAL_LABELLING.md` |
| Time to answer | Investigation page stopwatch, `GET /api/v1/investigations/timings/report` | 30 answered investigations | Section 4 below |

The minimums are proposals made for this project, not industry standards. Each tool refuses to call a result
evaluated below its minimum, and refuses data not declared as coming from a site.

## 1. Before collecting anything

* **Purpose and consent.** Site footage, plates and people are personal data. Record the purpose (evaluation of
  the system for this deployment) in the site's DPDP decision record (`DPDP_DECISION_RECORD.md`), keep the
  footage on the appliance or an approved workstation, and delete it when the evaluation is done.
* **Held out means held out.** Frames used for any fine-tune must not be in a test set. `evalPlates
  --train-hashes` refuses a test image that was used in training.
* **Spread, not convenience.** Sample across cameras, days, day and night (IR), and weather. Do not drop the hard
  frames: small, distant, blurred and partly hidden objects are what the numbers are for.

## 2. The India ANPR benchmark

Label frames from each LPR camera (`labels.csv`, format in `docs/ai/ANPR_EVALUATION.md`). Use these values in the
breakdown columns so that sites can be compared:

| Column | Values |
| --- | --- |
| `condition` | `day`, `night-ir`, `dusk`, `rain`, `glare`, `dirty-plate`, `tilted`, `occluded`, `far`, `motion-blur` |
| `vehicle_type` | `car`, `motorcycle`, `scooter`, `auto`, `truck`, `bus`, `tractor`, `other` |
| `plate_type` | `standard`, `two-line`, `bh`, `temporary`, `commercial`, `ev-green`, `hsrp`, `non-standard` |

Aim for at least 30 plate frames in every value you list. The report flags smaller groups (`fewSamples`). Their
intervals are too wide to compare. Include frames with no plate (an empty `plate_text`): they measure false reads.

The report (`--out report.json`) gives:

* **Read rate** (`plateAccuracy`, with its 95% interval), **misread rate**, **no-read rate**, **character error
  rate** and **false-read rate**, overall and per camera, condition, vehicle type and plate type.
* **Latency** per frame (p50, p95, max) on the machine that ran it. Run it on the reference hardware for a number
  that means something for the product.
* **Calibration**: reads grouped by the confidence the system gave them, with the share actually right. A
  well-calibrated system that says 0.9 is right about 90% of the time. `expectedCalibrationError` is the average
  gap. A large gap means the confidence threshold cannot be trusted as a dial.
* **Operating points**: at each confidence threshold (0.5 to 0.95), the read rate, misread rate and false-read rate
  a site would get. Choose the camera's minimum confidence from this table. A misread can trigger a wrong
  watchlist alarm or miss a right one, so it is usually worth some no-reads to cut misreads.
* **Verdict**: `evaluated: true` only for SITE data with at least 300 plate frames.

Report files go in `docs/ai/anpr-eval/<date>_SITE_<site>_<what>.json`.

## 3. Search recall@k

Follow `RETRIEVAL_LABELLING.md`: at least 100 labelled queries from the site's own crops, collected through the
real search API with `retrieval-collect.mjs` and scored with `retrieval-eval.mjs --real-site-data`.

## 4. Time to answer

The North Star's main product metric: from taking a question to an answer the operator accepts. Target: under 60
seconds.

**Turn it on:** `VIGILONE_FEATURE_INVESTIGATION_TIMING=true` on the backend. The Investigation page then shows a
stopwatch.

**How operators use it:**

1. When they take a question, they type it (optional, up to 120 characters) and press **Start stopwatch**.
2. They investigate as usual. The page counts searches run, results opened (jumping to footage from a search),
   cameras added to the grid, and evidence exports. The first opened result is also timed.
3. They press **Answered** when they have an answer they would act on, or **Abandon** if they give up or are
   interrupted.

All times are taken by the server clock. One stopwatch can run per operator. One left running for more than four
hours is closed as abandoned when that operator starts the next, and never counts as an answer.

**The report:** `GET /api/v1/investigations/timings/report?from=...&to=...` (permission `AUDIT_VIEW`; default:
the last 30 days). It gives:

* started, answered, abandoned and still-open counts;
* median and 90th-percentile time to answer;
* the share answered within 60 seconds, with its 95% interval;
* time to the first opened result;
* steps per answer.

It says NOT EVALUATED below 30 answered investigations. It has no per-operator breakdown on purpose: it measures
the product, not the staff.

**A fair test.** A time means little without a comparison and a fixed set of questions:

1. Write 20 to 30 realistic questions for the site before the pilot. For example: "who entered the store room after
   10 PM on the 14th", "when did the white van leave", "find every time the side gate was opened last night".
   Record the true answer to each, so "answered" can be checked afterwards.
2. **Baseline:** time the same kind of questions answered the old way (scrubbing recordings), with the same
   operators. Use a phone stopwatch, or this stopwatch with search turned off. The external review guessed about
   30 minutes for a traditional VMS; that is not measured.
3. Give each operator a mix of questions, and do not reuse a question with the same operator.
4. Report the median, the 90th percentile and the share under 60 s, with the baseline next to it.

## 5. What goes into the V0.1 gate

Put the four reports (file names and the `contentSha256` or date range of the data) in `docs/STATUS.md` with the
commands that produced them. A measurement on SYNTHETIC or public data never closes a gate.
