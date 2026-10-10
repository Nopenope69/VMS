# Footage Integrity Part 3 (C2PA-Style Manifests, Sabotage Condition Restore, Per-Camera Sensitivity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Footage Integrity Part 3 by:
1. Re-opening / restoring open camera sabotage conditions across AI worker process restarts so conditions do not remain orphaned or un-cleared.
2. Enabling per-camera sensitivity override thresholds for sabotage detection (hold time, clear time, blinded fraction, flat std, covered similarity, defocus ratio, displacement similarity).
3. Exporting standard C2PA-compliant cryptographic provenance manifests (`c2pa_manifest.json`) in evidence packages for Section 63 BSA court/evidentiary defensibility, with zero third-party dependencies, signed with the appliance Ed25519 key, and verified by `vigilone-verify`.

**Architecture:**
- **Sabotage Condition Recovery:** Backend adds `GET /api/v1/internal/camera-sabotage/open` (internal secret, gated by `FeatureFlag.CAMERA_SABOTAGE`). AI worker StreamSupervisor queries open conditions on startup/reconciliation and initializes `SabotageDetector.restoreActive(cameraId, conditions)`. When the camera view normalizes, the detector emits `state: 'CLEARED'` with the original `startedAt`, allowing backend `CameraSabotageService.cleared` to close the row and emit `CAMERA_TAMPER_CLEARED`.
- **Per-Camera Sabotage Sensitivity:** Migration `20261020000000_camera_sabotage_config` adds `sabotageConfigJson Json?` to `model Camera`. StreamSupervisor passes camera-specific thresholds to `SabotageDetector.setCameraConfig(cameraId, config)` which overrides global detector options.
- **C2PA Manifests:** `c2paManifestBuilder.ts` constructs canonical C2PA claim dictionary adhering to C2PA specification (claims, assertions: `c2pa.actions`, `c2pa.hash.data`, `stds.schema-org.CreativeWork`, `in.gov.bsa.section63`, signed with Ed25519 appliance key). `PackageAssembler` stages `c2pa_manifest.json` as an evidentiary artifact with role `C2PA_MANIFEST`. `vigilone-verify.mjs` verifies `c2pa_manifest.json` offline with `--require-c2pa`.

**Tech Stack:** TypeScript, Node.js / Express, Prisma / PostgreSQL, Node `crypto`, Jest.

**ADR Reference:** `docs/adr/0019-camera-sabotage-detection.md`, `docs/adr/0020-c2pa-export-manifests.md` (to be created).

## Global Constraints

- **Strict Evidence Integrity:** All evidence manifests remain strictly Section 63 BSA compliant without breaking backward compatibility of `manifest.json`.
- **Zero Third-Party Production Dependencies:** C2PA generation is implemented in pure TypeScript/Node `crypto` to avoid GPL/AGPL taint and native binary complications, ensuring 100% compliance with `check:dependency-licenses`.
- **Edge Surveillance Continuity:** Camera sabotage detection and restoration is advisory and must never interrupt recording, live view, or stream acquisition.
- **Fail-Closed & Fail-Loud:** Corrupted frames, unauthorized requests, or mismatched signatures are rejected; all 6 repository quality gates must exit 0.

---

## File Structure & Responsibilities

### Backend (`backend/`)
- `backend/prisma/schema.prisma`: Add `sabotageConfigJson Json?` to `model Camera`.
- `backend/prisma/migrations/20261020000000_camera_sabotage_config/migration.sql`: Schema migration.
- `backend/src/services/camera/cameraSabotage.ts`: Add `getOpenConditions()`, `CameraSabotageConfigSchema`.
- `backend/src/routes/internal.routes.ts`: Add `GET /internal/camera-sabotage/open`, return `sabotageConfig` in `GET /internal/cameras`.
- `backend/src/routes/camera.routes.ts`: Allow updating `sabotageConfigJson`.
- `backend/src/services/evidence/archive/c2paManifestBuilder.ts`: Zero-dependency C2PA claim dictionary builder & signer.
- `backend/src/services/evidence/archive/packageAssembler.ts`: Stage `c2pa_manifest.json` as artifact `C2PA_MANIFEST`.
- `backend/src/services/evidence/archive/evidenceArchive.service.ts`: Wire C2PA manifest builder into export packaging.
- `backend/src/__tests__/cameraSabotageRealDb.test.ts`: Test open condition recovery and per-camera sabotage config.
- `backend/src/__tests__/c2paManifestBuilder.test.ts`: Unit test C2PA generation, canonicalization, and signature verification.

