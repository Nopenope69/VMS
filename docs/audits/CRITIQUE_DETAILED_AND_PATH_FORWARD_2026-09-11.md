# Critique (Detailed) and Path Forward — 11 Sept 2026

**Repository:** https://github.com/Nopenope69/VMS
**Commit audited:** `5c8899d` (feat(packaging): implement commercial zero-terminal appliance packaging (Phase 3))
**Audit date:** 2026-09-11
**Type:** Technical due-diligence + commercialization-readiness audit

---

## Audit scope and limits

Inspected: backend entrypoint (`server.ts`), auth / SSO / media-auth / internal routes, licensing (`utils/license.ts`, `config/licenseKeys.ts`), env config, Prisma schema and all migrations, Dockerfiles, `docker-compose.yml`, `deploy/packaging/*` (installer, `vigilonectl`, prod compose, systemd unit), `Caddyfile`, `mediamtx.yml`, and service wiring across all of `backend/src`. Backend `tsc --noEmit` passes clean.

Not inspected in depth: frontend pages, playback streaming endpoint, evidence export and PDF generation, disaster-recovery restore, ONVIF client, storage-volume logic, federation crypto. Findings in those areas are marked unverified.

Test suite: could not complete in the audit sandbox (Prisma engine download blocked). Before the crash, 11 suites passed and 3 failed (`incidentOrchestrator`, `eventActionMatrix`, `applianceBootstrap`, possibly environment-related). One genuine logic/test mismatch: `storageVolumeManager.test.ts:176` expects `'unavailable'`, receives `'Fallback to system default volume'`.

---

## Executive Verdict

**Not deployable to a paying customer.** Two things to fix before anything else:

1. **Rotate the license signing key.** The vendor Ed25519 private key is committed in the repo and derives exactly to the production public key (verified with `openssl`).
2. **Remove `mockClaims` from `/api/v1/sso/callback`.**

**What's been built:** a large, well-named edge VMS written in 8 days (commits 2026-09-04 to 09-11). ~24k backend LOC, ~13k frontend LOC, ~9.4k test LOC. Express + Prisma/Postgres + MediaMTX + Caddy, 153 API endpoints, 51 data models.

**Genuinely decent:**
- Pure-logic modules: geometry, Merkle trees, hash chains, schedule evaluation, plate-text aggregation.
- Container hygiene: non-root user, pinned images, resource limits.
- Env fail-fast checks in production mode.
- Overall architectural intent (MediaMTX as media plane, backend as control plane).

**Immature:** nearly every integration seam. Several headline subsystems are never invoked by the running server, or silently fake success:
- incident orchestrator
- camera reconnect manager
- recording watchdog
- relays
- email notifications
- S3 archive
- AI inference
- federation tunnel

**Biggest risks:**
- Broken licensing: anyone can mint licenses.
- SSO endpoint trusts client-supplied identity claims.
- No baseline database migration, so a fresh install cannot create its schema.
- Segment-ingestion webhook can never authenticate.
- Installer swallows errors and reports success.
- Documentation marks all of this "Verified in Repository."

| Metric | Estimate |
|---|---|
| Engineering completion | **~45%** |
| Commercialization readiness | **~29%** |
| Deploy to a paying customer today? | **No** |

---

## 1. What Actually Exists

**Product:** single-box edge NVR/VMS for commodity IP cameras (Hikvision, Dahua, CP Plus, ONVIF), aimed at Indian customers, with Section 63 BSA evidence packaging, offline licensing, and a multi-tenant data model.

**Runtime topology** (`docker-compose.yml`):

| Service | Role |
|---|---|
| Caddy | TLS gateway on 80/443 |
| MediaMTX 1.9.3 | RTSP ingest, WHEP/HLS egress, fMP4 recording |
| Postgres 16 | Database |
| Node backend (`:4000`) | Control plane API |
| One-shot frontend container | Copies Vite SPA into a shared volume |

