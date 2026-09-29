# VigilOne VMS — Remediation Round 2 Review, 14 Sept 2026

Repo: github.com/Nopenope69/VMS. Reviewed range: `9414edc` (last independently verified state, 13 Sept) → `bcbd553` (current HEAD). Three commits in between:

- `f6a6c11` — the prior audit's own text, committed into the repo as `docs/audits/CRITIQUE_REMEDIATION_VERIFICATION_2026-09-13.md` (no new engineering; just persisting the review).
- `a048a60` — "fix(remediation): execute 13 Sept audit critique remediation across all 6 phases" — the substantive commit.
- `bcbd553` — adds a Track 1/2/3 next-steps roadmap doc (docs only).

## Verdict

Real, meaningful progress. Every item flagged as "still fake/unwired" or "theatrical" in the two prior audits has been addressed with a genuine implementation this round — not just relabeled. This is the best-engineered remediation commit of the three rounds so far. But the commit's own claimed test counts do not hold up under a fresh, from-scratch verification, and the pattern of markdown docs overstating verified state (fabricated sign-offs → theatrical tests → now an inflated pass count) has now recurred a third time, at a much smaller scale.

## What was independently verified as genuinely fixed

1. **64-camera soak test** — no longer pure simulation. `soakHarness.ts` now has `generateRealFmp4Segment()`, which shells out to real `ffmpeg` to produce actual H.264 fragmented MP4 video (moof/mdat atoms), and `realStreamLoad.test.ts` drives 4 concurrent camera streams across 3 real segment rotations, verifying `ffprobe`-confirmed container validity and SHA-256 hash match against disk bytes. Honestly scoped in its own comments: explicitly says this proves real encoding/rotation/hashing but does NOT prove the calendar-bound 168-hour physical soak, which remains "Field Validation Pending."
2. **Disaster recovery drill** — no longer an in-memory mock. `scripts/dr-drill.sh` spins up a real ephemeral `postgres:16-alpine` Docker container, runs real `prisma migrate deploy`, seeds real rows plus a real ffmpeg-generated video file, takes a real `pg_dump` backup, does a real `DROP SCHEMA public CASCADE` (behind a hard-coded safety guard that refuses to run against anything not matching the ephemeral test DB), restores from the backup, and verifies both DB row counts and on-disk SHA-256 match post-restore. This is a legitimate, well-guarded live DR drill — a genuine step up from the prior mocked-DB version.
3. **Playback / Evidence / ONVIF test suites** — real HTTP-level integration tests (spin up an actual Express app, real JWT, real routes) that mock only the DB layer and the external `onvif` vendor SDK (reasonable, since that needs physical hardware). `playbackRoutes.test.ts` genuinely exercises byte-range requests (`Range: bytes=100-199` → real 206 + `Content-Range`); `evidenceRoutes.test.ts` genuinely exercises cross-tenant access denial with two distinct tenant JWTs. Not string-grep tests.
4. **Out-of-scope UI cleanup** — ANPR, Federation, and Identity/SSO nav links removed from `Navbar.tsx`; the corresponding routes in `App.tsx` now render an explicit "Out of Scope for Commercial V1" notice instead of silently 404ing or showing a half-built console. Matches the README's v1 scope boundary from the previous round.
5. **Fake e2e test replaced honestly** — the old test that grepped a spec file for strings and called itself an e2e smoke test is gone. Its replacement (`frontendStaticValidation.test.ts`) does the same underlying string-based checks but now carries an explicit "HONEST SCOPE NOTICE" stating it validates static artifacts only and does not execute a browser, pointing to the real Playwright spec (`frontend/e2e/operations.spec.ts`, confirmed present) as the actual browser-driven e2e, to be run separately. This is a genuine improvement in honesty even though the underlying test technique is still shallow.

## What does not hold up — verified by actually running it

Cloned the repo fresh (`git clone`, no local modifications) and ran the exact test file the commit claims goes 4/4:

