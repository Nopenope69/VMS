# Master Commercialization Execution Contract & Implementation Plan

> **Status:** FROZEN MASTER EXECUTION CONTRACT (v1.0 Immutable)  
> **Rating:** 9.7/10 Hardened  
> **Authority:** Derived from [`docs/audits/CRITIQUE_DETAILED_AND_PATH_FORWARD_2026-09-11.md`](./CRITIQUE_DETAILED_AND_PATH_FORWARD_2026-09-11.md) and finalized through architectural synthesis on 2026-09-12.  
> **Core Mandate:** Freeze non-essential feature sprawl (federation, ANPR, S3 archive, SSO, redaction, floorplans, relays). Deliver the narrow **v1 core NVR**: Live View, Continuous & Scheduled Recording, Segment Indexing, Playback, Section 63 BSA Evidentiary Export, RBAC, Offline Licensing, and Zero-Terminal Appliance Deployment.  
> **Execution Rule:** Do not invent scope. Do not declare completion based on implementation alone. Execute stage-by-stage, produce objective evidence, and advance a gate only when its acceptance criteria and independent verification are complete.

---

## 1. Governance & Assessment Framework

### 1.1 Terminology Ladder
Replaces ambiguous "100% Production Ready" claims with an unambiguous milestone progression:

```
Engineering Complete  ──>  Pilot Ready  ──>  Field-Validated  ──>  First Paid Deployment  ──>  Repeatable Commercial Deployment
```

1. **Engineering Complete:** Every mandatory technical gate through Stage 4 has documented objective evidence; zero open Sev-1/Sev-2 findings; automated CI regression suites pass.
2. **Pilot Ready:** Engineering is complete, hardened, and accompanied by technician SOPs, admin guides, support/escalation paths, and legal review of evidence-export claims. Safe for controlled field installation.
3. **Field-Validated:** Controlled real-world validation has run to completion: the real-camera matrix and multi-week soak tests have met their measurable failure envelopes (calendar-bound).
4. **First Paid Deployment:** Exactly one paying customer live in production. Validates commercial willingness to pay, not broad repeatability.
5. **Repeatable Commercial Deployment (The Finish Line):** An independent third-party technician who did not build the appliance can install, configure, upgrade, troubleshoot, and recover it purely from documentation, with zero engineering intervention **for all documented supported workflows; defects outside the documented support boundary may be escalated.**

---

### 1.2 Two-Axis Readiness Scoring
Engineering effort cannot compress elapsed calendar time (e.g. a 30-day soak test requires 30 days). Progress is tracked on two strictly decoupled axes:

#### Axis 1: Implementation & Readiness Completion (Weighted Gates, advances with effort)
| Gate | Weight | Focus & Deliverables |
|---|:---:|---|
| **Security & Isolation** | 20% | Auth, token types, tenant boundary isolation, license cryptographic root |
| **Core Recording & Replay Pipeline** | 20% | MediaMTX ingest, webhook indexing, filename timestamps, playback engine |
| **Storage Reliability & Recovery** | 20% | Mount guard, multi-volume fallback, disk-full degradation, crash moov repair |
| **Deployment, Upgrades & Packaging** | 15% | Baseline migration, Caddy frontend bundle, signed OTA updates, rollback |
| **Evidence Integrity & Auditability** | 10% | Merkle tree, fail-closed custody & audit chains, Section 63 BSA manifest |
| **Operations & Supportability** | 10% | Support bundle sanitizer, metrics, stream watchdog, clock guard |
| **Documentation, Legal & Commercial** | 5% | Technician manual, BSA legal wording review, licensing policy |
| **Total** | **100%** | |

> [!CAUTION]
> **Mandatory Blocker Rule:** Weighted scoring **cannot** override mandatory blockers. Any open Sev-1/Sev-2 defect, unresolved tenant-isolation leak, untrusted licensing key, unrecoverable evidence-integrity flaw, or failed supported-camera recording path **caps the release state at Incomplete regardless of numerical score.**

