# VigilOne action-plan status

Maintained by the coding agent at the end of every session. States: `NOT_STARTED`, `IN_PROGRESS`,
`DONE_VERIFIED` (verified by a real run, command and output below), `DONE_UNVERIFIED` (built, not
yet run where it matters), `BLOCKED_HUMAN` (needs hardware, a clean VM, data or a decision).
Nothing here says "passing" without the run that showed it. CI-generated test counts live in
`docs/generated/TEST_STATUS.md` (written only by `.github/workflows/status.yml`).

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
