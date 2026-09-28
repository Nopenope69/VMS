# Fail-loud gate and second fake-success sweep (P0.4)

> [!IMPORTANT]
> **INTERNAL SELF-ASSESSMENT.** This document was written by the coding agent that implemented the work. It is not an independent audit, third-party certification, legal opinion or human sign-off. Any "independent verifier", reviewer or sign-off role named below is a role label from the execution contract, not a person who reviewed this work. Treat results as self-reported until re-run (see `docs/STATUS.md` and `docs/generated/TEST_STATUS.md`).


**Date:** 2026-09-26. **Type:** internal self-assessment by the coding agent, not an independent audit.
**Follows:** `SYSTEMIC_FAKE_SUCCESS_AUDIT_2026-09-12.md`.

## What changed

A CI gate now enforces the lessons of the 2026-09-12 audit instead of relying on reviewers:
`backend/scripts/ci/check-no-fake-success.ts` (`npm run check:no-fake-success`, job
*Hygiene, Model Licence & Fail-Loud Gates*). It scans `backend/src` and `services/ai-worker/src`
(tests excluded) for:

| Pattern id | What it catches |
| --- | --- |
| `SUCCESS_IN_CATCH` | `success/ok/confirmed/verified/healthy: true` or `COMPLETED/CONFIRMED/SUCCESS/VERIFIED` inside a `catch` block |
| `MOCK_OR_STUB_IDENTIFIER` | `mockX`, `fakeX`, `dummyX`, `mock-*`, `'test-stub'` in runtime code |
| `IN_MEMORY_EXTERNAL_STORE` | in-memory stand-ins for external systems (`s3Store`, ...) |
| `NON_TEST_ENV_FALLBACK` | behaviour gated on "not production" / "development" rather than `NODE_ENV=test` |
| `HARDCODED_CONFIRMATION` | literal `confirmed: true` |
| `INVENTED_HASH` | all-zero or literal 64-hex hashes |
| `INVENTED_VERSION` | literal semver / firmware strings |
| `HARDCODED_MODEL_NAME` | detector family names (yolo, mobilenet, efficientdet, rt-detr, rf-detr, ...) |

Each match must appear in `backend/scripts/ci/fake-success-allowlist.json` with a justification of
at least 15 characters. Entries are keyed on file + pattern + exact line text, so editing a flagged
line invalidates the entry; stale entries also fail the gate. The gate's own tests are in
`backend/src/__tests__/noFakeSuccessGate.test.ts`.

## Defects fixed in this sweep

| Location | Before | After | Test |
| --- | --- | --- | --- |
| `objectStorageArchive.service.ts` | In-memory "S3" marked jobs `COMPLETED` whenever `NODE_ENV !== 'production'` (i.e. in development) | Throws `FEATURE_DEFERRED_FOR_V1` unless `NODE_ENV=test` | `failLoudHardening.test.ts` |
| ai-worker `inferenceEngine.ts` | `AI_INFERENCE_MODE=test-stub` produced stub detections in development | Allowed only under `NODE_ENV=test` | ai-worker `inferenceEngine.test.ts` |
| ai-worker `modelLoader.ts` | `mock-runtime` accepted in any environment | Accepted only under `NODE_ENV=test` | gate + existing tests |
| `retentionPolicy.ts` | Non-atomic delete path for "mocked" clients reachable at runtime | Throws `RETENTION_ATOMIC_DELETE_UNAVAILABLE` outside tests | existing retention tests |
| `storageEpoch.service.ts` | Missing hash on an existing epoch silently re-anchored to the genesis hash | Records `CHAIN_BREAK:<epochId>` (not a hash) and logs; transition still proceeds so recording failover is not blocked | `failLoudHardening.test.ts` |
| `internal.routes.ts` detection ingest | P2002 conflict returned `success: true` even when no row matched the `inferenceId` | 409 `DETECTION_CONFLICT_UNRESOLVED` | `detectionIngestionIntegration.test.ts` |
| `otaUpdate.service.ts` | `skipHealthCheck` / `mockHealthCheck` could report a successful OTA without a real health check | Refused unless `NODE_ENV=test` | `failLoudHardening.test.ts` |
| ONVIF `client.ts`, `camera.routes.ts` | Invented `Generic ONVIF` / `Camera` / firmware `1.0.0` when the camera did not answer | `UNKNOWN` plus `deviceInfoError` | `onvifClient.test.ts` |
| `appliance.service.ts` | `softwareVersion: "1.0.0"` literal | OTA version file, else build `package.json`, with `softwareVersionSource` | gate |
| `system/disasterRecovery.service.ts` | Backup `schemaVersion: '5.22.0'` literal | `prisma-client@<runtime Prisma version>` | gate |
| `appliance/disasterRecovery.service.ts` | Restore wrote `1.0.0` as highest accepted OTA version when no live state existed | Uses the installed software version | gate |
| `auth.routes.ts` bootstrap | `initializationVersion: '1.0.0'` literal | Installed software version | gate |
| `federation.routes.ts` register | Missing node facts defaulted to invented values (`anprEnabled: true`, 16 cameras, 1000 GB, versions) | 400 `NODE_FACTS_REQUIRED` | gate |

Frontend fake-success paths (alarm acknowledge/resolve marked done locally as a hard-coded
operator when the backend failed; simulated alarms and cameras on empty lists or API errors) were
fixed under P0.3; see `docs/STATUS.md`.

## Not covered

- The gate is pattern-based. It cannot prove absence of fake success; it prevents the known
  shapes from coming back unnoticed.
- The frontend is not scanned by this gate; it is covered by the demo-bundle denylist
  (`frontend/scripts/check-no-demo-in-bundle.mjs`).
