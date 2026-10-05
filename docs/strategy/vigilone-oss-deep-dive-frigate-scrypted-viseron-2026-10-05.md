# VigilOne: deeper read of Frigate, Scrypted and Viseron (5 Oct 2026)

Status: follow-up to `vigilone-oss-reference-study-2026-10-05.md`. That study read 16 repositories shallowly; the
owner asked for a more thorough pass on the projects at the top of the research queue. This doc covers the three
where the first pass was thinnest. Ideas only: no code is copied. Frigate (MIT), Viseron (MIT) and Scrypted (MIT core,
per-plugin licences, commercial NVR) are read as design references. Every dependency still goes through
`THIRD_PARTY_LICENSES.md` and `scripts/models/model-license-exceptions.json`.

## 1. What was and was not read

Read in full or in the relevant part (shallow clones, nothing run):

- Frigate: `track/tracked_object.py`, `track/stationary_classifier.py`, `data_processing/post/semantic_trigger.py`,
  `embeddings/util.py`, the search endpoint in `api/event.py`, and the docs for semantic search, review, face
  recognition, license plate recognition and GenAI review summaries.
- Scrypted: `sdk/types/src/types.input.ts` (detection, zone, mixin and cluster interfaces) and the plugin directory
  layout (`objectdetector`, `prebuffer-mixin`, `snapshot`, `openvino`, `coreml`, `onnx`, `rknn`, `ncnn`, `tensorflow-lite`).
- Viseron: `domain_registry.py`, the `watchdog/` and `components/storage/` layout, `storage/config.py` tier
  validation, and the head of `domains/post_processor`.

Not read, so nothing below depends on it: Frigate's face and LPR processor code and GenAI client code; Scrypted
plugin bodies (including `objectdetector/main.ts`, smart motion and occupancy sensors); Viseron's NVR internals.
Frigate's face-vote behaviour comes from its documentation, not its code.

"Already ours" claims were checked by searching this repository. A search that finds nothing means "I did not find
it", not "it does not exist".

## 2. Frigate

| # | What Frigate does | VigilOne today | Proposal | Priority |
| --- | --- | --- | --- | --- |
| F1 | **Semantic triggers.** A saved text or image query is embedded once. Each new tracked object's thumbnail or description embedding is compared to it. Distances are z-score normalised with a running mean and standard deviation that are saved to disk, and the trigger fires at `similarity >= threshold` per camera. | Plain-language search and the pending "describe what to watch" rule (B1 in the reference study). No calibrated threshold across models or sites was found. | Use the same idea for B1: a saved query becomes a rule whose threshold is calibrated against that site's own distance distribution, with the dry run showing last week's matches. Keep the result advisory until measured. | **High, folds into B1** |
| F2 | **Plate matching.** Known plates may be literal, wildcard (`J*N-*234`) or regex. `match_distance` allows N edit-distance errors. Ordered regex `replace_rules` normalise OCR output (O to 0, I to 1, split into groups). Unknown plates are stored but not labelled. | `levenshtein` exists only in the plate evaluation harness. Plate search supports wildcards. Indian format rules are in `indianPlate.v1.ts`. A live known-plate or watchlist match with bounded edit distance was not found. | Bounded-distance watchlist match on top of the Indian format validator, with an Indian confusable table (O/0, I/1, B/8, S/5, Z/2) and state-code awareness. A near match is shown as a ranked candidate with the differing characters marked, never as an identity. This is where a format-aware system beats a generic one. | **High (India ANPR)** |
| F3 | **Face identity from many frames.** Recognition runs on many frames while a person is in view. The label comes from all attempts, weighted by face area, and one very confident frame cannot assign it. The docs say not to train on faces that already score high, only on clear, new angles. | `majority()` in `tracks/trackMath.ts` is an unweighted vote with `minVotes` and `minShare`. | Optionally weight votes by crop area or quality for face and plate reads, and require agreement across frames. Privacy and purpose-limitation controls stay as they are. | Medium |
| F4 | **Track score and stationary logic.** Object score is the median of its score history. A track that was once a true positive stays one. Stationary classification uses per-class IoU thresholds with hysteresis (`known_active_iou` 0.2, `stationary_check_iou` 0.6, `active_check_iou` 0.9, a history of 10 boxes; vehicles use 0.75). | Our track score is the best crop's score. Stationary handling exists (`trackMath`, the unattended bag work). | Compare against our stationary rules on recorded footage. The per-class hysteresis is the part worth checking, since it prevents parked cars flipping between active and stationary. | Medium |
| F5 | **GenAI review summary schema.** `title`, `scene`, `shortSummary` (two sentences, for notifications), `confidence`, `other_concerns` (a list of user-defined concerns) and `potential_threat_level` 0 to 2. A per-site "activity context" prompt defines what is normal. | Cited incident summary (ADR 0016), where every sentence cites a recorded fact. | Borrow two things: the per-site normal-activity context as an input, and a short notification form of the summary. A model-assigned threat level stays advisory and is not used for escalation. | Medium |
| F6 | **Hybrid search merge.** Thumbnail and description matches are normalised separately and merged by best distance per object. Filters include camera, label, sub-label, zone, score, speed, time-of-day and plate. | `trackSearch.ts` ranks tracks by best crop score. | Check how we merge image-space and text-space scores. If they are merged raw, normalise each first. | Low-medium |
| F7 | **Backfill is explicit.** Enabling semantic search does not index old objects; a reindex job does. | Not found as an operator-visible job. | When a search flag is turned on for an existing site, offer a throttled, resumable backfill that cannot starve recording. | Low-medium |
| F8 | **One-time model download, then offline.** | Offline bundle and licence process exist. | Make sure the same promise is stated in operator docs. | Low |