### AI Worker (`services/ai-worker/`)
- `services/ai-worker/src/types.ts`: Update `DiscoveredCamera` with `sabotageConfig?: SabotageCameraConfig`.
- `services/ai-worker/src/apiClient.ts`: Add `fetchOpenSabotageConditions()`.
- `services/ai-worker/src/sabotageDetector.ts`: Add `restoreActive()`, `setCameraConfig()`, per-camera threshold overrides in `classify()` and hold/clear evaluations.
- `services/ai-worker/src/streamSupervisor.ts`: Sync open conditions and per-camera configs during camera reconciliation.
- `services/ai-worker/src/__tests__/sabotageDetector.test.ts`: Unit tests for condition restoration and per-camera thresholds.

### Offline Verifier (`tools/vigilone-verify/`)
- `tools/vigilone-verify/vigilone-verify.mjs`: Add offline verification of `c2pa_manifest.json` (signature, hash binding, assertions).
- `tools/vigilone-verify/__tests__/c2paVerify.test.mjs`: Verification test for C2PA manifest.

### Documentation (`docs/`)
- `docs/adr/0020-c2pa-export-manifests.md`: Architectural decision record for C2PA manifests.
- `docs/operations/CAMERA_SABOTAGE.md`: Document condition recovery and per-camera thresholds.
- `docs/STATUS.md` & `PROJECT_STATE.md`: Update feature status.

---

### Task 1: Re-opening / Restoring Open Sabotage Conditions Across AI Worker Restarts

**Files:**
- Modify: `backend/src/services/camera/cameraSabotage.ts`
- Modify: `backend/src/routes/internal.routes.ts`
- Modify: `services/ai-worker/src/apiClient.ts`
- Modify: `services/ai-worker/src/sabotageDetector.ts`
- Modify: `services/ai-worker/src/streamSupervisor.ts`
- Modify: `backend/src/__tests__/cameraSabotageRealDb.test.ts`
- Modify: `services/ai-worker/src/__tests__/sabotageDetector.test.ts`

**Interfaces:**
- Produces: `CameraSabotageService.getOpenConditions(tenantId?: string)`
- Produces: `GET /api/v1/internal/camera-sabotage/open`
- Produces: `AuthenticatedInternalApiClient.fetchOpenSabotageConditions()`
- Produces: `SabotageDetector.restoreActive(cameraId: string, conditions: Array<{ type: SabotageType; startedAt: Date; confirmedAt: Date; score?: number; threshold?: number }>)`

- [ ] **Step 1: Write failing tests for condition restoration**
In `backend/src/__tests__/cameraSabotageRealDb.test.ts`, add test for `GET /api/v1/internal/camera-sabotage/open` and clearing of a restored condition.
In `services/ai-worker/src/__tests__/sabotageDetector.test.ts`, add unit test for `restoreActive()` verifying that when a normal frame arrives after clearMs, `ended(...)` emits `CLEARED` with the restored `startedAt`.

- [ ] **Step 2: Run tests to verify failure**
Run: `cd backend && npx jest src/__tests__/cameraSabotageRealDb.test.ts -t "open"`
Expected: FAIL

- [ ] **Step 3: Implement backend open condition query & route**
In `backend/src/services/camera/cameraSabotage.ts`, implement `getOpenConditions(tenantId?: string)`.
In `backend/src/routes/internal.routes.ts`, register `GET /internal/camera-sabotage/open` (verifies `INTERNAL_API_SECRET`, checks `isCameraSabotageEnabled`).

