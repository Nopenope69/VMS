# VigilOne action-plan status

Maintained by the coding agent at the end of every session. States: `NOT_STARTED`, `IN_PROGRESS`,
`DONE_VERIFIED` (verified by a real run, command and output below), `DONE_UNVERIFIED` (built, not
yet run where it matters), `BLOCKED_HUMAN` (needs hardware, a clean VM, data or a decision).
Nothing here says "passing" without the run that showed it. CI-generated test counts live in
`docs/generated/TEST_STATUS.md` (written only by `.github/workflows/status.yml`).

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
| Generated Test Status, step "Fail if any suite failed" | red on every master push | `status.yml` never ran `npm ci` in `services/ai-worker` (no `onnxruntime-node`) and never fetched the pinned models, so 2 native-engine tests in `inferenceEngine.test.ts` failed and 34 golden-model tests were skipped (generated status: ai-worker 17/23 suites, 139/175 tests). Reproduced locally by hiding the ai-worker `node_modules`: the same 2 tests fail. | PR 5 (`fix/status-workflow-ai-worker-deps`) mirrors the `ci.yml` setup and sets `VIGILONE_REQUIRE_MODEL_TESTS=1`. Locally with that setup the ai-worker suite is 22 suites run, 170 passed, 5 skipped (a suite `ci.yml` also skips). **DONE_UNVERIFIED**: the workflow only runs on push to master, so it is verified on GitHub only after PR 5 merges. |

The earlier "2 ai-worker failures, output not captured" note (Phase 4, "Not verified") has the
same likely cause (a missing dependency or model after a heavy run), but that was not proven for
those local runs; it is proven for the status workflow.

### Step 1: Wave A wiring

Local baseline before any change: backend 123/123 suites, 837 passed, 1 skipped. After the last
code commit: **128/128 suites, 868 passed, 1 skipped** (`cd backend && npx jest --runInBand`, real
PostgreSQL 16, real ffmpeg). The local database was a native PostgreSQL 16 service, not the
`postgres:16-alpine` container (there is no Docker daemon in this environment); CI uses the
container.

| Item | Label | Evidence and limits |
| --- | --- | --- |
| Prisma models `Explanation`, `ObjectCrop`, `SiteCropPolicy`; migration `20261002000000_phase5_explanations_crops` | DONE_VERIFIED | `prisma migrate deploy` on the local database and on a fresh database, then `prisma migrate diff` shows no drift; `migrationPhase5Wave.test.ts` 3/3 (hash, class, size, expiry and person-acknowledgement CHECKs, cascades). `SiteCropPolicy` is a third table beyond the two requested, needed for the per-site person gate. |
| Explanation service (`services/explanation/explanationService.ts`) | DONE_VERIFIED | `explanationWiringRealDb.test.ts` 7/7: facts from a real alarm, canonical event, rule, detection, model manifest and correlation chain; the stored record passes `verifyExplanationRecord`; a second call returns the stored record unchanged. Limits: the camera clock is always `UNKNOWN` (no clock verdict is persisted, and none is derived from the skew estimate); the only detection listed is the one named by the trigger's `inferenceId`; rule fields are read at generation time. |
| Non-blocking fail-loud hook in `AlarmLifecycle.elevateAlarm`, flag `EXPLANATIONS` default OFF | DONE_VERIFIED | Same suite. Flag off: nothing written. A facts failure leaves the alarm ACTIVE, logs, increments `vigilone_explanations_total{outcome="failed"}` and writes an `EXPLANATION_FAILED` audit row; a failing audit write is logged and counted too. Mutation check: making the hook rethrow fails 2 tests. Not exercised through the full orchestrator `TRIGGER_ALARM` action or on a live site. |
| `explanations.json` (role `EXPLANATIONS`) and the manifest `explanations` section in `evidenceArchive.service.ts` | DONE_VERIFIED | `explanationExportRealDb.test.ts` 5/5: a real export from a real ffmpeg segment passes `vigilone-verify --require-explanations` in a separate process (`explain.*` checks PASS); an edited record, and a stripped section re-signed with another key, are rejected; with the flag off and no records the verifier warns and `--require-explanations` fails; records are still included if the flag was switched off; a stored record that no longer matches its row fails the export. The Section 63 PDF does not mention explanations. |
| Crop capture on the detection path, flag `OBJECT_CROPS` default OFF | DONE_VERIFIED for the code path; **no live source** | `cropCaptureRealDb.test.ts` 10/10 through `DetectionIngestionService.ingest`: real ffmpeg cut (decoded 320x240 from a 640x480 snapshot), hash recorded, 14-day retention, per-site overrides, low or unknown free space fails loudly without stopping the detection, snapshot paths outside the allowed roots or behind a symlink are refused, and a database failure removes the written file. Mutation check: opening the person gate fails the refusal test. **The ai-worker does not write snapshot files today, so a live deployment captures nothing until a snapshot source exists (NOT_STARTED).** |
| Person crops behind the per-site policy gate | DONE_VERIFIED in the database and service; **no way to set it** | Off by default; a row enabling it without a recorded purpose and acknowledger is refused by a CHECK; same suite. There is no API or UI to write `SiteCropPolicy` yet (NOT_STARTED). The lawful basis and the retention defaults are still the open DPDP decision (BLOCKED_HUMAN). |
| Scheduled hold-aware crop purge (`CropPurger`, `purgeTenantCrops`) | DONE_VERIFIED for the purge logic; **DONE_UNVERIFIED for scheduling** | `cropPurgeRealDb.test.ts` 6/6 on real files: expired crops removed; incident-hold and legal-hold crops kept; other-camera and lapsed holds do not protect; if either hold lookup fails nothing is deleted and the failure is logged, counted and audited (`CROP_PURGE_FAILED`), and the next run succeeds; a missing file removes its row; an undeletable file keeps its row; pagination continues past 505 held rows. Mutation check: swallowing the lookup error fails the fail-closed test. The interval timer and the start in `server.ts` are not covered by a test. The shared hold lookup moved to `privacy/holds.ts`; `dpdpRealDb.test.ts` is unchanged and passes. |
| One existing test file changed | note | `evidenceBindingChain.test.ts` builds Prisma by hand; it gained `explanation.findMany` (as Phase 4 did for provenance). No assertion changed. `featureFlags.test.ts` gained the two flag names in its expected list. |
| Docs hygiene, model-licence, fail-loud, feature-flag-docs and status-docs gates; `node --test tools/vigilone-verify/*.test.mjs` (12/12); `docker compose config -q` (base and prod override) | DONE_VERIFIED | All exit 0 before each commit and after the last. |
| CI on `feat/phase5-wave-a-wiring` | DONE_VERIFIED for head `6cf7cb7` | PR 6 run 36602102549: 9/9 jobs green, including Backend Typecheck, Migrations & Tests (clean migration deploy on `postgres:16-alpine`) and the AI end-to-end scenarios. Later commits on this branch are documentation only and get their own run. |
| Wave B and Wave C | NOT_STARTED | Unchanged. |

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
