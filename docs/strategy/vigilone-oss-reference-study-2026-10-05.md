# VigilOne: what the open-source VMS and CV projects teach us (5 Oct 2026)

Status: reference study and build order. Companion to `00-north-star-v0.1-and-v1.0-plan-2026-09-29.md` and
`vigilone-oss-ai-catalog-2026-09-23.md` (which lists models; this doc looks at how other systems are built).

## 1. How this was done, and its limits

Shallow clones of 16 public repositories were read in a scratch directory (nothing was copied into this repo):
Frigate, Moonfire NVR, Kerberos Agent, Viseron, Scrypted, Shinobi, ZoneMinder, go2rtc, MediaMTX, FastReID,
MMTracking, MMAction2, Norfair, Supervision, OpenIPC firmware and PaddleDetection. The starting point was two
external write-ups (a "reference set" list and a Kerberos review). Their claims about this repository were checked
against the code and hold: the AI parts exist, are feature-flagged and are not field-proven.

Limits: source and interface files were read, nothing was run. Scrypted and Viseron were judged from interface
files and directory layout. Several documentation sites were unreachable from the sandbox. Licences below are as
shown in each repository; they are not legal advice and every dependency still goes through the repo's licence
process (`THIRD_PARTY_LICENSES.md`, `scripts/models/model-license-exceptions.json`).

**Rule for this doc:** a project is a source of ideas. No code is copied. GPL, AGPL and EULA projects are read for
design only.

## 2. Already done, so not repeated

| Suggestion from the write-ups | State in this repo |
| --- | --- |
| "Unified Track, Enrichment, Event, Investigation model" | North Star and ADRs 0011 to 0013; track index, track search, cross-camera follow built (flagged off) |
| Zone and line counting like Supervision | `docs/ai/TRACKER_VALIDATION.md`: our tracker and tripwire were compared with Supervision. `LineZone` made 24 false crossings on jittery tracks where ours made 0 |
| Automatic cross-camera clustering (PP-Human `mtmct.py`) | Rejected on purpose in ADR 0013: operator confirms every link |
| Pluggable AI models | `ai-adapter.v1`, `PipelineAdapterCore` (ADR 0007) |
| Storage decoupling (Kerberos Vault) | `StorageAdapter`; S3/MinIO archive behind a flag |
| Fleet and federation (Kerberos Factory) | CMS federation sync built; reverse video tunnel not built |
| Rule cooldown | `ruleEngine.ts` cooldown suppression |

## 3. Ideas worth taking, by project

