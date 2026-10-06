# VigilOne: what we can take from every repository on the research list (5 Oct 2026)

Status: consolidates `vigilone-oss-reference-study-2026-10-05.md` (16 repos, shallow) and
`vigilone-oss-deep-dive-frigate-scrypted-viseron-2026-10-05.md` (three repos, deep) with a second reading of the rest.
Models, licences and CPU numbers stay in `model-research-2026-10-05/`. This doc is about **what to build or change in
VigilOne**, ranked, and says honestly what is already ours.

Rules: ideas only, no code copied. GPL/AGPL/EULA projects (ZoneMinder, Moonfire, Shinobi) are design references. Any
new dependency or model goes through `THIRD_PARTY_LICENSES.md` and `scripts/models/model-license-exceptions.json`.

## 1. Method and limits

All repositories on your list were cloned shallowly and read for architecture, interfaces, config and docs. Nothing was
run or benchmarked. "Already ours" claims come from searching this repository; "I did not find" means exactly that.

| Depth | Repositories |
| --- | --- |
| Source and docs read | Frigate, Scrypted (interfaces, plugin layout), Viseron, Kerberos Agent, Kerberos Vault (README only), MediaMTX (recorder, cleaner, NTP estimator, playback layout), go2rtc (stream layer, source list), ZoneMinder (zone model, filters, event scoring), Supervision (slicer, smoother, docs), PaddleDetection pipeline (`deploy/pipeline`), PaddleOCR (pipeline API), open_clip (zero-shot builder), Qwen3-VL (video cookbook), OpenVINO (plugins and performance docs), FastReID (layout, evaluation), MMAction2 (configs, deploy tools), OpenIPC (layout) |
| Listed only | Shinobi (plugin processes, custom EULA), Kerberos Factory (repository now only a pointer; deployment lives elsewhere), MMDetection (config zoo; model use is in the model research), MMTracking (not cloned; superseded by tracking inside MMDetection 3.x) |

## 2. Yes, there is a lot to use. Ranked list

Effort: S = a day or two, M = a few days, L = a week or more. "Flag" means it must ship disabled by default per
AGENTS.md.