**Backend:** `server.ts` mounts 30 routers and starts 9 background loops (segment worker, catalog reconciler, storage sentinel, schedule, stream watchdog, retention, ANPR aggregator, AI runtime, notification dispatcher). There are 44 separate `new PrismaClient()` instances.

**Plausibly works end-to-end (not run live):** add camera → MediaMTX path injection via `:9997`; live view over WHEP gated by JWT webhook; MediaMTX writes fMP4 segments; users, RBAC, sites, hash-chained audit log; large set of admin UI screens.

**Not present at all:** CI (no `.github/workflows`), container registry / release artifacts, frontend tests, E2E tests, baseline migration, any WebSocket code (despite the claimed "reverse WSS tunnel"), S3 SDK / SigV4 signing, SMTP, any ML runtime.

---

## 2. Feature-by-Feature Status

Legend: ✅ Production-ready · 🟢 Functional, needs hardening · 🟡 Partial · 🟠 Prototype · 🔴 Stub/mock/broken · ❓ Not inspected

| Feature | State | Evidence | What remains | Impact |
|---|---|---|---|---|
| Live view (WHEP via MediaMTX) | 🟡 | `mediamtx.provider.ts`, `mediaAuth.routes.ts`, `whepPlayer.ts` | Per-camera authz; reject refresh tokens; real-camera test | Critical |
| Continuous recording (fMP4) | 🟢 likely | `mediamtx.yml` pathDefaults | Real-camera soak | Critical |
| Segment ingestion webhook / durable queue | 🔴 Broken | `mediamtx.yml` hook uses `${INTERNAL_API_SECRET:-...}`; MediaMTX 1.9.3 uses Go `os.Expand` (no `:-` support, verified in source); container has no such env var. Every call gets 401/403. | Pass secret via `MTX_`-prefixed env or file; integration test | Critical |
| Segment indexing fallback (5-min reconciler) | 🟡 unverified | `recordingCatalog.startReconciler` | Confirm disk scan; start times come from file mtime, not filename | Critical |
| Playback | ❓ | `playback.routes.ts` (350 lines) | E2E verification | Critical |
| Retention with evidence pins | 🟡 | `retentionPolicy.ts` mock fallbacks at lines 73, 77 | Test against real DB and full disk | Critical |
| Evidence export / BSA package | ❓ partial | `packageAssembler.ts:51` "write placeholder"; `evidenceArchive.service.ts:256` mock fallback | Legal review; real-footage E2E | High |
| Audit hash chain | 🟢 | `auditChain.service.ts`; advisory-lock failure silently falls back (line 57); audit rows cascade-delete with tenant | Fail closed; retention policy | High |
| Auth (password + JWT) | 🟡 weak | `auth.routes.ts`, `middleware/auth.ts` | Token-type enforcement; stop returning refresh token in body | Critical |
| SSO / OIDC | 🔴 stub + dangerous | `sso.routes.ts:127-185`: no code exchange, trusts `mockClaims`, returns sessionId with no JWT; `Login.tsx` has no SSO path | Rebuild on a real OIDC library, or disable | Critical |
| RBAC | 🟡 | `rbac/permissions.ts`, `authorize()` on most routes | Permission-matrix tests; per-camera scoping | High |
| Multi-tenancy | 🟠 | `User.email` globally unique; SSO upsert crosses tenants; media auth skips tenant check when claim absent | Decide if needed for v1 (probably not) | Medium |
| Offline licensing | 🔴 Broken | `config/licenseKeys.ts:16` private key committed; `auth.routes.ts:190` signs at runtime; bootstrap grants perpetual 16-cam Enterprise | New keypair off-box; remove on-box signing | Critical |
| First-run bootstrap | 🟢 | Advisory lock + singleton, `auth.routes.ts:112` | Depends on migrations working | High |
| Scene-change motion | 🟡 | ffmpeg spawn, started per camera from `camera.routes.ts:198` | Load test; restart behavior | Medium |
| Incident orchestrator / automation | 🔴 Not wired | `ingestEvent` never called in prod code; `orchestrator.start()` never called; routes use separate `EventActionMatrixService` whose default dispatch is simulated success (`eventActionMatrix.service.ts:246`) | One engine; wire event sources; delete the other | High |
| Alarms console | 🟡 | `alarm.routes.ts` uses orchestrator read/ack paths | Real alarm sources | High |
| Relays / DI-DO | 🔴 Fake | `relayAdapter.ts:28` default driver returns `confirmed: true`; never replaced | Real driver or remove feature | High (safety) |
| Notifications | 🟠 | Webhook/Slack real; EMAIL returns success 250 without sending (`notificationAdapter.ts:364`) | SMTP or remove channel | High |
| Object storage archive | 🔴 Mock | In-memory `s3Store` Map; `processArchiveJob` never called outside tests | Real S3 client or defer | Medium |
| ANPR | 🔴 No inference | `/anpr/detect` accepts plate text; AI telemetry hard-codes `READY` / 15 fps | Entire ML pipeline | Defer |
| Federation / CMS | 🟠 | HTTP register/heartbeat/sync endpoints only; no WebSocket code or edge client | Defer | Low for v1 |
| Camera reconnect storm guard | 🔴 Dead code | `CameraConnectionManager` has no prod references | Wire or delete | Medium |
| RecordingWatchdog, RecordingIndexer, RetentionService | 🔴 Dead code | No prod references | Wire or delete | Medium |
| PTZ / presets / guard tours | ❓ | `onvif/client.ts`, `ptzArbiter` | Real-camera test | Medium |
| Floorplans, spatial analytics, redaction, synced playback | 🟠 | Logic + UI; detection inputs don't exist | Defer | Low |
| Installer / appliance packaging | 🔴 | See section 6 | Rewrite | Critical |

