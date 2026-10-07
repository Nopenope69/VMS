# Verifying an evidence package offline (`vigilone-verify`)

`tools/vigilone-verify/vigilone-verify.mjs` is a single file with no dependencies. It needs
Node.js 18 or later and makes no network calls. A court, an expert or opposing counsel can run it
on their own machine against an export ZIP (or its extracted directory):

```
node vigilone-verify.mjs Evidence_<id>.zip --trusted-key appliance_public_key.pem --require-ai-provenance
node vigilone-verify.mjs Evidence_<id>.zip --trusted-key appliance_public_key.pem --require-segment-seals
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
| `summary.artifact_bound`, `summary.summary_matches`, `summary.records_intact`, `summary.unique`, `summary.scope` | Incident summaries (ADR 0016, `incident_summaries.json`, role `INCIDENT_SUMMARIES`): the artifact is in the signed manifest and agrees with its digest; every record recomputes its facts, text and record hashes, its sentences and citations equal what the named template renders from its facts, every citation points at a fact in the record, every fact is cited, and the closing statement is the fixed one; one summary per alarm; every summary is for this camera and its alarm was raised inside the export window. `--require-incident-summaries` makes a missing section a failure (otherwise `summary.present` is a warning) |
| `seals.artifact_bound`, `seals.summary_matches`, `seals.hashes`, `seals.signatures`, `seals.chain`, `seals.leaves_match`, `seals.coverage` | Segment seals (ADR 0018, `segment_seals.json`, role `SEGMENT_SEALS`): each seal hash recomputes from its body (`vigilone.segment-seal.v1`); each seal is signed by the package's appliance key (a seal signed by another key fails, it cannot be checked here); the seals form an unbroken run (consecutive numbers, each linking to the one before); every exported segment that has a seal has the sealed media hash, start and end in its Merkle leaf. A seal shows the segment's bytes were these when it was **recorded**, not only when it was exported. `--require-segment-seals` makes a missing section or an unsealed exported segment a failure (otherwise warnings). Seals before the package's first one stay on the appliance: check the full chain there with `GET /api/v1/segment-seals/cameras/:cameraId/verify` |
| `derivation.*` | For a redacted derivative: derivation.json names this video; the parent master hash equals the recomputed Merkle root; the source segments are leaves of the parent; the detector model is listed in the AI provenance |

## What the times in a recording mean, and how accurate they are

Read this before describing the time of an event in a statement, a certificate or in court. Nothing here has been measured on a
real appliance with real cameras; it states what the design guarantees and what it does not.

1. **The time of a recording is the appliance's clock, not the camera's.** A segment's start time is the appliance's wall clock
   (UTC) at the moment the recorder opened the file. It is in the file name, to the microsecond, and the catalog reads it as UTC.
   The MediaMTX container is pinned to UTC (`TZ=UTC`) because it writes that name in its own local time. If a segment's name and
   the file's last write differ by more than five minutes (a wrong time zone or a wrong clock), the appliance raises a warning
   event, `Segment time does not match the file clock`, and does **not** change the recorded time.
2. **Inside one segment, timing is the camera's.** The time of a frame is the segment start plus the frame's timestamp minus the
   first frame's timestamp, from the camera's own stream clock. So the spacing between frames of one camera is as exact as that
   camera's clock; the placement of the whole segment on the wall clock is as exact as the appliance's clock at the start,
   plus the delay between the camera capturing the first frame and the recorder opening the file (network and buffering delay,
   not measured, plausibly tens to hundreds of milliseconds).
3. **Between cameras, alignment is only as good as that.** Two cameras recording the same event are placed on one wall clock by
   the appliance's clock for each, plus each stream's own delay. Do not claim sub-frame alignment between cameras. A claim of
   "within one second" is supportable when the appliance clock is NTP-synchronised; anything finer needs a measurement on the site.
4. **The appliance clock must be synchronised.** The go-live runbook requires NTP and `vigilonectl` reports whether the host is
   NTP-synchronised. The ClockGuard floor (`clock_guard.state`) only stops the clock from moving backwards past what was already
   seen (it protects licensing and updates); it does not measure accuracy and is not evidence that the clock was right.
5. **The camera's clock is not used for video.** The ONVIF clock check (`CAMERA_EVENTS.md`) reads the camera's time in whole
   seconds and is used for event subscriptions, and it cannot confirm better than about a second. Camera-supplied event times
   are stored as the camera's, not corrected to the appliance's.
6. **Frame stepping** lands on a real frame of the reference camera, and every other camera of a synchronized view is put on
   the real frame it shows at that moment, read from its own file (see the RecordingCatalog audit). A camera whose file
   cannot be read is marked APPROXIMATE. Cameras film at their own rates, so their frames are not taken at the same instant:
   each shows its latest frame at or before the master time.

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