#### Axis 2: Field-Validated % (Calendar-Bound, advances only with elapsed real running time)
- **Real-Camera Soak Hours:** `[Elapsed Hours / Required Soak Hours]` (Target: 168 hours / 7 days continuous on 16 cameras per vendor).
- **Pilot Site Days:** `[Elapsed Production Days / Required Pilot Days]` (Target: 30 consecutive days with zero unrecoverable footage loss).
- *Rule: Axis 2 metrics are never averaged into Axis 1.*

---

### 1.3 Cross-Cutting Non-Negotiables

1. **Grounded Execution (Anti-Slop / Anti-Fake Principle):**
   No code path may report success without the underlying capability existing. Status codes must accurately reflect operational reality:
   - **Unimplemented capability:** `501 Not Implemented`
   - **Malformed or invalid caller input:** `400 Bad Request`
   - **Unauthorized (missing or invalid credentials):** `401 Unauthorized`
   - **Authenticated but disallowed (RBAC/tenant restriction):** `403 Forbidden`
   - *Admission Control Rule:* Input authenticity and object ownership must also be verified before accepting externally supplied state as authoritative; the system must not create valid domain records merely because a syntactically valid file, event, or identifier exists.
   - *Audit Standard:* Audit all explicit success returns associated with missing drivers, unimplemented integrations, fallback/mock adapters, exception/catch paths, placeholder implementations, or simulated telemetry; additionally search for `{confirmed:true}`, `{ok:true}`, `{success:true}`, and HTTP 200/250 responses occurring in those contexts.
2. **Operational Independent Verifier:**
   Every critical gate and stage exit must be verified by someone independent of the implementation of that specific change.
   - *Designated Verifier Role:* The verifier must be a concrete designated functional role independent of code authoring and direct pull-request review (e.g. Dedicated QA Engineer, SecOps Verification Auditor, or Independent Technical Assessor). The verifier cannot be the primary implementer or reviewer of the affected change and must independently reproduce the acceptance test from the documented procedure.
   - *Audit Trail:* Every gate sign-off logs:
     `Implementer ──> Reviewer ──> Independent Verifier Role & Identity ──> Evidence Artifact ──> Verification Result ──> Date`
3. **Permanent CI Boundary Regressions:**
   Any fix for a security boundary violation (tenant isolation, token privilege, license tampering) must immediately ship with a dedicated automated test wired into the CI pipeline to permanently prevent regressions.
4. **Compromise-Resilient Key Transition:**
   Key rotation mechanisms cannot assume the superseded private key is trusted. A rotation signed solely by a compromised vendor key is rejected. Key transitions must rely on an offline root trust anchor or out-of-band manual re-provisioning of the appliance trust store.
5. **Permanent Automated Secret Scanning & Key History Sanitization in CI:**
   - Search current repository contents, Git history, build artifacts, container layers, CI artifacts and deployment bundles for the historical private key. Treat any historical occurrence as permanently compromised. Remove it from all distributable/current artifacts; where repository history is intended for external distribution, rewrite/purge affected history and invalidate the old key. Future trust must never depend on the historical key.
   - CI workflows must include an automated secret-scanning check preventing the introduction of private signing keys, known compromised key material, production secrets, and prohibited development credentials (enforcing `secretsAudit.test.ts` and static credential scanning on all pull requests and branch pushes).

---

## 2. Stage-by-Stage Roadmap & Verification Gates

