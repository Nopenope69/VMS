# ANPR (Indian number plates)

Status: P4.1/P4.2 implemented and tested on SYNTHETIC plates only. Plate-level accuracy on real
Indian site footage is **not measured** (P4.3 is HUMAN-REQUIRED: it needs site data).

## Pipeline

```
LPR camera ──RTSP──► MediaMTX ──loopback──► anpr-worker (LprRunner, ffmpeg frames at lpr.fps)
                                               │  PP-OCRv4 DB text detection  (ppocrv4-det)
                                               │  line grouping, two-line merge
                                               │  fast-plate-ocr CCT-S v2      (fast-plate-ocr-cct-s-v2)
                                               │  Indian format + positional letter/digit correction
                                               ▼
                POST /api/v1/internal/anpr/observations  (provenance with components, required)
                                               ▼
    PlateTrackAggregator: confidence-weighted voting per session (same camera, Hamming ≤ 2, 30 s)
          → VehicleObservation → ANPR_MATCH event (incident orchestrator, rules: ANPR_WATCHLIST)
          → watchlist match (EXACT / WILDCARD / REGEX) → audited alarm when alertOnMatch
```

The pipeline is defined in `scripts/models/pipelines/anpr-india-v1.json`. Its SHA-256 is the
`modelSha256` in provenance; each component model (name, version, SHA-256) is listed in
`provenance.components`. The backend refuses reads whose pipeline is not a registered, active
`plate_recognition` manifest with that SHA (`PROVENANCE_UNKNOWN_MODEL`), reads without components
(`PROVENANCE_COMPONENTS_REQUIRED`) and reads from cameras not in LPR mode
(`CAMERA_NOT_IN_LPR_MODE`).

## Licence gate (read before enabling)

Both component models are **candidate models**: their code and weights are Apache-2.0 / MIT, but
their training data needs a human decision (see "Licence questions" in `docs/STATUS.md`). The
worker refuses to load them, and the backend refuses to register the pipeline, unless
`scripts/models/model-license-exceptions.json` (mounted at `/run/vigilone/…` in compose) holds an
approval for each **exact SHA-256**:

```json
{ "approvals": [
  { "key": "ppocrv4-det", "sha256": "<sha from models.lock.json>", "approvedBy": "<name>",
    "approvedAt": "<ISO date>", "reason": "<the decision and its basis>" }
] }
```

Only a person may add approvals. Without them the anpr-worker serves FAILED health with
`LICENSE_REJECTED` (or exits 78 with `AI_EXIT_ON_REFUSAL=true`); recording is unaffected.

## Enabling

1. `scripts/models/fetch-model.sh ppocrv4-det` and `fetch-model.sh fast-plate-ocr-cct-s-v2`
   (hash-verified; the PP-OCRv4 file is extracted from the pinned RapidOCR wheel).
2. Add the approvals (above).
3. Set `VIGILONE_FEATURE_ANPR=true` on the backend and start `docker compose --profile anpr up -d`.
4. In **ANPR console → Pipeline & LPR cameras**, tick the cameras that should read plates.
   `PUT /api/v1/anpr/cameras/:id/lpr` also takes `fps` (0.5–5, default 2), `roi`
   (`[x, y, w, h]`, normalised), `maxWidth` (default 1280) and `minConfidence` (default 0.5).
   Changes are audited (`ANPR_LPR_MODE_ENABLE` / `ANPR_LPR_MODE_DISABLE`).

Use a dedicated LPR camera: narrow field of view, plates ≥ ~100 px wide, shutter ≤ 1/1000 s, IR
for night. General-purpose overview cameras are not supported for ANPR (see BACKLOG).

## Known-plate lists

| matchType | Pattern | Example |
| :--- | :--- | :--- |
| `EXACT` | normalised plate | `MH12AB1234` |
| `WILDCARD` | `*` any run, `?` one character | `MH12*`, `KA0?AB12??` |
| `REGEX` | restricted: anchored, ≤ 64 chars, no groups or backreferences | `^DL[0-9]{1,2}C` |

Invalid patterns are rejected with 400 at creation. Categories: BLACKLIST, SUSPECT, VIP, WHITELIST.

## Indian formats (`backend/src/contracts/indianPlate.v1.ts`)

* STANDARD `LL DD S{0,3} DDDD` for every current state/UT code (TG included), district ≥ 1,
  series letters never I or O. Delhi's single-digit district and category letter
  (`DL 3C AB 4521`) are handled.
* Bharat series `YY BH NNNN XX`.
* Diplomatic plates `NNN CD|CC|UN NNNN`.
* Two-line plates: lines are merged top-to-bottom before recognition; the pipeline also tries
  per-line reads and picks the reading that is a valid Indian plate with the fewest corrections.
* Positional correction (e.g. O/Q/D/U→0, I/L/J→1, Z→2, A→4, S→5, G→6, T→7, B→8 and the reverse)
  is applied only where the format demands a digit or a letter; the raw OCR text and the corrections are stored with the observation.

## Privacy and audit

* `GET /api/v1/anpr/observations` is audited (`ANPR_OBSERVATIONS_QUERY`) with the query filters.
* Plate snapshots are not stored yet (BACKLOG); retention and purpose controls are covered by P4.6.

## Metrics

Worker: `vigilone_anpr_plates_read_total`, `vigilone_anpr_frames_dropped_total`, and the adapter
metrics `vigilone_ai_*`. Backend: `vigilone_anpr_reads_ingested_total`,
`vigilone_anpr_reads_rejected_total{reason}`, `vigilone_anpr_observations_total`,
`vigilone_anpr_watchlist_matches_total`.

## Tests

* `services/ai-worker/src/__tests__/goldenAnpr.test.ts`: the TypeScript pipeline matches the
  Python reference (RapidOCR + fast-plate-ocr) on six SYNTHETIC plates (HSRP, commercial, EV,
  BH, two-line, monospace font).
* `services/ai-worker/src/__tests__/anprAdapter.test.ts`: licence refusal, wrong-hash approval,
  integrity failure, HTTP adapter with provenance components.
* `backend/src/__tests__/anprRealDb.test.ts`: real HTTP/DB path, voting, watchlist alarms.
* `scripts/e2e/anpr-lpr-scenario.sh`: SIMULATED camera (MediaMTX publishing a SYNTHETIC plate
  video) → worker → alarm; recording continues when the worker is killed.

The synthetic `POST /api/v1/anpr/detect` endpoint exists only when `NODE_ENV=test` and
`VIGILONE_ANPR_TEST_ENDPOINT=true`.