- [ ] **Step 4: Implement AI worker client & detector restoreActive**
In `services/ai-worker/src/apiClient.ts`, add `fetchOpenSabotageConditions()`.
In `services/ai-worker/src/sabotageDetector.ts`, add `restoreActive()`.
In `services/ai-worker/src/streamSupervisor.ts`, fetch open conditions on start/sync and call `restoreActive()`.

- [ ] **Step 5: Run tests to verify pass**
Run backend and worker tests to confirm condition restoration passes.

- [ ] **Step 6: Commit Task 1**
```bash
git add backend/src/services/camera/cameraSabotage.ts backend/src/routes/internal.routes.ts services/ai-worker/src/apiClient.ts services/ai-worker/src/sabotageDetector.ts services/ai-worker/src/streamSupervisor.ts backend/src/__tests__/cameraSabotageRealDb.test.ts services/ai-worker/src/__tests__/sabotageDetector.test.ts
git commit -m "feat(camera-sabotage): restore open sabotage conditions across AI worker restarts"
```

---

### Task 2: Per-Camera Sensitivity Override Thresholds for Sabotage Detection

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/20261020000000_camera_sabotage_config/migration.sql`
- Modify: `backend/src/services/camera/cameraSabotage.ts`
- Modify: `backend/src/routes/internal.routes.ts`
- Modify: `services/ai-worker/src/types.ts`
- Modify: `services/ai-worker/src/sabotageDetector.ts`
- Modify: `services/ai-worker/src/streamSupervisor.ts`
- Modify: `backend/src/__tests__/cameraSabotageRealDb.test.ts`
- Modify: `services/ai-worker/src/__tests__/sabotageDetector.test.ts`

**Interfaces:**
- Produces: `sabotageConfigJson` in `model Camera`
- Produces: `CameraSabotageConfigSchema`
- Produces: `SabotageDetector.setCameraConfig(cameraId: string, options?: Partial<SabotageDetectorOptions>)`

- [ ] **Step 1: Write failing tests for per-camera thresholds**
In `services/ai-worker/src/__tests__/sabotageDetector.test.ts`, test that camera A with `flatStd: 8` ignores a frame with `stdLuma: 10`, while camera B with default `flatStd: 12` triggers `OCCLUSION`.
In `backend/src/__tests__/cameraSabotageRealDb.test.ts`, test storing and retrieving `sabotageConfigJson`.

- [ ] **Step 2: Run tests to verify failure**
Run: `cd services/ai-worker && npx jest src/__tests__/sabotageDetector.test.ts -t "per-camera"`
Expected: FAIL

- [ ] **Step 3: Database migration & Prisma generate**
Add `sabotageConfigJson Json?` to `model Camera` in `backend/prisma/schema.prisma`.
Create `backend/prisma/migrations/20261020000000_camera_sabotage_config/migration.sql`.
Run `prisma migrate deploy` and `prisma generate`.

- [ ] **Step 4: Implement per-camera config support in backend & AI worker**
Add `CameraSabotageConfigSchema` in `backend/src/services/camera/cameraSabotage.ts`.
Include `sabotageConfig` in `backend/src/routes/internal.routes.ts` `GET /internal/cameras`.
Update `DiscoveredCamera` in `services/ai-worker/src/types.ts`.
Implement `setCameraConfig()` in `SabotageDetector` and use camera-specific thresholds.
Wire `setCameraConfig()` in `StreamSupervisor.syncCameras()`.

- [ ] **Step 5: Run tests to verify pass**
Run: `cd backend && npx jest src/__tests__/cameraSabotageRealDb.test.ts` and `cd services/ai-worker && npx jest src/__tests__/sabotageDetector.test.ts`.

- [ ] **Step 6: Commit Task 2**
```bash
git add backend/prisma/ backend/src/services/camera/cameraSabotage.ts backend/src/routes/internal.routes.ts services/ai-worker/src/types.ts services/ai-worker/src/sabotageDetector.ts services/ai-worker/src/streamSupervisor.ts backend/src/__tests__/cameraSabotageRealDb.test.ts services/ai-worker/src/__tests__/sabotageDetector.test.ts
git commit -m "feat(camera-sabotage): support per-camera sensitivity thresholds for sabotage detection"
```

---

### Task 3: C2PA-Style Manifests for Exported Evidence Packages

**Files:**
- Create: `backend/src/services/evidence/archive/c2paManifestBuilder.ts`
- Modify: `backend/src/services/evidence/archive/packageAssembler.ts`
- Modify: `backend/src/services/evidence/archive/evidenceArchive.service.ts`
- Modify: `tools/vigilone-verify/vigilone-verify.mjs`
- Create: `backend/src/__tests__/c2paManifestBuilder.test.ts`
- Create: `docs/adr/0020-c2pa-export-manifests.md`
- Modify: `docs/operations/CAMERA_SABOTAGE.md`

**Interfaces:**
- Produces: `buildC2paManifest(input: C2paManifestInput): { manifestJson: string; manifestObj: C2paManifest }`
- Produces: `c2pa_manifest.json` staged in evidence ZIP with role `C2PA_MANIFEST`
- Produces: `vigilone-verify --require-c2pa` validation support

- [ ] **Step 1: Write failing tests for C2PA manifest builder and package verification**
Create `backend/src/__tests__/c2paManifestBuilder.test.ts`:
Test that `buildC2paManifest` generates valid JSON with C2PA 2.2 schema, valid assertions (`c2pa.actions`, `c2pa.hash.data`, `stds.schema-org.CreativeWork`, `in.gov.bsa.section63`), and a valid Ed25519 signature verifiable against the appliance public key.

- [ ] **Step 2: Run test to verify failure**
Run: `cd backend && npx jest src/__tests__/c2paManifestBuilder.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `c2paManifestBuilder.ts`**
Implement canonical C2PA claim dictionary generation adhering to C2PA standard, signed with appliance Ed25519 key, zero new dependencies.