---

## 3. Architecture Assessment

**Strengths:** clean media/control-plane split; MediaMTX is a sensible engine; single-origin Caddy removes CORS problems; the ADRs (`docs/adr/0001-0004`) are thoughtful on paper.

**Weaknesses:**

1. **Breadth without integration.** Modules are built and unit-tested in isolation, then left unwired. The orchestrator is the declared authority in ADR 0004, but routes use the legacy engine. `recordingIndexer.service.ts` duplicates the catalog. `gpioRelay.service.ts` is a deprecated shim still present.
2. **44 PrismaClient instances**, each with its own connection pool. Real exhaustion risk against Postgres's default 100 connections (512 MB container). Use one shared client.
3. **Silent failure pattern.** Dozens of `catch {}` blocks and "fallback for mock environments" branches in production paths: `auditChain.service.ts:57`, `custodyLedger.ts:74`, `retentionPolicy.ts:73-77`, `auth.routes.ts:131, 232`. For an evidentiary product, audit and custody writes must fail closed.
4. **Process-local state** (PKCE states, rate limiters, track ledgers) lost on restart. Acceptable for a single edge box, but know it.
5. **Evidentiary timestamps from file mtime** (`recordingCatalog.service.ts` ~line 114). MediaMTX encodes start time in the filename; use that.

**MVP-acceptable but commercially dangerous:** multi-tenant schema on a single-tenant appliance adds attack surface (cross-tenant SSO upsert, global email uniqueness) without customer value.

---

## 4. Security Assessment

### Known vulnerabilities (verified in code)

