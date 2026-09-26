# events.v1: canonical event envelope

Status: v1, draft-frozen with Phase 0. Schema: `backend/src/contracts/events.v1.ts`.

## Envelope

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Globally unique, used for de-duplication. |
| `type` | string | One of the types below, or `system.<snake_case>`. |
| `version` | `1` | Contract major version. |
| `tenantId` | string | |
| `siteId` | string \| null | Null when the producer does not know the site. |
| `cameraId` | string \| null | Null for non-camera sources (storage, access, POS, system). |
| `timestampUtc` | string | When the event happened (not when it was sent). ISO-8601 UTC with `Z`. |
| `source` | `{ kind, id }` | `kind` in `camera, recorder, storage, motion, ai, analytics, access, alarm_panel, pos, io, system, operator`. |
| `correlationId` | string | Groups an incident tree (event, derived events, actions). |
| `severity` | `INFO` \| `WARNING` \| `CRITICAL` | Optional. |
| `payload` | object | Validated per `type` (below). Unknown fields are rejected. |
| `provenance` | object \| null | **Required for `ai.*`, forbidden otherwise.** |

### AI provenance

`adapterId`, `adapterVersion`, `modelId`, `modelName`, `modelVersion`, `modelSha256` (64-hex),
`runtime`, optional `executionProvider`, `inferenceId`, `frameTimestampUtc`. This is what lets an
evidence export state exactly which model, weights and runtime produced an analytic event. A
producer without real provenance must not emit an `ai.*` event.

## Types and payloads

| Type | Payload |
| --- | --- |
| `camera.online`, `camera.offline`, `camera.degraded` | `reason?`, `lastSeenUtc?`, `fps?`, `expectedFps?`, `packetLossPercent?` |
| `recording.started`, `recording.stopped` | `segmentId?`, `reason?` |
| `storage.warning`, `storage.critical`, `storage.rollover`, `storage.full` | `volumeId`, `usedPercent`, `freeBytes` |
| `motion.detected` | `score` [0,1], `zoneId?`, `bbox?`, `method?` (`SCENE_DIFF` \| `AI`) |
| `ai.person_detected`, `ai.vehicle_detected` | `objectClass`, `confidence`, `bbox`, `trackId?` |
| `ai.line_crossing` | `ruleId`, `trackId`, `direction` (`A_TO_B` \| `B_TO_A` \| `UNSPECIFIED`), `objectClass?` |
| `ai.loitering` | `zoneId`, `trackId`, `dwellSeconds`, `thresholdSeconds` |
| `ai.plate_detected` | `plateText`, `confidence`, `watchlistMatchId?`, `watchlistCategory?`, `vehicleColor?` |
| `access.door_opened` | `doorId`, `credentialId?`, `forced?` |
| `alarm.fire` | `panelId`, `zone`, `state` (`ALARM` \| `TROUBLE` \| `RESTORED`) |
| `pos.transaction` | `terminalId`, `transactionId`, `amountMinor` (integer minor units), `currency` (ISO 4217) |
| `system.*` | `code`, `message`, `subsystem?`, `details?` |

## Mapping from `VigilOneEvent`

Implemented by `toEventV1()` in `backend/src/contracts/eventMapping.v1.ts`.

| `VigilOneEvent.type` | events.v1 type | Notes |
| --- | --- | --- |
| `MOTION` | `motion.detected` | `method: SCENE_DIFF` (today's producer is the classical ffmpeg scene detector). The internal `bbox` tuple has no declared coordinate space, so it is only carried when all values are within [0,1]. |
| `TRIPWIRE_CROSS` | `ai.line_crossing` | `tripwireId` becomes `ruleId`; `FORWARD`/`BACKWARD` become `A_TO_B`/`B_TO_A`, `BIDIRECTIONAL` becomes `UNSPECIFIED`. **Requires provenance.** |
| `LOITERING_DWELL` | `ai.loitering` | `dwellTimeSeconds` becomes `dwellSeconds`. **Requires provenance.** |
| `ANPR_MATCH` | `ai.plate_detected` | **Requires provenance.** |
| `CAMERA_OFFLINE` | `camera.offline` | |
| `STREAM_DEGRADED` | `camera.degraded` | `reason: STREAM_DEGRADED`. |
| `SCENE_CHANGE` | `camera.degraded` | `reason: TAMPER_<OCCLUSION\|DEFOCUS\|DISPLACEMENT>`. |
| `DI_TRIGGER` | `system.digital_input` | Not `access.door_opened`: a digital input is only a door once it is configured as a door contact, which the current model does not record. |
| `SYSTEM_ALERT` | `system.alert` | `alertCode` becomes `code`. |

The internal union carries no model provenance, so AI-derived events can only be mapped when the
caller passes the provenance of the inference that produced them; otherwise the mapping throws
`AI_PROVENANCE_REQUIRED`. Source kinds map as `VISION_AI`/`ANPR` to `ai`, `SPATIAL_ANALYTICS` to
`analytics`, `WATCHDOG`/`SYSTEM` to `system`, `HARDWARE_IO` to `io`, `ALARM` to `alarm_panel`,
`MANUAL` to `operator`.

Types with no internal producer yet: `camera.online`, `recording.*`, `storage.*`,
`ai.person_detected`, `ai.vehicle_detected`, `access.door_opened`, `alarm.fire`, `pos.transaction`.
