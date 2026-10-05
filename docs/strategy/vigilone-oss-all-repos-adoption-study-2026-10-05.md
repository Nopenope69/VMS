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
| 5 | **India plate watchlist match.** Bounded edit distance plus an Indian confusable table (O/0, I/1, B/8, S/5, Z/2) on top of the existing format validator; show differing characters, never assert identity. | Frigate LPR (`match_distance`, `replace_rules`); PaddleOCR `return_word_box` for per-character scores | ANPR already handles two-line plates and Indian formats (`plateCandidates.ts`, `indianPlate.v1.ts`). A live watchlist is the missing step. Per-character confidence would let the match weigh uncertain characters less. | M | Flag, RBAC, purpose-limitation |
| 6 | **Per-camera lifecycle state and health.** States (pending, loading, loaded, failed, retrying), last error, retry count, a task supervisor that records panics with stack, and a shutdown report. | Viseron `domain_registry.py`; Kerberos Agent `lifecycle/supervisor.go`; Kerberos `/health` | Folds into the per-camera health endpoint already planned (A3). A failed camera stays visible and isolated. Read-only. | M | None |
| 7 | **Metrics for our own eval sets.** Precision, recall, F1, mAP and a detection-matching routine so detector and tracker changes are compared on the same footage. | Supervision `metrics/` | We have a plate evaluation harness and tracker validation. A general detector metric set would make model swaps (YOLOX versus alternatives) measurable. | M | None |
| 8 | **Resumable archive upload with persisted resume state.** | Kerberos Agent `cloud/tus_client.go` (resume state in a sidecar file, survives restarts) | Our archive job retries but I found no multipart or resumable upload. Matters for large segments over poor Indian site links. | M | With archive flag |
| 9 | **Re-ranking and query expansion for cross-camera candidates.** | FastReID `evaluation/rerank.py`, `query_expansion.py` (algorithms, Apache-2.0) | Improves the ranked list shown to the operator in follow-a-person. Operator confirmation stays mandatory (ADR 0013). Needs our own labelled journeys to prove it helps. | M | Measure first |
| 10 | **Model capability descriptor in the adapter.** Input size, input format, trigger classes, prebuffer need. | Scrypted `ObjectDetectionModel` | `ai-adapter.v1` minor-version proposal, already queued as A4. | S | Contract change, docs first |
| 11 | **Per-track enrichment cadence.** Run attribute, action and classifier models on a tracked crop only, every N frames, hold the verdict for a set number of frames, with a warm-up. | PaddleDetection `infer_cfg_pphuman.yml` (`skip_frame_num`, `display_frames`, `warmup_frame`, batch size per task) | Matches the track-centric model. Compare against what our scheduler already does before changing anything. | S (compare) | None |
| 12 | **Preclusive-zone idea: one signal suppresses others.** A whole-frame change (lighting, camera shake) cancels motion alarms from the other zones. | ZoneMinder `ZoneType` (`PRECLUSIVE`, `INCLUSIVE`, `EXCLUSIVE`, `PRIVACY`), per-event `tot_score`, `max_score`, `max_score_frame_id` | We already have `sceneChangeDetector` and exclusion zones. Check whether scene change suppresses zone alarms; the best-frame-per-event score is also a cheap way to pick evidence thumbnails. Idea only (GPL). | S (compare) | None |
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
