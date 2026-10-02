# Feature flags

Source of truth: `backend/src/config/featureFlags.ts`. The README scope table is generated from it
(`cd backend && npm run docs:feature-flags`), and CI fails if the README drifts
(`npm run check:feature-flag-docs`).

## Why they exist

Several subsystems are built but not proven on real hardware, real identity providers or real
models. Shipping them "on" would let an operator believe they work. Each one is therefore behind a
flag that is **off by default**.

## Behaviour when a flag is off

| Layer | Behaviour |
| --- | --- |
| HTTP API | Every route under the flag's prefix answers `501` with `{"code":"FEATURE_DISABLED","feature":"<FLAG>","enableWith":"VIGILONE_FEATURE_<FLAG>=true"}`. The guard runs before authentication, so no handler runs and nothing is written. |
| Background workers | Not started (currently: the ANPR plate-track aggregator). |
| Operator console | Navigation entries and entry-point buttons are hidden. Navigating to the page directly shows the out-of-scope notice. The console reads `GET /api/v1/features` after login and treats any error as "all off". |

Flags are read from the environment on every request. Set `VIGILONE_FEATURE_<FLAG>=true` in `.env`
(passed through by `docker-compose.yml`) and restart the backend to be sure workers start.

## Flags

| Flag | Env var | Gated prefix |
| --- | --- | --- |
| `FEDERATION` | `VIGILONE_FEATURE_FEDERATION` | `/api/v1/federation` and the site `federationUplink` (hash-chained site-to-headquarters sync; `docs/operations/MULTI_SITE.md`) |
| `OBJECT_STORAGE_ARCHIVE` | `VIGILONE_FEATURE_OBJECT_STORAGE_ARCHIVE` | `/api/v1/archive` and the `archiveWorker` (S3-compatible off-site archive; `docs/operations/MULTI_SITE.md`) |
| `OIDC_SSO` | `VIGILONE_FEATURE_OIDC_SSO` | `/api/v1/sso` |
| `DIO_RELAY` | `VIGILONE_FEATURE_DIO_RELAY` | `/api/v1/relays`, `/api/v1/access` (doors, I/O modules); also starts the door monitor; see PHYSICAL_ACCESS.md |
| `ANPR` | `VIGILONE_FEATURE_ANPR` | `/api/v1/anpr`, `/api/v1/internal/anpr/*` (501 `FEATURE_DISABLED`); see ANPR.md |
| `REDACTION` | `VIGILONE_FEATURE_REDACTION` | `/api/v1/privacy/jobs` (privacy policies stay available) |
| `SMART_SEARCH` | `VIGILONE_FEATURE_SMART_SEARCH` | `/api/v1/search` |
| `FLOORPLANS` | `VIGILONE_FEATURE_FLOORPLANS` | `/api/v1/floorplans` |
| `CAMERA_EVENTS` | `VIGILONE_FEATURE_CAMERA_EVENTS` | `/api/v1/camera-events` (and the `cameraEventManager` worker; see `docs/operations/CAMERA_EVENTS.md`) |
| `EXPLANATIONS` | `VIGILONE_FEATURE_EXPLANATIONS` | no routes: an explanation is generated for each new alarm and written into evidence packages (ADR 0005) |
| `SEMANTIC_SEARCH` | `VIGILONE_FEATURE_SEMANTIC_SEARCH` | `/api/v1/search/crops` and the `cropEmbedder` worker (needs `EMBEDDING_ADAPTER_URL`; ADR 0005) |
| `VLM_VERIFICATION` | `VIGILONE_FEATURE_VLM_VERIFICATION` | the `vlmVerifier` worker and `GET /api/v1/alarms/:id/second-opinion`, `/alarms/second-opinion/agreement` (needs `VLM_ADAPTER_URL`; ADR 0005; advisory only) |
| `TRACK_INDEX` | `VIGILONE_FEATURE_TRACK_INDEX` | `/api/v1/tracks` (list, one track, and `POST /search`, which also needs `SEMANTIC_SEARCH`) and the per-detection track update in detection and plate ingestion (ADR 0011, 0012; `TRACK_INDEX.md`, `TRACK_SEARCH.md`) |
| `OBJECT_CROPS` | `VIGILONE_FEATURE_OBJECT_CROPS` | `/api/v1/crop-policy` (per-site person-crop switch and retention), crop capture on the detection path and the `cropPurger` worker (ADR 0005); person crops also need the per-site switch |

Note: the ANPR router also checks the licence entitlement (`requireFeature('ANPR')` in
`middleware/license.ts`). The feature flag is an operational switch; the licence is a commercial
one. Both must allow a request.

## Tests

`backend/src/__tests__/featureFlags.test.ts` mounts the real `app.ts` routing table over HTTP and
checks, for every flag, that the route answers 501 when off and reaches the real router (401 from
the auth gate) when on.

## Adding a flag

1. Add it to `FeatureFlag` and `FEATURE_FLAGS` with an honest `status` line.
2. Guard the route prefix in `backend/src/app.ts` with `requireFeatureFlag(...)`, and any worker in
   `backend/src/server.ts` with `isFeatureEnabled(...)`.
3. Add it to `frontend/src/services/features.ts` and hide its UI entry points.
4. Run `npm run docs:feature-flags` and add the probe to `featureFlags.test.ts`.