```
Stage 0: Contain (Week 1)
  ├── Rotate vendor license keys (offline root / untrusted old key assumption)
  ├── Full licensing lifecycle model (local trial entitlement vs signed commercial artifact)
  ├── Secret & commit history scan (purge all private key references)
  ├── Hard-disable SSO routes & purge attack surface
  ├── Strict token types (ACCESS / REFRESH / MEDIA) & tenant isolation
  └── Repo-wide audit & remediation of systemic fake-success returns
          │
          ▼
Stage 1: Make It Install (Weeks 2-4)
  ├── Baseline PostgreSQL migration for clean DB install
  ├── Single shared PrismaClient singleton
  ├── Bake frontend assets into Caddy container
  └── CI pipeline with mandatory boundary-isolation regression tests
          │
          ▼
Stage 2: Make the Core True (Weeks 5-8)
  ├── Fix MediaMTX webhook secret injection & reliable indexing
  ├── Switch segment timestamps to filename-based authority
  ├── Fail-closed custody ledger & audit chain
  ├── Wire canary real camera (smoke test against physical RTSP stream)
  └── Establish storage reliability & time-integrity envelopes
          │
          ▼
Stage 3: Prove It (Weeks 9-12, calendar-bound)
  ├── 4-Vendor hardware matrix (Hikvision, Dahua, CP Plus, ONVIF Profile S/T)
  ├── 7-day soak test against concrete failure envelope (reconnect <= 15s, gap <= 30s)
  └── Playwright frontend smoke & operations validation
          │
          ▼
Stage 4: Operationalize (Weeks 13-15)
  ├── Zero-terminal installer with strict error exit
  ├── Signed OTA update mechanism with rollback & downgrade protection
  └── End-to-end disaster recovery & database restore drill
          │
          ▼
Stage 5: Commercialize & Pilot Ready (Weeks 16-17)
  ├── Full evidence manifest package binding video -> hash -> manifest -> user -> custody
  ├── External legal review of admissibility wording & disclaimer
  └── Complete commercial operability checklist (warranty, escalation, handover, backup/restore)
          │
          ▼
Stage 6: Controlled Pilot (Weeks 18-22, calendar-bound)
  └── 1-2 live customer deployments for 30 consecutive days with zero footage loss
```

---

## 3. Concrete Specifications for Core Envelopes

### 3.1 Stage 3 Measurable Failure Envelope
To eliminate ambiguity around "zero footage loss", the system's resilience is tested against these concrete limits:

| Failure Mode | Acceptance Criterion | Concrete Metric / Threshold |
|---|---|---|
| **Graceful application restart** | 0 unrecoverable footage; pipeline resumes immediately | Recording gap $\le 5\text{ seconds}$; 0 orphaned segments |
| **Process crash** | Auto-recovery via systemd/Docker; repair incomplete MP4s | Boot-time FFmpeg moov repair completes in $\le 60\text{ seconds}$; no loss of prior completed segments |
| **Power interruption** | Unscheduled shutdown and recovery | After power restoration, ingestion resumes in $\le 30\text{ seconds}$; 0 previously completed footage unrecoverably lost (the unavoidable outage interval is reported separately as outage duration, not conflated with recovery latency) |
| **Camera network drop** | Network cable disconnect / RTSP disconnect | Reconnect $\le 15\text{ seconds}$ after network restoration; backoff capped at 30s |
| **Disk full condition** | Storage reaches 95% capacity; Hard-full at 100% capacity | **At 95% capacity:** Priority retention ladder activates; Section 63 pinned legal evidence is 100% preserved (0 deletions).<br>**At 100% capacity / write failure:** No deletion outside the retention policy is permitted; new recording attempts fail explicitly, pinned evidence remains protected, and the operator receives a critical storage alarm. |
| **Disk removal / I/O fault** | Storage volume unmounted or enters read-only (EROFS) | Mount Guard trips in $\le 5\text{ seconds}$. If the active recording volume fails, route subsequent recordings to the next healthy configured recording volume according to the storage priority order; if no healthy volume exists, fail closed and raise an explicit recording-storage alarm; 0 silent discards. |
| **Corrupt / partial segment** | Truncated segment or invalid atom structure | Detected, logged, and quarantined to `/recordings/.quarantine` in $\le 60\text{ seconds}$ without index crash. |
| **DB / Media divergence** | Segments exist on disk but missing in DB or vice-versa | 5-minute background reconciliation identifies 100% of discrepancies and executes deterministic resolution ladder. |

