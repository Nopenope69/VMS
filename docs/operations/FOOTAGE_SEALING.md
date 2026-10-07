# Footage sealing (`FOOTAGE_SEALING`, ADR 0018)

Off by default. Set `VIGILONE_FEATURE_FOOTAGE_SEALING=true` and restart the backend.

## What it does

- **A seal per segment, made when it is recorded.** When the recording catalog registers a finished segment with its
  SHA-256, it writes a seal: camera, sequence number, segment id, start and end (UTC), size, SHA-256, the previous seal's
  hash, the sealing time, and the appliance key fingerprint. The seal is signed with the appliance Ed25519 key
  (`/etc/vigilone/appliance_ed25519.key`, the same key that signs evidence packages).
- **One chain per camera.** Each seal names the previous one, so a removed or edited seal shows.
- **The first hash wins.** A sealed file that is registered again with other content, or whose stored hash is changed in the
  database, is reported as an integrity failure (`DIFFERS_FROM_SEAL`, `DB_HASH_DIFFERS_FROM_SEAL`; see
  `RECORDING_INTEGRITY.md`) and never resealed. An export of such a segment is refused (`EXPORT_SEGMENT_SEAL_MISMATCH`).
- **Anchors.** Every 15 minutes the worker `segmentSealAnchor` writes the head of each camera's chain into the audit chain
  (`SEGMENT_SEAL_ANCHOR`).
- **Exports** carry `segment_seals.json`; `vigilone-verify --require-segment-seals` checks it offline
  (`EVIDENCE_VERIFICATION.md`).

## Checking a camera's chain

`GET /api/v1/segment-seals/cameras/:cameraId/verify` (needs `CAMERA_VIEW`). Reads only. The answer lists:

| Field | Meaning |
| --- | --- |
| `valid` | No problem found |
| `problems[]` | `SEQUENCE_GAP` (seals removed), `BROKEN_LINK`, `SEAL_HASH_MISMATCH` (a seal row was edited), `BAD_SIGNATURE`, `STORED_HASH_DIFFERS` (the segment's stored hash is not the sealed one), `ANCHORED_SEAL_MISSING` / `ANCHOR_MISMATCH` (the audit chain recorded a seal that is gone or different) |
| `segmentsGone` | Seals whose segment row no longer exists: retention, or a deletion. Not a failure by itself |
| `otherKeys` | Seals signed by an earlier appliance key; not checkable with the current key |
| `unanchoredSeals` | Seals newer than the last anchor; a cut tail here would not show |

## When sealing fails

Recording never waits for or depends on sealing. If a seal cannot be written (key unreadable, database error) the segment
is still registered and counts as footage, and a `RECORDING_FAILURE` warning "Recorded segment could not be sealed" is
raised (at most one per camera per hour). That segment is not sealed later: sealing long after recording would vouch for
whatever is on disk then. It shows in exports as an unsealed segment.

## Limits (say these when describing the feature)

- **Root on the appliance defeats it.** The key is a file on the appliance. Someone with root can read it and sign a forged
  chain. Seals stop edits by anyone with less access, and accidents. A hardware key (TPM) and off-box anchors are not built.
- A chain tail cut before the next anchor (up to 15 minutes of seals) is not detectable on the appliance alone.
- Seals are never deleted, even when retention deletes the footage (a few hundred MB a year at 32 cameras with
  10-minute segments).
- Segments recorded before the feature was switched on carry no seal.
- Not run on a live appliance with real cameras. The cost per segment (one signature, one small insert) is unmeasured on
  the reference hardware.
