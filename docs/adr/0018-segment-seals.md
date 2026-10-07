# 0018: Segment seals, a signed record of every recorded segment made when it is recorded

## Status
Accepted (2026-10-07). First part of the fifth software feature in `docs/strategy/vigilone-ai-features-landscape-2026-10-03.md`
(section 6, item 5, "footage integrity"). Builds on ADR 0001 (RecordingCatalog) and ADR 0002 (evidence archive). The other
two parts of that feature (camera-sabotage detection, C2PA-style export manifests) are separate decisions.

## Context
Evidence packages are signed with the appliance Ed25519 key when they are exported (ADR 0002). Before that, a recorded
segment is protected only by `RecordingSegment.sha256Hash`, a database column. Anyone who can write to both the disk and the
database can replace a file and its hash together, and the periodic integrity check (RecordingCatalog audit F7) will then
agree with the replacement. A second path does the same by accident: `registerSegment` is idempotent and overwrites the
stored hash when a file is registered again (the crawler re-registers a file whose size changed).

So an export can prove "these are the bytes the appliance held at export time", not "these are the bytes it recorded".
Deleting a segment's row and file leaves no trace either.

## Decision
Feature `FOOTAGE_SEALING`, off by default.

* **A seal per segment, made at ingest.** When `registerSegment` stores a FINALIZED segment with a content hash and the
  segment has no seal yet, the catalog writes a `SegmentSeal`: camera, per-camera sequence number, segment id, start and
  end (UTC), size, SHA-256 of the file, the previous seal's hash, the time of sealing and the signing key's fingerprint.
* **Canonical form `vigilone.segment-seal.v1`.** The seal body is canonical JSON (the same `canonicalizeJson` the audit
  chain and the packages use; the size is a decimal string). `sealHash` = SHA-256 of that text. `signature` = Ed25519 over
  that text with the appliance key. The key fingerprint is the SHA-256 of the public key's SPKI DER, the same value
  `vigilone-verify` prints.
* **A hash chain per camera.** Each seal carries the previous seal's hash (the first one carries 64 zeros). Sequence numbers
  have no gaps. A removed or edited seal row breaks the chain. Sealing takes a PostgreSQL transaction advisory lock per
  camera, like the audit chain, so concurrent registrations (completion hook and crawler) cannot fork it. Chain order is
  sealing order, which is usually but not always time order (a crawler can find an older file late); nothing relies on
  time order.
* **The first hash wins.** A segment is sealed once. When it is registered again with a different hash, it is not sealed
  again: the catalog reports it through the integrity checker's failure path (status CORRUPTED, reason
  `DIFFERS_FROM_SEAL`, audit-chain entry, RECORDING_FAILURE event, CRITICAL alarm for held evidence). The periodic content
  check compares the file with the seal's hash when a seal exists, and also reports a database hash that differs from the
  seal (`DB_HASH_DIFFERS_FROM_SEAL`). A repaired segment keeps being checked against its repaired hash; the seal still
  names the original.
* **Never blocks recording.** Sealing runs after the segment row is stored. If it fails (no key, database error) the error
  is logged and a RECORDING_FAILURE warning is raised (at most one per camera per hour); registration still succeeds.
  Unsealed segments are not sealed later: sealing a file long after it was written would bless whatever is on disk then.
* **Anchored in the audit chain.** A worker (`segmentSealAnchor`, started only with the flag) writes one audit-chain entry
  `SEGMENT_SEAL_ANCHOR` per camera whose chain moved since its last anchor (default every 15 minutes), carrying the head
  sequence and hash. Cutting the tail of a seal chain is then visible against the audit chain, up to the last anchor.
* **Checked on the appliance.** `GET /api/v1/segment-seals/cameras/:cameraId/verify` (needs `CAMERA_VIEW`) walks a
  camera's chain: links, sequence gaps, hashes, signatures, and whether each sealed segment's stored hash still equals the
  seal. It reads only.
* **Checked offline.** Exports carry `segment_seals.json` (role `SEGMENT_SEALS`, listed in the signed manifest) when the
  feature is on or seals exist for the exported segments: the seals of every exported segment, plus the neighbouring seals
  needed to show the run of seals is unbroken. `vigilone-verify` re-derives each seal hash from its body, checks the
  signature with the package's appliance key (a seal signed by another key is reported, not passed), checks the links and
  that each Merkle leaf's media hash equals its seal. `--require-segment-seals` makes a missing section a failure. A parity
  test checks that the backend and the verifier compute the same seal hash.

## Not decided here
* **The key lives on the appliance.** Someone with root on the appliance can read the key and re-sign a forged chain from
  the start; seals stop edits by anyone with less than that, and accidents. Keeping the key in a TPM or secure element, and
  sending anchors off the box (federation uplink, a printed or emailed anchor), are later decisions.
* **Seals made before the last anchor are covered; newer ones are not.** A chain tail cut before the next anchor is not
  detectable from the appliance alone.
* **Key rotation.** A new appliance key starts a new fingerprint; seals made with the old key can only be checked with the
  old public key. No rotation record is kept yet.
* **Seals are never deleted.** About 4,600 rows a day at 32 cameras with 10-minute segments (some hundreds of MB a year).
  Retention deletes footage, not seals; a seal whose segment is gone is how a deletion stays visible.
* **Camera-sabotage detection and C2PA-style manifests** are the other two parts of footage integrity, decided separately.

## Consequences
* `SegmentSeal` table (migration `20261018000000`), audit actions `SEGMENT_SEAL_ANCHOR` and the existing
  `SEGMENT_INTEGRITY_FAILURE` with two new reasons.
* `vigilone-verify` 1.2.0 carries its own copy of the seal format; the parity test fails first if they drift.
* Not run on a real appliance with real cameras. Sealing adds one signature and one small insert per segment; its cost on
  the reference hardware is unmeasured but expected to be far below the hash the catalog already computes.