### 3.1.1 64-Camera Soak Workload Specification
To ensure strict reproducibility and separate camera compatibility from appliance capacity:
- **Topology:** 16 streams per cohort across 3 primary hardware manufacturers (Hikvision, Dahua, CP Plus) and 1 cohort of 16 ONVIF Profile S/T-compliant cameras from one or more non-primary vendors, with exact manufacturer/model/firmware recorded = 64 concurrent streams.
- **Workload Profile Parameters (Mandatory in test reporting):**
  - **Camera Model & Firmware:** Exact hardware model and tested firmware version.
  - **Resolution & Frame Rate:** Primary stream 1080p (1920x1080) @ 25 FPS; secondary substream 360p (640x360) @ 10 FPS.
  - **Codec & Compression:** H.264 Baseline/Main; H.265 Main/Main10 where supported by the selected camera set.
  - **Bitrate & Rate Control:** VBR / CBR with explicit target bitrate (e.g. 2.5 Mbps primary, 512 kbps secondary).
  - **GOP & Keyframe Interval:** GOP length = 2× frame rate (50 frames / 2.0s keyframe interval).
  - **RTSP Transport:** TCP transport (interleaved RTP over RTSP).
  - **Recording Mode:** 24/7 continuous segmented recording (fMP4, 10-minute segment duration, 1-second part duration).
  - **Storage Configuration:** Direct-attached storage pool (ext4, write-optimized flags, Mount Guard probe active).
  - **Appliance Hardware SKU:** CPU model, physical core count, RAM capacity, and drive interface (SATA/NVMe).

> [!IMPORTANT]
> **Claim Separation Rule:** Camera compatibility and appliance capacity are strictly separate claims. Passing 1 camera on a vendor firmware validates protocol compatibility; maintaining 64 concurrent streams validates appliance hardware sizing and pipeline throughput.

### 3.1.2 Database and Media Reconciliation Ladder & Quarantine Accounting
Reconciliation runs periodically (every 5 minutes) and at boot/startup. It categorizes and acts upon discrepancies according to four explicit states:
1. **Orphan Media on Disk (File exists, DB record missing):**
   - **Orphan-Media Admission Control:** Before indexing orphan media, the reconciler must resolve the filesystem path to a configured camera/path identity and verify the camera remains active and belongs to the expected tenant. Files that cannot be deterministically mapped are quarantined and never indexed.
   - If admitted: parse fMP4 metadata, extract start/end timestamps from filename and duration, calculate SHA-256 hash, and index the segment into the database.
2. **Missing Media File (DB record exists, file unreadable/deleted):** Mark segment state in database as `FILE_MISSING`, decrement healthy storage metrics, and emit a high-priority system telemetry alert.
3. **Corrupt Media File (Invalid atoms or truncated moov):** Execute FFmpeg repair; if unrecoverable, quarantine to `/recordings/.quarantine` and mark segment state as `CORRUPTED`.
4. **Valid DB/Media Pair:** Reconcile and confirm file size, segment bounds, and cryptographic hash.

> [!NOTE]
> **Quarantine Storage Accounting & Evidence Invariant:** Files in `/recordings/.quarantine` count toward total disk utilization, but must be bounded by a separate quarantine cap (default 5% of storage volume).
> **Evidence-Pinned Protection Invariant:** Evidence-pinned files, including quarantined evidence artifacts, are **never** automatically pruned. If pinned quarantine content causes the quarantine cap to be exceeded, the system raises a critical storage alarm and requires operator intervention rather than deleting pinned evidence. Non-pinned corrupt files are pruned by age only if the quarantine cap is reached.

> [!CAUTION]
> **Anti-Fake Invariant:** Reconciliation must never fabricate a media record, simulate missing bytes, or mark missing footage as healthy.

---

### 3.2 Full Licensing Lifecycle Specification (C-001)