| # | Severity | Finding | Location |
|---|---|---|---|
| S1 | **Critical** | Vendor license private key committed and used at runtime; derives exactly to `VENDOR_LICENSE_PUBLIC_KEY`. Anyone can sign any license. Key is public on GitHub: rotate, don't just scrub history. | `config/licenseKeys.ts:16`, `utils/license.ts:45`, `auth.routes.ts:190` |
| S2 | **Critical** | SSO callback accepts client-supplied `mockClaims`, never exchanges the code, upserts users by global email with role from attacker-controlled `groups`. Anyone with a provider ID can create users or change any user's role, cross-tenant. | `sso.routes.ts:127-185` |
| S3 | **High** | Production secret guard checks lowercase `change_me`; `.env.example` ships uppercase `CHANGE_ME_...`. Copying `.env.example` with `NODE_ENV=production` boots with a publicly known JWT secret and setup token. (Installer generates random secrets; affects manual / Quick Start deploys.) | `config/env.ts:77-85` vs `.env.example` |
| S4 | **High** | Refresh tokens (7 d) accepted as access tokens: same secret, no `type` check. Refresh tokens carry no `tenantId`, so media-auth tenant check is skipped: a refresh token reads any tenant's stream. | `middleware/auth.ts:102`, `mediaAuth.routes.ts:92` |
| S5 | **High** | Any valid user JWT authorizes live view of every camera. No per-camera permission, no active-user check in media webhook. | `mediaAuth.routes.ts:70-97` |
| S6 | Medium | Any authenticated user can unlock/revoke any session by ID (no ownership check). | `sso.routes.ts:227-246` |
| S7 | Medium | OIDC client secret stored plaintext in field named `clientSecretEncrypted`. | `sso.routes.ts:55` |
| S8 | Medium | Refresh token also returned in JSON body, undermining the HttpOnly cookie. | `auth.routes.ts:262, 332` |
| S9 | Low | `/api/v1/media/auth` reachable via Caddy (only `/api/v1/internal/*` blocked). Internal secret comparison not constant-time. | `Caddyfile`, `internal.routes.ts:16` |
| S10 | Low | Synthetic camera hard-codes the dev internal secret. | `docker-compose.yml` |

### Architectural risks (not proven exploitable)
- Fail-open audit chain makes it unsafe to rely on legally.
- Dev fallback encryption key in source (`env.ts:63`); guarded in production mode, but it's the Compose default.
- Relay "STATE_CONFIRMED" false positive is a physical-safety risk, not just a data risk.

### Hardening recommendations
- One JWT audience per token type.
- Use `openid-client` for OIDC.
- `npm audit` + SBOM in CI.
- Fail closed on audit writes.
- CSP review for the WHEP origin.

---

## 5. Testing & QA Assessment

**Claimed:** 262/262 tests passing across 50 suites.

**Observed:** backend `tsc --noEmit` clean. Full Jest run crashed in the audit sandbox (Prisma engine blocked). Partial results as noted in the scope section, including one genuine assertion mismatch at `storageVolumeManager.test.ts:176`.

**What the tests are:** almost entirely unit tests against mocked Prisma (`__tests__/setup.ts`). They prove pure logic is internally consistent.

**What they cannot catch** (every critical defect above fits here): missing migrations, the broken webhook, unwired services, installer failures, real camera behavior, the SSO bypass.

**Missing:** CI, frontend tests, E2E against the Compose stack, migration tests, real-camera hardware tests, load tests on real media (`loadStress` simulates), security tests. `scripts/__tests__/installer.test.sh` exists but was not run.

---

## 6. Deployment & Operations Assessment

**Could a competent engineer deploy this tomorrow without fixing the application? No.** In the order you'd hit them:

1. **No baseline migration.** All three migrations `ALTER` pre-existing tables (first one touches `ChainOfCustodyLog`). `prisma migrate deploy` on an empty DB fails; nothing else creates the 51-model schema.
2. **Installer never places the application in `/opt/vigilone`** (no clone or copy step) yet runs Compose there. It swallows every failure (`2>/dev/null || true`, `install.sh:441-447`) and prints "Successfully Completed" regardless.
3. **Non-reproducible runtime image.** Prisma CLI is a devDependency; runtime stage runs `npm ci --omit=dev && npx prisma generate`, so `npx` fetches whatever Prisma is current at build time. Outcome unverified, but risky.
4. **Segment webhook can never authenticate** (section 2).
5. **Upgrades don't update the frontend.** `frontend_dist` named volume is mounted at `/srv/frontend`; after first install the old volume masks the new image, and `cp` writes into an unmounted `/dist`.
6. **`vigilonectl update` doesn't work as described.** `docker compose pull` on locally built images with no registry; "rollback" is `down` + `up` of the same images.
7. **TLS by LAN IP unverified.** Caddy `tls internal` with a `:443` catch-all likely needs `on_demand` for IP certs. `/etc/vigilone/ssl` mount is unused.

