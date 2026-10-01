# 0006: One table describes each VigilOneEvent kind

## Status
Accepted (2026-10-01). Item 2 of the architecture review.

## Context
Adding or changing a `VigilOneEvent` kind meant editing five places that had to agree with each other:

* `RuleEngine.mapEventTypeToTriggerType`, a switch from event kind to rule trigger type;
* `RuleEngine.matchesTriggerConfig`, one `if (payload.kind === ...)` branch per kind;
* `ruleSchema.ts`, the `EVENT_TYPES` list and a zod schema per trigger type (`TRIGGER_CONFIG`);
* `rulePreview.service.ts`, `EVENT_TYPES_FOR`, the inverse of the first switch, written out by hand;
* `eventMapping.v1.ts`, the events.v1 type table, a payload switch, and per-kind type refinements for AI objects and doors.

The automation dry run kept a sixth copy of the kind list. Nothing checked that the copies agreed. A kind that
was added to the union but forgotten in the preview's inverse map would make the preview silently scan nothing.

## Decision
`backend/src/services/incident/orchestrator/eventKinds.ts` holds one entry per kind (`EVENT_KINDS`). Each
entry has:

* the trigger types it feeds, with each trigger's config schema;
* how one event picks its trigger type (only AI objects need this: person or vehicle);
* its kind-specific trigger-config match;
* its events.v1 type, a per-event refinement where needed, and its payload.

Every other view is derived from the table and has no table of its own:

* the rule engine's trigger mapping and match;
* the rule schema's kind list and config schemas;
* the rule preview's event-type filter (`RULE_TRIGGERS[trigger].eventKind`);
* the dry run's type check;
* the events.v1 mapping.

Checks that the table is complete:

* The compiler refuses a kind that has no entry (`{ [K in VigilOneEventType]: EventKind<K> }`).
* A load-time check throws if a `RuleTriggerType` is fed by no kind, or by two.
* `eventKinds.test.ts` pins both, plus the kind-to-trigger mapping.

## Consequences
* Adding a kind is one entry in the table, plus its payload type in `types.ts`.
* Behaviour is unchanged. The existing rule engine, orchestrator, events.v1, preview, dry-run and Modbus door
  tests pass unmodified.
* The Prisma `RuleTriggerType` enum stays as it is. Stored rules are untouched.