| # | Take | From | Why it fits VigilOne | Effort | Gate |
| --- | --- | --- | --- | --- | --- |
| 1 | **Archive-aware retention.** When disk pressure forces deletion, prefer segments already confirmed in the archive store, and alert loudly when an unarchived segment must go. | Kerberos Agent `capture/main.go` (`pickRecordingToCleanup`, `recordingPendingUpload`) | Our `RetentionPolicyEngine` checks evidence pins only; I found no reference to archive state in retention. Archive is hash-verified and queued (`objectStorageArchive.service.ts`), so the data to decide is there. Evidence pins still win over everything. | M | Flag with archive |
| 2 | **OpenVINO and ONNX Runtime provider options, with a reported CPU fallback.** Pass `device_type` (CPU, GPU, NPU), `cache_dir`, precision and thread settings; try `[openvino, cpu]` and report which one is really running. | OpenVINO docs (auto device selection, performance hints, caching); Scrypted's separate hardware plugins | `inferenceEngine.ts` passes only a bare provider name (`executionProviders: [ep]`) and throws if it fails. No options, no fallback. A model cache also cuts restart time after a crash. The fallback must be visible in `runtimeInfo` so no one is told they have hardware acceleration when they do not. | S-M | None (internal), report honestly |
| 3 | **Prompt-template ensembling for text-to-image search.** Average the embeddings of several phrasings ("a CCTV image of {}", "a photo of {}") instead of one. | open_clip `zero_shot_classifier.py` | Cheap accuracy gain for plain-language search and for the describe-what-to-watch rules. I found no template averaging in our search or embedding code. Must be measured on our own eval set before the default changes. | S | Measure first |
| 4 | **Semantic triggers with calibrated thresholds** (z-score normalised distances, kept per site). | Frigate `semantic_trigger.py`, `embeddings/util.py` | Gives describe-what-to-watch rules a threshold that means the same thing across sites. Stays advisory. | M | `NL_SEARCH` family |
| 5 | **Near-match candidates for the known-plate list.** Bounded weighted edit distance with look-alike costs. **Correction:** a live known-plate list already exists (`services/anpr/watchlistMatcher.ts`: exact, wildcard and regex, with alerts); only near matches were missing. | Frigate LPR (`match_distance`, `replace_rules`) | Built as an advisory, audited, on-demand endpoint (see `docs/operations/PLATE_NEAR_MATCH.md`). | M | Done |
| 6 | **Per-camera lifecycle state and health.** States (pending, loading, loaded, failed, retrying), last error, retry count, a task supervisor that records panics with stack, and a shutdown report. | Viseron `domain_registry.py`; Kerberos Agent `lifecycle/supervisor.go`; Kerberos `/health` | Folds into the per-camera health endpoint already planned (A3). A failed camera stays visible and isolated. Read-only. | M | None |
| 7 | ~~Metrics for our own eval sets~~ **Already ours.** `tools/eval/coco-eval.mjs` computes AP, mAP50 and per-class AP checked against pycocotools, with precision, recall and false positives per hour; `retrieval-eval.mjs` and `plateEval.ts` cover search and plates. | Supervision `metrics/` | Nothing to build. The gap is real labelled site data (HUMAN-REQUIRED, P2.10). | n/a | Done already |
| 8 | **Resumable archive upload with persisted resume state.** | Kerberos Agent `cloud/tus_client.go` (resume state in a sidecar file, survives restarts) | Our archive job retries but I found no multipart or resumable upload. Matters for large segments over poor Indian site links. | M | With archive flag |
| 9 | **Re-ranking and query expansion for cross-camera candidates.** | FastReID `evaluation/rerank.py`, `query_expansion.py` (algorithms, Apache-2.0) | Improves the ranked list shown to the operator in follow-a-person. Operator confirmation stays mandatory (ADR 0013). Needs our own labelled journeys to prove it helps. | M | Measure first |
| 10 | **Model capability descriptor.** **Largely already ours:** `ModelCardV1.input` carries width, height, colour space and letterbox. What Scrypted adds (`triggerClasses`, `prebuffer`, per-detection `clipped` and `cost`) is small: `cost` belongs to the tracker, which sits outside the adapter, and a box touching the frame edge can be derived without a contract change. | Scrypted `ObjectDetectionModel` | No contract change proposed. Revisit only if a second detector needs trigger classes. | n/a | Dropped |
| 11 | **Per-track enrichment cadence.** Checked: `InferenceScheduler` bounds concurrency, enforces a deadline and prefers the newest frame per camera; `frameQueue` limits a camera to 1 to 5 fps. I found no per-task frame skipping or verdict-hold for enrichments (attributes, classifiers). | PaddleDetection `infer_cfg_pphuman.yml` | Worth doing only when a second per-track model exists; measure compute on reference hardware first. | S | Compared, not built |
| 12 | **Preclusive-zone idea.** Checked: `SceneChangeDetectorService` runs an episode state machine with detection-zone include and exclude masks and a rate limiter. I found no rule where a whole-frame change (lighting, camera shake) suppresses zone alarms; ONVIF tamper events are mapped separately. | ZoneMinder `ZoneType`, per-event `max_score_frame_id` | Needs real footage to set a threshold; not built. | S-M | Compared, not built |
| 13 | **Far-field tiled detection.** Run the detector on overlapping tiles of a motion region and merge with NMS, to catch small distant people on wide or 4K views. | Supervision `InferenceSlicer`, "detect small objects" guide | I found no tiling in `ai-worker`. It multiplies compute, so it must be motion-gated, off by default, and measured on the reference hardware; AGENTS.md prefers substreams for AI. | M | Flag, hardware numbers |
| 14 | **Timestamped frames for VLM verification.** Send frames interleaved with their timestamps, and ask for time and box answers that we then check against tracker boxes. | Qwen3-VL video cookbook (interleaved timestamp-image pairs, spatio-temporal grounding) | Keeps VLM output tied to PTS and checkable against the track. Advisory only, and the local model licence decision is still open. | M | Flag, licence decision |
| 15 | **Camera-protocol coverage, lazy pull and preload.** Sources for cheap DVR and camera families, streams pulled only when a consumer exists, optional preload. | go2rtc (`dvrip`, `isapi`, `tapo`, `onvif`, `streams/preload.go`) | Camera interoperability for the Indian market (Xiongmai/XMeye and Dahua OEMs). Compare with our supported list; MediaMTX stays the media plane. | Research | None |
| 16 | **Signals on the scrub bar.** Door, relay, alarm state drawn on the playback timeline. | Moonfire `design/signal.md` | Cheap investigation win using data we already record. | S-M | None |

