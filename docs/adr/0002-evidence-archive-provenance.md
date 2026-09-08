# 0002: Establish EvidenceArchive as Authoritative Legal Evidence Spine

## Status
Accepted

## Context
Evidentiary functions were fragmented across shallow, overlapping modules: `EvidenceExportService` (single-camera ZIP packaging and PDF generation), `EvidenceManifestService` (multi-camera manifests, Section 63 BSA JSON declarations, derivative clip creation), `ChainOfCustodyService` (flat event logging), and static `EvidencePinManager` (separate pin store). This created conflicting authority for evidence pins, an incomplete Merkle structure relying on colon-delimited string concatenation, and ambiguous boundaries between machine provenance signatures and statutory human legal certifications under Section 63 of Bharatiya Sakshya Adhiniyam, 2023.

## Decision
We consolidate all evidence packaging, Merkle tree construction, chain-of-custody logging, Section 63 BSA certificate package generation, derivative export lineage, and pin lifecycle coordination into a single deep module: `EvidenceArchive` (`src/services/evidence/archive/`).

1. **Pin Lifecycle Separation**:
   - `TemporaryExportPin`: Created for the duration of an export job. Automatically expires or releases upon export completion, failure, or cancellation.
   - `LegalHoldPin`: Created during investigation hold placement. Holds an absolute retention veto.
   - Invariant: Export completion or cancellation **cannot** release segments held by an active `LegalHoldPin`. Segments remain pinned until an authorized user explicitly calls `setLegalHold(false)`.
   - All pins are acquired and verified via `RecordingCatalog.pinSegment()`.

2. **Merkle Root vs. Media Checksum Precision**:
   - The Merkle root over segment leaves is named `evidenceMerkleRoot` (not "master evidence hash").
   - `EvidenceManifest` explicitly tracks `evidenceMerkleRoot`, `sourceSegmentHashes[]`, and `derivativeSha256`.

3. **Canonical Length-Prefixed Merkle Leaf Encoding**:
   - Leaves use length-prefixed binary buffer encoding: `domain ("VIGILONE-EVIDENCE-SEGMENT-V1") || len(segmentId) || segmentId || len(cameraId) || cameraId || int64(startMs) || int64(endMs) || raw32ByteMediaSha256`.
   - Odd-leaf nodes are handled deterministically by duplicating the final node at any unbalanced level.
   - Enables $O(\log N)$ cryptographic proofs of inclusion for individual segments.

4. **Signing the Canonical Manifest**:
   - The appliance Ed25519 private key signs the SHA-256 digest of the canonical manifest JSON (binding time range, cameras, version, and Merkle root).
   - The signature authenticates the manifest as an integrated whole, while Merkle proofs authenticate individual segment leaves.

5. **Section 63 BSA Statutory Boundary (`bsaCertificatePackageBuilder`)**:
   - Software pre-populates official Schedule Part A (Party in-charge) and Part B (Technical Expert) certificates.
   - The appliance Ed25519 signature is strictly labeled as the *VigilOne system provenance/integrity signature*.
   - Statutory party/expert declarations require explicit human completion and signing.

6. **Tamper-Evident Custody Hash Chain**:
   - Custody logs form a continuous cryptographic hash chain: $E_n = \text{SHA-256}(E_{n-1}.\text{eventHash} \parallel \text{eventId} \parallel \text{action} \parallel \text{actorUserId} \parallel \text{timestampUtcIso} \parallel \text{payloadHash})$.
   - Any modification or deletion of past records invalidates chain verification.

7. **Terminology & Product Claims**:
   - Packages are designated as "structured evidence export packages", avoiding unqualified "court-ready" claims.