**Good pieces:** healthchecks, resource limits, log rotation, non-root containers, metrics endpoint, sanitized support bundle, Grafana/alerts spec (wiring unverified).

---

## 7. Commercial / Product Readiness

**Needed for a v1 edge NVR:**
- **Licensing:** real activation with keys held off-box, hardware binding (`deviceBinding` field exists, no enforcement seen), trial expiry. Current bootstrap gives away perpetual Enterprise.
- **Installer:** reproducible versioned release artifacts; signed update channel; tested backup/restore of config and DB.
- **Camera compatibility matrix:** tested on real Hikvision, Dahua, CP Plus firmware.
- **Customer docs:** installation, technician SOP, troubleshooting.
- **Support path:** remote support, versioning, crash reporting.
- **Legal review** of Section 63 BSA package wording (code does include an admissibility disclaimer).

**Probably not needed for v1:** multi-tenancy, federation, SSO, ANPR, object storage, redaction, floorplans.

---

## 8. Technical Debt

- **Critical:** committed license key (S1); SSO stub (S2); no baseline migration; broken installer; broken segment webhook; fake-success adapters (relay, email, S3, AI telemetry) presented as working.
- **High:** 44 Prisma clients; two automation engines; dead modules claimed as verified (`CameraConnectionManager`, `RecordingWatchdog`, `RecordingIndexer`, `RetentionService`); fail-open audit/custody writes; token model (S4, S5); frontend upgrade path.
- **Medium:** mtime-based timestamps; global email uniqueness; in-memory PKCE and rate-limit state; mock fallbacks in production code.
- **Low:** duplicate shims; hard-coded Keycloak auth path (`sso.routes.ts:106`); constant-time comparisons.

**Root cause:** very fast, AI-assisted generation (`.agents/skills`, 8-day timeline) optimized for feature count and unit-test count over integration. Cost of leaving it: false confidence. Docs and test counts say "done" where the product isn't.

---

## 9. Completion Score

| Dimension | Weight | Why | Completion | Weighted |
|---|---:|---|---:|---:|
| Core pipeline (ingest, record, index, playback, export) | 25% | It's the product | 40% | 10.0 |
| Security & licensing integrity | 15% | Evidence product; S1/S2 | 25% | 3.8 |
| Reliability & data integrity | 15% | Lost footage is fatal | 30% | 4.5 |
| Install / upgrade / recovery | 12% | Appliance model | 15% | 1.8 |
| Testing & QA | 8% | | 25% | 2.0 |
| UX / admin / onboarding | 8% | | 45% | 3.6 |
| Commercial infrastructure | 7% | | 10% | 0.7 |
| Observability & supportability | 5% | | 40% | 2.0 |
| Documentation | 5% | Overclaims | 30% | 1.5 |
| **Total** | **100%** | | | **~29%** |

**Commercialization Readiness: ~29%.**
**Engineering Completion: ~45%.** Lots of real logic written, some of it good. The missing half is wiring, persistence setup, hardware/vendor integrations, packaging, and fixing what's broken.

---

## 10. Remaining Work

