# VigilOne VMS — Remediation Verification, 13 Sept 2026

Independent, read-only re-audit of commit `9414edc` ("fix(audit): remediate 13 Sept critique, purge fabricated sign-offs, cut v1 scope & fix core runtime wiring"), which responded to `docs/audits/CRITIQUE_FOLLOWUP_2026-09-13.md`. Every claim below was checked against the actual current file content and code paths, not the commit's self-reported status.

## Verdict

**First round where the self-reported remediation claims check out under independent verification.** Meaningful, real progress on both the integrity issue (fabricated attestations) and the specific runtime-wiring gaps flagged previously. Still not ready for a full, unsupervised paying-client rollout — the remaining gap is proof under real load/failure conditions, not scope or integrity anymore.

## 1. Fabricated sign-off docs purged — TRUE

`docs/operations/LEGAL_ADMISSIBILITY_AND_SECTION_63_BSA_REVIEW.md` and `docs/audits/STAGE_5_VERIFICATION_EVIDENCE.md` are now explicitly labeled internal self-assessments with disclaimers ("NOT a formal legal opinion", "does NOT constitute an independent third-party audit, external certification, or formal legal opinion"). `docs/audits/STAGE_4_VERIFICATION_EVIDENCE.md` likewise relabeled. Repo-wide grep for `/Users/`, `tecbusiness`, and `Apex Security` turns up nothing live — the only remaining hit is inside the prior critique file itself, quoting the original leak as historical record.

## 2. V1 scope boundaries — TRUE

`README.md` now has a prominent, second-section "Commercial V1 Shipping Scope & Explicit Boundaries" with an explicit out-of-scope warning block naming ANPR, multi-site federation, S3/offsite archive, email notifications, physical relay/access control, and enterprise SSO as not-for-v1, with "Do Not Deploy / Market as Functional" language. Mirrored in `docs/operations/KNOWN_LIMITATIONS_AND_ENVIRONMENT_CONSTRAINTS.md`.

## 3. OTA CLI repair — TRUE

`applyUpdate`, `triggerRollback`, `getCurrentVersion`, `hasRollbackSnapshot`, `getCurrentEpoch`, `getLatestSnapshot` all exist on `OtaUpdateService` and do real work: real tar extraction, real Ed25519 manifest/payload verification, real file deployment via `fs.copyFileSync`, and a real DB-dump restore + config-file restore (excluding monotonic state) on rollback — not flag flips. `vigilonectl cmd_ota apply/rollback/status` now call these real methods with matching signatures and correctly consume their `{success, ...}` return shape. `cmd_update` routes through the same verified pipeline; the old unsigned `docker compose pull && restart` bypass is gone. The 12 `otaUpdate.test.ts` tests were independently re-run (working around a sandbox-only Prisma-generate network block) and genuinely pass against real file and crypto operations, not mocks of the thing under test.

## 4. Camera auto-reconnect — FULLY FIXED

`cameraConnectionManager.service.ts` now has a real `defaultReconnectionHandler` that runs whenever no external `connectRequest` listener is registered — confirmed none is, repo-wide, so this path is what actually executes in production. It does a genuine TCP probe (`net.Socket().connect` with a 2.5s timeout) and, on success, calls the real `mediaProvider.createOrUpdateStream` with genuine schema fields. A 15-second safety timer now guarantees `activeHandshakes` always decrements, closing the previous leak. This is wired live from `server.ts` at boot, not test-only.

**Caveat**: the 6 passing tests in `connectionManager.test.ts` only exercise the pre-existing queue/backoff logic — every test injects a custom handler and never exercises the new TCP-probe/MediaMTX path itself. That path is verified here by manual code trace, not by test coverage. Recommend adding a test that actually opens an ephemeral local TCP listener and confirms `defaultReconnectionHandler` connects to it and calls `createOrUpdateStream`.

## 5. IncidentOrchestrator wiring — FULLY FIXED

`incidentOrchestrator.start()`/`.stop()` are now called from `server.ts` in the real (non-test) boot and shutdown paths, and `start()` genuinely starts the `ActionOutbox` polling worker rather than being a no-op. All three real event detectors now call `ingestEvent` at their actual detection sites, alongside their pre-existing direct database writes:
- `sceneChangeDetector.service.ts` — inside the `IDLE → ACTIVE` motion transition
- `streamWatchdog.service.ts` — inside the stall/degradation detection branch
- `storageSentinel.service.ts` — inside the `PINNED_STORAGE_EXHAUSTION` branch of the emergency purge loop

The 3 tests in `incidentAutomationWiring.test.ts` exercise the real detector methods (`handleSceneChange`, `evaluateStream`, `checkAndPurge`) and spy on `ingestEvent` to confirm reachability — a legitimate wiring test, not a self-fulfilling mock.

## 2. What this round did not address — still open

- The 64-camera "soak test" (`soakTopology.ts`, `soakHarness.ts`) is still a pure simulation: mock RTSP URIs, and the "recording segment" is a literal ASCII string written to disk and hashed. No ffmpeg, no RTSP client, no real load.
- The companion "Playwright e2e" test (`frontendOperationsSmoke.test.ts`) still doesn't run a browser — it greps the spec file's source for expected substrings.
- Disaster-recovery Scenarios A & B (`disasterRecoveryDrill.test.ts`) still run against an in-memory mock database and scratch files, never a real Postgres restore.
- Frontend page completeness, the playback endpoint, evidence export/PDF generation, and the ONVIF client remain unverified from the original 11 Sept audit — no evidence either way yet.
- The self-declared status table marking Stage 3 "ENGINEERING COMPLETE" and Stage 4/5 "COMPLETE (100%)" overstates the current state: Stage 3's hardware-capacity claim is still backed only by simulation (0/168h real soak), and Stage 4's DR drills are still mocked. These should not be marked 100% until backed by real runs.

## 3. Recommended next steps, in order

1. Rebuild the soak test to drive real ffmpeg/RTSP load — start with 4-8 real or emulated streams rather than 64 simulated ones. Do not quote a hardware-capacity number to a client until it comes from this.
2. Replace the string-grep "Playwright" test with an actual browser run of the real e2e flows.
3. Re-run DR Scenarios A & B against a real Postgres instance and real filesystem state, not the in-memory mock.
4. Verify the remaining 11 Sept open items: frontend page completeness, the playback endpoint, evidence export/PDF, the ONVIF client, and a genuinely clean full `npm test` run outside sandbox network restrictions.
5. Once 1-4 are done for real, correct the Stage 3/4/5 status table to reflect actual state. At that point this becomes a reasonable candidate for a small, closely-supervised pilot deployment — still short of an unsupervised commercial rollout, but meaningfully closer than either prior audit found it.