The licensing system must govern the complete commercial lifecycle without ambiguity:

1. **Root Trust Anchor & `kid`:**
   - Public key embedded into appliance config with explicit key identifier (e.g. `kid: "root-2026-09"`).
   - Signatures without a recognized `kid` or signed with an unapproved key are rejected.
2. **Two Separate States (Local Entitlement vs. Signed Cryptographic Artifact):**
   - **Local Evaluation Trial:** Modeled as a local database entitlement state (`tenant.isTrial = true`, `tenant.trialEndsAt = tenant.createdAt + 30 days`, `maxCameras = 4`, `tier = BASIC`). It does **not** generate or require a fake unsigned license artifact pretending to be cryptographic.
   - **Commercial License:** Requires an authentic Ed25519-signed artifact verified against `VENDOR_LICENSE_PUBLIC_KEY`.
3. **Trial-to-Commercial Transition:**
   - Activating a signed commercial license via `POST /api/v1/license/activate` or `vigilonectl license activate <file>` replaces the local trial state, setting `tenant.isTrial = false` and recording the license in `License` table with SHA-256 audit log.
4. **License Expiration Behavior:**
   - When `now > expiresAt`: camera onboarding and tier-gated settings are blocked (`402 LICENSE_EXPIRED`).
   - *Surveillance Continuity Invariant:* Live video viewing and existing recording playback **must continue indefinitely**, even on expired licenses.
5. **Clock Rollback Protection & Protected Host State:**
   - `ClockGuard` tracks monotonic time and the maximum observed valid timestamp (`lastKnownGoodTime`).
   - **Persistent Storage Invariant:** `lastKnownGoodTime` is persisted in protected appliance host state (`/etc/vigilone/clock_guard.state`, `chmod 600`) outside the rebuildable PostgreSQL database.
   - It survives ordinary database rebuilds, reinstallations, and container restarts, subject to the supported recovery model. This ensures a database rebuild cannot reset or bypass the clock rollback protection.
   - If system clock is set back before `lastKnownGoodTime` or before license `issuedAt`, the appliance flags `CLOCK_TAMPER_DETECTED` and freezes the license expiration clock at the high-water mark.
6. **Device Hardware Binding:**
   - Commercial licenses can optionally contain `deviceBinding: "<machine-uuid>"`.
   - The appliance verifies this against `/etc/machine-id` or system board DMI UUID; mismatch returns `400 HARDWARE_BINDING_MISMATCH`.
7. **Revocation Strategy:**
   - Appliance maintains a local revocation blacklist table (`RevokedLicense`). Uploading a license revocation artifact immediately invalidates compromised or superseded license IDs.
8. **Appliance Reinstall & Backup Persistence:**
   - Active commercial licenses are automatically mirrored to `/etc/vigilone/license.json` (`chmod 600`).
   - On appliance reinstallation or database rebuild, the bootstrap service automatically ingests and validates `/etc/vigilone/license.json`.
9. **Compromise-Resilient Key Rotation & Trust Anchor:**
   - A rotation signed solely by a compromised vendor key is **rejected**.
   - If the active keypair is compromised, field appliances accept new trust anchors **only** via:
     - (a) An offline root trust anchor pre-provisioned in `/etc/vigilone/license_trust_anchor.pem`, OR
     - (b) Explicit out-of-band manual re-provisioning: `vigilonectl license trust-anchor --update <new_pubkey_path>`.
   - *Note:* The licensing system uses an Ed25519 raw public key trust anchor, NOT an X.509 certificate authority (CA) / PKI hierarchy.

---

### 3.3 Stage 5 Evidence-Chain Manifest Acceptance Gate

Before commercial launch, the Section 63 Bharatiya Sakshya Adhiniyam (BSA) evidence package must be validated by independent verification:

1. **Cryptographic Binding Chain:**
   The exported evidence zip archive must cryptographically bind:
   $$\text{Video Segment} \longrightarrow \text{Segment SHA-256 Hash} \longrightarrow \text{Merkle Root} \longrightarrow \text{Manifest JSON} \longrightarrow \text{Camera/Device Identity} \longrightarrow \text{Timestamp (UTC + Local TZ)} \longrightarrow \text{Exporting User Identity} \longrightarrow \text{Export Timestamp} \longrightarrow \text{Chain of Custody Audit Log}$$
2. **Legal & Compliance Review:**
   - External legal counsel reviews and signs off on the **evidentiary characterization and disclaimer wording**.
   - The software must explicitly state it provides a cryptographically verifiable audit trail and custody package under Section 63 BSA, but **does not legally certify judicial admissibility** (which remains the court's sole discretion).

---

### 3.4 Full Commercial Operability Checklist (Stage 5 Gate)

To satisfy the finish-line definition (**Repeatable Commercial Deployment**), the following operational documents and procedures must exist, be verified, and be executable without engineering intervention:

- [ ] **Technician SOP & Installation Manual:** Step-by-step physical hardware setup, static IP assignment, storage initialization.
- [ ] **Installation Acceptance Checklist:** Objective criteria for technicians to sign off an on-site installation.
- [ ] **Hardware Compatibility Matrix:** Validated list of cameras (Hikvision, Dahua, CP Plus, ONVIF Profile S/T firmware baselines), supported switches, and storage drives.
- [ ] **Warranty & Support Policy:** Explicit definitions of hardware warranty, software subscription updates, SLA tiers, and support boundaries.
- [ ] **Support Escalation Procedure:** Documented L1/L2/L3 triage paths, log collection runbooks, and sanitized support bundle generation via `vigilonectl support-bundle`.
- [ ] **Known Limitations Document:** Transparent statement of maximum camera limits, storage limits, and non-supported environments.
- [ ] **Release & Versioning Policy:** Semantic versioning guarantees, update cadence, backward compatibility policies, and deprecation windows.
- [ ] **Customer Handover Procedure:** Formal checklist for credentials handover, initial password reset, and customer sign-off.
- [ ] **Backup & Restore Runbook:** Tested procedure for full configuration and database recovery from cold storage.

---

## 4. Stage 0 Execution Plan: Containment (COMPLETE)

```
Stage 0 Tasks:
[Task 0.1] C-001: Compromise-Resilient License Key Rotation & Offline Minting Tool (COMPLETE)
[Task 0.2] C-002: Hard-Disable SSO & Attack Surface Elimination (COMPLETE)
[Task 0.3] C-003: Token Model Hygiene, Tenant Boundary Enforcement, & Secret Guard (COMPLETE)
[Task 0.4] C-013: Systemic Fake-Success Audit & Adapter Hardening (COMPLETE)
[Task 0.5] Verification Gate 0: Independent Verification, Secret History Scan & Evidence Pack (COMPLETE)
```

---

## 5. Stage 1 Execution Plan: Make It Install (COMPLETE)

```
Stage 1 Tasks:
[Task 1.1] C-004: Baseline Migration & DB Initialization (COMPLETE)
[Task 1.2] C-006: Prisma Client Singleton Hardening (COMPLETE)
[Task 1.3] C-008: Caddy / Docker Frontend Volume Fix (Bake into Caddy image) (COMPLETE)
[Task 1.4] C-010: CI Pipeline Construction (.github/workflows/ci.yml) (COMPLETE)
[Task 1.5] Installer Script Hardening & Offline Idempotency (Audit Section 6 / Deployment Pre-requisite) (COMPLETE)
[Task 1.6] Verification Gate 1: Independent Verification & Evidence Pack Assembly (COMPLETE)
```

---

## 6. Stage 2 Execution Plan: Make the Core True (NEXT UP)

```
Stage 2 Tasks:
[Task 2.1] MediaMTX Webhook Secret Injection & Ingestion Path (C-005)
[Task 2.2] Filename-Based Authority for Timestamps (C-011)
[Task 2.3] Fail-Closed Custody Ledger & Audit Chain (C-012)
[Task 2.4] Storage Reliability & Mount Guard Trip Envelopes (C-018)
[Task 2.5] Mandatory Physical RTSP Camera Smoke Test & Verification Gate 2
```

### Task 2.1: MediaMTX Webhook Secret Injection & Ingestion Path (C-005)
- **Ingestion Pipeline:** MediaMTX calls `POST /api/v1/internal/segment-complete` via `runOnRecordSegmentComplete`.
- **Timing-Safe Authentication:** In `backend/src/routes/internal.routes.ts`, enforce constant-time comparison (`crypto.timingSafeEqual`) on `INTERNAL_API_SECRET` with buffer length checking. Status code: `401 Unauthorized` for missing/malformed Bearer header; `403 Forbidden` for invalid secret.
- **Durable Segment Job:** Idempotently upsert `SegmentJob` (`status: JobStatus.PENDING`).
- **Worker Execution:** `SegmentJobWorkerService` claims jobs (`status: PROCESSING`), probes media via native FFmpeg, computes streaming SHA-256 hash, and indexes into `RecordingSegment` (`status: FINALIZED`).

### Task 2.2: Filename-Based Authority for Timestamps (C-011)
- **Authoritative Timestamp Origin:** Segments must never derive `startTime` or `endTime` from filesystem `mtime` (which mutates during repair, backup, and sync).
- **Filename Parser:** Implement `backend/src/utils/segmentPath.ts` to parse UTC start times from MediaMTX naming convention (`/recordings/%path/%Y-%m-%d_%H-%M-%S-%f`).
- **Time Boundary Invariant:** `startTime = parseSegmentFilenameTimestamp(filePath)`. `endTime = new Date(startTime.getTime() + durationMs)`.
- **Pipeline Integration:** Wire filename timestamp authority into `SegmentJobWorkerService`, `RecordingCatalog.registerSegment()`, `reconcileFilesystem()`, and playback range/seek queries.

### Task 2.3: Fail-Closed Custody Ledger & Audit Chain (C-012)
- **Eliminate Silent Failure:** Purge all `catch {}` blocks that swallow audit or custody write errors across `AuditChainService`, `CustodyLedger`, `auth.routes.ts` (`/bootstrap`, `/login`), and `retentionPolicy.ts`.
- **Transactional Integrity:** If PostgreSQL transactional advisory lock (`pg_advisory_xact_lock`) or event hash write fails, abort transaction and fail closed.
- **Evidentiary Export Fail-Closed:** Remove fake placeholder generation (`VIGILONE_STRUCTURED_EVIDENCE_MEDIA_PAYLOAD`) in `packageAssembler.ts` and `evidenceArchive.service.ts`. If requested footage or disk file is missing, fail closed with explicit error (`NO_RECORDING_SEGMENTS_FOUND` / `404`).
- **Retention Fail-Closed:** If database constraint checks fail during retention evaluation, do not delete any files via unverified in-memory fallbacks.

### Task 2.4: Storage Reliability & Mount Guard Trip Envelopes (C-018)
- **4-State Reconciliation Ladder (Section 3.1.2):**
  1. *Orphan Media on Disk:* Verify camera and tenant ownership via path admission control; unmappable files quarantined. For valid orphan files: parse filename timestamp + FFmpeg probe + SHA-256 $\to$ index into database.
  2. *Missing Media File:* Mark segment `FILE_MISSING`, decrement healthy storage metrics, raise system warning.
  3. *Corrupt Media File:* Execute FFmpeg repair; if unrepairable, quarantine to `/recordings/.quarantine` and mark `CORRUPTED`.
  4. *Valid DB/Media Pair:* Confirm size, bounds, and SHA-256 hash.
- **Mount Guard & Hard-Full Envelopes:**
  - Mount Guard active R/W probe trips in $\le 5$s on EROFS or unmount.
  - If active recording volume fails, route subsequent recordings to the next healthy configured recording volume according to the storage priority order; if no healthy volume exists, fail closed and raise an explicit recording-storage alarm.
  - At 100% capacity / filesystem write failure, no deletion outside retention policy is permitted; new recording attempts fail explicitly, pinned evidence remains protected, and operator receives critical storage alarm.
  - Quarantine storage accounting: `/recordings/.quarantine` files count toward disk usage and are capped at 5% of volume; pinned quarantine evidence is **never** automatically pruned.
- **Lifecycle Wiring:** Wire `RecordingWatchdogService` into `server.ts` boot and shutdown; wire `CameraConnectionManager` into stream reconnect logic.

### Task 2.5: Mandatory Physical RTSP Camera Smoke Test & Verification Gate 2
- **Mandatory Physical Hardware Invariant:**
  > **A real physical camera RTSP feed is mandatory for Stage 2 exit. Synthetic streams may be used for deterministic automated tests but cannot satisfy the canary acceptance criterion.**
  > At least one supported physical camera must successfully complete: RTSP ingest → segment creation → webhook → indexing → playback → evidence export.
- **Separation of Concerns (Stage 2 vs Stage 5):**
  - **Stage 2 Smoke Test:** Proves the evidence pipeline technically produces a non-empty, cryptographically bound package under real stream ingest.
  - **Stage 5 Final Gate:** Proves the complete evidence manifest, custody semantics, export metadata, audit chain, and legal characterization satisfy statutory Section 63 BSA compliance.
- **Temporal Integrity Verification:**
  - After the real camera produces multiple consecutive segments, verify:
    $$\text{Segment Filename Timestamp} \longrightarrow \text{DB } startTime / endTime \longrightarrow \text{Playback Seek Target} \longrightarrow \text{Exported Package Timestamps}$$
    are mathematically consistent and **strictly independent of filesystem `mtime`**.
- **Stage 2 Verification Deliverable:**
  - Run full backend regression test suite.
  - Assemble `docs/audits/STAGE_2_VERIFICATION_EVIDENCE.md` signed off by independent verifier role.

---

## 7. Long-Lead Dependencies, Procurement & Governance

### 7.1 Externally-Gated Critical Path Items (Initiate in Stage 0/1)
1. **64-Camera Physical Soak Test Rig Procurement:**
   - Procuring 64 physical cameras across 4 target vendors (16x Hikvision, 16x Dahua, 16x CP Plus, 16x ONVIF Profile S/T) and managed PoE switches is a long-lead procurement action.
   - **Action:** Initiate hardware acquisition and rack setup immediately in Stage 0/1 to ensure the soak bench is physically online before Stage 3 entry.
2. **Early Section 63 BSA Legal Framing Review:**
   - Legal review of admissibility wording and statutory disclaimers cannot wait until Stage 5.
   - **Action:** Submit draft statutory disclaimers and Section 63 evidentiary characterization to external legal counsel in Stage 1/2 for early review.
3. **Commercial & Customer Expectation Reset:**
   - **Action:** Align commercial and customer-facing teams immediately: confirm no active sales, pilot, or client agreements assume frozen v2 capabilities (SSO, ANPR ML inference, cloud archive, floorplans, federation, physical relays). All conversations reflect the narrow v1 core edge NVR scope.

### 7.2 Independent Verifier Designation & Audit Protocol
- Self-certification is strictly forbidden.
- For every gate sign-off, the verification must be executed by a designated independent role:
  - **Stage 0 & 1:** Dedicated Security / Systems Auditor.
  - **Stage 2 & 3:** Lead QA Engineer / Field Validation Engineer.
  - **Stage 4 & 5:** External Solutions Architect / Independent Compliance Reviewer.
- Every verification evidence document must record:
  `Implementer Name ──> Code Reviewer Name ──> Independent Verifier Role & Name ──> Test Execution Logs ──> Verification Result (PASS/FAIL) ──> Timestamp`