## 3. Scrypted

| # | What Scrypted does | VigilOne today | Proposal | Priority |
| --- | --- | --- | --- | --- |
| S1 | **Model capability descriptor.** `ObjectDetectionModel` declares `inputSize`, `inputFormat` (gray, rgb, rgba), `triggerClasses`, `prebuffer` and `decoder`, so the host can hand each detector the frame it wants. `ObjectDetectionZone` supports `Intersect` or `Contain`, exclusion zones and per-class lists. | `inputSize`, `inputFormat` and `triggerClasses` were not found in the adapter contract or docs. | Add an optional capability block to a future `ai-adapter.v1` minor version (with `clipped`, `cost` and source-media fetch from the earlier study). Frame scheduler uses it to avoid resizing for every model. | Medium |
| S2 | **Detection as a streaming session.** `generateObjectDetections` takes a frame generator plus a session, so tracker state lives with the detector across frames. | Tracker is in `ai-worker/src/tracker.ts`, outside the adapter. | No change. Recorded as a design difference; our split keeps tracks vendor-neutral. | None |
| S3 | **Result fields.** Track `id`, `cost`, `clipped`, base64 `embedding`, recognised `label` and `labelScore`, `landmarks`, `clipPaths`, movement history. | Partly covered by the earlier proposal. | Add `landmarks` to the candidate list only if the pose work needs it. | Low |
| S4 | **Mixins and cluster fork.** Detection, prebuffer and snapshot attach to any camera as mixins. `ClusterForkInterface` lets plugins run on other machines. Hardware backends are separate plugins. | One appliance; adapter seam exists. | Matches the optional Command Center direction: AI workers on other nodes later, never required on the 32-camera appliance. Nothing to build now. | Later |
| S5 | **Licensing.** Mixed per plugin, and the NVR product is commercial. | n/a | Do not lift plugin code. Design reference only. | n/a |

## 4. Viseron

| # | What Viseron does | VigilOne today | Proposal | Priority |
| --- | --- | --- | --- | --- |
| V1 | **Domain lifecycle.** Each configured camera or detector has a state (`PENDING`, `LOADING`, `LOADED`, `FAILED`, `RETRYING`), a cancel event, and a retained error. A failed camera still appears with its error rather than vanishing. | `streamSupervisor.ts`, watchdogs, and the planned per-camera health endpoint (A3). | Give A3 an explicit per-camera state machine with a retained last error and retry count. One camera's failure stays visible and isolated. | **Medium, folds into A3** |
| V2 | **Tiered retention by category.** Storage tiers have `min_age` and `max_age` per category (recorder, snapshots, timelapse); recorder tiers can differ for continuous and event footage. Config validation rejects missing paths, reserved paths, duplicates and non-increasing ages at save time. | Retention settings exist. A continuous-versus-event split was not found. | Keep event footage longer than continuous footage, behind `StorageAdapter`, with save-time validation. Any evidence hold or custody record must override retention, and a failed validation must keep existing recordings. | **Medium-high (storage cost)** |
| V3 | **Three watchdog kinds** (thread, process, subprocess) with restartable workers. | Stream and worker supervisors. | Compare restart and backoff policy only. | Low |
| V4 | **Remote AI backends** (CompreFace, DeepStack, CodeProject.AI) and accelerator components (Hailo, EdgeTPU). | OpenVINO and ONNX paths. | Add Hailo to the hardware watch list. Remote AI services are not a fit for an offline appliance. | Low |
| V5 | **Orphaned-camera handling** in storage. | `crashRecovery` and reconciler cover orphaned segments. | Check that footage of a deleted camera stays reachable for evidence export. | Low |

## 5. Your 12-item list: where each is covered

| Item | Covered in |
| --- | --- |
| Frigate, Scrypted, Viseron, Shinobi, ZoneMinder, Kerberos | reference study (shallow) and this doc (Frigate, Scrypted, Viseron deeper) |
| Moonfire | reference study; led to the RecordingCatalog audit (`docs/audits/RECORDING_CATALOG_AUDIT_2026-10-05.md`) |
| MediaMTX, go2rtc, Supervision, MMTracking, OpenIPC | reference study; tracker comparison in `docs/ai/TRACKER_VALIDATION.md` |
| PaddleDetection, MMDetection, FastReID, PaddleOCR, MMAction2, Qwen3-VL, open_clip, OpenVINO | `model-research-2026-10-05/` (licences, CPU numbers, shortlist and do-not-use list) |

Still shallow after this pass: Shinobi, ZoneMinder, OpenIPC (low value for us), and the plugin bodies in Scrypted.

## 6. Suggested order

1. F1 into B1 (describe-what-to-watch), because it supplies the threshold calibration that feature lacks.
2. F2, the India-specific plate watchlist match, as its own small PR behind a flag.
3. V1 into A3 (per-camera health), then V2 (retention by footage kind) after an ADR.
4. S1 into the A4 adapter-fields proposal.
5. F3, F4, F5, F6, F7 as measured follow-ups; none changes a flag default or a shipping claim.
