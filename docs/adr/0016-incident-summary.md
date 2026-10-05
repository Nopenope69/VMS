# 0016: Incident summary, a written story where every sentence cites recorded facts

## Status
Accepted (2026-10-06). Third of the four software features in `docs/strategy/vigilone-ai-features-landscape-2026-10-03.md`
(section 6, item 3). Follows the pattern of ADR 0005's explanation records and builds on ADR 0014 (incident window).

## Context
Operators and investigators need "what happened here" as a short text, not a pile of rows. Vendors sell AI-written case
summaries. A model-written paragraph can state things that never happened, and in a court bundle that is worse than no
summary. VigilOne's difference is evidence: the summary must be checkable.

## Decision
Feature `INCIDENT_SUMMARY`, off by default.

* **Facts first.** A summary is built from a numbered timeline of recorded facts (`F1`, `F2`, ...): the alarm being raised,
  the triggering event, earlier events in its correlation chain, the linked detection, tracks and operator-confirmed links
  of a journey, repeats (ADR 0014), the advisory second opinion, acknowledgement, verdict, resolution, and evidence holds.
  Facts come only from existing rows. A fact that is not recorded is absent, never guessed.
* **Template, no model (`incident-summary.v1`).** The text is a pure function of the facts: one sentence per fact (runs of
  earlier events or detections share one sentence). **Every sentence ends with the facts it rests on, `[F1, F3]`.** The only
  sentence without a citation is the fixed closing statement. A model may be added later as a new template version that
  must obey the same rule; it cannot replace this one.
* **Nothing personal is repeated.** No number plate text, no person description, no free text typed by an operator (only
  that it exists), no colour or appearance attributes. User ids appear as opaque ids. A plate trigger says a plate was read
  and withheld. The facts schema is strict, so such fields cannot be added by accident.
* **Hashed and chained.** The record holds the facts, the sentences with their citations, and three SHA-256 hashes
  (facts, text, record). Creating one writes an audit-chain entry carrying the record hash, which puts it in the custody
  chain. Records are immutable. An incident keeps changing (acknowledged, resolved), so each generation is a snapshot: the id
  is derived from the alarm, template and facts hash, and generating again after the facts changed makes a new record.
* **Checked offline.** The summary document goes into the evidence package (`incident_summaries.json`, role
  `INCIDENT_SUMMARIES`, listed in the signed manifest). `vigilone-verify` recomputes the hashes, re-renders the text from the
  facts with its own copy of the template, and checks that every citation points at a fact in the record and that every
  fact is cited. A parity test runs both renderers on the same inputs.
* **API.** `POST /api/v1/incident-summaries/alarms/:alarmId` (generate a snapshot; needs `ALARM_MANAGE`; audited),
  `GET /api/v1/incident-summaries/alarms/:alarmId` (latest; needs `CAMERA_VIEW`).

## Not decided here
* No language model writes any sentence yet. If one is added, its output goes in as a new template version whose every
  claim cites facts and is checked by a rule, not trusted; that needs the local-model licence decision.
* Summaries of a journey across cameras include the journey's tracks and confirmed links, but not a map or a person
  description. Cross-camera "who is this" stays with the operator.
* Hindi and other languages: the template is English. A translated template is a new version.
* The summary does not say the event occurred. It says what the system recorded.

## Consequences
* `IncidentSummary` table (migration `20261016000000`), one new audit action `INCIDENT_SUMMARY_CREATED`.
* The offline verifier carries a second copy of a template, so a template change needs a new version in both, and the
  parity test fails first if they drift.
* A summary of an alarm with no linked event is short (alarm raised, then its lifecycle). That is correct, not a gap.
* Not used by investigators on a real site; whether the text saves time is unmeasured (the time-to-answer stopwatch can
  measure it in the pilot).
