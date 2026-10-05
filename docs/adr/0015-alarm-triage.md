# 0015: Alarm triage, order and propose, never decide

## Status
Accepted (2026-10-05). Builds on ADR 0014 (incident window) and ADR 0004. Second of the four software features in
`docs/strategy/vigilone-ai-features-landscape-2026-10-03.md`, section 6.

## Context
Alarm fatigue is the main operator complaint. Operators already record a verdict on alarms (`AlarmFeedback`), the
local VLM gives an advisory yes/no (`VlmVerification`), and an incident now carries a repeat count (ADR 0014). None
of it reached the queue.

## Decision
Feature `ALARM_TRIAGE`, off by default. Two read-only endpoints under `/api/v1/alarm-triage`:

* **`GET /queue`** (needs `CAMERA_VIEW`): the open (ACTIVE) alarms, most important first, each with the reasons
  for its place.
  * **Severity first.** Nothing below can put a WARNING above a CRITICAL.
  * Inside a severity, adjustments (each stated as a reason): repeat activity (+1 per repeat, at most +10); a passed
    acknowledge deadline (+15); the second opinion "no" (-15) or "yes" (+10), labelled advisory; the history of the
    same rule on the same camera over 30 days once at least 10 alarms were reviewed (mostly false: -15; mostly
    confirmed: +10). Then the oldest first.
  * **Nothing is hidden, acknowledged or resolved.** The response says it is advisory.
* **`GET /report`** (needs `ALARM_FEEDBACK`): false-alarm counts per camera, and **proposed** rule changes for a
  rule and camera with at least 20 reviewed alarms of which at least 90 % were false: add an incident window if the
  rule has none, otherwise review its zone, schedule, class filter or confidence. Each proposal carries its
  numbers and says to check the change with the rule dry run. Every proposal has `applied: false`; nothing in this
  feature writes a rule.
* The rules are pure functions (`incident/triage/alarmTriage.ts`); the service only reads and calls them.

## Why order and propose instead of suppress
A model's "no" is wrong sometimes (`vlmAgreement.service.ts` measures how often it doubts a true alarm), and a
wrongly buried alarm is the harmful error. Ordering costs an operator a few seconds; hiding costs a missed event.
"AI proposes, the rule engine acts" (North Star, section 6): a proposal only becomes a change when an operator saves
it in the rule editor.

## Not decided here
* No automatic quieting, no per-operator view, no learning beyond counting verdicts.
* After-hours and zone risk are not scored: they need each site's schedule, which is not stored per camera.
* No frontend yet; the endpoints are API only, so the queue page is the next piece.
* The thresholds (10 reviewed, 20 for a proposal, 80 % / 90 %) are first guesses. Tune them on pilot verdicts.

## Consequences
* An alarm that operators keep marking false sinks inside its severity once there are 10 verdicts, and a rule that
  keeps being right rises. A rule that changes behaviour keeps its old history for up to 30 days.
* `occurrenceCount` only grows on rules with an incident window, so repeat points appear only there.
* Not used by operators on a real site, so whether the order helps is unmeasured.
