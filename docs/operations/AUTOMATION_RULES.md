# Automation rules

`/api/v1/automation/rules` (create, `PUT` replace, delete; all audited). Rules are validated by
`backend/src/services/automation/ruleSchema.ts`; an invalid rule is rejected with
`RULE_INVALID` rather than stored.

**On screen:** Alarms page, **Automation rules** (operators and administrators, permission `AUTOMATION_MANAGE`). Until
2026-10-07 the builder opened only from the Federation console, which v1.0 never shows, so rules could only be made
through the API.

**Alarm grouping (ADR 0014):** on a `TRIGGER_ALARM` action, "Group repeats into one alarm for N seconds" sets
`incidentWindowSeconds`. Empty or 0 keeps one alarm per firing. The form accepts whole seconds from 0 to 86400 and the
backend refuses anything else. The rule list shows "groups repeats within Ns".

## Triggers

`PERSON_DETECTED`, `VEHICLE_DETECTED` (AI objects from the ai-worker: `minConfidence`,
`minDwellSeconds`, vehicle `objectClasses`), `TRIPWIRE_CROSS`, `LOITERING_DWELL`
(`spatialRuleId`), `ANPR_WATCHLIST`, `MOTION_ZONE`, `DIGITAL_INPUT_STATE`, `CAMERA_OFFLINE`,
`SCENE_CHANGE`, `CAMERA_ANALYTIC` (camera-native analytics: `analyticTypes`, `protocols`; fires
on start). All accept `cameraId`. Camera and spatial-rule ids must belong to the tenant.

## Conditions (all must hold)

- `SEVERITY_THRESHOLD` `{value: INFO|WARNING|CRITICAL}`: at least that severity.
- `TIME_SCHEDULE` `{operator: BETWEEN|NOT_BETWEEN, value: {windows: [{days, start, end}], timezone?}}`:
  evaluated at the **event** time in the given IANA zone, default the camera's site zone. `end` is
  exclusive; `end < start` is an overnight window belonging to the day it starts. DST follows the
  tz database.
- `PRECEDED_BY` / `NOT_PRECEDED_BY` `{value: {eventTypes, withinSeconds, scope: SAME_CAMERA|ANY_CAMERA|CAMERA, cameraId?, objectClasses?}}`:
  whether a stored event of those types happened strictly before the event within the window.
  Example (tailgating): person detected `NOT_PRECEDED_BY` `DI_TRIGGER` (badge reader) within 30 s.
  Limitation: correlation sees events already stored; a preceding event that arrives late is
  not seen.

Conditions are evaluated fail-closed: a stored condition the engine cannot evaluate (unknown
type, invalid JSON, no resolvable time zone) stops the rule and is counted in
`vigilone_rule_condition_errors_total{reason}`.

## Preview

`POST /automation/rules/preview {triggerType, triggerConfig, conditions, cooldownSeconds, from, to}`
replays stored events of the window (max 31 days, 5 000 events) through the engine's own
matching code without side effects, and reports `scanned`, `triggerMatched`,
`conditionsMatched` and `wouldFire` (after cooldown, in event time) with samples. It replays
events, not video: detections that never became events are not considered.

Tests: `ruleConditions.test.ts` (schedule/DST vectors cross-checked with Python zoneinfo,
validation), `ruleBuilderRealDb.test.ts` (live engine, correlation, preview, audit).
