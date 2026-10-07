# 0014: One incident, one alarm (incident window)

## Status
Accepted (2026-10-05). Builds on ADR 0004 (IncidentOrchestrator). Idea taken from how Frigate ends a review item
(`frigate/review/maintainer.py`, MIT; design only, no code copied). See
`docs/strategy/vigilone-oss-reference-study-2026-10-05.md`.

## Context
A rule's cooldown only skips evaluation after a firing. A person who stays in a zone fires the rule again after
every cooldown, and each firing raised a new alarm. The operator saw a list of alarms about one event. Alarm
triage and incident summaries (the next planned features) need one alarm to stand for one incident.

## Decision
* A `TRIGGER_ALARM` action may carry `incidentWindowSeconds` (a whole number, 0 to 86400). **Unset or 0 keeps
  today's behaviour exactly**: every firing raises its own alarm. No flag is needed because nothing changes until
  a rule asks.
* With a window, a firing **joins** the newest open alarm (ACTIVE or ACKNOWLEDGED) of the **same rule and the same
  camera** when that alarm's last activity is inside the window. Otherwise a new alarm is raised.
* A join moves `lastActivityAt`, adds one to `occurrenceCount`, remembers the trigger event in
  `metadataJson.continuations` (the last 50), and writes an `ALARM_CONTINUE` audit entry.
* **Never joined:** a RESOLVED alarm (the operator closed that incident); an alarm older than one hour
  (`MAX_INCIDENT_SPAN_SECONDS`), however continuous the activity, so a long event cannot hide a new one.
* **Severity** only goes up. If the rule's severity is raised while an incident is open, the next joining firing
  raises the open alarm and its notification is sent again. A lower severity never lowers it.
* **Notifications:** a `DISPATCH_NOTIFICATION` for a firing that only continues an incident is not sent again; the
  action succeeds with `suppressed: INCIDENT_CONTINUATION`. A firing that escalated the severity is sent.
* The decision is one pure function (`decideIncidentJoin`, `incidentWindow.ts`); the orchestrator only applies it.

## Not decided here
* Frigate also holds a detection that appears after an alert's last activity and publishes it as its own segment.
  We keep the simpler rule: after the window, a new alarm.
* Joining across rules or cameras. A journey across cameras is the investigation entity (North Star, V1.0).
* ~~A window set from the rule builder UI.~~ Added 2026-10-07 (Session 37): "Group repeats into one alarm for N seconds" on
  a TRIGGER_ALARM action; `e2e/automation-rules.spec.ts`.

## Consequences
* `Alarm` gains `lastActivityAt`, `occurrenceCount`, `lastCanonicalEventId` (migration `20261014000000`).
* The window should be at least the rule's cooldown, or a quiet gap shorter than the cooldown cannot be seen.
* Two firings handled at exactly the same moment could both raise an alarm: the outbox runs actions one at a time
  in one process, so this was not seen, and there is no database lock. Revisit if the outbox is ever parallelised.
* Only one escalation notice per severity rise is sent; operators see the rest in `occurrenceCount`.
* Not measured on real sites. Choosing a window per rule needs pilot data on how long real events last.
