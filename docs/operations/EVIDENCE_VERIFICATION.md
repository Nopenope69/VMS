# Verifying an evidence package offline (`vigilone-verify`)

`tools/vigilone-verify/vigilone-verify.mjs` is a single file with no dependencies. It needs
Node.js 18 or later and makes no network calls. A court, an expert or opposing counsel can run it
on their own machine against an export ZIP (or its extracted directory):

```
node vigilone-verify.mjs Evidence_<id>.zip --trusted-key appliance_public_key.pem --require-ai-provenance
node vigilone-verify.mjs Evidence_<id>.zip --json > verification.json
```

Exit codes: 0 means VALID (warnings allowed), 1 means INVALID (a check failed), 2 means a usage
or read error.

## What it checks

| Check | Meaning |
| :--- | :--- |
| `manifest.canonical`, `manifest.sha256`, `manifest.signature` | manifest.json is canonical JSON, its SHA-256 is in manifest.sha256, and manifest.sig is a valid Ed25519 signature by the key in the package |
| `trust.appliance_key` | Compares the package key with the key you trust (`--trusted-key` PEM or `--trusted-key-sha256` of its SPKI). Without either, this is a WARN: the package only proves it was signed by the key it carries |
| `artifact:<path>`, `artifacts.no_unlisted_files`, `artifacts.key_bound` | Every file is listed in the signed artifacts table with the same size and SHA-256, no file is unlisted, and the signing key is listed too |
| `media.hash` | The primary media hash equals `videoChecksumSha256` |
| `merkle.leaf_media_hashes`, `merkle.leaf_hashes`, `merkle.root`, `merkle.proof:*` | Every leaf has a media hash computed from bytes (not the placeholder older exports used). Each leaf hash is recomputed, the root is recomputed, and every inclusion proof is checked |
| `custody.chain`, `custody.head` | Every event links to the previous one from genesis, every event hash recomputes, and the head equals the signed custody summary |
| `custody.export_event` / `custody.derivation_event` | EVIDENCE_EXPORTED links the Merkle root to this video. For a derivative, EVIDENCE_REDACTED links the parent master hash to this derivative |
| `ai.artifact_bound`, `ai.records_attributed`, `ai.summary_matches` | Every AI record in ai_provenance.json names a model (name, version, SHA-256) listed in the file, plus confidence, frame timestamp and camera. The counts and models match the signed summary |
| `ai.unattributed`, `ai.models_unevaluated` (WARN) | Some AI events have no model provenance (written before Phase 2), or a model has no evaluation on site data |
| `derivation.*` | For a redacted derivative: derivation.json names this video; the parent master hash equals the recomputed Merkle root; the source segments are leaves of the parent; the detector model is listed in the AI provenance |

## Package contents (P4.5)

* `manifest.json`, `manifest.sha256`, `manifest.sig`, `appliance_public_key.pem`
* `video.mp4`: the primary media. For a derivative, this is the redacted video.
* `chain_of_custody.json`: the custody ledger for the evidence item.
* `bsa-section-63/certificate_sec63.pdf`: the certificate. It now states the AI annotations
  (count and models with their SHA-256) and, for derivatives, the parent evidence.
* `ai_provenance.json`: every AI-derived record for the camera and time window, with model name,
  version and SHA-256, components, confidence, frame timestamp, camera, inference id and adapter.
  It also lists the models with their licences and evaluation (`null` means not evaluated on site
  data), and counts AI events that carry no provenance.
* `derivation.json` (derivatives only): parent evidence id and master hash, redaction job, source
  segment hashes, detector, masks, and the ffmpeg build.

## Fixes made in P4.5

* **Custody hashes.** Custody-event payload hashes now use canonical (key-sorted) metadata.
  Hashing `JSON.stringify` in insertion order made events unverifiable once PostgreSQL JSONB had
  reordered their keys. Events written before this fix verify only if their stored key order
  happens to equal the original order; the verifier reports how many used the legacy hash.
* **Missing segment hashes.** Exports no longer put a placeholder hash in a leaf when a segment
  has no recorded hash. The real hash is computed from the file, and a segment whose bytes differ
  from its recorded hash stops the export (`EXPORT_SEGMENT_INTEGRITY_FAILED`).
* **Missing segment files.** Segments missing from disk stop the export (`EXPORT_SEGMENT_MISSING`)
  rather than being listed in the manifest without being in the video.
* **Tool version.** The assembly specification records the ffmpeg build that actually ran,
  instead of a fixed string.

Video *enhancement* does not exist in VigilOne. If it is ever added, it must produce a derivative
recorded in the same way as redaction (derivation.json and a custody event).
