# GDPR & DPDP Statutory Privacy Audit: VigilOne Surveillance Platform

> **Audit Type:** GDPR / India DPDP Act 2023 DPO 6-Question Forcing Interrogation  
> **Date:** 2026-10-01  
> **Target Scope:** Edge Surveillance Ingest, ANPR Plate Recognition, Facial Redaction Subsystem, Evidence Packages & Cloud Archival  
> **Governing Standards:** EU GDPR (Regulation (EU) 2016/679), India DPDP Act 2023, Bharatiya Sakshya Adhiniyam 2023 (BSA Section 63)

---

## 1. Article 30 RoPA — Record of Processing Activities

### Status: PARTIALLY MET (Technical Register Implemented; Formal Document Missing)
- **Codebase Evidence:**
  - `backend/src/services/privacy/dataProtection.service.ts` maintains canonical `DATA_PURPOSES` (`SECURITY`, `INVESTIGATION`, `COMPLIANCE`, `ANALYTICS`, `MAINTENANCE`) and enforces purpose-tagging on plate searches and forensic queries.
  - Multi-tenant data segregation is strictly enforced by `tenantId` database scoping across all camera registries and video segment indexes.
- **Article 30(1)(c) Finding:**
  - Automated video decimation and ANPR plate observations lack a statically compiled machine-readable RoPA export covering categories of data subjects (employees, visitors, public pedestrians, vehicle owners).
- **Mandatory Corrective Action:**
  - Provide an exportable `/api/v1/privacy/dpdp/ropa` endpoint consolidating tenant camera counts, storage retention periods, enabled AI models (`ModelManifest`), and categories of personal data captured.

---

## 2. Article 6 & Article 9 Lawful Basis (Biometric Face & ANPR)

### Status: FULLY COMPLIANT (Strict Technological Gates Enforced)
- **Article 6(1) Basis:**
  - Primary processing relies on *Article 6(1)(f) Legitimate Interests* (commercial physical perimeter protection) or *Article 6(1)(e) Public Task* (municipal transit and critical infrastructure).
- **Article 9(1) Special Category Biometric Data:**
  - Facial recognition features are governed under **Article 9(2)(g) Substantial Public Interest** and DPDP Section 4.
  - **Technological Safeguard:** In `backend/src/services/privacy/dataProtection.service.ts`, `faceProcessingEnabled` defaults to `false`. Enabling it requires explicit statutory attestation (`faceAcknowledgement: true`). When disabled, both camera-level face detection and YuNet model loading are blocked at the kernel/process boundary.
- **Purpose Specification (DPDP Section 4 / GDPR Article 5(1)(b)):**
  - Plate searches requiring high sensitivity (`INVESTIGATION`, `COMPLIANCE`) strictly require a statutory incident case ID (`statutoryReference`) before query execution is permitted.

---

## 3. Article 35 DPIA (Data Protection Impact Assessment)

### Status: COMPLIANT WITH INTRINSIC RISK MITIGATIONS
- **High-Risk Processing Triggers (Article 35(3)(c)):**
  - Continuous surveillance of publicly accessible areas and automated ANPR observation matching trigger mandatory DPIA requirements.
- **Mitigations Built Directly into System Architecture:**
  1. **Automated Dual-Target Redaction (`videoRedactor.service.ts`):** Implements dynamic Gaussian blur or solid blackout over human faces (YuNet) and vehicle plates (PP-OCRv4), fulfilling the Article 5(1)(c) *Data Minimization* mandate prior to evidence release.
  2. **Decoupled AI Plane Invariant:** AI inferences and telemetry operate in a separate unprivileged process (`services/ai-worker`) connecting exclusively to local loopback RTSP (`127.0.0.1:8554`).
  3. **Derivative Lineage Binding (P4.5):** Redacted derivative files strictly link back to parent evidence manifests via cryptographically signed `derivation.json` packages, eliminating untracked media manipulation.

---

## 4. Articles 15–22 Data Subject Rights (DSAR & Right to Erasure)

### Status: DEFECT IDENTIFIED & BOUNDED BY LEGAL CLAIMS EXCEPTION
- **Right to Erasure (Article 17) & DPDP Section 12:**
  - `POST /api/v1/privacy/dpdp/purge` prunes unpinned plate observations and telemetry records older than `retentionDays` (default 30 days).
- **Article 17(3)(e) Statutory Exemption (Establishment, Exercise or Defence of Legal Claims):**
  - Segments pinned under active legal leases (`LegalHoldPin` or `TemporaryExportPin`) strictly veto automated pruning and cannot be deleted via tenant purge commands until authorized release.
- **Remaining Open Backlog Item (BACKLOG.md Item 48):**
  - Individual data-principal access and erasure workflows (request intake, verification of individual presence, targeted snippet export/deletion) are currently managed via manual administrative procedures. Automated DSAR ticketing remains on the roadmap.

---

## 5. Chapter V International Transfers (Schrems II Compliance)

### Status: FULLY COMPLIANT (Air-Gapped Edge Architecture)
- **Local Sovereignty:**
  - VigilOne is designed as an air-gapped on-premise NVR appliance. Raw video footage, media segments, and encryption keys never transit third-country boundaries by default.
- **Cloud Archival Safeguards (`objectStorageArchive.service.ts`):**
  - Where S3/MinIO archival is configured by the tenant, pre-flight content-addressed checks (`SHA-256`) prevent redundant transfers, bandwidth rate limiting restricts off-peak transmission, and Section 63 BSA evidence packages remain end-to-end encrypted with appliance-resident Ed25519 signatures.

---

## 6. Article 33(5) Breach Log & Forensic Custody Chain

### Status: FULLY COMPLIANT (Cryptographically Tamper-Evident)
- **Continuous Audit Chain (`CustodyHashChain` & `AuditChainService`):**
  - Every administrative action, redaction execution, export download, camera modification, and permission change is recorded in an immutable PostgreSQL append-only hash chain:
    $$E_n = \text{SHA-256}(E_{n-1}.\text{eventHash} \parallel \text{eventId} \parallel \text{action} \parallel \text{userId} \parallel \text{timestamp} \parallel \text{payloadHash})$$
  - Any out-of-band record tampering or deletion immediately breaks the cryptographic root verification (`verifyChain`).
- **Fail-Closed Security Posture:**
  - Missing output derivative files or hash mismatches automatically transition jobs to `FAILED` with `REDACTION_OUTPUT_TAMPERED` alerts logged directly to the security incident outbox.
