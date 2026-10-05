# VigilOne action-plan status

Maintained by the coding agent at the end of every session. States: `NOT_STARTED`, `IN_PROGRESS`,
`DONE_VERIFIED` (verified by a real run, command and output below), `DONE_UNVERIFIED` (built, not
yet run where it matters), `BLOCKED_HUMAN` (needs hardware, a clean VM, data or a decision).
Nothing here says "passing" without the run that showed it. CI-generated test counts live in
`docs/generated/TEST_STATUS.md` (written only by `.github/workflows/status.yml`).

## Session 29 (2026-10-05): plain-language search (rules first, a local model for what they cannot read)

Branch `claude/amazing-hypatia-hkgolw`, from `master` after #43. Feature `NL_SEARCH` (default OFF), endpoint
`POST /api/v1/tracks/parse-query`, Find panel box "Ask in plain words". ai-adapter.v1.2 adds task `query_rewrite`
and `POST /v1/rewrite-text` (additive); SDK 0.3.0 adds `rewriteText`. Worker mode `query-rewrite` runs Qwen3-4B
(candidate, `PENDING_HUMAN_REVIEW`) on the pinned llama-server. No migration.

Local runs: backend `tsc` passes; backend full suite in band 159 suites, 1185 passed, 36 skipped, 2 failed (the
pinned feature-flag list and the one-reader-per-setting guard, which then got `NL_SEARCH` and the rewrite client
and pass, 49/49 on rerun); all six gates exit 0 (after the rewrite adapter's version string was tagged like the
others). Worker 32/33 suites, 323 passed, 2 skipped (RF-DETR, model not fetched), with the real Qwen3-4B; SDK 31/31,
`check-contract` and worker `check-sdk` pass; frontend `tsc` and build pass; browser test
`plain-language-search.spec.ts` 2/2.

| Item | Label | Evidence and limits |
| --- | --- | --- |
| Rules and word list | DONE_VERIFIED on labelled sets | `queryParser.test.ts` (11 tests, floors per set). English and Hinglish held-out set 28/30 on its first run (29/30 after the "last hour" fix); `dev` 39/40. Sets written by the coding agent; see `docs/ai/nl-search-evaluation.md`. |
| Rewrite model | DONE_VERIFIED on labelled sets | Devanagari set 0/20 with rules alone, 19/20 with the Qwen3-4B rewrite; median 2.4 s on CPU. `goldenQueryRewrite.test.ts` runs the real model (3 requests and a determinism check). The model needs the owner's licence approval to run in the product. |
| Endpoint | DONE_VERIFIED | `nlSearchRealDb.test.ts`: 501 with the flag off, 400 on a bad request, site time zone, another tenant's cameras never matched, only unreadable requests sent to the model with this tenant's names, original reading wins, fallback with the reason when the model fails or is not set up. |
| Find panel | DONE_VERIFIED in a browser | `plain-language-search.spec.ts`: the request fills the form and lists what was understood, removing a part changes the search, the unread notice without a model. |
| Real operators' requests | NOT_STARTED / BLOCKED_HUMAN | Needs the pilot: operators' own requests, scored the same way. |

## Session 28 (2026-10-04): threat detections without a new model (unattended bag, wrong way)

Branch `claude/amazing-hypatia-hkgolw`, from `master` after #42. Migration `20261013000000_threat_rules`
(`EventType.OBJECT_DETECTED`, `RuleTriggerType.UNATTENDED_OBJECT` and `WRONG_WAY`, `SpatialAnalyticsRule.paramsJson`).
events.v1.1 adds `ai.unattended_object` and `ai.wrong_way` (additive). Also carries the AI feature research
(`docs/strategy/vigilone-ai-features-landscape-2026-10-03.md`).

Local runs: backend `tsc` and build pass; backend full suite in band 157 suites, 1169 passed, 36 skipped, 2 failed
(the two pinned event-kind lists, `eventKinds.test.ts` and `events.v1.test.ts`, which then got the new kinds and pass);
all six gates exit 0. Worker 30/31 suites, 308 passed, 2 skipped
(RF-DETR, model not fetched), all real models present; SDK `check-contract` and worker `check-sdk` pass; frontend
`tsc` passes; browser test `threat-rules.spec.ts` passes, and the other 19 browser tests pass.

