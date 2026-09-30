# Certification readiness (Phase 8)

**Status:** preparation only. No certification has been applied for or obtained. Everything marked
*unverified* must be confirmed with the certifying body or an accredited lab before anyone plans around it.
The sources are in `docs/strategy/vigilone-ai-features-and-research-2026-09-23.md` (section 2.6).

## Which schemes might apply

| Scheme | What the official documents cover | Relevance to VigilOne | Status |
| --- | --- | --- | --- |
| BIS Compulsory Registration (CRS), CCTV | Cameras **and recorders**; IS 13252 (Part 1) safety plus Essential Requirements ER:01 test reports from third-party labs (gazette 9 Apr 2024, in force 9 Apr 2025) | The documents do not mention VMS software. **Unverified:** whether a VigilOne appliance sold with its hardware counts as a "recorder" (it records video like an NVR). If it does, the hardware SKU needs registration. | Ask BIS or an accredited lab. **Owner decision.** |
| STQC IoT scheme P01 | CCTV **cameras** only: hardware, firmware, process and development security | Does not cover NVR or VMS software. Its checklist is still a good security baseline (see the mapping below). | Not applicable as written |
| "STQC-certified VMS" (government, PSU and GeM buyers) | Claimed by vendor blogs; **no official MeitY or STQC document found** | Could matter for government sales | **Unverified.** Ask STQC or a GeM buyer directly. |
| ONVIF client conformance (Profile S, T, M) | ONVIF membership plus the ONVIF client test tool | VigilOne is an ONVIF client (discovery, PullPoint events, Profile M metadata) | Not started: needs membership (owner decision and fee) |
| IEC 62676 (video surveillance systems) | International system standard | Useful for tenders outside India | Not assessed |
| DPDP Act 2023 | Personal data (video of people, plates, faces) | Applies | `DATA_PROTECTION.md`, `DPDP_DECISION_RECORD.md` (sign-off pending) |
| CERT-In directions (April 2022) | Incident reporting within 6 hours; ICT logs kept for 180 days, for covered entities | Applies to the operator of a deployment, not to the software as such | VigilOne never deletes audit events; disk sizing and backups decide how long they last (below) |

## Security baseline: the STQC camera checklist, applied to VigilOne

| Control | VigilOne | Evidence |
| --- | --- | --- |
| Software bill of materials | **Done (Phase 8):** CycloneDX 1.5 with every npm package, AI model (SHA-256, licences, training data) and container image | `scripts/release/generate-sbom.mjs`; CI uploads `vigilone-sbom` |
| Signed updates | Done: OTA manifests signed with Ed25519, key id and purpose checked | `backend/src/services/appliance/otaUpdate.service.ts` |
| Anti-rollback | Done: a version epoch that cannot decrease | same file |
| No hard-coded credentials | CI secrets audit; first-run bootstrap token | CI job "Secrets & Key Material Security Audit" |
| Tamper-evident logs | Done: hash-chained audit log; hash-chained site-to-HQ record log (Phase 6) | `auditChain.service.ts`, federation `recordLog.ts` |
| Credentials at rest | Encrypted (AES-256-GCM): camera, S3 and SSO secrets | `utils/crypto.ts` |
| Transport security | Caddy TLS; self-signed by default | Customer certificate: installation step |
| Authentication | Local passwords (bcrypt), rate limits, sessions; SSO with OIDC (Phase 8) | `SSO.md` |
| Least privilege | Role-based access (RBAC); person-appearance search limited to administrators | `rbac/permissions.ts` |
| Dependency and model licences | CI gates | `check:dependency-licenses`, `check:model-licenses` |
| Evidence integrity | SHA-256 manifests, chain of custody, standalone verifier | `EVIDENCE_VERIFICATION.md`, `tools/vigilone-verify` |
| Secure boot, disk encryption on the appliance | **Not built** (operating-system image work) | |
| Vulnerability disclosure policy, security contact | **Not written** | Owner decision |
| Independent penetration test | **Not done** | Needs a vendor |
| Secure development process record (threat model, code review policy) | Partial: CI gates and review rules exist; no written threat model | |

## What the owner needs to decide or buy

1. Ask BIS (or a lab) whether an appliance SKU is a "recorder" under the CCTV CRS order.
2. Ask STQC, or a GeM buyer, whether any VMS certification is actually required for the target customers.
3. Decide whether to join ONVIF to run the client conformance tests.
4. Commission a penetration test before the first government or enterprise tender.
5. Publish a vulnerability disclosure policy and a security contact.

## Per-deployment checks (the operator's job, not the software's)

* **Audit-log retention:** VigilOne never deletes audit events. Size the disk, and keep backups for at least
  180 days if the operator is covered by the CERT-In directions.
* **Time:** NTP-synchronised clocks. Evidence timestamps and log correlation depend on it, and so does high
  availability.
* **Certificate:** replace the self-signed one with the customer's own.
