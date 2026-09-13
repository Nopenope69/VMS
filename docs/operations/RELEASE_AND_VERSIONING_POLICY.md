# Release, Versioning & Monotonic Upgrade Policy
**Document Reference:** `VIGILONE-POL-RELEASE-2026-V1`  
**Governance Framework:** Semantic Versioning 2.0.0 (SemVer) with Persistent Monotonic Epoch Guarantees  
**Applicability:** All VigilOne Edge NVR software releases, OTA bundles, and container builds  

---

## 1. Versioning Architecture (SemVer 2.0.0)

All software artifacts and firmware updates are designated using the standard semantic versioning schema:
$$\text{MAJOR} . \text{MINOR} . \text{PATCH}$$

- **MAJOR (X.0.0):** Incremented when incompatible architectural changes, breaking API contract modifications, or database schema restructuring requiring cold data migration are introduced. Major releases are scheduled annually.
- **MINOR (1.X.0):** Incremented when backward-compatible functional enhancements, new camera adapter support, or non-breaking performance improvements are introduced. Minor releases are scheduled quarterly.
- **PATCH (1.0.X):** Incremented for backward-compatible bugfixes, security vulnerability remediations, or documentation updates. Patch releases are issued monthly or on-demand for critical CVEs.

---

## 2. Monotonic Epoch Floor & Anti-Rollback Invariant

In addition to SemVer strings, every signed OTA update bundle carries an internal integer `releaseEpoch`:
$$\text{releaseEpoch} \in \mathbb{N}$$

### 2.1 The Monotonic Invariant
Under Section 4.2 of the Master Contract, the appliance strictly enforces an unregressible release floor:
$$\text{candidateEpoch} \ge \text{highestAcceptedOtaEpoch}$$

1. The appliance records `highestAcceptedOtaEpoch` inside root-only state file `/etc/vigilone/ota_release.state` (`0o600`).
2. An update bundle with `releaseEpoch < highestAcceptedOtaEpoch` is **rejected prior to extraction** (`400 Bad Request / REJECTED_DOWNGRADE_ATTEMPT`).
3. During automated recovery or database restoration, the persistent host floor is strictly preserved, preventing downgrade attacks designed to re-expose patched vulnerabilities.

---

## 3. Backward Compatibility & Database Migration Guarantees

### 3.1 Metadata & Ingestion Schema Compatibility
- **Database Migrations:** All database migrations are managed through Prisma (`prisma migrate deploy`). Migrations are strictly forward-additive (adding nullable columns or new tables).
- **Two Major Versions Schema Guarantee:** Video recording metadata, segment indexing tables, and chain-of-custody logs are guaranteed backward compatible for a minimum of two (2) major versions.
- **Pre-Update Database Snapshots:** Before any OTA update is applied, the system automatically executes a full PostgreSQL database dump (`database.sql`) to `/opt/vigilone/snapshots/` alongside host configuration state.

### 3.2 Evidence Export & Forensic Archive Compatibility
- **Permanent Evidentiary Stability:** Evidence ZIP archives generated under any previous release remain permanently verifiable offline using standard tools (`unzip`, `openssl`, `sha256sum`).
- **Signature Independence:** Public keys embedded in evidence packages are raw Ed25519 PEM keys and do not rely on external certificate revocation lists (CRLs) or online OCSP responders.

---

## 4. Release Cadence & Deprecation Windows

| Release Type | Cadence | Support Lifespan | Notice Period for Deprecations |
|---|---|---|---|
| **Major Releases** | Annual (Q3) | 24 Months | Minimum 180 Days (6 Months) prior notice |
| **Minor Releases** | Quarterly (Q1, Q2, Q4) | 12 Months | Minimum 90 Days prior notice |
| **Patch Releases** | Monthly (1st Tuesday) | Superseded by next patch | Immediate release notes |
| **Critical Hotfixes** | Out-of-band ($\le 24\text{h}$) | Integrated into next patch | Published immediately with CVE advisory |

### Deprecation Protocol:
1. Any API endpoint or configuration field marked for deprecation will emit an `X-VigilOne-Deprecation` HTTP warning header identifying the scheduled retirement date.
2. Deprecated endpoints remain functional without behavioral alteration for the entire duration of the notice window.
