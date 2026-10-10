# 0020: C2PA 2.2 Export Manifests with Section 63 BSA Assertions

## Status
Accepted (2026-10-10). Third part of the fifth software feature in `docs/strategy/vigilone-ai-features-landscape-2026-10-03.md`
(section 6, item 5, "footage integrity: C2PA-style manifests on exports"). Builds on ADR 0002 (evidence archive),
ADR 0013 (Section 63 BSA evidence certificates), and ADR 0018 (segment seals).

## Context
Under Section 63 of the Bharatiya Sakshya Adhiniyam (BSA) 2023, electronic records are admissible as evidence in Indian
courts provided their cryptographic integrity, provenance, and custody unbroken ancestry are demonstrated.
While VigilOne evidence packages already include a signed canonical `manifest.json`, Merkle tree inclusion proofs,
and an Ed25519 signature over exported segment sets, interoperability with external forensic tools and judicial
repositories increasingly demands standardization.

The Coalition for Content Provenance and Authenticity (C2PA 2.2) specification defines open standards for expressing asset
provenance and claim signing. However, typical C2PA implementations (such as Rust native C-bindings or external CLI binaries)
introduce heavy foreign-function bindings, binary distribution overhead, or GPL/AGPL dependency risks that violate
VigilOne edge appliance architecture boundaries.

## Decision

* **Zero-dependency, pure TypeScript C2PA manifest builder (`c2paManifestBuilder.ts`).**
  Instead of pulling in third-party native or GPL-tainted binaries, VigilOne implements a lightweight, deterministic
  manifest builder and signer using standard Node.js `crypto` and the existing appliance Ed25519 keypair.
* **Standard C2PA 2.2 claim format (`c2pa_manifest.json`).**
  Every exported evidence archive automatically packages `c2pa_manifest.json` in root, bound in `manifest.json`'s artifacts
  table under role `C2PA_MANIFEST`.
  The claim contains:
  * `c2pa_version`: `'2.2'`
  * `claim_generator`: `'VigilOne Edge VMS/1.0.0'`
  * `instance_id`: `urn:uuid:<exportId>`
  * `signature_info`: Ed25519 signature, appliance identifier issuer, appliance public key PEM, ISO 8601 timestamp.
* **Standard Assertions:**
  1. `c2pa.actions`: Standard actions `c2pa.created` (when edge recording started, software agent `VigilOne Media Plane`)
     and `c2pa.packaged` (when exported, software agent `VigilOne Evidence Subsystem`).
  2. `c2pa.hash.data`: Hard cryptographic binding to the primary media (`name: 'primary_media'`, `alg: 'sha256'`, `hash: <videoSha256>`).
  3. `stds.schema-org.CreativeWork`: Schema.org metadata for the exported video object, attributing authorship to the certifying
     operator and appliance producer.
  4. `in.gov.bsa.section63`: Custom Indian evidentiary assertion encapsulating statutory compliance:
     `applianceIdentifier`, `evidenceMerkleRoot`, `segmentCount`, `custodyChainHeadHash`, and Part A / Part B signatory metadata.
  5. `c2pa.ai_provenance`: When AI detections are present, binds record counts, model versions, and model hashes.
* **Deterministic claim canonicalization and signing.**
  The claim dictionary is constructed and canonicalized (omitting `signature_info.signature`) using RFC 8785 JSON canonicalization.
  The appliance Ed25519 private key signs the canonical string, and the resulting signature is embedded into `signature_info.signature`.
* **Integrated Package Assembler.**
  `PackageAssembler.assemblePackage` generates and stages `c2pa_manifest.json` whenever primary media is exported,
  calculates its SHA-256 and byte size, and enters it in the package's signed `artifacts` table.
* **Offline Verification (`vigilone-verify.mjs`).**
  The standalone offline verifier validates `c2pa_manifest.json`:
  * Validates JSON syntax and `c2pa_version === '2.2'`.
  * Confirms `c2pa.hash.data` matches `video.mp4` hash.
  * Reconstructs unsigned canonical claim and verifies the Ed25519 signature with the appliance public key.
  * Checks `in.gov.bsa.section63.evidenceMerkleRoot` against `manifest.json`.
  * Supports CLI flag `--require-c2pa` to enforce C2PA manifest presence on exported packages.

## Consequences

* **Standardized judicial interoperability.** Indian law enforcement and judicial authorities can verify exported packages
  against C2PA 2.2 provenance schemas without losing Section 63 BSA legal assurances.
* **No external runtime dependencies.** The edge appliance remains autonomous, self-contained, and free of native C/Rust
  linking complexities.
* **Tamper evident.** Any byte alteration to `video.mp4`, `manifest.json`, or `c2pa_manifest.json` breaks artifact hash checks,
  Merkle roots, or C2PA Ed25519 signatures.