| Item | Label | Evidence and limits |
| --- | --- | --- |
| Bags tracked | DONE_VERIFIED on unit tests | The worker keeps COCO backpack, handbag and suitcase (were dropped) as `OBJECT_DETECTED`, one track group so a bag read as a backpack then a handbag stays one track (`decoders.test.ts`, `tracker.test.ts`). Bags never fire person or vehicle automation rules (`threatRulesRealDb.test.ts`; mapping a bag to the vehicle trigger again fails it). Detection quality of bags on site footage is not measured; COCO-trained weights still need the owner's licence decision. |
| Unattended bag rule | DONE_VERIFIED on synthetic tracks | `threatRules.test.ts` (15 tests with wrong way): alert after the threshold with nobody near, once; owner beside it keeps it quiet and the clock starts after a 3 s grace; a far person does not attend it; carrying restarts the clock, box jitter does not; outside the zone nothing; re-left after a move alerts again; owner radius honoured; memory bounded. `threatRulesRealDb.test.ts` through the internal endpoint: one incident, canonical event, alarm with provenance, events.v1 `ai.unattended_object`; owner beside it and a still person give nothing. |
| Wrong-way rule | DONE_VERIFIED on synthetic tracks | Against the arrow (more than 120 degrees) for the minimum travel alerts once per track; with the arrow, crossing at right angles, short jitter and leaving the zone do not; a U-turn is caught. Real DB: a car against the arrow gives one incident and alarm; a car with it and a person (not in the rule's classes) give nothing. |
| Rule API | DONE_VERIFIED | `POST /spatial-rules` validates every type (points 0..1, polygon 3–32 points, arrow points apart, thresholds and settings ranges) and refuses another tenant's camera (404, before: accepted) and a viewer (403). |
| Rule screen | DONE_VERIFIED in a browser | Rewritten: before, it loaded rules from a URL that does not exist, saved canvas pixels (no track could ever match) and sent the tripwire direction under the wrong name. Now four rule types, 0..1 coordinates, a zone and an arrow for wrong way, classes to watch. `threat-rules.spec.ts` checks what the backend stored. |
| Explanations and verifier | DONE_VERIFIED | Both renderers describe the two new kinds; `explanationTemplateParity.test.ts` covers them. |
| On real cameras | NOT_STARTED / BLOCKED_HUMAN | Needs the pilot: how often a left bag is caught and how often a still bag next to a seated person is wrongly flagged. |
| Person down, fence climbing | NOT_STARTED | Need a pose model (licence decision). |

## Session 27 (2026-10-03): the ai-worker on the adapter SDK

Branch `claude/amazing-hypatia-hkgolw`, from `master` after #41 (the track-path fix). ADR 0007 updated. No schema
change.

Local runs (all real models present, including SmolVLM2 with `llama-server` built from the pinned llama.cpp commit):
ai-worker `npm test` with `VIGILONE_REQUIRE_MODEL_TESTS=1`: 30/31 suites, 307 passed, 2 skipped (RF-DETR, model
not fetched); SDK 30/30 (with the real YOLOX-tiny); `check-sdk` and `check-contract` pass; backend `tsc` passes and
the AI suites that start the real worker pass (16 suites, 171 tests). All six gates exit 0.

| Item | Label | Evidence and limits |
| --- | --- | --- |
| SDK core and hooks (SDK 0.2.0) | DONE_VERIFIED | `core.test.ts`, 14 tests: VLM answers (wrong class, missing answer, answer to another task refused), `vlmQuery` rules, card and extra provenance components, liveness (FAILED then back to READY; one dead model of two is DEGRADED), a model serving two tasks, DEGRADED when busy and OVERLOADED with no queue, frames over 3840x2160, `run()` sharing slots and reporting once, another copy of `AdapterError` keeping its code, blank text. The earlier server tests and the YOLOX-tiny example pass unchanged. |
| Worker ships the SDK | DONE_VERIFIED | `services/ai-worker/src/sdk/` is generated by `npm run sync-sdk`; `npm run check-sdk` runs in CI before the worker build. `zod` added to the worker's dependencies. |
| Pipelines on the SDK core | DONE_VERIFIED | ANPR, redaction, embedding and VLM adapter tests and their golden real-model tests pass. Conformance kit 19/19 against the real worker in `adapter-only`, `anpr-adapter-only`, `redaction-adapter-only` and `embedding-adapter-only` modes (TEST-ONLY approvals, local run; CI still runs the kit against `adapter-only` only). One test changed: the embedding busy test used an all-zero vector, which the SDK now refuses; a new test pins that. |
| Object-detection core on the SDK | NOT_STARTED | Kept separate on purpose: its queue is shared with the camera stream pipeline (ADR 0007). |

## Session 26 (2026-10-02): North Star Bucket 7, housekeeping

Branch `claude/sharp-keller-tq0t8r`, from `master` after #38. Migration `20261012000000_camera_monitored_flag`.

Local runs: backend and frontend `tsc` pass; browser tests 19/19; all six gates exit 0. Backend full suite in band
(as CI runs it): 155 suites, 1152 passed, 29 skipped, 2 failed: `storageVolumeManager` (fails on `master` in this
sandbox, disk below 5% free) and `frontendStaticValidation`, which checked the old `operations.spec.ts` for its
flow titles; it now checks that the rewritten spec is wired into the Playwright run, and passes.

| Item | Label | Evidence and limits |
| --- | --- | --- |
| Orchestrator from the composition root | DONE_VERIFIED | `compositionEventSinks.test.ts`: the watchdog, scene detector and plate aggregator sinks reach the one orchestrator (removing one wiring line fails it); no service imports an orchestrator instance; a producer without a sink logs "no event sink wired". The bookmark adapter uses the shared catalog. |
| Camera liveness | DONE_VERIFIED | `isOnline` was always true. Now `monitored` (what the watchdogs select on) and online = stream seen by the watchdog within 90 s. Watchdog stamps a ready stream and not a dead one; the registry list follows the stamp on the real database; browser test: a never-seen camera is offline (putting back "always online" fails it). |
| One settings reader | DONE_VERIFIED | `RECORDINGS_DIR`, `EXPORTS_DIR`, `COTURN_*` only through `config/settings`; a test pins that `config/env.ts` does not declare them; the production TURN secret check still refuses defaults (`env.test.ts`). |
| Unused evidence services | DONE_VERIFIED | Deleted; their tests use `EvidenceArchive` and pass. |
| Operator browser tests | DONE_VERIFIED | `operations.spec.ts` 4/4 on the seeded tenant: wrong password, role menus, sign-out across a reload, camera liveness, alarm filter / acknowledge / resolve with verdict (checked through the API, viewer refused by the backend), storage figures. |
| README Smart search row | DONE_VERIFIED | Generated table regenerated; `check:feature-flag-docs` passes. |
| `main` branch | BLOCKED_HUMAN | Owner chose deletion; agent sessions cannot delete branches. Everything on it is on `master`. |
| ai-worker on the SDK server | NOT_STARTED | Owner moved it to its own piece of work (ADR 0007). Done in Session 27. |

## Session 25 (2026-10-02): North Star Bucket 4 finished, journey on the floor plan and journey to incident

Branch `claude/sharp-keller-tq0t8r`, from `master` after #37. Operations: `docs/operations/INVESTIGATION_WORKSPACE.md`.
No schema change.

Local runs: backend `tsc` passes; frontend build passes; browser tests 15/15. All six gates exit 0. Backend full
suite: see the PR.

| Item | Label | Evidence and limits |
| --- | --- | --- |
| Journey on the floor plan | DONE_VERIFIED | `journeyIncidentRealDb.test.ts`: steps numbered over the whole journey and drawn at their cameras' placements, other floors left out, a camera with no placement listed as unplaced (skipping it fails 2 tests); person journeys need the permission and a purpose. Browser test: Gate drawn, Yard listed as not on a floor plan; the person journey drawn at Gate and Lobby; leaving out the purpose fails the test. Drawn at the camera position, not the object's floor position (needs calibrated cameras). |
| Journey to incident | DONE_VERIFIED | An alarm on the first camera with the journey in its metadata (no plate text) and the sealed package; holds on every journey camera from 60 s before the first sighting to 120 s after the last (holding only one camera, or ending the window at the first sighting, each fail the test); the alarm sweeper pins the Yard segment inside the window and not the one outside, and marks the Gate hold failed because Gate recorded nothing. Bad bodies, a client-sent step list, another tenant's package and a viewer are refused with no alarm created. Browser test: incident opened from the screen with the package attached (dropping it fails the test), checked through the alarms API. |
| Use on real footage | NOT_STARTED / BLOCKED_HUMAN | Needs the pilot site. |

## Session 24 (2026-10-02): North Star Bucket 4, investigation workspace

Branch `claude/sharp-keller-tq0t8r`, from `master`. Operations: `docs/operations/INVESTIGATION_WORKSPACE.md`.
Frontend only, plus one backend bug fix found by the new browser test.

Local runs: frontend build passes; browser tests (`scripts/e2e/frontend-browser.sh`) 15/15, including the 3 new
ones. Backend full suite: only `storageVolumeManager` fails, which also fails on `master` in this sandbox (disk
below 5% free). All six gates exit 0.

| Item | Label | Evidence and limits |
| --- | --- | --- |
| Find panel: filters, description, photo, AND/NOT | DONE_VERIFIED in a browser | Filter search for cars returns the Gate and Yard tracks and no people, with the real crop picture loaded; a description search without an embedding adapter shows `QUERY_EMBEDDING_NOT_AVAILABLE`. |
| Open, follow, decide | DONE_VERIFIED in a browser | Follow by plate refused without a purpose (`PURPOSE_REQUIRED`), then suggests the Yard sighting, which is confirmed. Follow by appearance suggests two Lobby people; the look-alike is rejected and the backend no longer suggests it. Sending the purpose under the wrong header fails 2 tests. |
| Journey, play, seal | DONE_VERIFIED in a browser | Journey of 2 steps in time order, matching the backend; Play journey puts both cameras in the grid (breaking it fails the test); sealing makes one evidence manifest over both cameras, checked through the API. |
| Evidence manifest with a camera that has no recording | DONE_VERIFIED (bug fix) | A multi-camera package failed with a database error when one camera had no footage in the window (an old fallback call passed a camera id as a date). `manifestBuilderRealDb.test.ts` 2/2; both failed before the fix. |
| Journey on the floorplan, journey to incident | NOT_STARTED | Next part of the workspace. |
| Use on real footage | NOT_STARTED / BLOCKED_HUMAN | Needs the pilot site. |

## Session 23 (2026-10-02): North Star Bucket 3, cross-camera following

Branch `feat/cross-camera-follow`, from `master`. Design: ADR 0013. Operations: `docs/operations/CROSS_CAMERA_FOLLOW.md`.
New tables `CameraNeighbour` and `TrackLink` (migration `20261011000000_cross_camera_follow`).

Local runs: backend `tsc` passes; full suite with 2 workers 151 suites, 1129 passed, 10 failed, 29 skipped. The
failures: `cropEmbedderRealDb` and `semanticSearchRealModels` pass 24/24 when run alone (timeouts under load);
`storageVolumeManager` also fails on `master` in this sandbox (disk below 5% free). All six gates exit 0.

| Item | Label | Evidence and limits |
| --- | --- | --- |
| Camera neighbours | DONE_VERIFIED | `trackFollowRealDb.test.ts`: set by CAMERA_CONFIG only (operator 403), pairs stored once in id order, self-pairs, duplicates, unknown cameras and min > max refused (also by database CHECKs), audited. |
| Appearance candidates | DONE_VERIFIED on controlled embeddings | The same person on a neighbouring camera within the travel time and back on the same camera rank above another person; a non-neighbour camera, another site and a sighting too slow for the pair's travel time are left out (`outsideTravelTime` 1); a camera without neighbours falls back to its own site (`site-fallback`). Ignoring travel times, or widening the fallback beyond the site, fails the tests. |
| Plate candidates | DONE_VERIFIED on synthetic reads | Same plate on another camera two hours later; a read without a vehicle track listed separately; outside a 1-hour window nothing; plate text only with `includePlates` and the plate purpose. Works with semantic search off. |
| Decisions and journey | DONE_VERIFIED | Confirmed A-B and B-C give the journey A, B, C in time order from either end; a rejected look-alike is not suggested again (keeping it fails the test); PLATE links between different plates refused; person-to-vehicle and self links refused; server-side evidence (similarity, same plate, gap) and no plate text in the stored link (storing it fails the test). |
| Privacy and retention | DONE_VERIFIED | Person following needs CROP_PERSON_QUERY and a purpose, plate following PLATE_DATA_QUERY and a purpose; queries, decisions and journey views audited with the purpose; a link is deleted with either track. |
| Accuracy on real footage | NOT_STARTED / BLOCKED_HUMAN | How often the true next sighting is in the top 5 needs labelled cross-camera journeys from the pilot; travel times need the real site layout. |
| Screens | NOT_STARTED | Bucket 4 (investigation workspace). |

## Session 22 (2026-10-02): North Star Bucket 2, track search

Branch `feat/track-search`, built on `feat/track-index` (PR #30, since merged; `master` merged in). Design: ADR 0012. Operations:
`docs/operations/TRACK_SEARCH.md`. Route `POST /api/v1/tracks/search` (flags TRACK_INDEX and SEMANTIC_SEARCH).

Local runs: backend `tsc` passes; full suite with 2 workers 149 suites, 1106 passed, 3 failed, 29 skipped. The
failures are the two known ones: `vlmVerifierRealDb` 14/14 when run alone, and `storageVolumeManager`, which also
fails on `master` in this sandbox (disk below 5% free). Retrieval tool tests 16/16. All six gates exit 0.

| Item | Label | Evidence and limits |
| --- | --- | --- |
| One result per track, filters before ranking | DONE_VERIFIED on controlled embeddings | `trackSearchRealDb.test.ts` 10/10 on the real database: a white SUV seen three times is one result with `matchedCrops` 3; a camera filter finds its track with a candidate budget of one, which a filter applied after ranking could not; dwell and body colour filters. Removing the camera condition from the SQL fails the test. |
| AND and NOT terms | DONE_VERIFIED on controlled embeddings | "person" AND "backpack" ranks the person with a backpack first; "person" NOT "uniform" drops the track in uniform in every frame and keeps the one in uniform in one frame of three (1 frame set aside). Scoring AND by the best term instead of the weakest, or dropping a track on any one set-aside frame, each fail the tests. |
| Query by stored crop and by uploaded JPEG | DONE_VERIFIED | The query crop is never returned; a non-JPEG photo is refused; the photo's SHA-256 and size are audited and the picture is not. |
| Privacy | DONE_VERIFIED | Person tracks left out by default; `includePersons` needs the permission (operator 403) and a purpose (400 without); person-crop and clothing-colour queries must set it; persons and plates not together; audited as `TRACK_SEARCH_QUERY` / `TRACK_PERSON_SEARCH_QUERY` with the purpose. |
| Refusals | DONE_VERIFIED | Malformed queries, more than 4 AND terms, a model the adapter does not serve (409), an unknown crop (404), 501 without SEMANTIC_SEARCH or without an embedding adapter (a stored-crop query still works). |
| Recall@k tools in track mode | DONE_VERIFIED | `retrieval-tracks.test.mjs`: hand-computed recall@k and MRR, the query crop's own track removed before scoring, refusals, and the collector calling track search with filters and purpose. |
| Crop search refactor | DONE_VERIFIED | Its text embedder now comes from the shared `queryEmbedder.ts`; the crop search suites pass unchanged. |
| Search quality and speed on site data | NOT_STARTED / BLOCKED_HUMAN | Needs labelled queries from the pilot (recall@k) and the reference hardware (speed with hundreds of thousands of embedded crops). |
| Search screens | NOT_STARTED | Bucket 4 (investigation workspace) puts this on screen. |

## Session 21 (2026-10-02): North Star Bucket 5, measurement tools

Branch `feat/measurement-tools`, from `master` (independent of Bucket 1). Guide: `docs/operations/PILOT_MEASUREMENT.md`.
Flag `VIGILONE_FEATURE_INVESTIGATION_TIMING` (default OFF).

Local runs: backend `tsc` passes; full suite with 2 workers 147 suites, 1067 passed, 5 failed, 29 skipped. The
failures: `vlmVerifierRealDb` 14/14 when run alone (timeouts under load); `storageVolumeManager` fails on `master`
too, because this sandbox's disk is below the 5% free it needs. ai-worker 29 suites, 275 passed, 13 skipped.
Frontend builds; browser tests 7/7. All six gates exit 0.

| Item | Label | Evidence and limits |
| --- | --- | --- |
| ANPR benchmark: calibration, operating points, vehicle and plate type, verdict | DONE_VERIFIED on SYNTHETIC data | `plateEval.test.ts` 16/16, including hand-computed calibration error (0.45 on a constructed set), operating points at each threshold, groups under 30 frames flagged, and the verdict (NOT EVALUATED for SYNTHETIC data or under 300 plate frames). The compiled tool ran with the real pinned models on the six SYNTHETIC fixtures: 6/6 read, calibration error 14.3%, NOT EVALUATED. **Says nothing about Indian roads.** |
| Time-to-answer stopwatch, backend | DONE_VERIFIED | `investigationTimingRealDb.test.ts` 8/8 on the real database: server-clock times (a client-sent start time is refused), steps, first opened result kept on later ones, one running stopwatch per operator also under 5 concurrent starts (database partial unique index; without it the test fails), other operators' stopwatches 404, stale ones closed as ABANDONED, report median / p90 / share within 60 s / steps checked against hand-computed values, NOT EVALUATED under 30 answers, report needs AUDIT_VIEW and stays in the tenant, 501 with the flag off. Moving the first-result time on a later step fails the test. |
| Stopwatch on the Investigation page | DONE_VERIFIED in a browser | `investigation-stopwatch.spec.ts`: start with a question, a camera assigned to the grid is counted, Answered stops it, and the backend's current stopwatch and report agree. Removing the camera step makes it fail. |
| Pilot measurement guide | DONE | `PILOT_MEASUREMENT.md`: the four V0.1 measurements, their tools and minimums, breakdown values for the India benchmark, and a fair time-to-answer protocol (fixed questions with known answers, a baseline the old way). |
| Measurements on a real site | BLOCKED_HUMAN | Needs the pilot: labelled plate frames, labelled search queries, annotated detector frames, and operators timing real questions. |
| Found in passing | NOT_STARTED | The console's plate search calls `/search/anpr-plates`, which does not exist, and sends no purpose. Queued as a separate task. |

## Session 20 (2026-10-01): North Star Bucket 1, the track index

Branch `feat/track-index`, from `master`. Design: ADR 0011. Operations: `docs/operations/TRACK_INDEX.md`. Flag
`VIGILONE_FEATURE_TRACK_INDEX` (default OFF).

Local runs: backend `tsc` passes; full suite 148 suites, 1083 passed, 16 failed, 29 skipped. The failures were then
checked one by one: `featureFlags` expected the old flag list (updated, 27/27); `vlmVerifierRealDb` 14/14,
`leaderLeaseRealDb` 7/7 and `semanticSearchRealModels` 7/7 pass when run alone (timeouts under the full parallel
load on this 4-core sandbox); `storageVolumeManager` fails 1 test on `master` too, because this sandbox's disk is
below the 5% free it needs. ai-worker 30 suites, 290 passed, 13 skipped. Frontend builds; browser tests 6/6.
Hygiene, model-licence, fail-loud, feature-flag-docs, status-docs and dependency-licence gates exit 0.

| Item | Label | Evidence and limits |
| --- | --- | --- |
| `ObjectTrack` table and migration | DONE_VERIFIED | Migration `20261009000000_track_index` applied; `prisma migrate diff` against the schema is empty (apart from the HNSW index Prisma cannot express). |
| Track summary from detections | DONE_VERIFIED on synthetic detections | `trackIndexRealDb.test.ts` 13/13 through the real internal endpoint: class vote, first seen from the tracker, dwell, thinned ground-point path, direction, visits to INCLUSION zones only, colour votes (monochrome and malformed attributes add no names), best detection; tentative and duplicate detections ignored; nothing while the flag is off. Ten concurrent detections of one track give `observationCount` 10; without the row lock that test fails. |
| Plate read tied to the vehicle track | DONE_VERIFIED on synthetic reads | Same suite: the plate inside the car box in the nearest frame is tied both ways (`ObjectTrack.vehicleObservationId`, `VehicleObservation.trackId`); a plate outside every vehicle box and one 14 s later are not. Not run with the real ANPR pipeline and detector on one camera. |
| Colour names in the worker | DONE_VERIFIED on synthetic pictures | `colourAttributes.test.ts` 20/20: eleven colour names, a person's shirt and trousers and a car's body on a letterboxed 1920x1080 canvas, IR pictures reported as monochrome with no names, no name when no colour leads, a failure counted and the detection still sent. The first version judged a grey street with one coloured person as monochrome (found by the test, fixed). Accuracy on real cameras: NOT_STARTED, needs pilot footage. |
| API `/api/v1/tracks` | DONE_VERIFIED | Same suite: person tracks left out by default; `includePersons` needs `CROP_PERSON_QUERY` (operator 403) and a purpose (400 without); plate text needs `PLATE_DATA_QUERY` and a purpose; both together refused; audited as `TRACK_QUERY`, `TRACK_PERSON_QUERY` (with purpose) and `TRACK_PLATE_QUERY`; another tenant's track 404; 501 with the flag off. Removing the person exclusion fails 2 tests. |
| Retention | DONE_VERIFIED | Tracks last seen before `detectionSnapshotRetentionDays` are purged, held ones kept, counts in the purge result and the DPDP dialog. Ignoring holds fails the test. |
| Pure rules | DONE_VERIFIED | `trackMath.test.ts` 22/22: path waypoints and the 120-point bound over 2000 observations, eight directions and STATIONARY, zone visits across gaps, vote and colour thresholds. |
| Load at a real site's detection rate | NOT_STARTED | Three extra statements per confirmed detection; measure on the bench before enabling for many cameras. |

## Session 19 (2026-10-01): redaction console and DPDP settings (Antigravity commit 4482397, reviewed and fixed)

Branch `feat/redaction-console`, from `master`. It carries the Antigravity commit, which was pushed to `main`, 91
commits behind `master`, and fixes on top of it.

| Item | Label | Evidence and limits |
| --- | --- | --- |
| Redaction job creation | DONE_VERIFIED | Before: the modal sent `redactionMode` `BLUR`/`SOLID_BLACK`, which the backend rejects with 400, and the export id instead of the manifest id. Its source list also stayed empty because it was mounted before the list loaded. It now sends `FACE`/`LICENSE_PLATE` with the matching `detectKinds` and the manifest id. The invented blur choice is removed: masking is solid black only. Browser test: the job is stored QUEUED for the seeded manifest. A second test checks that the refusal for faces while face processing is off is shown. |
| DPDP settings save and purge report | DONE_VERIFIED | Before: the save sent `retentionDays` and `faceAcknowledgement`, which the strict schema rejects with 400, and the purge message read fields that do not exist, so it always said 0. It now sends `plateRetentionDays`, `detectionSnapshotRetentionDays` and `acknowledgeBiometricProcessing`. Browser tests: saved values persist and reload; the purge reports 1 deleted read, then 0. |
| Downloads | DONE_VERIFIED | Plain `<a href>` links got 401: the token is in memory, not a cookie. All three (MP4, package ZIP, evidence ZIP) now download through the authenticated client (`services/download.ts`). Browser test: the MP4 arrives byte for byte (SHA-256 checked), and a refused download is shown, not swallowed. |
| Evidence page crash | DONE_VERIFIED | Found by the browser tests. The rewritten packages table read `timeWindowStart`, `cameraName` and `cameraIp`, which do not exist. With any real evidence export, `toISOString` threw and the whole app went blank. It now uses `startTime`/`endTime`/`camera.name`, a date formatter that cannot throw, and shows non-COMPLETED status instead of a green tick. |
| Browser test setup | DONE_VERIFIED | The repository had never been able to run Playwright: no dependency, no config. Added `@playwright/test` 1.56.1 (pinned to the installed Chromium build), `playwright.config.ts`, `scripts/e2e/frontend-browser.sh` (scratch DB, seed, real backend, `vite preview`) and the CI job `frontend-browser-tests`. Six tests pass. Against Antigravity's original files the job, settings and purge tests fail. |
| Documents | DONE_VERIFIED | `GDPR_DPDP_COMPLIANCE_AUDIT_2026-10-01.md` was rewritten: every claim was checked against the code, eight false statements are listed and corrected, there are no "fully compliant" verdicts, and the self-assessment marker is added. `PHASE_5_PGVECTOR_SCHEMA_ARCHITECTURE.md` now describes the `CropEmbedding` schema that exists, not the unbuilt `VisualEmbedding` design. |
| `e2e/operations.spec.ts` | NOT_DONE | Flows 1 to 6 predate this work, log in as `admin`/`admin123` (no such user exists) and have never run; they are not wired into the config. Antigravity's flows 7 to 9 are removed, replaced by `redaction-dpdp.spec.ts`. |
| Code-splitting | DONE_VERIFIED | Antigravity's `React.lazy` routes and `manualChunks` are kept: the largest chunk is 202 kB (55 kB gzip), with no Vite size warning. `tsc`, the build and `check:no-demo` pass. |

## Session 18 (2026-10-01): architecture review, item 6 (one declaration of settings)

Branch `refactor/typed-settings`. ADR 0010 has the details.

| Item | Label | Evidence and limits |
| --- | --- | --- |
| `config/settings.ts` declares every non-boot setting | DONE_VERIFIED | `setting(NAME)` parses with limits, and a bad value is an error naming the variable. 50 direct `process.env` reads in 29 files now go through it. A guard test fails on any new direct read outside `config/`, two CLI scripts, a redaction listing and the self-checking subsystems. `settings.test.ts` 17/17; the guard was shown to catch a planted read. |
| NaN timers from bad intervals | DONE_VERIFIED | Measured on the old code: `DOOR_POLL_INTERVAL_MS=5s` gave about 180 timer ticks in 200 ms. The built `dist/server.js` now refuses to start with that value, or with `VIGILONE_AIR_GAPPED=yes`, naming both and exiting 1. With valid settings it booted, answered `/api/v1/health` 200 and shut down with exit 0. |
| Fail-loud gate | DONE_VERIFIED | The `NON_TEST_ENV_FALLBACK` pattern also recognises `setting('NODE_ENV')`, so the gate does not go blind. Four allowlist entries were updated to the new line text after re-review; the logic is unchanged. `check:no-fake-success` and `noFakeSuccessGate.test.ts` pass. |
| `RECORDINGS_DIR` / `EXPORTS_DIR` / `COTURN_*` single reader | NOT_DONE | These are still also loaded by `config/env.ts`, which about ten tests patch. Their live readers use `settingIfSet(...) ?? config.X`, and a test pins that both places declare the same defaults (ADR 0010). |
| Suites | DONE_VERIFIED | Backend 144/145 suites in the full run. The failing one was `noFakeSuccessGate`, fixed above and re-run alone (14/14). `tsc`, the build and the gates pass. |
## Session 17 (2026-10-01): architecture review, item 5 (camera registry)

Branch `refactor/camera-registry`. ADR 0009 has the details.

| Item | Label | Evidence and limits |
| --- | --- | --- |
| Cross-tenant writes on camera sub-resources fixed | DONE_VERIFIED | A real-database reproduction against the old `camera.routes.ts` showed an admin of another tenant getting HTTP 200 on six routes: zone update, zone delete, zone test, tour stop, tour delete and the diagnostic probe. The zone and the tour were really deleted. Through `CameraRegistry` every one of them is now 404 and nothing changes. Tour start and preset routes also check that the tour or preset belongs to the camera. `cameraRegistryRealDb.test.ts` 8/8. |
| Onboarding all or nothing | DONE_VERIFIED | When the media engine refuses the stream, the camera row is removed and the call fails with 502. Tested with the real database and an unreachable MediaMTX. A guessed RTSP URI is now returned and audited as a warning. |
| No invented diagnostics or presets | DONE_VERIFIED | `GET /:id/diagnostic` returns `diagnostic: null` without a measurement; the modal says "no measurement yet" instead of showing "OPTIMAL". A preset the camera refused is a 502, and no row is stored. Both are tested. Frontend `tsc`, build and `check:no-demo` pass. |
| `Camera.isOnline` misuse | NOT_DONE (finding) | The field is set at onboarding and never updated, and the watchdogs and scheduler select on it. It is kept as it is (see ADR 0009); a rename or a real liveness writer is separate work. |
| Suites | DONE_VERIFIED | Backend 145/145 suites, 1068 passed, 8 skipped (real PostgreSQL, simulated Modbus); `tsc` passes. |

## Session 16 (2026-10-01): architecture review, item 4 (composition root)

Branch `refactor/composition-root`, stacked on item 3. ADR 0008 has the details.

| Item | Label | Evidence and limits |
| --- | --- | --- |
| `composition.ts` builds the long-lived modules once | DONE_VERIFIED | It owns one `RecordingCatalog` (shared by evidence, playback and the alarm workflow), one `RelayAdapter` (the orchestrator's, shared by the relay and door routes) and every background worker that route files used to build. It also starts and stops them. `server.ts` keeps only the HTTP server, the HA lease and shutdown. Three test files that took instances from route files, or read `server.ts` source, now read `composition.ts`, with the same assertions. Backend 144/144 suites (the full run passed 142; the 2 retargeted files then passed alone). The built `dist/server.js` booted, answered `/api/v1/health` and shut down on SIGTERM. Gates exit 0. |
| Orchestrator instance built in the composition root | NOT_DONE | Four services import the `incidentOrchestrator` instance directly. Injecting it is the next step (ADR 0008). |

## Session 15 (2026-10-01): architecture review, item 3 (one ai-adapter.v1 seam on each side)

Branch `refactor/ai-adapter-seam`, stacked on item 2. ADR 0007 has the details.

| Item | Label | Evidence and limits |
| --- | --- | --- |
| Backend `AiAdapterClient` | DONE_VERIFIED | The embedding, redaction-region and VLM clients now share one connection: probe, registry check, call and provenance check. Each keeps its own error codes. The stub-based adapter tests pass unmodified: `cropEmbedderRealDb`, `vlmVerifierRealDb`, `redactionRealDb` and `evidencePackageVerifyRealDb`. `semanticSearchRealModels` 7/7 was run with the real SigLIP 2 models. Backend 144/144 suites, 1059 passed. `storageVolumeManager` first failed locally because the sandbox disk dropped below its 5% free floor during the model downloads; with space freed it passes 5/5. |
| Worker `PipelineAdapterCore` | DONE_VERIFIED | The ANPR, redaction, embedding and VLM adapters now share the contract rules: validation, busy limit, deadline, error results, health, descriptor and provenance. The worker suite was run with every real model: SigLIP 2, PP-OCR/CCT, YuNet, YOLOX, and SmolVLM2 on the pinned llama.cpp build. 281 passed, 2 skipped. |
| Worker on the SDK `createAdapter` server | NOT_DONE | The SDK lacks VLM answers, component provenance and a liveness hook, and the worker image does not ship the SDK. See ADR 0007, "Not done". Done in Session 27 (ADR 0007, "The worker on the SDK"). |

## Session 14 (2026-10-01): architecture review, item 2 (one table per event kind)

Branch `refactor/event-kind-registry`, stacked on item 1. ADR 0006 has the details.

| Item | Label | Evidence and limits |
| --- | --- | --- |
| Event-kind table `eventKinds.ts` | DONE_VERIFIED | Five hand-kept copies are replaced: the trigger mapping, the trigger-config match, the trigger-config schemas, the preview's inverse map, and the events.v1 type and payload mapping. The dry-run kind list is replaced too. All are now derived from one entry per kind. `eventKinds.test.ts` 5/5 pins that every kind has an entry, every `RuleTriggerType` is fed by exactly one kind, and the kind-to-trigger mapping is right. Behaviour is unchanged: the existing tests pass unmodified. Backend 144/144 suites, 1033 passed, 35 skipped (they need the S3, OIDC, SMTP and real-model test servers). `modbusRelayRealIo.test.ts` 22/22 was run separately against the simulated Modbus module, covering the door-event rules. Gates exit 0. |

## Session 13 (2026-10-01): architecture review, item 1 (retire the legacy rule engine)

Branch `refactor/retire-legacy-rule-engine`. This is the first of six items from the architecture review
(`improve-codebase-architecture`). The ADR 0004 follow-up has the details.

| Item | Label | Evidence and limits |
| --- | --- | --- |
| `POST /automation/dry-run` writes nothing | DONE_VERIFIED | Before: reproduced on the real database, the endpoint returned **HTTP 500** after writing a stray `RuleExecutionRecord`. Had the crash been fixed, it would also have set `lastTriggeredAt`, the field the live `RuleEngine` reads for cooldown. After: `automationDryRunRealDb.test.ts` 3/3. Matching rules are reported, including whether a real event would be held back by the cooldown. No execution record is written and `lastTriggeredAt` is untouched. |
| Legacy modules deleted | DONE_VERIFIED | `EventActionMatrixService` (251 lines), `AlarmService` (104 lines, unused, with a dead `EventRule` alarm path) and `GpioRelayService` (64-line pass-through) are gone. The relay routes use `RelayAdapter`. Their tests went too. The one behaviour not covered elsewhere, cross-tenant acknowledge refused, moved to `incidentOrchestrator.test.ts`. The relay handshake test now targets `RelayAdapter`. Backend 143/143 suites, 1028 passed; gates exit 0. |

## Session 12 (2026-09-30): live-deployment readiness

Branch `feat/live-deployment-readiness` (from `master` `96d1a13`, with Phases 5 to 8 merged). Runbook:
`docs/operations/GO_LIVE_RUNBOOK.md`.

Bugs found and fixed in the appliance tooling (`deploy/packaging/vigilonectl`), all of which would have
surfaced only at the worst moment:
* **`backup create`** reported "backup created successfully" when the database dump failed or was truncated,
  leaving an archive with no usable database. It now checks the dump's completion marker, writes a SHA-256
  manifest, and writes the archive under a temporary name that is renamed only when complete. It also includes
  the install's `.env`, which may hold the credential key.
* **`backup restore`** ignored SQL errors and reported success. It now checks the manifest, stops the backend,
  and loads the dump in one transaction, so a failed restore changes nothing. It warns when the backup's
  credential key differs from this machine's.
* **`backup restore` (anti-rollback step), `ota apply`, `ota rollback` and `ota status`** ran `npx ts-node`
  against `./src` inside the backend container. The production image has neither (compiled `dist/` only,
  without development dependencies), so they could never have worked. `ota apply` also passed a host path
  into the container. They now run the compiled code, and the bundle is copied in first.
* **The backup runbook** described a manifest, `.env` handling and container restarts that the code did not
  do. It now describes the code.

Local runs:
* backend: 1064 passed, 8 skipped (full suite below);
* `backup-restore.test.sh`: 25/25 against local PostgreSQL 16;
* `installer.test.sh`: 43/43;
* gates exit 0.

| Item | Label | Evidence and limits |
| --- | --- | --- |
| `vigilonectl golive` (go-live readiness: BLOCK / WARN / MANUAL / PASS, exit 1 when blocked) | DONE_VERIFIED | `goLiveCheck.test.ts` 18/18: each of 12 blocking rules alone, the warnings, the manual sign-offs, and the snapshot against the real database (a new continuous camera with no segment is caught; a missing recordings directory is reported, not guessed). Run locally against the development system: correctly NOT READY with 5 blocking items. |
| Backup and restore | DONE_VERIFIED against real PostgreSQL | `scripts/__tests__/backup-restore.test.sh` 25/25: round trip (rows, dropped tables, configuration, `.env`); failing dump; truncated dump; altered archive; SQL error half-way (rolled back, data unchanged); no manifest; credential-key mismatch warning. Removing the dump check fails 5. **Only the `docker compose` wrapper is simulated**: Docker Hub rate-limited image pulls here (HTTP 429), so no containerised run. |
| OTA commands and the restore anti-rollback step | DONE_UNVERIFIED on an appliance | The snippets run against the compiled backend locally. An update applied from inside the backend container has not been proven on a real appliance. |
| Go-live runbook | DONE (document) | Not yet used on a real site. |
| First real go-live | BLOCKED_HUMAN | Needs a site, hardware, the owner's model licence approvals and the DPDP sign-off. |

## Session 10 (2026-09-30): Phase 7, relays, door strikes and door contacts

Branch `feat/phase7-physical-security` (from `master` `46433ff`; Sessions 8 and 9 are on the Phase 5 Wave C and
Phase 6 branches). Operations: `docs/operations/PHYSICAL_ACCESS.md`. Everything is behind `DIO_RELAY` (OFF).
**Nothing here has run on real relays, strikes or door contacts.** The module used is SIMULATED
(`tools/sim/modbus_io_sim.py`, pymodbus 3.8.6).

Legacy bugs found and fixed: the relay adapter wrote `COMMAND_ACK` before any driver was called; `ACK_ONLY`
never called a driver at all; pulses were capped at 500 ms; no physical driver existed. Found by the new tests:
after a pulse the relay was counted as off as soon as the module acknowledged the off command, so a relay stuck
on was not reported as possibly energised (fixed). pymodbus answers a device failure with function code 0x80
(the spec says request | 0x80); the client now treats any reply with the high bit as an exception.

Local runs: backend **136/136 suites, 976 passed, 7 skipped** with the simulator required
(`VIGILONE_REQUIRE_MODBUS_SIM=1`); governance gates exit 0; frontend typecheck clean.

| Item | Label | Evidence and limits |
| --- | --- | --- |
| Modbus TCP client (FC 1, 2, 5) | DONE_VERIFIED against pymodbus | `modbusRelayRealIo.test.ts`: echo-checked coil writes, coil and input reads, exception, connection and timeout errors. Not tried against a real module. |
| Relay handshake (`COMMAND_SENT` → `COMMAND_ACK` on the module's echo → `STATE_CONFIRMED` on read-back) | DONE_VERIFIED against the simulator | Confirm on/off, active-low, stuck relay (acknowledged, never confirmed), failing module (never acknowledged), `ACK_ONLY` stops at ACK, full-length pulse, relay stuck on after a pulse says it may still be energised, no driver, disabled module. **Read-back is the module's register, not the physical contact.** |
| Doors, unlock API, audit | DONE_VERIFIED against the simulator | Module, pin and door configuration with validation, tenant isolation and roles; `POST /access/doors/:id/unlock` pulses the strike while the simulated door swings open, reads as `OPENED`, writes `DOOR_UNLOCK` audit entries (also for a failed unlock, which does not count as an unlock). |
| Door monitor (`OPENED`, `FORCED_OPEN`, `HELD_OPEN`, `CLOSED`, `DOOR_CONTACT_UNREADABLE`) | DONE_VERIFIED against the simulator | Forced vs authorised by unlock window, held open once, inverted contact, unreadable module goes UNKNOWN with one alert and no invented event on recovery, two monitors report one change under one event id; `DOOR_EVENT` rules and events.v1 mapping tested. |
| Existing tests changed | note | `incidentOrchestrator.test.ts` ACK_ONLY test relied on acknowledging without a driver; it now supplies one and checks it was called. One fail-loud allowlist entry for the removed pulse code was deleted. |
| Real hardware (module, strike, contact), card-reader doors, intrusion, POS, BMS, camera alarm-input binding, console page | NOT_STARTED / BLOCKED_HUMAN | Needs a bench module and a door. Unlocks outside VigilOne read as `FORCED_OPEN`; an access-control integration is not built. |

## Session 11 (2026-09-30): Phase 8, platform (SSO, high availability, adapter SDK, certification preparation)

Branch `feat/phase8-platform` (from `master` `50c6b0b`; Sessions 8 to 10 are on the Phase 5 Wave C, 6 and 7
branches). Operations: `docs/operations/SSO.md`, `HIGH_AVAILABILITY.md`, `CERTIFICATION_READINESS.md`;
SDK: `sdk/ai-adapter/README.md`.

Legacy bugs found and fixed in single sign-on:
* The client secret was stored in plain text in a column named `clientSecretEncrypted`, and the API returned it.
* The PKCE state lived in process memory.
* The callback was a 501 stub, so SSO had never worked.
* An unused helper mapped groups to SUPER_ADMIN without checking any signature. It is documented as unsafe;
  login does not use it.

Local runs:
* backend: **137/137 suites, 978 passed, 7 skipped**, with the OIDC provider required
  (`VIGILONE_REQUIRE_OIDC_SIM=1`);
* SDK: 16/16 with the real YOLOX-tiny model required;
* `scripts/e2e/ha-failover.sh`: PASS;
* governance gates exit 0 (the dependency-licence gate now also covers `tools/sim/oidc` and
  `sdk/ai-adapter`);
* frontend build clean.

| Item | Label | Evidence and limits |
| --- | --- | --- |
| OIDC single sign-on (code + PKCE, ID token verified, userinfo, account linking, one-time login code, login page) | DONE_VERIFIED against oidc-provider 9.12.2 | `ssoOidcRealIdp.test.ts` 18/18. Covers: the real provider driven like a browser; linking by verified email; replayed and tampered state; unverified email; unknown user; other tenant; disabled user; provisioning with role mapping and a domain allow-list; wrong client secret (invalid_client at the provider); secret never returned; disabled provider. Crafted tokens are rejected for wrong nonce, audience, issuer or key, for expiry, for HS256, for `alg: none`, and for several audiences without `azp`. **Not tried with Entra ID, Okta, Keycloak or Google.** |
| Backend high availability (leader lease) | DONE_VERIFIED on one machine | `leaderLeaseRealDb.test.ts` 7/7; removing the lease condition fails 5 of them. `scripts/e2e/ha-failover.sh` with two real processes: `kill -9` of the leader, takeover after 5.4 s with a 6 s lease; the restarted node comes back as a follower; graceful handover in 1.4 s. **PostgreSQL replication and recording failover are not built.** |
| AI adapter SDK (`sdk/ai-adapter`) | DONE_VERIFIED | Server guarantees with test doubles (11 tests, including the full conformance kit and a blocking-model deadline; removing that deadline guard fails its test). The YOLOX-tiny example matches the official YOLOX post-processing on 4 golden images and passes conformance. The contract copy is checked for drift in CI. **Private and unpublished: the repository has no licence (owner decision).** |
| SBOM (CycloneDX 1.5) | DONE_VERIFIED as a tool | `scripts/release/generate-sbom.mjs`: 257 npm packages, 8 AI models (SHA-256, licences, training data), 4 container images; uploaded by CI. |
| Certification | BLOCKED_HUMAN | `CERTIFICATION_READINESS.md`. Open questions for BIS (is an appliance a "recorder"?) and STQC (is VMS certification required?); ONVIF membership; penetration test; disclosure policy. No certification applied for. |

## Session 9 (2026-09-30): Phase 6, multi-site sync and off-site archive

Branch `feat/phase6-multisite` (from `master`; the Wave C VLM branch is separate). Operations:
`docs/operations/MULTI_SITE.md`. Flags `VIGILONE_FEATURE_FEDERATION` and
`VIGILONE_FEATURE_OBJECT_STORAGE_ARCHIVE` (both default OFF).

**Found and fixed in the existing code (verified by tests that fail when the fix is undone):** the sync
endpoint's EVENT stream wrote site events into headquarters' own DetectionEvent table under a camera id the site
chose, with no tenant check; AUDIT and ALARM streams advanced the cursor and stored nothing; any valid pairing
token could re-register another tenant's node id with a new key; the deprovision check read a field that does
not exist; pairing tokens were in memory only; the archive "uploaded" to an in-memory map, stored the bucket keys
in plain text, returned them from `GET /archive/config`, and its queue endpoint accepted any file path. No site
or bucket ever used this code.

Local runs: backend **138/138 suites, 981 passed, 8 skipped** (6 real-model search tests whose model files were
not in this run, the payload-hash check, and the long-standing skip) with `S3_TEST_ENDPOINT` pointing at a local moto server
that enforces signatures (as in CI); governance gates exit 0. `scripts/e2e/federation-scenario.sh`
PASS locally.

| Item | Label | Evidence and limits |
| --- | --- | --- |
| Record chain, site outbox and uplink, headquarters storage and views | DONE_VERIFIED on one machine | `federationSyncRealDb.test.ts` 11/11 (run twice): pairing (hashed single-use tokens, https-only, key file 0600), sync of events, alarm changes and audit entries in order, chain recomputed, headquarters tables untouched, cross-site alarm view, cut link (queue, backoff, catch-up), lost reply (no duplicate), altered record, unsigned and replayed requests, retired streams, deprovisioned node, takeover refused. Mutations: removing the chain check fails 1 test, removing the takeover guard fails 7. |
| Two-process scenario (two databases, relay cut, `kill -9` of the site) | DONE_VERIFIED locally; CI pending | `scripts/e2e/federation-scenario.sh`: link cut 15 s (nothing arrives, 17 records queued, 4 backoffs), restored (caught up in 5 s, acknowledgements applied), site killed mid-sync and restarted (35/35 alarms, no gap), 111 records recomputed at headquarters, contiguous from 1. **Loopback, not a WAN.** |
| S3 client (SigV4) | DONE_VERIFIED | `s3Client.test.ts`: signatures equal botocore 1.43.105 on 5 cases (path-style, virtual-hosted, metadata, unicode key, bucket). |
| Archive worker, encrypted credentials, queue by segment id | DONE_VERIFIED against moto (locally and in CI) | `archiveS3RealDb.test.ts` 7/7 against moto 5.1.0 started with signatures enforced (`tools/sim/moto_s3_with_auth.py`): pinned first outside the window, rest inside, bytes read back identical, duplicate recognised, changed file never uploaded, retries then FAILED, queue API refuses paths and other tenants, wrong secret refused (SignatureDoesNotMatch). **Not verified:** that a server refuses a body differing from its signed SHA-256 (moto does not check it; the test exists behind `S3_TEST_VERIFIES_PAYLOAD=1` for MinIO or AWS). CI first used MinIO, but `minio/minio` is no longer on Docker Hub, so CI uses moto. |
| Existing tests changed | note | `storeAndForwardSync.test.ts` tested the retired EVENT stream (the security bug) and now tests the new input rules; `federationAuth.test.ts` pairing tests use the database-backed tokens; `objectStorageArchive.test.ts`, `fakeSuccessHardening.test.ts` and `failLoudHardening.test.ts` asserted that the in-memory S3 stub refused; they now assert that no job completes without a store that confirmed it. Three fail-loud allowlist entries for the removed stub were deleted; one entry was added for the record chain's genesis hash (same role as the audit chain's). |
| Real WAN, customer bucket, live video across sites, config push to sites, console pages | NOT_STARTED / BLOCKED_HUMAN | A WAN and a bucket need a second site and credentials. The reverse video tunnel and config push are not built. |

## Session 8 (2026-09-30): Phase 5 Wave C, the alarm second opinion (local VLM)

Branch `feat/phase5-wave-c-vlm`. Operations: `docs/operations/VLM_VERIFICATION.md`. Flag
`VIGILONE_FEATURE_VLM_VERIFICATION` (default OFF). With this, every Phase 5 item is built; the Phase 5 exit
gate (retrieval recall on labelled site queries, VLM agreement with operators) still needs site data.

Pinned: SmolVLM2 2.2B Instruct GGUF Q4_K_M `0cf76814555b8665149075b74ab6b5c1d428ea1d3d01c1918c12012e8d7c9f58`
and Q8_0 projector `ae07ea1facd07dd3230c4483b63e8cda96c6944ad2481f33d531f79e892dd024` (ggml-org repository commit
`1bc3c9f74cea`; both equal the Hugging Face LFS SHA-256), llama.cpp tag `b11277` commit
`eae11d2217fe9225d1aaba48773b6cca45ae4de9`, built from source here.

Local runs: ai-worker **25 suites passed, 5 skipped (249 tests passed, 34 skipped)**, now run serially
(`--runInBand`) because the SigLIP 2 and VLM suites timed out loading when run side by side on 4 cores; the
skips are the ANPR and redaction suites whose files were not in the local models directory (CI requires them).
Backend **137/137 suites, 976 passed, 1 skipped** after the feature-flag list test was updated for the new flag.
Hygiene, model-licence, fail-loud, feature-flag-docs, status-docs and dependency-licence gates exit 0; the
frontend builds.

| Item | Label | Evidence and limits |
| --- | --- | --- |
| Model choice | DONE_VERIFIED on 8 questions | SmolVLM2 500M: 5/8, answering "yes" while its reason said "no"; rejected. 2.2B: 8/8. |
| Worker adapter (`vlm` mode, llama-server child process) | DONE_VERIFIED | `vlmAdapter.test.ts` 33/33 with a SIMULATED llama-server: approvals, file hashes, the server's reported build and model path, vision input, the exact prompt, schema and settings sent, refusals, malformed or truncated output (RUNTIME_ERROR, never an answer), backpressure, a dying server (FAILED health). `goldenVlm.test.ts` 12/12 with the real model and a llama-server built from the pinned commit: 8/8 answers, the same answer twice, refused without approval. |
| Contract v1.1 `vlm_verification` | DONE_VERIFIED | Backend schema, worker types, docs; `contracts/vlmAdapterConformance.test.ts` validates the real adapter core's messages and refuses a free-text prompt. |
| Backend worker, storage, API, agreement report | DONE_VERIFIED against a SIMULATED adapter | `vlmVerifierRealDb.test.ts` 14/14 on the real database: asks about the detected class with the snapshot (crop fallback, a tampered crop is never sent), stores hashes and provenance, **leaves the alarm row unchanged**, asks once per alarm and model, skips alarms with no recorded detection, image or supported class, and old ones; an unready, unregistered, wrong-model, wrong-class or failing adapter stores nothing; the database refuses bad answers and hashes; agreement counts and Wilson intervals checked by hand; API tenant isolation and permissions. Mutation check: removing the provenance or class check fails two tests. |
| Console | DONE_UNVERIFIED | The resolve dialog shows the advisory answer; the frontend builds; not tested in a browser. |
| Container image `Dockerfile.vlm`, compose `vlm-worker` (`--profile vlm`), CI | DONE_UNVERIFIED | `docker compose config` accepts it; no Docker daemon here. CI now builds llama-server from the pinned commit (cached) and runs the real-model VLM tests; that run is pending. |
| Speed and memory | measured once, build machine | 11 to 16 s for a new picture on 4 threads; about 3.0 GB peak RSS for llama-server. Not measured on reference hardware. |
| Licence approval for SmolVLM2 | BLOCKED_HUMAN | Candidate model (mixed training-data licences); refused in the product until approved. |
| Agreement with operators on real alarms | BLOCKED_HUMAN | Needs a pilot with operator verdicts; the endpoint reports it once there are 100. |

## Session 7 (2026-09-30): Phase 5, SigLIP 2 adapter and text search

Branch `feat/phase5-siglip2` (from `master` `00a1786`). The Hugging Face hosts (`huggingface.co` and
`us.aws.cdn.hf.co`) were allowed, so the item that was BLOCKED_HUMAN in Session 5 is built. Operations:
`docs/operations/SEMANTIC_SEARCH.md`.

**Licence approval (added after this section was first written, 30 Sept 2026):** the repository owner
approved both SigLIP 2 towers for product use and asked the coding agent to enter the approval. It is in
`scripts/models/model-license-exceptions.json`, names the owner and says the agent entered it. It is a
business decision, not a legal clearance: the training data (WebLI) is unpublished and has not been reviewed
by counsel. **Still not done:** retrieval quality on site footage (NOT MEASURED).

Pinned artefacts (SHA-256 computed from the files fetched here; `scripts/models/models.lock.json`):
vision tower `c0573e3f4140c3a7c4e9cc5912bd6b26a033b46a6a8e8af26cbea262b163bcad`, text tower
`baf12d941beabafafb14f7b4adb38dc15be18681b964a84410ec53d9d65e6293`, tokenizer
`cb9140fae3ac5122c972d37adf83e1248471a38147ad76f8215c8872c6fd8322` (identical to the official
`google/siglip2-base-patch16-224` tokenizer file). Source: `onnx-community/siglip2-base-patch16-224-ONNX`
at commit `ba1f3b0843f24bc5417d38e19c37b287d719b2f4`. Official checkpoint used as ground truth:
`google/siglip2-base-patch16-224` `model.safetensors` `612923381c76ec5a9bed335d1c48827e3f2e506ac31b044b63b2031fadee6a0b`
(repository revision `75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2`).

Local runs (Node 20, native PostgreSQL 16 with pgvector 0.6.0, the SigLIP 2 files present):
ai-worker **23 suites passed, 5 skipped (203 tests passed, 34 skipped)**, the skips being the ANPR and redaction suites whose model files were not in the models directory used for this run (CI fetches them and requires them); backend **135/135 suites, 959 passed, 1 skipped**; hygiene, model-licence, fail-loud, feature-flag-docs, status-docs and
dependency-licence gates exit 0. The one skipped backend test was already skipped in Session 5 (939 passed, 1 skipped).

| Item | Label | Evidence and limits |
| --- | --- | --- |
| Pillow-exact preprocessing (`embedding/preprocess.ts`) | DONE_VERIFIED | `embeddingPreprocess.test.ts` 7/7: the resized 224x224 bytes equal Pillow 12.3.0 `Image.resize(BILINEAR)` on five synthetic images (enlarging, identity, mixed, shrinking, strong shrink) by SHA-256. Synthetic images only. |
| Official-checkpoint reference (`tools/reference/siglip2_reference.py`) | DONE_VERIFIED | Ran with torch 2.14.0, transformers 5.17.0: the official processor equals PIL resize plus normalisation (max difference 0); the pinned ONNX towers equal the official PyTorch weights (5 images, 9 prompts): cosine at least 0.9999998, largest component difference 7.6e-6. Output committed in `fixtures/embedding/siglip2.reference.json`. |
| Tokenizer (`@huggingface/tokenizers` 0.2.0, Apache-2.0) | DONE_VERIFIED on 9 prompts | Token IDs equal the official tokenizer's for English, mixed Latin and Devanagari, accents, empty, upper case and an over-long input (truncation keeps the end token, padding 0 to 64). The ADR listed emoji as a case; **no emoji fixture was tested**. |
| Embedding pipeline, adapter core, boot mode, `POST /v1/embed-text` | DONE_VERIFIED | `goldenSiglip2.test.ts` 26/26 (25 before the approval was added) and `embeddingAdapter.test.ts` 24/24: the worker's own preprocessing, tokenizer and towers reproduce the official embeddings (cosine above 0.99999); refusals (wrong task, model, frame, blank or over-long text, wrong contract), runtime error, wrong-size vector, late answer, backpressure, FAILED health when unloaded; without an approval per tower it refuses (`LICENSE_REJECTED`), and an approval for another hash is refused. Approvals in tests are a TEST-ONLY temporary file, not a licence decision. |
| Contract v1.1 text request; backend conformance | DONE_VERIFIED | `contracts/embeddingAdapterConformance.test.ts`: the real adapter core validates against the zod schemas, and the adapter and schema agree on valid text lengths. Docs updated. |
| Text search `POST /api/v1/search/crops {text}` | DONE_VERIFIED against a stand-in adapter over HTTP, and with the real model | `cropSearchApiRealDb.test.ts` 17/17 (9 new): text embedded through the verified client, best match first, audited with the text; person text needs the permission and a purpose; other tenants never seen; blank, over-long and text-plus-crop refused before the adapter is called; 503 for an unreachable, erroring, wrong-model or unregistered adapter, 409 for a different requested model. |
| End to end with the real model | DONE_VERIFIED | `semanticSearchRealModels.test.ts` 7/7: real adapter over HTTP, crop embedder, pgvector, Express. Four public-domain pictures; the text queries "astronaut", "cat", "cup of coffee" and "man with a camera on a tripod" each return the right picture first; every crop gets one 768-dim vector under the pipeline SHA-256. **This proves the pipeline, not retrieval quality on site footage.** |
| Compose service `embedding-worker` (`--profile search`), CI | DONE_UNVERIFIED | `docker compose config` accepts it; no Docker daemon here, so it has not run in a container. CI now caches the 1.5 GB model files and runs the worker golden tests with the models required, and the end-to-end test in the `ai-e2e-scenario` job; those runs are pending. |
| Memory and speed | measured once, on the build machine | Loading both towers peaked at about 3.7 GB RSS and settled near 2.2 GB; about 0.33 s per crop and 0.11 s per text query (4 cores, one thread). Not measured on reference hardware, so the 4.5 GB compose limit is an estimate. |
| Licence entry for the towers | DONE (owner decision) | Entered at the owner's instruction on 30 Sept 2026; the licence gate lists both towers as approved, and `goldenSiglip2.test.ts` loads the pipeline through the product path with the repository's approvals file (and still refuses with an empty one). Not a legal clearance. |
| Retrieval quality on site data | BLOCKED_HUMAN | Needs labelled site queries (`docs/operations/RETRIEVAL_LABELLING.md`). |

## Session 6 (2026-09-30): DPDP record, retrieval collection tooling, person-search permission

Branch `feat/dpdp-record-and-retrieval-tools`. The product owner asked the agent to decide the open
items it could and to leave out real-hardware tests for now. Local runs: backend **133/133 suites,
939 passed, 1 skipped**; gates exit 0; `node --test tools/eval/__tests__/*.test.mjs
tools/vigilone-verify/*.test.mjs` 25/25.

| Item | Label | Evidence and limits |
| --- | --- | --- |
| DPDP lawful basis and retention for person crops and appearance search | **PROPOSED, BLOCKED_HUMAN for sign-off** | `docs/operations/DPDP_DECISION_RECORD.md`: recommended positions (off by default per site, written purpose and internal record, notice at the site, 14/7 day retention with a 30 day policy cap for people, embeddings die with their crop, administrators only, data stays local), the code that enforces each, the gaps, and five questions for counsel. The agent cannot make a legal determination; **no production site should enable person crops until a named person signs it.** No default in the code changed. |
| Gaps the record lists | NOT_STARTED | Erasure and access requests per person (no tool), a code cap on person-crop retention (the database allows up to 3650 days), site signage and notice text, crop-specific breach handling. |
| Person-appearance permission narrowed to administrators | DONE_VERIFIED | `CROP_PERSON_QUERY` had been granted to `OPERATOR` alongside plate lookup; it is now `SUPER_ADMIN` and `TENANT_ADMIN` only. `cropSearchApiRealDb.test.ts` gains operator refusals for person search and person images; restoring the permission to operators fails that test. |
| Retrieval collection tool `tools/eval/retrieval-collect.mjs` | DONE_VERIFIED as a tool | `retrieval-collect.test.mjs` 5/5 against a local stub of the API: one POST per labelled query, purpose headers and person flag only when asked, stops without writing a file if any query fails, is refused, is answered by a different model or is malformed; its output scores with `retrieval-eval.mjs`. Mutation check: removing the mixed-model refusal fails a test. Not run against a live appliance. |
| Labelling procedure and template | DONE_UNVERIFIED (documentation) | `docs/operations/RETRIEVAL_LABELLING.md` and `tools/eval/sample/retrieval-labels.example.json` (placeholder ids). |
| Labelled site queries and the retrieval numbers | BLOCKED_HUMAN | Needs real crops from a real site and people to label them; not something the agent can do. |
| The model approval line in `scripts/models/model-license-exceptions.json` | NOT_STARTED, waiting for the model | The file says the coding agent must never add entries. The product owner has now explicitly instructed the agent to add it, so it will be added when the model is pinned (it needs the exact SHA-256), recorded as entered by the agent at that instruction and not as a legal clearance. |
| SigLIP 2 files | BLOCKED_HUMAN | `huggingface.co` is reachable, but the large files redirect to `us.aws.cdn.hf.co`, which the environment's network policy still denies (checked 30 Sept). Add that host (or `*.cdn.hf.co`) under Network access. |
| Real-camera and clean-VM tests | Deferred by the product owner | Not started. |

## Session 5 (2026-09-29): Phase 5 Wave B (semantic search), partly blocked

Branch `feat/phase5-wave-b`, stacked on `feat/phase5-wave-a-wiring` (PR 6). Decisions:
`docs/adr/0005-phase5-search-and-explain.md`. Operations: `docs/operations/SEMANTIC_SEARCH.md`.
Flags: `VIGILONE_FEATURE_SEMANTIC_SEARCH` (default OFF), and crops need `VIGILONE_FEATURE_OBJECT_CROPS`.

**Blocked (superseded in Session 7: the hosts were allowed and the adapter is built): the SigLIP 2 model.** This environment's network policy denied `huggingface.co` (the proxy
answers 403 to CONNECT; `hf-mirror.com` and `modelscope.cn` are unreachable too; npm and PyPI work). So
the model weights, the tokenizer files and the Python reference token IDs cannot be fetched here, and I
will not invent hashes or expected IDs. To unblock (BLOCKED_HUMAN):

1. In the cloud environment's settings, allow Network access to `huggingface.co` (and the hosts it
   redirects to for large files, which the proxy log will name), or provide the files another way with
   their SHA-256.
2. Decide the exact variant. The database column is 768 dimensions, the SigLIP 2 base size; another
   size needs a migration.
3. Licence decisions per `docs/STATUS.md` list: SigLIP 2 code and weights are Apache-2.0 by the model
   card as I remember it (unverified here); the training data is a question for your legal call, as with
   COCO. An approved model needs an entry with its exact SHA-256 in `scripts/models/model-license-exceptions.json`.

Then remaining work: the image-tower adapter (`ai-adapter.v1.1`, task `embedding`), the pinned lock
entry, the text tower and `@huggingface/tokenizers` tests against reference IDs, and text search.

Local runs: backend **133/133 suites, 939 passed, 1 skipped** (was 130/130, 892 passed); the docs
hygiene, licence, fail-loud, feature-flag-docs and status-docs gates exit 0; verifier tests 12/12; eval
tests 8/8. The local database was a native PostgreSQL 16 with pgvector **0.6.0** from apt; CI and compose
use `pgvector/pgvector:0.8.0-pg16` (the tag exists on Docker Hub; the CI run is the first time the
migration and tests run on 0.8.0, and on the Debian image). Nothing here uses a feature newer than 0.6.

| Item | Label | Evidence and limits |
| --- | --- | --- |
| pgvector image in CI, compose and the DR drill; migration `20261003000000_phase5_crop_embeddings`; `CropEmbedding` | DONE_VERIFIED locally (pgvector 0.6.0); CI pending | Migration deploys to the local and a fresh database. `cropEmbeddingStoreRealDb.test.ts` 11/11: the database refuses a wrong vector size, a wrong recorded size and a bad model hash, and rows follow their crop. **The image change is not safe for an existing alpine volume** (glibc vs musl ordering); the ADR's earlier "data directory is compatible" claim was wrong and is corrected. `scripts/dr-drill.sh` uses the new image but was not run (no Docker daemon here). |
| Existing test changed: `migrationPhase2.test.ts` drift guard | note | Prisma has no syntax for the HNSW index, so the diff reports it as an index to drop. The guard now runs `--script` and allows exactly that one statement; any other difference still fails (checked by adding a bogus column: it fails). |
| Storing and searching (`cropEmbeddingStore.ts`) | DONE_VERIFIED on SYNTHETIC vectors | Only 768 finite non-zero components are stored, L2-normalised; the model must be a registered active `embedding` model (name, version, SHA-256); a repeat write keeps the first; search is per tenant and per model; person crops are excluded unless asked for; results equal a brute-force cosine ranking; filters work; a selective filter falls back to an exact scan and says `exact`. The HNSW index is shown to be the query plan (EXPLAIN) and its recall@10 against the exact answer is at least 0.9 on 300 synthetic vectors (a threshold, not a measured figure to quote). Mutation checks: removing the fallback, the tenant filter or the person exclusion each fails a test. **This says nothing about a real model.** |
| Adapter contract v1.1: optional `embedding` result | DONE_VERIFIED | Backend schema, worker type, docs, 71/71 contract tests including refusals; v1 results unchanged. |
| Embedder worker, adapter client, startup | DONE_VERIFIED against a SIMULATED stub adapter | `cropEmbedderRealDb.test.ts` 17/17 with a stub that validates every request against the contract: unexpired crops embedded, bytes verified first, missing and tampered files reported and not retried, a person crop embedded only while its site allows it (switching off stops it), an unreachable, not-ready or unregistered adapter stops the run, a wrong-size, wrong-model, NaN, zero or off-contract answer is refused, a repeatedly failing crop is set aside, overlapping runs do not both work, startup refuses a missing or bad URL or interval. Mutation checks: skipping the person re-check or the provenance check fails a test. Not run against a real adapter. |
| Search API `POST /api/v1/search/crops`, image endpoint, permission `CROP_PERSON_QUERY` | DONE_VERIFIED | `cropSearchApiRealDb.test.ts` 8/8 on the real Express app: 501 when off; the licence feature is required; query by crop or vector; tenant isolation; text query refused 501 `TEXT_QUERY_NOT_AVAILABLE`; bad input 400; person queries need the permission (viewers refused), a declared allowed purpose (and a reference where required) and are audited with it, and a person example must set `includePersons`; images are hash-checked (tampered: 500, removed: 404) and person images audited. Mutation checks: skipping the person gate or the image tenant check fails a test. |
| Retrieval scorer `tools/eval/retrieval-eval.mjs` | DONE_VERIFIED as a tool | `node --test tools/eval/__tests__/*.test.mjs` 8/8 against hand-computed values; refuses missing results, self-matches and duplicates; says NOT EVALUATED without `--real-site-data` and at least 100 queries. **Retrieval quality on site data: NOT MEASURED (BLOCKED_HUMAN: needs a model and labelled site queries).** |
| SigLIP 2 adapter, pinned hash and licence entry, tokenizer reference tests, text search | BLOCKED_HUMAN | See above. |
| CI on `feat/phase5-wave-b` | DONE_VERIFIED | PR run 36612020495 (head `d5ed487`): 9/9 jobs green, including the first clean migration deploy and full backend suite on `pgvector/pgvector:0.8.0-pg16` (Debian). The same head on `master` after the merge: CI run 36680569116 green. Wave B reached `master` through PR 8 (PR 7 was merged into the already-merged Wave A branch, so it did not). |
| Wave C (VLM sidecar) | NOT_STARTED | Unchanged. |

## Session 4 (2026-09-29): Phase 5 Wave A wiring

Branch `feat/phase5-wave-a-wiring`. Every new behaviour sits behind a flag that is OFF by default
(`VIGILONE_FEATURE_EXPLANATIONS`, `VIGILONE_FEATURE_OBJECT_CROPS`).

### Step 0: is main verified on CI?

The default branch is `master` (there is no `main`). The Wave A merge commit `44c4cdf` did get a
CI run: run 36596277782, all 9 jobs green, so the CI workflow is **DONE_VERIFIED for the merge**.
What was red is a different workflow, **Generated Test Status** (runs 36577651739 and 36596277728).
There is no CI job named "inferenceEngine"; that is the ai-worker suite file that failed inside the
status workflow.

| Job / workflow | Status | Cause | Fix |
| --- | --- | --- | --- |
| CI: all 9 jobs (frontend, backend, ai-worker, e2e, governance, field tooling, packaging, compose, secrets) on `44c4cdf` | green (run 36596277782) | n/a | none needed |
| Generated Test Status, step "Fail if any suite failed" | **DONE_VERIFIED on `master`** | Was red on every master push. Cause: `status.yml` never ran `npm ci` in `services/ai-worker` (no `onnxruntime-node`) and never fetched the pinned models, so 2 native-engine tests in `inferenceEngine.test.ts` failed and 34 golden-model tests were skipped. Fix (PR 5): mirror the `ci.yml` setup and set `VIGILONE_REQUIRE_MODEL_TESTS=1`. First green run on `master`: run 36680569142 on `6d711df` (backend 133/133 suites, 939/940 tests, 1 skipped; ai-worker 24/25 suites, 176/181 tests, 5 skipped; 0 failed). The two runs before it (36680131289, 36680176165) also ran both suites but were red at the bot's final `git push`, which was rejected "fetch first" because another PR merged into `master` during the ~3-minute run. That is a race in the workflow (it pushes without rebasing), not a test failure; it recurs whenever `master` moves mid-run. |

The earlier "2 ai-worker failures, output not captured" note (Phase 4, "Not verified") has the
same likely cause (a missing dependency or model after a heavy run), but that was not proven for
those local runs; it is proven for the status workflow.

### Step 1: Wave A wiring

Local baseline before any change: backend 123/123 suites, 837 passed, 1 skipped. After the last
Wave A commit: **128/128 suites, 868 passed, 1 skipped**; after the follow-up commit below: **130/130 suites, 892 passed, 1 skipped** (`cd backend && npx jest --runInBand`, real
PostgreSQL 16, real ffmpeg). The local database was a native PostgreSQL 16 service, not the
`postgres:16-alpine` container (there is no Docker daemon in this environment); CI uses the
container.

| Item | Label | Evidence and limits |
| --- | --- | --- |
| Prisma models `Explanation`, `ObjectCrop`, `SiteCropPolicy`; migration `20261002000000_phase5_explanations_crops` | DONE_VERIFIED | `prisma migrate deploy` on the local database and on a fresh database, then `prisma migrate diff` shows no drift; `migrationPhase5Wave.test.ts` 3/3 (hash, class, size, expiry and person-acknowledgement CHECKs, cascades). `SiteCropPolicy` is a third table beyond the two requested, needed for the per-site person gate. |
| Explanation service (`services/explanation/explanationService.ts`) | DONE_VERIFIED | `explanationWiringRealDb.test.ts` 7/7: facts from a real alarm, canonical event, rule, detection, model manifest and correlation chain; the stored record passes `verifyExplanationRecord`; a second call returns the stored record unchanged. Limits: the camera clock is always `UNKNOWN` (no clock verdict is persisted, and none is derived from the skew estimate); the only detection listed is the one named by the trigger's `inferenceId`; rule fields are read at generation time. |
| Non-blocking fail-loud hook in `AlarmLifecycle.elevateAlarm`, flag `EXPLANATIONS` default OFF | DONE_VERIFIED | Same suite. Flag off: nothing written. A facts failure leaves the alarm ACTIVE, logs, increments `vigilone_explanations_total{outcome="failed"}` and writes an `EXPLANATION_FAILED` audit row; a failing audit write is logged and counted too. Mutation check: making the hook rethrow fails 2 tests. Not exercised through the full orchestrator `TRIGGER_ALARM` action or on a live site. |
| `explanations.json` (role `EXPLANATIONS`) and the manifest `explanations` section in `evidenceArchive.service.ts` | DONE_VERIFIED | `explanationExportRealDb.test.ts` 5/5: a real export from a real ffmpeg segment passes `vigilone-verify --require-explanations` in a separate process (`explain.*` checks PASS); an edited record, and a stripped section re-signed with another key, are rejected; with the flag off and no records the verifier warns and `--require-explanations` fails; records are still included if the flag was switched off; a stored record that no longer matches its row fails the export. The Section 63 PDF does not mention explanations. |
| Crop capture on the detection path, flag `OBJECT_CROPS` default OFF | DONE_VERIFIED (real ffmpeg, real DB; **not on a live camera**) | `cropCaptureRealDb.test.ts` 14/14 through `DetectionIngestionService.ingest`: real ffmpeg cut (decoded 320x240 from a 640x480 snapshot), hash recorded, 14-day retention, per-site overrides, low or unknown free space fails loudly without stopping the detection, snapshot paths outside the allowed roots or behind a symlink are refused, a database failure removes the written file, and a JPEG attached by the worker is stored as-is (truncated or non-JPEG bytes are refused). Mutation check: opening the person gate fails the refusal test. See the follow-up section for the snapshot source. |
| Person crops behind the per-site policy gate | DONE_VERIFIED in the database, service and API | Off by default; a row enabling it without a recorded purpose and acknowledger is refused by a CHECK; set through the API in the follow-up section. The lawful basis and the retention defaults are still the open DPDP decision (BLOCKED_HUMAN). |
| Scheduled hold-aware crop purge (`CropPurger`, `purgeTenantCrops`) | DONE_VERIFIED for the purge logic and its scheduling | `cropPurgeRealDb.test.ts` 6/6 on real files: expired crops removed; incident-hold and legal-hold crops kept; other-camera and lapsed holds do not protect; if either hold lookup fails nothing is deleted and the failure is logged, counted and audited (`CROP_PURGE_FAILED`), and the next run succeeds; a missing file removes its row; an undeletable file keeps its row; pagination continues past 505 held rows. Mutation check: swallowing the lookup error fails the fail-closed test. Scheduling is covered in the follow-up section. The shared hold lookup moved to `privacy/holds.ts`; `dpdpRealDb.test.ts` is unchanged and passes. |
| One existing test file changed | note | `evidenceBindingChain.test.ts` builds Prisma by hand; it gained `explanation.findMany` (as Phase 4 did for provenance). No assertion changed. `featureFlags.test.ts` gained the two flag names in its expected list. |
| Docs hygiene, model-licence, fail-loud, feature-flag-docs and status-docs gates; `node --test tools/vigilone-verify/*.test.mjs` (12/12); `docker compose config -q` (base and prod override) | DONE_VERIFIED | All exit 0 before each commit and after the last. |
| CI on `feat/phase5-wave-a-wiring` | DONE_VERIFIED for head `6cf7cb7` | PR 6 run 36602102549: 9/9 jobs green, including Backend Typecheck, Migrations & Tests (clean migration deploy on `postgres:16-alpine`) and the AI end-to-end scenarios. Later commits on this branch are documentation only and get their own run. |
| Wave B and Wave C | NOT_STARTED | Unchanged. |

### Follow-up: end-to-end crop plumbing, policy API, scheduling tests

Requested after the Wave A wiring (items 5 to 7 of the next-actions list). Same branch. Local
runs: backend **130/130 suites, 892 passed, 1 skipped**; ai-worker (`VIGILONE_REQUIRE_MODEL_TESTS=1`,
models present) 24 suites passed and 1 skipped, 179 tests passed and 2 skipped (the skipped counts
differ from the earlier PR 5 run, 5 skipped, and I did not investigate why); docs hygiene,
licence, fail-loud, feature-flag-docs and status-docs gates exit 0; `docker compose config -q`
(base and prod override) OK; verifier `node --test` 12/12.

| Item | Label | Evidence and limits |
| --- | --- | --- |
| Snapshot source: the ai-worker attaches a JPEG crop (`AI_ATTACH_CROPS`, default off) and the backend stores it | DONE_VERIFIED for the code path; **not run against a live camera or the full compose stack** | Design: the worker holds only a letterboxed RGB canvas, so it cuts the detection's box out of it (mapped back through the frame geometry), encodes it with ffmpeg and sends only the crop; the full frame is never written or sent, which also avoids storing every person in every frame regardless of policy. `cropExtractor.test.ts` 3/3 (real ffmpeg: a coloured block at known source coordinates in a letterboxed canvas comes back as exactly that block, size and colour checked in the decoded JPEG; too-small boxes give null; an inconsistent frame throws). `workerCrops.test.ts` 3/3 on the real `AiWorker` (test-stub engine): off by default, a real JPEG on every CONFIRMED detection when on, and a crop failure is counted and logged while the detection is still submitted. Backend: the field `cropJpegBase64` (max 400 kB) is used only by the crop store, never persisted on the detection, and only decoded when `OBJECT_CROPS` is on. Limits: crop resolution is at most the model input (640-class), not the camera's native resolution; the AI end-to-end CI scenarios do not turn this on. |
| Per-site policy API `GET/PUT /api/v1/crop-policy/:siteId` (behind `OBJECT_CROPS`, 501 when off) | DONE_VERIFIED; **no UI** | `cropPolicyApiRealDb.test.ts` 6/6 on the real Express app: 501 when off; defaults (person crops off, 14/7 days) without creating a row; operators and viewers get 403; another tenant's or an unknown site gets the same 404; enabling needs a valid purpose (and a reference for law-enforcement and legal-claim purposes), bad input changes nothing; enable is audited with who and why and a real person crop is then stored; disable clears the acknowledgement, capture is refused again, and stored crops remain and are counted; retention overrides apply and `null` resets them. The console has no page for it (NOT_STARTED). |
| Purge scheduling (`startCropWorkers`, `CropPurger.start/stop`) | DONE_VERIFIED | `cropPurgeScheduling.test.ts` 12/12: flag off starts nothing; on starts once with the hourly default or `CROP_PURGE_INTERVAL_MS`; an invalid interval now stops startup loudly (before, `Number("abc")` would have become a 1 ms timer); on the real database the purger runs at start and on each tick, stops when told, and a slow run is never overlapped. Mutation checks: a `stop()` that does not stop, and removing the overlap guard, each fail their test. `server.ts` itself cannot be imported without listening, so its use of `startCropWorkers` is only checked statically. |
| Docs | DONE_VERIFIED | `docs/operations/DATA_PROTECTION.md` gains an "Object crops" section and no longer says VigilOne stores no face images without qualification (a person crop can contain a face). |

## Session 3 (2026-09-29): Phase 5 Wave A (explain and crop store), in progress

Branch `feat/phase5-explain-crops`. Decisions are in `docs/adr/0005-phase5-search-and-explain.md`.

| Item | Label | Evidence |
| --- | --- | --- |
| ADR 0005 (order, VLM sidecar, TS tokenizer, person-crop default) | DONE_VERIFIED | Document written; docs hygiene gate exits 0. |
| Explanation record, template and hashes (`backend/src/services/explanation/`) | DONE_VERIFIED | `npx jest src/__tests__/explanation.test.ts` passes, including 8 tamper cases. |
| Offline verifier checks for `explanations.json` | DONE_VERIFIED | `node --test tools/vigilone-verify/*.test.mjs` passes; the tests caught and fixed a WARN/PASS bug in the missing-section check. |
| Backend and verifier renderers agree | DONE_VERIFIED | Seeded 500-case fuzz plus a mutation check in `explanationTemplateParity.test.ts`. |
| Crop store (safe paths, atomic write, free-space floor, person gate, hold-aware purge) | DONE_VERIFIED | `npx jest src/__tests__/cropStore.test.ts` passes on a real temp directory. |
| Explanation persistence (Prisma model, migration), alarm-time hook, archive writes `explanations.json` and the manifest section, crop capture from the detection path | Superseded | Built and tested in Session 4 below. |
| Wave B (pgvector, SigLIP 2 adapter, tokenizer reference tests, search) and Wave C (VLM sidecar) | NOT_STARTED | See the ADR. |
| Full backend suite and CI on this branch | DONE_VERIFIED (later) | It merged before this session could run either. CI then ran: PR run 36595729357 and the master push run 36596277782 (merge commit `44c4cdf`), 9/9 jobs green. See Session 4, Step 0. |

## Session 2, continued (2026-09-27/28): Phase 4, India ANPR and privacy

Same branch (`claude/gracious-galileo-vtpuvp`), so Phase 4 extends the open PR for Phases 2–3
rather than opening a new one. I was not permitted to push to another branch; split the PR if
preferred. The environment is as below, plus candidate models fetched from PyPI and GitHub
(Hugging Face is blocked here) and a TensorFlow CPU venv for the fine-tune smoke run.

### Final verification run (after the last code commit, `8ce7964`)

| Command (from repo root) | Result |
| --- | --- |
| `cd backend && npx tsc --noEmit && npx jest` (real Postgres, ffmpeg, python3) | **120/120 suites, 808/808 tests** |
| `cd services/ai-worker && npm run build && npx jest` (candidate models present) | first run after the backend run: 173/175, 2 failures, output not captured (see "Not verified"); then **23/23 suites, 175/175** in 7 further runs, including 2 parallel runs under contention |
| redaction adapter (`AI_WORKER_MODE=redaction-adapter-only`, TEST-ONLY approvals) + `npm run conformance:ai-adapter` | **19/19** (`docs/ai/e2e-results/2026-09-27_p4.4_redaction-adapter_conformance.json`) |
| `MEDIAMTX_BIN=/tmp/mtx/mediamtx scripts/e2e/anpr-lpr-scenario.sh` | **PASS**: MH12AB1234 read exactly, known-plate alarm with provenance, recording continued after the worker was killed (`2026-09-28_p4-final_anpr_*.json`) |
| `scripts/e2e/redaction-scenario.sh` (real YuNet + PP-OCRv4) | **PASS**: `sha256sum` of the downloaded derivative equals the recorded hash; faces and plates opaque in the decoded pixels; custody links master to derivative; masters unchanged (`2026-09-28_p4-final_redaction_*.json`) |
| `cd frontend && npm run build && npm run check:no-demo` | build exit 0; bundle clean |
| `check:model-licenses / check:no-fake-success / check:dependency-licenses / check:hygiene / check:feature-flag-docs` | all exit 0 (the feature-flag README table was regenerated) |
| `node --test tools/eval/__tests__/*.test.mjs`; `node --test scripts/lib/*.test.mjs scripts/soak/*.test.mjs` | 3/3; 11/11 |
| `docker compose config -q` (default, `--profile anpr --profile privacy`) | exit 0 |

## Phase 4: India ANPR and privacy

| Task | State | Commit | Verification |
| --- | --- | --- | --- |
| P4.1 ANPR adapter, LPR mode, known-plate lists | DONE_VERIFIED on SYNTHETIC plates; site accuracy BLOCKED_HUMAN | `3b4faa0`, `da3a7ab` | The TypeScript pipeline equals the Python reference (RapidOCR DB post-processing + fast-plate-ocr) on 6 SYNTHETIC plates, and mutations fail it. `anprAdapter.test.ts` 6/6, `anprRealDb.test.ts` 7/7, conformance 19/19, e2e PASS. `/anpr/detect` exists only with NODE_ENV=test and VIGILONE_ANPR_TEST_ENDPOINT=true. Weight licences are pinned; the training data needs a human decision (below). |
| P4.2 Indian formats | DONE_VERIFIED | `3b4faa0` | `indianPlate.test.ts` 25/25: STANDARD for all state/UT codes incl. TG, BH, diplomatic, Delhi category letter, district 0 refused, series never I/O; two-line plates with per-line reading; the fixtures are licence-clean SYNTHETIC renders |
| P4.3 Data and fine-tune | Tools DONE_VERIFIED; accuracy **BLOCKED_HUMAN** | `9854cc4` | `evalPlates` (Wilson CI, misread/no-read/false-read, CER, leakage refusal) 11/11 tests. The fine-tune flow (prepare → verified base weights → train → uint8 NHWC ONNX → eval) ran end to end on 300 SYNTHETIC plates: baseline 80.0% (68–88%), 2-epoch fine-tune 88.3% (78–94%), overlapping intervals. **This says nothing about Indian roads.** |
| P4.4 Real redaction | DONE_VERIFIED (SIMULATED recording, real detectors); recall on site footage NOT MEASURED | `98bbc1c` | YuNet port equals OpenCV FaceDetectorYN, and mutations fail it. `redactionRealDb.test.ts` 7/7 (real ffmpeg: masks verified in decoded pixels; a job with no output file fails; masks ignored → REDACTION_MASK_NOT_APPLIED; detector down/unregistered, altered source → fail closed; the DB refuses COMPLETED without a hash). e2e with real models PASS. |
| P4.5 AI provenance, derivatives, `vigilone-verify` | DONE_VERIFIED | `8c0a483` | `evidencePackageVerifyRealDb.test.ts` 3/3: a real export with ai_provenance.json and a redacted-derivative package both verify with the standalone CLI (separate process). Tampering is rejected: media byte, AI record, re-signed manifest, custody metadata, extra file, wrong parent. |
| P4.6 DPDP controls | DONE_VERIFIED | `8ce7964` | `dpdpRealDb.test.ts` 7/7: purpose required and audited (who/why/filters/count); viewers refused; a disallowed purpose is refused; face switch off by default, needs acknowledgement, and gates face redaction and camera face analytics; the purge deletes expired reads and snapshot files and keeps held ones and files outside the roots. `migrationPhase4Dpdp.test.ts`. |

**Acceptance (plan).**

* "A redaction job produces a real file whose hash verifies": **met** (e2e, `sha256sum`).
* "The verifier CLI validates a package including AI provenance": **met**.
* "ANPR measured on human-supplied site data": **not met**, because it needs site data
  (HUMAN-REQUIRED). The harness is ready; see `docs/ai/ANPR_EVALUATION.md`.

### Defects found and fixed in Phase 4

1. **Custody chain verification failed for most real events.** Payload hashes used
   `JSON.stringify(metadata)` in insertion order, and PostgreSQL JSONB reorders keys, so
   `verifyChain` reported "tamper detected" on genuine events. Hashes are now canonical, and a
   legacy fallback verifies old rows whose order happened to survive. Shown with a real-DB
   reproduction before the fix. `8c0a483`
2. **Exports could invent a segment hash.** A segment without a recorded hash got a synthetic
   "UNFINALIZED" leaf, and segments missing from disk were still listed in the manifest. Exports
   now hash the bytes and refuse missing or altered segments. `8c0a483`
3. **Hard-coded tool and runtime strings.** Export manifests recorded a fixed `ffmpeg-v6.1`, and
   ANPR provenance recorded `onnxruntime@1.30.0` regardless of what ran. Both now record the real
   version. `8c0a483`, `98bbc1c`
4. **Fake redaction success.** `executeRedactionJob` never ran ffmpeg: it hashed whatever file
   was at the output path. `modelVersion` defaulted to "1.0.0". `98bbc1c`
5. **Redaction route gaps.** Jobs could reference another tenant's manifest, and `/jobs/:id/execute`
   had no tenant check. `98bbc1c`
6. **Viewers could read plate data**, and plate lists and plate search were not audited. `8ce7964`
7. **ANPR console showed invented numbers.** It displayed 15 FPS and 24 ms latency when no data
   existed; it now shows recorded facts only. `da3a7ab`
8. **E2E cleanup.** The scripts killed the subshell and left `node` running, which is how a stale
   backend answered a later run. They now `exec` node. `98bbc1c`
9. **Found by new tests or tools before commit:**
   * a NULL-unsafe CHECK constraint that let COMPLETED jobs without output through;
   * a backpressure race in the redaction adapter (caught by the conformance burst);
   * a wrong descriptor path in my own client, which my stub test mirrored and only the real-model
     e2e exposed.

### Not verified (and why)

- **No Indian site footage.** No plate or redaction accuracy number exists for real conditions:
  night IR, rain, motion blur, dirty or non-standard plates, profile faces.
- **Docker images** were not built (apt 403). The CI jobs added for Phase 4 have not run in GitHub
  Actions yet: redaction e2e, YuNet fetch, verifier syntax.
- **UI changes** (ANPR console purpose selector, LPR toggles) were verified by type-check and
  build only, not in a browser. There is no UI yet for redaction jobs or DPDP settings (BACKLOG).
- **Candidate models ran only under TEST-ONLY approval files.** Production runs refuse them until
  a person approves.
- **Unexplained test failures, output not captured:**
  * one backend parallel run had 1 failure in `anprRealDb` (session 2, not reproduced in 6 runs);
  * the ai-worker suite twice had 2 failures on the first run after heavy work (not reproduced in
    11 runs).
  Recorded in BACKLOG; not dismissed as flakes.

### Licence questions (Phase 4, added to the list below)

4. **YuNet** (MIT) was trained on WIDER FACE, whose terms forbid commercial use of derived data.
   The plan names YuNet for redaction. This needs a legal decision before approval.
5. **fast-plate-ocr global model** (MIT): the training data is unpublished and India is not a
   listed region.
6. **PP-OCRv4 detection** (Apache-2.0): its training datasets are not fully published.
7. Test and training tools only, never shipped:
   * Pillow (HPND) and the DejaVu fonts (Bitstream Vera) are used for SYNTHETIC fixtures;
   * matplotlib (Matplotlib licence) and tqdm (MPL-2.0 AND MIT) are pulled in by the fine-tune
     stack.
   None of these is on the allowlist.
8. The NASA astronaut portrait (public domain, via scikit-image) is the only real face in the
   fixtures. Confirm that is acceptable as a test asset.

### What I need from the human (Phase 4)

1. **Licence decisions** (4–8 above). For each model you approve, add an entry with its exact
   SHA-256 to `scripts/models/model-license-exceptions.json`. The files are pinned in
   `models.lock.json`.
2. **ANPR data** (P4.3): labelled frames from each LPR camera, following the layout in
   `docs/ai/ANPR_EVALUATION.md`. Include day, night-IR and two-line plates, and hold out whole
   days for the test split.
3. **Redaction review:** a few real clips from a site, to judge face and plate recall before
   releasing any derivative.
4. **DPDP:** decide the allowed purposes and retention periods per deployment, and whether face
   processing (even for redaction) has a lawful basis at each site.

---

## Session 2 (2026-09-27): Phase 2 and Phase 3

Branch `claude/gracious-galileo-vtpuvp`, stacked on `claude/admiring-wozniak-k4dzqm` (session 1,
not yet merged). Environment: Node 22.22, PostgreSQL 16, ffmpeg 6.1.1, MediaMTX 1.9.3 and MailHog
1.0.1 binaries (downloaded for tests, not committed), Python 3 venvs for reference
implementations (onnxruntime, OpenCV, supervision 0.30.5, pycocotools; RF-DETR export). No GPU, no
cameras. Docker image builds still fail here (apt mirrors return 403 inside build containers).

### Final verification run (after the last code commit, `dddc58e`)

| Command (from repo root) | Result |
| --- | --- |
| `cd backend && npm run build` | exit 0 |
| `cd backend && MAILHOG_BIN=... VIGILONE_REQUIRE_MAILHOG=1 npm test` (real Postgres, ffmpeg, openssl, MailHog) | run 1: 110/111 suites, 750/751 tests (1 failure in `disasterRecoveryDrill`, see "Not verified"); run 2: **111/111 suites, 751/751 tests passed** |
| `cd services/ai-worker && npm run build && VIGILONE_REQUIRE_MODEL_TESTS=1 npm test` | build exit 0; **18/18 suites, 141/141 tests** (golden YOLOX nano/tiny and the RF-DETR Nano export present) |
| worker `AI_WORKER_MODE=adapter-only AI_MODEL_KEY=yolox-tiny` + `npm run conformance:ai-adapter -- --url http://127.0.0.1:7010` | "ai-adapter.v1 conformance: 19/19 checks passed" |
| `MEDIAMTX_BIN=/tmp/mtx/mediamtx scripts/e2e/ai-tripwire-scenario.sh` | **PASS**, frame-to-alarm 74 ms (budget 5 000), all 9 checks true; report `docs/ai/e2e-results/2026-09-27_phase3-regression_SIMULATED-CAMERA.json` |
| `node --test tools/eval/__tests__/*.test.mjs` | 3/3 (COCO metrics equal pycocotools to 1e-6 on the committed fixtures) |
| `node --test scripts/lib/*.test.mjs scripts/soak/*.test.mjs` | 11/11 |
| `cd frontend && npm run build && npm run check:no-demo` | build exit 0; "Production bundle clean: 3 files scanned, 15 demo strings absent" |
| `cd backend && npm run check:hygiene / check:model-licenses / check:no-fake-success / check:feature-flag-docs / check:dependency-licenses` | all exit 0 ("No un-allowlisted fake-success patterns"; "Dependency licence gate passed") |
| `cd backend && npm run check:status-docs` | "No CI-generated test status yet (PENDING_FIRST_CI_RUN)" |
| `cd backend && npx ts-node src/scripts/auditSecrets.ts` | "All security hygiene checks passed" |
| `bash scripts/__tests__/installer.test.sh` | "All packaging and installer tests passed successfully." |
| `docker compose config -q` (dev and prod overlays) | exit 0 |

## Phase 2: Real AI

| Task | State | Commit | Verification |
| --- | --- | --- | --- |
| P2.1 AI adapter contract | DONE_VERIFIED | `77dd192` | Conformance kit 19/19 against the real worker (above); `adapterHttp.test.ts`, backend `contracts/aiAdapterConformance.test.ts`. OVERLOADED -> 429 + Retry-After; DEADLINE_EXCEEDED -> 504 (ORT runs synchronously, so late results are discarded; worker_thread in BACKLOG). |
| P2.2 Worker container + compose `ai` profile | DONE_UNVERIFIED | `e2b2179` | Worker runs from `dist/main.js` in the e2e scenario; `docker compose config -q` exit 0. The image itself was **not built** (apt 403 in the sandbox). |
| P2.3 Pinned models | DONE_VERIFIED | `35ddf2d` | `scripts/models/models.lock.json` with real SHA-256 of the YOLOX release files; `fetch-model.sh` verifies them; RF-DETR Nano exported for real with `export-rfdetr.sh` (sha `f744e454...`). Licence gate reads the lock file. |
| P2.4 Decoders + preprocessing | DONE_VERIFIED | `4182849`, `694bdf4` | Golden tests equal the official YOLOX Python postprocess (`tools/reference/yolox_reference.py`) and upstream RF-DETR decoding; a mutation (dropping the BGR swap) fails them. |
| P2.5 Motion gating | DONE_VERIFIED | `77dd192` | `motionGate.test.ts`; `streamSupervisor.test.ts` (queue-only pump, one inference per frame). |
| P2.6 Provenance + audit | DONE_VERIFIED | `4d6a2c3`, `842a638` | `aiPipelineRealDb.test.ts` (21 tests, real DB): detections without valid provenance refused; model deploy/rollback audited in every tenant chain; chains re-verify (`auditChainRealDb.test.ts`, regression that fails on the old code). |
| P2.7 Tracker validation | DONE_VERIFIED | `0bb083e` | `docs/ai/TRACKER_VALIDATION.md`: identity metrics equal supervision ByteTrack; ground-truth tripwire crossings exact (LineZone reports 24 spurious crossings on the same data). |
| P2.8 Evaluation harness + model cards | DONE_VERIFIED (harness); model accuracy NOT EVALUATED | `0bb083e` | `tools/eval/coco-eval.mjs` equals pycocotools; model cards say NOT EVALUATED on site data (no annotated site footage). UI shows the experimental banner and provenance badge. |
| P2.9 End-to-end scenario | DONE_VERIFIED on a SIMULATED camera | `a1e6fda` | PASS (61-83 ms in session runs, 74 ms in the final run); worker SIGKILL does not stop recording. |
| P2.10 Real-site validation | BLOCKED_HUMAN | n/a | Needs cameras, footage and annotations from a pilot site. |

## Phase 3: Events, notifications, incident workflow

| Task | State | Commit | Verification |
| --- | --- | --- | --- |
| Phase 3 migration | DONE_VERIFIED | `78274fb` | `migrationPhase3.test.ts` 7/7 on the real DB (CHECK constraints, uniqueness, cascades); drift test (`migrationPhase2.test.ts`) confirms migrations == schema. |
| P3.1 ONVIF PullPoint, Profile M, clock check | DONE_VERIFIED against test doubles; physical cameras BLOCKED_HUMAN | `0b90922`, `2118afe` | `cameraEventParsers.test.ts` 24/24 (RFC 7616 digest vectors, WS-Security vector from Python hashlib, fixtures), `cameraEventsIntegration.test.ts` 8/8 (ONVIF stub with a camera clock 5 s ahead enforcing the token window). Mutations caught: removing the skew correction, removing the transition filter. |
| P3.2 Hikvision ISAPI, Dahua | DONE_VERIFIED against test doubles; physical cameras BLOCKED_HUMAN | `0b90922` | Digest-authenticated multipart stubs; manager on the real DB -> one CAMERA_ANALYTIC start and stop -> rule fired once; bad credentials -> FAILED, no retries until changed. Flag off -> 501. |
| P3.3 Notifications | DONE_VERIFIED locally; real providers NOT VERIFIED | `78274fb` | `smtpClient.test.ts` 10/10 (STARTTLS with an openssl cert, MailHog interop), `notificationDeliveryRealDb.test.ts` 9/9 (secrets encrypted and redacted, SMTP receipt, WhatsApp test double, signed receipts, dead letter + retry, air-gapped block, audit chain verifies). |
| P3.4 Incident workflow | DONE_VERIFIED | `40a24e9` | `alarmWorkflowRealDb.test.ts` 8/8 with real ffmpeg segments: assignment, SLA stamping/breach, escalation once per step and stopped by acknowledge, INCIDENT_HOLD pins, FAILED hold without footage, one-click signed export. Mutation-checked. |
| P3.5 AI rule builder | DONE_VERIFIED (API); UI build-verified only | `a8b40b1` | `ruleConditions.test.ts` 15/15 (DST/overnight vectors cross-checked with Python zoneinfo), `ruleBuilderRealDb.test.ts` 9/9 (validation, audit, schedules in site time zone, preview without side effects). |
| P3.6 Event correlation | DONE_VERIFIED | `a8b40b1` | PRECEDED_BY / NOT_PRECEDED_BY on real canonical events (tailgating case, same-camera scope, "after" does not count). Fail-closed on unevaluable conditions (mutation-checked). |
| P3.7 False-alarm controls | DONE_VERIFIED | `a8b40b1` | Verdicts (changeable, audited), stats per rule and model equal hand-computed values; dwell and confidence filters from P2 in the rule builder. |

### Defects found and fixed this session

1. The Incident table had no migration: every database built with `prisma migrate deploy` lacked
   it and spatial incident inserts failed (mocked tests hid it). `9fd8395`
2. System alarms were silently rolled back (audit userId `SYSTEM` violated a foreign key and the
   error was swallowed); audit entries with undefined values or Dates could never re-verify.
   `842a638`
3. Every frame was inferred twice in the worker; deadlines were not honoured; the worker's
   MediaMTX reads had no credentials so every read was denied. `77dd192`, `e2b2179`
4. The notification UI reported "succeeded" for failed test pings and read log fields the API
   never returned; email always failed with a 501. `78274fb`
5. The automation-rule UI posted fields the API does not read and toggled rules with a partial
   PUT that did not exist, so creating or toggling rules from the UI failed. `a8b40b1`
6. A stored condition the engine did not implement (`CAMERA_TAG`) was ignored, so the rule fired
   as if it had no condition. Now fail-closed. `a8b40b1`
7. Found by the new tests before commit: the SMTP client rejected `"Name <address>"` senders and
   truncated MailHog's queue id; the multipart parser corrupted binary parts ending in CR/LF.

### Not verified (and why)

- **No physical camera, NVR, WhatsApp account, SMS gateway or production SMTP relay.** Camera
  events ran against local test doubles and fixtures written from published formats (labelled in
  `backend/src/__tests__/fixtures/camera-events/README.md`).
- The camera clock check cannot confirm a 100 ms bound: ONVIF reports whole seconds, so VigilOne
  reports DRIFT only when certain and UNDETERMINED otherwise (docs/operations/CAMERA_EVENTS.md).
- Profile M: parser and archive only; nothing captures the RTSP metadata track yet.
- Docker image builds (ai-worker, backend) did not run here; the new CI jobs (`ai-worker-checks`
  with models, `ai-e2e-scenario`, MailHog, licence gate) have not run in GitHub Actions yet.
- UI changes (notification channels, dead letters, rule builder, SLA badges, export, camera event
  feeds) were verified by type-check, build and bundle checks, not in a browser.
- `disasterRecoveryDrill.test.ts` failed once in the first full run (`orphansIndexed` 0, expected
  2). **Root cause found later (CI run 36396607639, fixed in the commit after `238b5d8`):** a file
  written in the same millisecond as the recovery scan has an mtime a fraction of a millisecond
  ahead of `Date.now()`, so its age was negative and it was skipped as "being written" even with
  the grace period set to 0.
- Model accuracy on real sites: NOT EVALUATED (P2.10).

### Licence questions

1. `sax` (BlueOak-1.0.0), reached through `onvif` -> `xml2js`, and the other entries in
   `backend/scripts/ci/dependency-license-exceptions.json` (BlueOak x5, `tslib` 0BSD,
   `pako` MIT AND Zlib, `png-js` undeclared) predate this session and need a decision. New
   Phase 3 code avoids `xml2js` and uses `fast-xml-parser` (MIT throughout).
2. The common Node mail libraries are MIT-0 (not on the allowlist); an in-house SMTP client was
   written instead. If MIT-0 is acceptable, a maintained library could replace it.
3. YOLOX and RF-DETR weights are Apache-2.0 but were trained on COCO, whose images carry
   individual Flickr licences. Whether that affects commercial use of the weights is a legal
   question for a human.

### What I need from the human

1. Review and merge session 1's PR, then this PR (stacked on it); watch the first run of the new
   CI jobs.
2. Decide the licence questions above.
3. P2.10 / P1.6: a pilot site with cameras (ideally one Hikvision, one Dahua, one generic ONVIF
   with analytics enabled) to capture event streams and footage; a WhatsApp Business test number
   with an approved template; the site's SMTP relay details.

---

## Session 1 (2026-09-26)

Branch `claude/admiring-wozniak-k4dzqm`, base `master` at `f38adf5`.
Environment: Node 22.22, local PostgreSQL 16 (migrations applied with `prisma migrate deploy`),
ffmpeg 6.1.1 (installed during the session), MediaMTX 1.9.3 binary (downloaded for rehearsal
only, not committed), no GPU, no cameras. A Docker daemon could be started late in the session
but image builds could not reach the network from build containers, so the compose stack was not
brought up.

### Final verification run (after the last commit, `3ec4a07`)

| Command (from repo root) | Result |
| --- | --- |
| `cd backend && npm run build` | exit 0 |
| `cd backend && CREDENTIAL_ENCRYPTION_KEY=<dev key> npm test` (real Postgres, real ffmpeg) | 99/99 suites, 642/642 tests passed |
| `cd services/ai-worker && npm run build && npm test` | build exit 0; 13/13 suites, 83/83 tests passed |
| `cd frontend && npm run build && npm run check:no-demo` | build exit 0; "Production bundle clean: 3 files scanned, 15 demo strings absent" |
| `cd backend && npm run check:hygiene` | exit 0 |
| `cd backend && npm run check:model-licenses` | exit 0 |
| `cd backend && npm run check:no-fake-success` | "30 pattern matches, 30 allowlisted" exit 0 |
| `cd backend && npm run check:status-docs` | "No CI-generated test status yet (PENDING_FIRST_CI_RUN)" exit 0 |
| `cd backend && npm run check:feature-flag-docs` | exit 0 |
| `cd backend && npx ts-node src/scripts/auditSecrets.ts` | "All security hygiene checks passed" |
| `node --test scripts/lib/*.test.mjs scripts/soak/*.test.mjs` | 11/11 passed |
| `bash scripts/__tests__/installer.test.sh` | "39/39 tests passed" |
| `docker compose config -q` and with `deploy/packaging/docker-compose.prod.yml` | exit 0 |

Baseline before any change (master `f38adf5`, same environment): backend 81/85 suites and 500/505
tests passed (3 failures `spawn ffmpeg ENOENT`, 1 ClockGuard failure from leaked host state, 1
read-only simulation that cannot work as root); ai-worker 13/13 suites, 81/81 tests. Master CI has
been red since the fMP4 ingestion tests landed because runners have no ffmpeg.

---

## Phase 0: Stabilise and de-risk

| Task | State | Commit | Verification |
| --- | --- | --- | --- |
| P0.1 Baseline run + CI | DONE_VERIFIED locally; CI run pending | `eed075a` | Backend suite run as above. Fixes: ffmpeg installed on the CI backend runner; new CI jobs for ai-worker build+test and for the governance gates (none ran in CI before); `pg_isready` health check used the wrong role; test host-state (`/etc/vigilone/*`) isolated per test file; chmod-read-only simulation guarded when running as root; frontend static test self-build gets 300 s and surfaces errors. The "frontend/dist not shared between CI jobs" issue was already fixed on master (artifact upload/download); the self-build path is for fresh clones. |
| P0.2 Feature flags | DONE_VERIFIED | `9c289e1` | `npx jest src/__tests__/featureFlags.test.ts`: 23/23, drives the real `app.ts` routing table over HTTP; each of 8 flags gives 501 `FEATURE_DISABLED` when off and reaches the real router (401 auth) when on. README table generated (`npm run docs:feature-flags`, drift checked in CI). |
| P0.3 Demo hazards | DONE_VERIFIED | `ca0bcd7` | Demo build (`VITE_DEMO_MODE=true`) contains the bypass strings; production build contains none of 15 denylisted strings (`npm run check:no-demo`, `frontendDemoHazards.test.ts`). `env.test.ts` 12/12 incl. no default setup token and rejection of the public dev encryption key in production. `secretsAudit.test.ts` 8/8 incl. new checks. |
| P0.4 Fail-loud gate | DONE_VERIFIED | `5d873ee` | `noFakeSuccessGate.test.ts` 14/14, `failLoudHardening.test.ts` 5/5, ai-worker `inferenceEngine.test.ts` new cases. Defects fixed are listed in `docs/audits/FAIL_LOUD_GATE_2026-09-26.md`. |
| P0.5 Generated status | DONE_UNVERIFIED | `9cc436f` | Generator unit-tested (`generateStatus.test.ts` 4/4) and dry-run end-to-end on real Jest JSON (outputs discarded; only CI may commit them). `.github/workflows/status.yml` has **not run yet**: it runs on the first push to master and needs permission to push to master (see asks). |
| P0.6 Docs hygiene | DONE_VERIFIED | `9cc436f` | `docsHygiene.test.ts` 5/5; `npm run check:hygiene` exit 0. Added the INTERNAL SELF-ASSESSMENT disclaimer to Stage 0-5 evidence packs (Stage 2/3 named a non-existent "independent verifier") and the Section 63 spec; removed `file:///` links. |
| P0.7 Contracts | DONE_VERIFIED | `350d5f5` | `npx jest src/__tests__/contracts`: 4 suites, 53 tests, incl. a real Postgres round trip of `RecordingSegment` rows into recording-index.v1. Specs in `docs/contracts/`, portable examples in `docs/contracts/examples/`. |

**Exit gate:** clean build and test logs recorded (above); flags work (P0.2); demo hazards absent
from the production bundle (P0.3); no-fake-success gate passes (P0.4); contracts merged with
contract tests (P0.7, pending PR merge). Open: P0.5 needs its first CI run on master.

## Phase 1: Field-proof the core (agent-doable parts)

| Task | State | Commit | Verification |
| --- | --- | --- | --- |
| P1.1 Bench harness | DONE_VERIFIED on a SIMULATED source; real cameras BLOCKED_HUMAN | `3ec4a07` | `node scripts/bench/bench-camera.mjs --source-kind simulated --rtsp-url rtsp://127.0.0.1:8554/sim_cam_1 --duration 20`: PASS (19.24 s recorded, fragmented, 0 decode errors, 8/8 seeks within tolerance). ONVIF client tested against a SOAP stub (3/3). The compatibility matrix was **corrected**: v1 claimed "Validated Benchmark Baseline" for hardware that had never been tested. |
| P1.2 Fault injection | DONE_VERIFIED for local-rig drills; compose drills BLOCKED_HUMAN | `3ec4a07` | SIMULATED rig (MediaMTX 1.9.3 + ffmpeg publishers): `mediamtx-kill` PASS (resumed 3 s after restart, 12 pre-kill segments playable, outage gap 5.8 s for 5 s down); `abrupt-kill-mid-segment` PASS (killed 7.93 s into a segment, 7.47 s readable, 0.46 s lost, decodes cleanly); `camera-poweroff` PASS (other camera unaffected, resumed 3 s after restore); `backend-restart` **FAIL on master code, PASS after fix** (see defects); `disk-full` on a real loop filesystem INCONCLUSIVE (live view and resume PASS; pruning needs the backend with registered cameras); `network-fault` INCONCLUSIVE (netem not available in this kernel). Not run: `postgres-kill`, `clock-jump`, all compose-target variants. |
| P1.3 Soak runner | DONE_VERIFIED as a 5-minute SIMULATED-CAMERAS rehearsal | `3ec4a07` | 4 simulated cameras, real backend (`node dist/server.js`) and MediaMTX metrics scraped every 10 s: 0 gaps > 5 s on all 4 cameras (PASS_SHORT_RUN), 0 scrape failures, event-loop lag max 72 ms, average backend CPU 0.9 %; memory growth NOT_VERIFIED (window < 6 h by design). The backend was idle (cameras not registered; see backlog). Unit tests 5/5. |
| P1.4 Acceptance automation | DONE_VERIFIED (tooling); on-appliance run BLOCKED_HUMAN | `3ec4a07` | `vigilonectl acceptance` -> `scripts/acceptance/acceptance.sh`. Run in this sandbox: E21/E23/E24 PASS against the rig, the non-appliance items correctly FAIL or NOT_VERIFIED, 14 items MANUAL. `evidencePackageOfflineVerify.test.ts` 3/3: a package from the real `PackageAssembler` verifies offline; tampered video and tampered manifest are detected. |
| P1.5 Clean-VM install | BLOCKED_HUMAN | `3ec4a07` | `scripts/install-drill/clean-vm-install-drill.sh` written (bash -n clean). Needs a fresh Ubuntu 22.04/24.04 VM. |
| P1.6 Real bench and soak | BLOCKED_HUMAN | n/a | Procedure in `docs/operations/FIELD_VALIDATION_TOOLKIT.md` ("P1.6: what the human must do"). |

### Defects found and fixed this session

Found by running things for real, not by reading code:

1. **Crash recovery destroyed segments still being written** (recording invariant). At every
   backend start (while MediaMTX keeps recording) it unlinked freshly opened 0-byte segments and
   replaced or moved partially written ones. Fixed with an active-write grace period; reproduced
   by a unit test and by `scripts/fault/backend-restart.sh` (FAIL before, PASS after). `bbd6c3d`.
2. **Automation rules could not fire for MOTION, ANPR_MATCH, DI_TRIGGER, STREAM_DEGRADED or
   SYSTEM_ALERT events**: the raw event type was put into the Prisma enum filter and the query
   threw. Mocked tests hid it; a real-Postgres test reproduces it. `bbd6c3d`.
3. **Critical storage alarms were never created**: raised under a non-existent tenant (FK
   violation). `bbd6c3d`.
4. **Storage sentinel told operators all footage was pinned under Section 63 holds** when there was
   no footage at all. `bbd6c3d`.
5. **`/health` reported the media engine OK while MediaMTX was down.** `bbd6c3d`.
6. **Frontend showed simulated alarms/cameras on empty lists or API errors, and marked alarms
   acknowledged/resolved (as a hard-coded operator) when the backend rejected the request.** `ca0bcd7`.
7. **docker-compose never passed `SETUP_TOKEN` to the backend**, so the installer's random token was
   ignored and the published default applied. `ca0bcd7`.
8. Fake-success paths listed in `docs/audits/FAIL_LOUD_GATE_2026-09-26.md` (dev-mode fake S3
   COMPLETED, ai-worker stub detections in development, invented ONVIF/firmware/software versions
   and federation node facts, OTA success without a health check, ...). `5d873ee`.
9. CI on master has been red because runners lack ffmpeg. `eed075a`.

### Not verified (and why)

- Nothing has run on a real camera, real PoE switch or the reference mini-PC.
- CI has not run on this branch yet at the time of writing; the new jobs (`ai-worker-checks`,
  `governance-gates`, `field-tooling-checks`) and the ffmpeg fix are unproven in GitHub Actions.
- `.github/workflows/status.yml` has never run; it may be blocked by branch protection on master.
- Compose stack: not brought up here (image builds need network from build containers). So
  `postgres-kill.sh`, compose variants of every drill, retention pruning under disk-full, and
  `clean-vm-install-drill.sh` are unexecuted.
- `network-fault.sh`: netem missing in this kernel; only its NOT_VERIFIED path ran.
- `clock-jump.sh`: not run (changes the host clock).
- Soak: 5 minutes, simulated sources, idle backend. It establishes nothing about 72-hour behaviour.
- Frontend UI changes (flags, error banners, demo gating) were verified by build output and bundle
  inspection, not in a browser.

### Licence questions

None open. No npm dependencies were added. The MediaMTX binary (MIT) was downloaded only to run
the rehearsal rig and is not committed; the product keeps using the pinned container image.

### What I need from the human

1. Review and merge the PR for this branch; watch the first CI run (new jobs) and the first
   `status.yml` run on master. If branch protection blocks the status bot, either allow
   `github-actions[bot]` to push to master or tell me to change the workflow to open a PR instead.
2. P1.5: a disposable Ubuntu 22.04 or 24.04 VM; run
   `sudo scripts/install-drill/clean-vm-install-drill.sh --with-test-camera` and commit the report.
3. P1.6: the bench hardware and the procedure in `docs/operations/FIELD_VALIDATION_TOOLKIT.md`.
4. Decision (backlog): may footage of a camera that was removed from the database ever be deleted
   automatically by the quarantine cap?

### Next session

Start with this file and the CI results. Then Phase 1 follow-ups from `docs/BACKLOG.md` (register
simulated cameras for a realistic software soak, index segments only after the grace period,
expose ClockGuard state), or Phase 2 if the human prefers.