## 3. Already ours, so do not rebuild

| Idea elsewhere | Where it lives here |
| --- | --- |
| Continuous versus event retention | `CameraQuotaConfig.continuousDays` and `motionDays`, evidence pins never deleted |
| Hash-verified object-store archive | `objectStorageArchive.service.ts` (SHA-256 checked before and after upload) |
| Two-line Indian plates, format validation, plate evaluation | `services/ai-worker/src/anpr/` |
| Scene-change and exclusion handling | `sceneChangeDetector.service.ts`, `zoneEvaluator.ts` |
| Track-level votes (label, colour) | `tracks/trackMath.ts` |
| Tracker and tripwire versus Supervision | `docs/ai/TRACKER_VALIDATION.md` |
| Incident window and alarm triage | ADRs 0014 and 0015 |

## 4. Looked at and rejected, with reasons

| Item | Reason |
| --- | --- |
| Pretrained weights from FastReID, MMAction2 (ST-GCN, PoseC3D) and PP-Human fall models | Trained on research-only data (Market, Duke, NTU RGB+D, Kinetics). Code is usable, weights are not. See `model-research-2026-10-05/`. |
| MediaMTX NTP estimator as our timing source | It caps estimated time at "now" and resyncs after 5 s of drift, which suits live streams, not exact-PTS evidence. Use RTCP sender reports as already planned. |
| Shinobi plugin model | Custom EULA, nothing to gain. |
| Remote AI services (CompreFace, DeepStack, cloud VLMs) | Break the offline-appliance rule. |
| Automatic cross-camera clustering | Rejected in ADR 0013; the operator confirms every link. |
| OpenIPC firmware | Strategic radar only. Its Xiongmai and HiSilicon support does tell us which cheap camera families to test. |

## 5. Suggested build order

1. **#2 provider options and honest fallback.** Smallest, self-contained, gives a real hardware story.
2. **#1 archive-aware retention.** Prevents silent loss of unarchived footage; failure-path tests first.
3. **#6 camera lifecycle and health** (the planned A3), then **#5 plate watchlist**.
4. **#3 and #4 together** with the describe-what-to-watch feature, after an eval set exists.
5. **#7 metrics**, then **#9, #13, #14** only after reference-hardware numbers and the local-model licence decision.

None of these changes a flag default or a shipping claim.

## 6. Status after the first build round (5 Oct 2026)

| # | Item | Result |
| --- | --- | --- |
| 1 | Archive-aware retention | **Built**, `docs/operations/ARCHIVE_AWARE_RETENTION.md` |
| 2 | Provider fallback and CPU settings | **Built**, `docs/operations/AI_EXECUTION_PROVIDER.md`. No acceleration shipped: the ONNX Runtime package is CPU only |
| 3 | Prompt-template ensembling | **Built, off by default, unmeasured**, `docs/operations/QUERY_TEMPLATE_ENSEMBLE.md` |
| 4 | Calibrated semantic triggers | **Not built.** Depends on the describe-what-to-watch rules, which need the local-model licence decision |
| 5 | Plate near matches | **Built** (advisory, audited), `docs/operations/PLATE_NEAR_MATCH.md`. The known-plate list itself already existed |
| 6 | Per-camera health | **Built**, `docs/operations/CAMERA_HEALTH.md`. No retry counters: none are recorded today |
| 7 | Detector metrics | **Already existed** (`tools/eval`) |
| 8 | Resumable archive upload | **Not built.** Needs a live MinIO or S3 to test multipart and resume; unverifiable with test doubles alone |
| 9 | Re-ranking for cross-camera candidates | **Not built.** Needs labelled journeys to prove it helps |
| 10 | Adapter capability descriptor | **Dropped**, mostly present already |
| 11, 12 | Enrichment cadence, preclusive zones | **Compared**, findings above |
| 13 | Tiled detection | **Not built.** Needs reference-hardware numbers |
| 14 | Timestamped frames for VLM checks | **Not built.** Local-model licence decision open |
| 15 | Camera-protocol coverage | **Not done.** Needs a list of camera models seen at pilot sites |
| 16 | Signals on the scrub bar | **Not built.** Frontend work that cannot be verified here |

Two claims in earlier versions of this study and the deep dive were wrong and are corrected in place: the plate list
existed, and a continuous-versus-event retention split existed. The detector metrics and retrieval evaluation tools
also already existed.