| Project (licence) | Idea | What it means for VigilOne | Priority |
| --- | --- | --- | --- |
| **Frigate** (MIT) | A review item is derived from tracked objects. Severity (alert or detection) comes from label plus `required_zones`, per camera. After an alert's last activity, later detections are held and published as a new segment, so they cannot keep the alert open (`frigate/review/maintainer.py`) | Our cooldown skips repeat triggers; it does not decide where one incident ends. Alert-cutoff semantics reduce alarm fatigue and give triage (feature 4 below) a clean unit to rank | **High, build first** |
| Frigate | Post-processors keyed on `recording`, `review` or `tracked_object`; GenAI describes a review item from at most 1 fps and about 28 frames pulled from the recording | Same shape as our cited incident summary: frames come from recordings, never live video | Medium (feature 3) |
| Frigate | A plate read is published as metadata on the track | Matches our track index; no change | None |
| **Moonfire NVR** (GPL, ideas only) | Write order: write file, fsync file, fsync directory, then insert the row. Delete via a garbage table. Tiered fsck: presence, size, content hash | Audit how `RecordingCatalog` and MediaMTX behave after a crash against this order. Backlog already notes a segment indexed while still being written | **High (audit)** |
| Moonfire | `time.md`: camera clock vs NVR clock, RTCP sender reports, main and sub streams on one timeline | Compare with ClockGuard, PTS to UTC mapping and the backlog item on 1 s camera-clock resolution | High (audit) |
| Moonfire | "Signals": non-video time series drawn on the scrub bar | Alarm, door and relay state on the playback timeline | Low |
| **MediaMTX** (MIT) | `ntpestimator` maps RTP PTS to wall clock with a drift cap; recorder and record cleaner are separate modules | Reference for exact-PTS playback and the RTCP clock work in the backlog | Medium |
| **go2rtc** (MIT) | `streams/producer.go`: per-source reconnect worker with retry counts | Reference for stream lifecycle and camera quirks | Low |
| **Scrypted** (mixed per plugin; check NVR terms) | `ObjectDetectionResult` carries track `id`, `cost`, `clipped`, optional `embedding`, recognised `label` and `labelScore`; `getDetectionInput(detectionId)` fetches the source media | Candidate fields for a future `ai-adapter.v1` minor version. Hardware backends are separate plugins (CoreML, ONNX, OpenVINO, NCNN, RKNN, TFLite), matching our hardware plan | Medium |
| **Kerberos Agent** (MIT) | Unauthenticated `/health` with connectivity and stream stats; a lifecycle supervisor; recording conditions (time window, URI) | Per-camera health view and a formal per-camera "agent" boundary. Mostly present as watchdogs; formalise and expose | Medium |
| **Viseron** (MIT) | Domains (object detector, plate recognition, face recognition, motion, post-processor) with per-camera event topics | Vocabulary comparison only; our adapter seam already covers it | Low |
| **ZoneMinder** (GPL-2, ideas only) | Saved filters with automatic actions (archive, delete, move, upload, notify) | Our rule engine covers this; retention-by-filter is the one idea not yet ours | Low |
| **Shinobi** (custom EULA) | Detector plugins as separate processes | Not used. Do not copy code | None |
| **PaddleDetection** (Apache-2.0) | PP-Human, PP-Vehicle: attributes, retrograde (wrong-way) and lane-pressing violations, plate pipeline | Candidate models behind our adapters for the traffic pack. Each model needs the licence process | Later (vertical pack) |
| **FastReID** (Apache-2.0) | ONNX and TensorRT export tooling | Candidate appearance re-ID model; weights and training-data terms must be checked first | Later |
| **MMAction2** (Apache-2.0) | Skeleton (ST-GCN, PoseC3D) and spatio-temporal action models | The route to fall, fight and loiter behaviour. Compute on the reference hardware is unmeasured | Later (needs hardware numbers) |
| **MMTracking, Norfair, Supervision** (Apache-2.0, BSD-3, MIT) | Trackers and zone primitives | Ours already matches Supervision on the validation scenarios; no case to swap | None |
| **OpenIPC** (MIT) | Open camera firmware for many SoCs | Strategic radar only | None |

## 4. Order of work

Decided with the owner on 5 Oct 2026. Each item is one PR from `master`, small and reversible, behind its own flag
where it adds behaviour.

### A. From this study

1. **Alert-cutoff and review-segment semantics** (new ADR, `IncidentOrchestrator`). Decide when one incident ends
   and a later detection starts another; keep cooldown as it is. Failure-path tests first.
2. **`RecordingCatalog` crash-safety and time audit.** Compare against Moonfire's write order and fsck tiers and
   MediaMTX's PTS estimator. Output is a written audit plus failing tests for any gap, before any fix.
3. **Per-camera health endpoint** modelled on the Kerberos `/health`: connectivity, stream stats, last recorded
   segment, reconnect count. Read-only; no change to recording.
4. **Adapter result fields.** Propose `clipped`, `cost` and a "get the source media for this detection" call as an
   `ai-adapter.v1` minor version, with the contract docs updated. Proposal first; no breaking change.

### B. The four software features still pending (from `vigilone-ai-features-landscape-2026-10-03.md`, section 6)

Natural-language search is done (Session 29, flag `NL_SEARCH`). The remaining four, one PR each:

1. **Describe-what-to-watch rules.** A local model drafts a normal rule; the dry run shows last week's matches; the
   operator saves it. Open-vocabulary checks stay advisory until measured. Needs the local-LLM licence decision.
2. **Cited incident summary.** Ordered timeline from a journey or alarm, then a summary where every sentence cites
   a timeline fact; hashed into custody and checked by `vigilone-verify`. Template first, model later. Alert-cutoff
   (A1) gives it the incident boundary.
3. **Alarm triage.** Rank open alarms and report false-alarm rate per camera; **propose** quieter rules, never
   apply them. Builds on A1.
4. **Footage integrity.** Per-device signing of segment hashes at ingest, C2PA-style manifests on exports, and
   classical camera-sabotage detection. C2PA library licence check first.

Parked, unchanged: privacy tools (Bucket 6), V1.0 act-on-events work, and the owner's field track (bench, clean-VM
drill, footage, licences, pilot site). None of the above changes a flag default or a shipping claim.

### Suggested sequence

A1 then B3 (shared incident unit), A2 in parallel (audit only), B2, B1, B4, then A3 and A4 as small follow-ups.