```
FAIL src/__tests__/frontendStaticValidation.test.ts
  ✕ verifies production frontend dist bundle exists and references assets
  ✓ verifies Playwright E2E test file exists and defines operator workflow specifications
  ✓ verifies client API configuration routes to /api/v1 and maintains local credential auth
  ✓ verifies frontend login and settings preserve v1 core edge focus (no SSO callback invocations)
Tests: 1 failed, 3 passed, 4 total
```

Root cause confirmed by reading `.github/workflows/ci.yml`: `backend-checks` and `frontend-checks` are separate jobs with no `needs:` dependency and no `upload-artifact`/`download-artifact` step between them. `frontend/dist` is gitignored and only ever produced by the `frontend-checks` job's `npm run build`. So in the actual CI as configured today, `backend-checks` (which runs `npm test`, and therefore this suite) never has a built frontend available — this test fails on every real CI run, not just in a review sandbox. This is a small, mechanical bug, not a fabrication, but it directly contradicts:
- The commit message's "Phase 3: ... replace mock E2E smoke test with static validation (4/4 passed)"
- `docs/audits/STAGE_3_VERIFICATION_EVIDENCE.md`'s claim of a clean "PASS" for this suite
- `docs/operations/NEXT_STEPS_PILOT_AND_HARDWARE_ROADMAP.md`'s headline claim of "77/77 Test Suites Passed (432/432 tests)"

77 test suite files do genuinely exist (verified by listing), so the suite *count* is real — but at least one of those 77 does not pass as CI is currently wired, so the "77/77 passed" framing is not accurate today.

## Not independently re-verified this round (environment-limited, not a repo problem)

Could not execute `realStreamLoad.test.ts` or `scripts/dr-drill.sh` end-to-end in this review sandbox: Prisma's engine binaries are blocked by this sandbox's outbound network policy (`binaries.prisma.sh` → 403), and no Docker daemon is reachable here. Both pieces of code read as legitimate on manual trace (real ffmpeg invocation, real Docker/Postgres commands, a real safety guard on the destructive drop), and the connectionManager and evidence/playback/onvif suites that *could* be run all passed, so there's no reason to suspect these are fake — but "reads correctly" is exactly the kind of claim that turned out wrong twice before with this repo, so treat them as plausible-but-unconfirmed until a real CI run (which has neither restriction) reports them as passing, and until `scripts/dr-drill.sh` has actually been executed once and its console output captured.

## Recommended next moves, in order

1. **Fix the CI job gap** (`backend-checks` needs the frontend build before `npm test` runs `frontendStaticValidation.test.ts`) — either add `needs: [frontend-checks]` + artifact upload/download of `frontend/dist`, build the frontend as a step inside `backend-checks` too, or move that one test file into the `frontend-checks` job. Small, fast fix; until it's done, the "all tests green" claim is false on every push.
2. **Get one real, unedited CI run** on current `HEAD` and link it (or paste its actual log) into the STAGE_3/4/5 docs and `NEXT_STEPS_PILOT_AND_HARDWARE_ROADMAP.md`, replacing the hand-typed "PASS" blocks and pass counts. Given this repo's history (fabricated external sign-offs on 13 Sept, a theatrical soak/e2e/DR round before that, now an inflated pass count), the fix isn't just "get the number right this time" — it's removing hand-authored test-result prose from these docs entirely in favor of a link to the actual run, so the docs can't drift from reality again.
3. **Actually execute `scripts/dr-drill.sh` once**, in an environment with Docker, and capture its real output — it has never been confirmed to run successfully outside the sandbox it was written in.
4. Once 1–3 are done, `bcbd553`'s Track 1/2/3 roadmap (GCP VM install drill → 1–4 physical camera bench canary → supervised pilot) is the right shape and sequencing for what comes after lab verification — it matches what all three audits so far have converged on as the real remaining gap (proof under real network/hardware conditions, not more lab code). No changes needed to that plan itself; just don't start the physical-camera track while claiming a lab-verified state that a fresh CI run doesn't actually reproduce.
