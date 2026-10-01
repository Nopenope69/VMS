# GDPR and DPDP: technical controls review (VigilOne)

> **Date:** 2026-10-01 (corrected the same day: the first version had claims the code does not support; see the
> end of this document).
> **Scope:** recording, ANPR, redaction, evidence packages, the off-site archive and federation.
> **INTERNAL SELF-ASSESSMENT.** Written by the engineering team, not by a data protection officer, lawyer or
> auditor.
> **What this is:** an engineering review of the technical controls in the code, with file references, against
> the questions a data protection officer asks under the EU GDPR and India's DPDP Act 2023.
> **What this is not:** a legal opinion or a certification. VigilOne supports a lawful deployment; whether a
> particular site complies depends on how it is configured and operated, and on its own records and legal basis
> (`docs/operations/DPDP_DECISION_RECORD.md`). No section below states that a site "is compliant".

---

## 1. Record of processing (GDPR Art. 30)

**Technical controls present**
- Purposes are a fixed list (`DATA_PURPOSES` in `backend/src/services/privacy/dataProtection.service.ts`):
  `SECURITY_INCIDENT_INVESTIGATION`, `LAW_ENFORCEMENT_REQUEST`, `ACCESS_CONTROL`, `SAFETY_EMERGENCY`,
  `LEGAL_CLAIM`, `AUDIT_REVIEW`. Each tenant chooses which are allowed (`allowedPurposes`).
- `requirePurpose` gates plate and biometric queries: plate searches (`routes/anpr.routes.ts`,
  `routes/smartSearch.routes.ts`) and crop search (`routes/cropSearch.routes.ts`). A query without a purpose, or
  with one the tenant has not allowed, is refused. `LAW_ENFORCEMENT_REQUEST` and `LEGAL_CLAIM` also need a case
  or request reference (`PURPOSES_NEEDING_REFERENCE`). Each such query is written to the audit chain with its
  purpose (`recordSensitiveQuery`).
- Tenant data is separated by `tenantId` on every query.

**Gaps**
- There is no exportable record of processing. The site must keep its own Art. 30 record; the DPDP decision
  record is the starting point. A `GET /privacy/dpdp/ropa` export (cameras, retention periods, enabled models,
  categories of data) would help; it does not exist.

## 2. Lawful basis and special-category data (GDPR Art. 6 and 9, DPDP s.4)

**Technical controls present**
- Face processing is off by default (`faceProcessingEnabled`, default `false`). Switching it on requires the
  administrator to send `acknowledgeBiometricProcessing: true`, which is recorded in the audit chain
  (`DPDP_SETTINGS_UPDATE`).
- While it is off:
  - redaction jobs that ask for face detection are refused (`videoRedactor.service.ts`,
    `REDACTION_FACE_PROCESSING_DISABLED`);
  - face analytics events from cameras are not ingested (`cameraEvents/cameraEventManager.service.ts`).
- VigilOne has no face recognition: faces are only detected, to be masked.
- Person appearance search (crop search, `routes/cropSearch.routes.ts`, feature `SEMANTIC_SEARCH`) is treated as
  biometric. Searching person crops needs the `CROP_PERSON_QUERY` permission and an allowed purpose, and each
  query is audited.

**Gaps**
- The lawful basis itself (legitimate interest, consent, legal obligation) is the site's decision, recorded
  outside the software. The acknowledgement is a record that someone confirmed it, not a check of it.

## 3. Impact assessment (GDPR Art. 35)

Continuous surveillance of publicly accessible areas and ANPR are processing types that normally require a DPIA.
The DPIA is the site's document. The software provides these mitigations to cite in it:

- **Redaction:** faces (YuNet detector) and license plates (PP-OCRv4 text detection) are covered with opaque
  black boxes (`maskPlanner.ts`, ffmpeg `drawbox`). There is no blur option. Each redacted derivative has its
  own SHA-256. Its signed package (`derivation.json`, AI provenance, custody) links it to the parent evidence
  manifest (`evidence/archive/redactionPackage.ts`).
- **Separation:** AI inference runs in a separate process (`services/ai-worker`). It reads camera streams from
  the local media server (`rtsp://127.0.0.1:8554`), never from the cameras directly.