- [ ] **Step 4: Integrate into `PackageAssembler` and `EvidenceArchiveService`**
In `PackageAssembler.assemblePackage`, generate `c2pa_manifest.json` when assembling package, add to artifacts table as role `C2PA_MANIFEST`.
Update `tools/vigilone-verify/vigilone-verify.mjs` to parse and verify `c2pa_manifest.json`.

- [ ] **Step 5: Run tests and offline verifier**
Run: `cd backend && npx jest src/__tests__/c2paManifestBuilder.test.ts src/__tests__/evidencePackageVerifyRealDb.test.ts`
Verify all pass.

- [ ] **Step 6: Document ADR 0020 & operations**
Create `docs/adr/0020-c2pa-export-manifests.md`.
Update `docs/operations/CAMERA_SABOTAGE.md`.

- [ ] **Step 7: Commit Task 3**
```bash
git add backend/src/services/evidence/archive/ backend/src/__tests__/c2paManifestBuilder.test.ts tools/vigilone-verify/ docs/adr/0020-c2pa-export-manifests.md docs/operations/CAMERA_SABOTAGE.md
git commit -m "feat(evidence): add C2PA-style manifests for evidence packages with Section 63 BSA assertions"
```

---

### Task 4: Full Validation Across Quality Gates & Status Updates

**Files:**
- Modify: `docs/STATUS.md`
- Modify: `PROJECT_STATE.md`

- [ ] **Step 1: Run all 6 repository quality gates**
Run:
- `npm --prefix backend run check:hygiene`
- `npm --prefix backend run check:no-fake-success`
- `npm --prefix backend run check:feature-flag-docs`
- `npm --prefix backend run check:dependency-licenses`
- `npm --prefix backend run check:model-licenses`
- `npm --prefix backend run check:status-docs`

- [ ] **Step 2: Update `docs/STATUS.md` and `PROJECT_STATE.md`**
Mark C2PA-style manifests, sabotage condition restore, and per-camera sensitivity as COMPLETE.

- [ ] **Step 3: Commit and push**
```bash
git add docs/STATUS.md PROJECT_STATE.md
git commit -m "docs(status): mark Footage Integrity Part 3 complete"
```
