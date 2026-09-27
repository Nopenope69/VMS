# Incident workflow

Built on alarms (`/api/v1/alarms`). One sweeper (`AlarmWorkflowService`, every 15 s) handles the
time-based parts for alarms from every source.

- **Assignment:** `POST /alarms/:id/assign {userId | null}`. The assignee must be an active user
  of the tenant whose role can manage alarms. Audited (`ALARM_ASSIGN` / `ALARM_UNASSIGN`).
- **SLA:** `PUT /alarms/policies/sla {severity, ackWithinMinutes, resolveWithinMinutes?}`
  (`ALARM_POLICY_MANAGE`). Deadlines are `triggeredAt + minutes`, stamped on alarms raised after
  the policy existed (not retroactive). A breach is recorded once (`ackSlaBreachedAt`,
  `resolveSlaBreachedAt`), audited (`ALARM_SLA_BREACHED`) and counted
  (`vigilone_alarm_sla_breaches_total{kind,severity}`); the UI shows the deadline or the breach.
- **Escalation:** `POST /alarms/policies/escalation {name, minSeverity, steps: [{afterMinutes,
  channelIds}]}`. While an alarm stays unacknowledged each step fires once (unique
  `AlarmEscalation` row) and queues notifications to its channels (`ALARM_ESCALATED` audit).
  Acknowledging stops escalation. Policies apply to alarms raised after they were created.
- **Evidence holds:** every CRITICAL alarm on a camera gets an `IncidentEvidenceHold` over
  `[triggeredAt - INCIDENT_HOLD_PRE_SECONDS, triggeredAt + INCIDENT_HOLD_POST_SECONDS]`
  (defaults 60 s / 120 s). All segments overlapping the window are pinned with pinType
  `INCIDENT_HOLD` for `INCIDENT_HOLD_DAYS` (default 90), so retention cannot delete them. Once
  the window plus a finalize grace has passed the hold is `COMPLETE` (with the count) or `FAILED`
  with `NO_RECORDING_SEGMENTS_IN_WINDOW`; it never reports success without footage.
  `GET /alarms/:id/holds`.
- **One-click export:** `POST /alarms/:id/export` (`EVIDENCE_EXPORT`) builds the signed Section 63
  package over the hold window (or the default window), through the same path as
  `/evidence/export`. Audited (`ALARM_EVIDENCE_EXPORT`).
- **Operator verdicts:** `POST /alarms/:id/feedback {verdict: FALSE_ALARM | TRUE_ALARM, reason}`
  (`ALARM_FEEDBACK`, changeable, audited); `GET /alarms/feedback/stats?from&to` gives alarms,
  reviewed and false-alarm rate per rule and per model (model taken from the alarm's own
  provenance). The resolve dialog records the verdict.

Tests: `alarmWorkflowRealDb.test.ts` (real DB, HTTP, ffmpeg-generated segments),
`ruleBuilderRealDb.test.ts` (feedback), `migrationPhase3.test.ts` (constraints).