- **Retention:** retention periods are enforced by an automatic purge (section 4).

## 4. Data subject rights and erasure (GDPR Art. 15–22, DPDP s.11–13)

**Technical controls present**
- **Retention purge:** the purge runs hourly (`DPDP_PURGE_INTERVAL_MS`, default one hour) and on demand
  (`POST /privacy/dpdp/purge`). It deletes:
  - plate reads (`vehicleObservation`) older than `plateRetentionDays` (default 30);
  - detection snapshots older than `detectionSnapshotRetentionDays` (default 30).
- **Legal holds:** items covered by an incident hold or a legal-hold evidence manifest are kept, and counted as
  held. Each purge run is written to the audit chain (`DPDP_RETENTION_PURGE`) with its counts.

**Gaps**
- There is no workflow for an individual's access or erasure request: no intake, no identity check, no targeted
  export or deletion. `docs/BACKLOG.md` lists it ("Data-principal requests"), and the DPDP decision record
  explains why it is not built. Such requests must be handled by a documented manual procedure.

## 5. Transfers outside the site (GDPR Chapter V)

**What leaves the appliance, and only when configured**
- **Off-site archive** (`storage/objectStorageArchive.service.ts`, feature `OBJECT_STORAGE_ARCHIVE`): recording
  segments are uploaded to the S3/MinIO bucket the site configures.
  - The connection must be https unless `ARCHIVE_ALLOW_INSECURE_ENDPOINT=true`.
  - The segments are **not** encrypted by VigilOne before upload. Encryption at rest depends on the bucket's own
    settings.
  - Uploads are content-addressed (SHA-256), rate-limited and scheduled off-peak; legally pinned segments go
    first.
- **Federation to a headquarters** (`federation/uplink.ts`): event, alarm and audit records are sent to the
  configured headquarters. Event payloads include ANPR plate reads.
- **Notifications** (WhatsApp, e-mail and others): alarm text leaves the site. `VIGILONE_AIR_GAPPED=true`
  refuses channels that need the internet.

**Gaps**
- Where the bucket, the headquarters or a notification provider is in another country, the transfer needs its
  own legal basis (adequacy, SCCs or another mechanism). That is outside the software.

## 6. Breach detection and custody (GDPR Art. 33)

**Technical controls present**
- **Audit chain:** administrative and data-access actions are recorded in a hash chain (`AuditChainService`).
  Each record's hash covers the previous one, so a changed or deleted record breaks verification. The go-live
  check blocks on a broken chain.
- **Evidence custody:** evidence custody has its own chain (`CustodyHashChain`).
- **Tampered derivatives:** a redacted derivative whose file no longer matches its recorded SHA-256 is refused,
  on download (HTTP 409, `REDACTION_OUTPUT_TAMPERED`) and when building its package. The job record is not
  changed, and no alarm is raised.

**Gaps**
- There is no breach register or notification workflow. The 72-hour notification (GDPR Art. 33) and the DPDP
  Board notification are the site's procedure.

---

## Corrections to the first version of this document

The first version (commit `4482397` on `main`) stated several things the code does not do:

| First version said | The code |
| --- | --- |
| Purposes `SECURITY`, `INVESTIGATION`, `COMPLIANCE`, `ANALYTICS`, `MAINTENANCE` | The six purposes listed in section 1 |
| A reference is required for `INVESTIGATION` / `COMPLIANCE` | Required for `LAW_ENFORCEMENT_REQUEST` and `LEGAL_CLAIM` |
| Face processing needs `faceAcknowledgement: true` | The field is `acknowledgeBiometricProcessing` |
| Redaction uses "Gaussian blur or solid blackout" | Solid black boxes only |
| Purge removes data older than `retentionDays` | Two settings: `plateRetentionDays` and `detectionSnapshotRetentionDays` |
| Archived evidence is "end-to-end encrypted" | No encryption by VigilOne; it depends on the bucket |
| Data "never transits" off-site | Archive, federation and notifications send data when configured |
| A tampered derivative moves the job to `FAILED` and alerts the incident outbox | The download or package is refused; no state change or alert |
| "FULLY COMPLIANT" verdicts | Removed: software can support compliance, not certify it |
