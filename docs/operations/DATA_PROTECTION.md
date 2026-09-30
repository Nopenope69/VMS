# Data protection controls (DPDP Act, P4.6)

These are technical controls that support a DPDP compliance programme. They do not replace one:
the lawful basis, notices, consent where it applies, and grievance handling are for the Data
Fiduciary to decide and document.

## Per-tenant settings (`/api/v1/privacy/dpdp/settings`; permission PRIVACY_POLICY_MANAGE)

| Setting | Default | Effect |
| :--- | :--- | :--- |
| `faceProcessingEnabled` | **false** | When false, face-related processing is refused or dropped. Face redaction jobs fail with `REDACTION_FACE_PROCESSING_DISABLED`; this is checked when a job is created and again when it runs. Camera face analytics (Hikvision `faceDetection`, Dahua `FaceDetection`) are dropped and counted in `vigilone_camera_events_dropped_total{reason="face_processing_disabled"}`. Switching it on requires `acknowledgeBiometricProcessing: true` |
| `plateRetentionDays` | 30 | Plate reads (and their snapshot files) whose last sighting is older than this are purged |
| `detectionSnapshotRetentionDays` | 30 | AI detection snapshot images older than this are deleted. The event record (time, class, box, provenance) stays |
| `allowedPurposes` | all six | Purposes operators may declare for plate queries |

Every change is audited as `DPDP_SETTINGS_UPDATE` with the before and after values.

## Purpose limitation and audit on plate queries

`GET /anpr/observations`, `GET /anpr/watchlist` and `GET /search/plates` require all of the
following:

* the `PLATE_DATA_QUERY` permission. Tenant admins and operators have it; **viewers do not**.
* a purpose, sent as `X-VigilOne-Purpose` or `?purpose=`. The allowed values are
  SECURITY_INCIDENT_INVESTIGATION, LAW_ENFORCEMENT_REQUEST, ACCESS_CONTROL, SAFETY_EMERGENCY,
  LEGAL_CLAIM and AUDIT_REVIEW.
* for LAW_ENFORCEMENT_REQUEST and LEGAL_CLAIM, a reference (`X-VigilOne-Purpose-Reference`),
  such as an FIR or notice number.

Errors: `PURPOSE_REQUIRED` / `PURPOSE_UNKNOWN` / `PURPOSE_REFERENCE_REQUIRED` (400),
`PURPOSE_NOT_PERMITTED` (403).

Each answered query is recorded in the tamper-evident audit chain (`ANPR_OBSERVATIONS_QUERY`,
`ANPR_WATCHLIST_QUERY`, `PLATE_SEARCH_QUERY`). The record holds the user, purpose, reference,
filters and number of results, and the query is counted in
`vigilone_dpdp_sensitive_queries_total{category,purpose}`. The ANPR console asks for the purpose
before it loads any plate data.

VigilOne does no face recognition and has no face-matching endpoint. It stores no face images and
keeps no embeddings, except that (a) a person crop (see "Object crops" below) can contain a face if a
site has turned person crops on, and (b) with semantic search on, crops (person crops only where the
site enabled them) are turned into embeddings that can be searched by appearance (see "Semantic
search" below). Any further feature that queries biometric data must use the `BIOMETRIC` category
in `requirePurpose` and add its data to the purge. The `BIOMETRIC` category exists in `requirePurpose` for any future feature,
which must use it and add its data to the purge.

## Retention purge

The purge runs hourly (`DPDP_PURGE_INTERVAL_MS`) for every tenant, and on demand with
`POST /privacy/dpdp/purge`. It does the following:

* deletes plate reads past retention, together with their snapshot files;
* deletes detection snapshot files past retention and clears their path on the event;
* **keeps** anything on the same camera that overlaps an active incident evidence hold or a
  legal-hold evidence manifest;
* deletes files only under `RECORDINGS_DIR` or `SNAPSHOTS_DIR`. A path outside those roots is
  counted as `snapshotFilesOutsideRoots` and left alone.

Each run is audited as `DPDP_RETENTION_PURGE` with its counts, stored in `lastPurgeJson`, and
counted in `vigilone_dpdp_purged_total{kind}` (failures in `vigilone_dpdp_purge_failures_total`).

Recorded video follows the recording retention policies, not these settings.

## Object crops (Phase 5, ADR 0005)

Off unless `VIGILONE_FEATURE_OBJECT_CROPS=true`. A crop is a small JPEG of one detection, stored
under `CROPS_DIR` (default `<RECORDINGS_DIR>/crops`) with its SHA-256. It comes from a JPEG the
ai-worker attaches (worker setting `AI_ATTACH_CROPS=true`; the full frame never leaves the worker)
or from a detection's snapshot image. The crop is cut from the worker's model-input image, so it is
at most that resolution.

* **Person crops are off for every site** until an administrator enables them with
  `PUT /api/v1/crop-policy/:siteId` (`{"personCropsEnabled": true, "purpose": "...", "purposeReference": "..."}`).
  The purpose must be one of the allowed purposes above (a reference is required where the list
  says so). The acting user and time are stored, the change is audited (`CROP_POLICY_UPDATE`), and
  the database refuses an enabled row without them. Disabling clears the acknowledgement. Crops
  already stored stay until their retention ends or a hold releases; `GET` reports how many person
  crops remain. The lawful basis for enabling this is the deployment's own DPDP decision; nothing
  here is legal advice.
* **Retention:** 14 days for other objects, 7 days for people; each can be overridden per site
  (1 to 3650 days, `null` resets it).
* **Purge:** runs hourly (`CROP_PURGE_INTERVAL_MS`, at least 1000 ms, a bad value stops startup).
  Held evidence is never purged (same incident-hold and legal-hold lookup as above). If the hold
  lookup cannot be read, that run deletes nothing and is logged, counted
  (`vigilone_crop_purge_failures_total`) and audited (`CROP_PURGE_FAILED`). Runs are audited as
  `CROP_RETENTION_PURGE`.
* **Free space:** a crop is refused, loudly, when free space cannot be read or would fall below
  `CROP_MIN_FREE_BYTES` (default 5 GiB). Recording is never touched.
* Every capture outcome is counted in `vigilone_crops_total{outcome}`; `policy_denied` is the
  expected refusal of a person crop, `failed` carries a `code`.

## Semantic search over crops (Phase 5, ADR 0005)

Off unless `VIGILONE_FEATURE_SEMANTIC_SEARCH=true`. Details, setup and limits are in
`docs/operations/SEMANTIC_SEARCH.md`; the data-protection points are:

* An embedding is stored per crop and model and is deleted with its crop, so the crop retention,
  evidence holds and the per-site person-crop switch above govern it. A person crop is embedded only
  while its site still has person crops enabled.
* Searching by appearance over **people** is treated as biometric-category access: it needs the
  `CROP_PERSON_QUERY` permission and a declared, allowed purpose (and a reference where the purpose
  needs one), and every such query and every person-crop image view is written to the audit chain
  (`CROP_PERSON_SEARCH_QUERY`, `CROP_PERSON_IMAGE_VIEW`) with that purpose. Other crop searches are
  audited as `CROP_SEARCH_QUERY`. The audit entry is written before the answer is returned. A text
  query ("a person in a red jacket") is the same kind of access when it asks for people, and the audit
  entry records the query text itself, so an operator's free text is stored in the tamper-evident chain.
* Results never cross tenants, and a search names exactly one embedding model.
* Appearance search over people can behave like profiling even without face recognition. Whether and
  where a deployment may turn it on is its own DPDP decision; this is not legal advice.

