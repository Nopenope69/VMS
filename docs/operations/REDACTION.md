# Video redaction (P4.4)

**Status:** implemented and verified end to end on a SIMULATED recording of a SYNTHETIC scene,
with a public-domain face and a synthetic plate, using the real models
(`docs/ai/e2e-results/2026-09-27_p4.4_redaction_*`). How well faces and plates are found in site
footage (recall) is **not measured**. Review a derivative before you release it.

## What a job does

1. **Source.** It takes the segments of one camera from an evidence manifest. Each file's SHA-256
   must equal the hash the manifest recorded, otherwise the job fails with
   `REDACTION_SOURCE_INTEGRITY_FAILED`. The segments are concatenated by stream copy into a
   private work directory. The master files are only read.
2. **Detection** (modes FACE and LICENSE_PLATE, and `detectKinds`). Frames are sampled at
   `sampleFps`, which defaults to 4 per second. They go to the redaction adapter
   (`redaction-worker`, ai-adapter.v1). Faces come from YuNet. Plate regions are text groups from
   PP-OCRv4 detection that look like plates; the plate text is never read. Every result must
   carry provenance that names a registered, active `redaction-regions` pipeline. Otherwise the
   job fails with `REDACTION_PROVENANCE_INVALID`.
3. **Masks.** Each detection is grown by 15% and held for one sample interval before and after its
   frame. Detections in consecutive samples are linked, and the union of the two boxes covers the
   time between them. Manual masks are added. Every mask is an **opaque filled box**. Blur is not
   offered, because a blurred plate or face can often be recovered.
4. **Render.** ffmpeg re-encodes the video with libx264 (veryfast, CRF 20, yuv420p) and applies
   the mask filter. **Audio is removed.**
5. **Verify.**
   * The output must exist, be non-empty, decode, and have the same frame size and duration as
     the source. Otherwise the job fails with `REDACTION_OUTPUT_MISSING` or
     `REDACTION_OUTPUT_INVALID`.
   * Up to five masks are decoded back from the output and must be opaque. Otherwise the job
     fails with `REDACTION_MASK_NOT_APPLIED`.
6. **Publish.**
   * The file is renamed atomically to `EXPORTS_DIR/derivatives/<tenant>/<job>.mp4`, and the
     SHA-256 of those exact bytes is recorded on the job.
   * A chain-of-custody `EVIDENCE_REDACTED` event links the master hash to the derivative hash.
     It also records the provenance: source segment hashes, the detector pipeline and its model
     hashes, mask counts and checks, the ffmpeg version, and the SHA-256 of the filter.
   * The database refuses a COMPLETED job that has no hash, size and object key.

If any step fails, the job is marked FAILED with an error code. No derivative and no custody event
is recorded. If the backend restarts during a job, the job is marked FAILED with
`REDACTION_INTERRUPTED`.

## API (`VIGILONE_FEATURE_REDACTION=true`; permission REDACTION_EXECUTE)

| Call | Notes |
| :--- | :--- |
| `POST /api/v1/privacy/jobs` | `{ sourceManifestId, redactionMode: FACE \| LICENSE_PLATE \| STATIC_MASK, cameraId?, detectKinds?, sampleFps?, masks? }`. BYSTANDER returns 400 because no person detector is wired for redaction. Audited as `REDACTION_JOB_CREATE` |
| `POST /api/v1/privacy/jobs/:id/execute` | Returns 202. Jobs run one at a time in the background. Audited as `REDACTION_JOB_EXECUTE` |
| `GET /api/v1/privacy/jobs/:id` | Status, `errorCode`, `outputSha256`, `outputBytes`, `provenanceJson` |
| `GET /api/v1/privacy/jobs/:id/download` | Re-hashes the file before serving it (409 `REDACTION_OUTPUT_TAMPERED` if it changed). Sends `X-VigilOne-SHA256`. Audited as `REDACTION_DERIVATIVE_DOWNLOAD` |

To check a downloaded derivative: `sha256sum redacted-<job>.mp4` must equal `outputSha256`, and
also the `resultHash` of the job's `EVIDENCE_REDACTED` custody event.

## Enabling

1. Run `scripts/models/fetch-model.sh yunet-2023mar` and `scripts/models/fetch-model.sh ppocrv4-det`.
2. A person decides the licence questions below and records approvals for both SHA-256 values in
   `scripts/models/model-license-exceptions.json`.
3. Run `VIGILONE_FEATURE_REDACTION=true docker compose --profile privacy up -d`.

Without approvals the redaction-worker reports FAILED health. Jobs that need detection then fail
with `REDACTION_DETECTOR_UNAVAILABLE`. Jobs with manual masks only still work.

## Licence questions (human decision required)

* **YuNet** (MIT code and weights) was trained on WIDER FACE, whose terms forbid commercial use of
  derived data. The plan names YuNet for redaction.
* **PP-OCRv4 detection** (Apache-2.0): its training datasets are not fully published.

## Limits

* Recall on site footage has not been measured. Small, blurred, occluded or profile faces may be
  missed.
* Plate regions over-cover: stickers and badges are masked too.
* A face that crosses the frame faster than about 1.5 box sizes per sample interval breaks the
  track link, although each sample is still covered for ±1 interval.
* One camera per job. The maximum clip length is `REDACTION_MAX_CLIP_SECONDS` (default 1800).

## Metrics

`vigilone_redaction_jobs_total{outcome,code}` and `vigilone_redaction_last_job_seconds` (backend);
`vigilone_redaction_regions_total{kind}` and `vigilone_ai_*` (redaction-worker).