| ID | Work item | Category | Priority | Depends on | Effort | Blocks launch? |
|---|---|---|---|---|---|---|
| C-001 | New vendor license keypair off-box; remove runtime signing; replace free Enterprise with time-boxed trial | Security/Licensing | P0 | — | 3–5 d | Yes |
| C-002 | Delete `mockClaims`; disable SSO or rebuild on `openid-client` | Security | P0 | — | 1 d / 2 wk | Yes |
| C-003 | Enforce token `type`/`aud`; per-camera media tokens; session ownership checks; fix case-sensitive secret guard | Security | P0 | — | 1 wk | Yes |
| C-004 | Baseline migration from `schema.prisma`; migration CI on empty DB | Data | P0 | — | 2–3 d | Yes |
| C-005 | Fix MediaMTX webhook secret; E2E: camera → indexed segment | Core | P0 | C-004 | 3–5 d | Yes |
| C-006 | Single shared PrismaClient | Architecture | P0 | — | 2–3 d | Yes |
| C-007 | Rewrite installer: fetch release, fail loudly, migrate before start, verify health | DevOps | P0 | C-004, C-010 | 2 wk | Yes |
| C-008 | Fix frontend volume (bake into Caddy image) | DevOps | P0 | — | 1 d | Yes |
| C-009 | Real update/rollback: versioned images, DB snapshot restore | DevOps | P0 | C-010 | 1–2 wk | Yes |
| C-010 | CI: build, test, image publish, SBOM, `npm audit` | DevOps | P0 | — | 1 wk | Yes |
| C-011 | Playback + export E2E on real footage; filename-based timestamps | Core | P0 | C-005 | 2 wk | Yes |
| C-012 | Audit and custody writes fail closed | Data integrity | P0 | C-006 | 3 d | Yes |
| C-013 | Remove or feature-flag fake adapters (relay, email, S3, ANPR telemetry) | Honesty/Safety | P0 | — | 2–3 d | Yes |
| C-014 | Real-camera matrix (Hikvision, Dahua, CP Plus, ONVIF); 7-day soak | QA | P0 | C-005 | 3–4 wk | Yes |
| C-015 | Disk-full, power-loss, retention-with-pins tests on real disks | Reliability | P0 | C-011 | 1–2 wk | Yes |
| C-016 | Backup/restore drill (config + DB) | DR | P0 | C-004 | 1 wk | Yes |
| C-017 | One automation engine; wire motion events into it | Architecture | P1 | C-006 | 2 wk | No |
| C-018 | Wire or delete dead modules | Debt | P1 | — | 1 wk | No |
| C-019 | Rewrite README / PROJECT_STATE to match reality | Docs | P1 | all | 3 d | Yes (sales) |
| C-020 | Technician install guide, troubleshooting, admin guide | Docs | P1 | C-007 | 1–2 wk | Yes |
| C-021 | Legal review of BSA package wording | Commercial | P1 | C-011 | external | Likely |
| C-022 | Frontend smoke E2E (Playwright) | QA | P1 | C-007 | 1 wk | No |
| C-023 | Real SMTP, or drop email | Feature | P2 | — | 3 d | No |
| C-024 | Real relay driver (vendor I/O box) | Feature | P2 | hardware | 2 wk | No |
| C-025 | S3 archive via AWS SDK | Feature | P3 | — | 1–2 wk | No |
| C-026 | Federation / CMS with real tunnel + edge client | Feature | P3 | stable core | 2–3 mo | No |
| C-027 | ANPR inference pipeline | Feature | P3 | stable core | 2–4 mo | No |

---

## 11. Critical Path

**Security track:** C-001 + C-002 + C-003 (week 1)

**Pipeline track:** C-004 baseline migration → C-006 single client → C-005 webhook fix → C-011 playback/export E2E → C-014 real-camera soak + C-015 failure tests

**Converge:** C-010 CI + images → C-007 installer → C-009 upgrade/rollback → C-016 DR drill → C-019/C-020 docs → launch gate

**Irreducible before first paying customer:** C-001–C-005, C-007, C-009, C-011, C-012, C-013, C-014–C-016, C-020.

---

## 12. Roadmap to 100% (narrow v1 core NVR, 2 senior engineers)

v1 scope: live view, recording, schedules, playback, hashed export, users/RBAC, licensing, installer and upgrades.

| Stage | Work | Exit criteria | Readiness after |
|---|---|---|---|
| **0. Contain** (1 wk) | C-001, C-002, C-003, C-013 | No known critical vulns; fake features hidden | ~33% |
| **1. Make it install** (3 wk) | C-004, C-006, C-008, C-010 | Fresh VM → working UI from published image, in CI | ~42% |
| **2. Make the core true** (4 wk) | C-005, C-011, C-012, C-018 | Camera → segment → index → playback → export verified E2E | ~55% |
| **3. Prove it** (4 wk, overlaps) | C-014, C-015, C-022 | 7-day soak on 4 vendors; power-loss and disk-full pass | ~68% |
| **4. Operationalize** (3 wk) | C-007, C-009, C-016 | Install, upgrade, rollback, restore drilled on hardware | ~80% |
| **5. Commercialize** (2–3 wk) | Licensing activation, C-019, C-020, C-021 | Technician installs from docs alone | ~90% |
| **6. Pilot** (4–6 wk) | 1–2 friendly sites, fix-forward | 30 days, zero footage loss | ~100% for v1 |

Realistic total: **~4–5 months** to a sellable core NVR. Full README scope: 9–12+ months.

---

## 13. Commercial Launch Gate (all must be true)

- [ ] No committed secrets; license key rotated; signing happens off-appliance
- [ ] No endpoint trusts client-supplied identity or claims
- [ ] Fresh install from a published release succeeds with zero manual steps, fails loudly on error
- [ ] `prisma migrate deploy` passes on empty DB and on upgrade from previous release, in CI
- [ ] Every recorded segment indexed within 60 s (webhook verified)
- [ ] Playback and export verified on footage from each supported vendor
- [ ] 7-day soak on 16 cameras: no gaps beyond threshold, no memory growth, no DB connection exhaustion
- [ ] Power-loss and disk-full tests pass with zero loss of pinned evidence
- [ ] Upgrade and rollback drilled; backup and restore drilled
- [ ] No feature reports success it didn't achieve (relay, email, archive)
- [ ] Audit and custody writes fail closed
- [ ] Docs match implementation; technician guide tested by someone outside the team
- [ ] BSA package wording reviewed by counsel

---

## 14. Bottom Line

1. **Built:** ~45% of engineering work.
2. **Remaining:** ~55% of engineering; ~71% of the distance to commercial readiness.
3. **Biggest gaps:** install/migrate/upgrade; recording-index pipeline; auth and licensing integrity; real-hardware validation.
4. **Hidden risks:** fake-success adapters misleading operators (a gate "confirmed" open that never moved); fail-open audit logging; docs labeling unwired code "Verified."
5. **Major rework risk:** unneeded multi-tenancy; two automation engines; 44 DB clients; migration history that must be re-baselined before any customer data exists (do it now).
6. **Before first paying customer:** section 11 critical path, real-camera soak, drilled upgrade and restore.
7. **Safe to defer:** federation, ANPR, S3 archive, SSO, redaction, floorplans, spatial analytics, relays.
8. **Most efficient path:** freeze features, cut to a core NVR, fix security and packaging first, then prove the recording pipeline on real cameras. Breadth is this repo's biggest liability; shrinking scope is the fastest route to sellable.

### First action: rotate the license key

Run on a machine that never touches the repo:

```bash
openssl genpkey -algorithm ed25519 -out ~/vigilone_vendor_license_private.pem
openssl pkey -in ~/vigilone_vendor_license_private.pem -pubout -out ~/vigilone_vendor_license_public.pem
```

Put only the public key into `backend/src/config/licenseKeys.ts` and delete `DEV_VENDOR_LICENSE_PRIVATE_KEY`.
