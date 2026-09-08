# 0004: Unified IncidentOrchestrator Architecture

## Status
Accepted

## Context
Event processing, automation rules, alarm operations, digital I/O relays, and notification dispatching in VigilOne were fragmented across loosely coordinated services: `AlarmService` (`backend/src/services/alarm/alarm.service.ts`), `EventActionMatrixService` (`backend/src/services/automation/eventActionMatrix.service.ts`), `GpioRelayService` (`backend/src/services/hardware/gpioRelay.service.ts`), and `NotificationDispatcherService` (`backend/src/services/notification/notificationDispatcher.service.ts`).

This caused several critical architectural vulnerabilities:
1. **Loose Event Typing:** Sensor events lacked a canonical contract, relying on untyped JSON payloads that hid typing bugs until runtime.
2. **Cascading Feedback Loops:** While individual rules had cooldown timers, cross-rule feedback loops (e.g. Rule A triggers relay $\rightarrow$ DI triggers Rule B $\rightarrow$ triggers notification $\rightarrow$ triggers alarm $\rightarrow$ triggers relay) could cascade indefinitely.
3. **Missing Outbox Boundary:** Actions (hardware relay pulses, webhook dispatching, PTZ moves) were executed synchronously inside ingestion handlers, risking silent action loss if the process crashed after event ingestion.
4. **Fragile Relay Feedback Assumptions:** Relays assumed physical state feedback (`STATE_CONFIRMED`) even for open-loop hardware or simple pulses.
5. **Duplicate Ingestion Replays:** Lack of database-enforced unique execution keys allowed retried HTTP requests or replayed sensor events to trigger duplicate rule runs.

## Decision
We consolidate event ingestion, automation rule evaluation, action queueing, alarm lifecycle management, relay execution, and notification delivery into a unified deep module: **`IncidentOrchestrator`** (`backend/src/services/incident/orchestrator/`).

1. **Strongly-Typed Canonical Event Contract (`VigilOneEvent`)**:
   - Standardized `VigilOneEventType` union (`'MOTION' | 'TRIPWIRE_CROSS' | 'LOITERING_DWELL' | 'ANPR_MATCH' | 'CAMERA_OFFLINE' | 'STREAM_DEGRADED' | 'DI_TRIGGER' | 'SCENE_CHANGE' | 'SYSTEM_ALERT'`).
   - Strongly-typed `SpatialRef` and `EvidenceRef`.
   - Discriminated union payloads per event family (`MotionEventPayload`, `TripwireEventPayload`, `AnprEventPayload`, etc.).

2. **Cascade Loop & Depth Protection**:
   - Events carry `correlationId`, `rootEventId`, and `depth`.
   - Hard execution limits: `MAX_EVENT_ACTION_DEPTH = 5` and `MAX_ACTIONS_PER_CORRELATION = 25`.
   - If a cascading event chain breaches depth or count limits, execution terminates safely with `status = 'CASCADE_TERMINATED'`, emitting a security warning.

3. **Multi-Level Database-Enforced Idempotency**:
   - `event.id` is the canonical deduplication key.
   - `RuleExecutionRecord` enforces `@@unique([ruleId, triggerEventId])`. Duplicate event ingestion never runs duplicate rules.
   - `ActionExecutionRecord` enforces `@@unique([ruleExecutionId, actionId])`. Duplicate rule executions never trigger duplicate actions.

4. **Persistent Action Outbox Pattern**:
   - `ingestEvent()` persists the event and creates pending `RuleExecutionRecord` and `ActionExecutionRecord` entries durably before dispatch.
   - `ActionOutbox` claims pending action records and executes domain adapters (PTZ, Relay, Notification, Bookmark, Alarm elevation).
   - In-flight failures retry with exponential backoff; crashes resume cleanly from persisted state.

5. **Adapter-Specific Relay Confirmation Semantics**:
   - `RelayConfirmationMode`:
     - `ACK_ONLY`: Confirms controller receipt (`COMMAND_ACK`). Never falsely claims `STATE_CONFIRMED`.
     - `STATE_FEEDBACK`: Only transitions to `STATE_CONFIRMED` when physical input feedback matches target state.
     - `PULSE_COMPLETION`: Confirms once timed pulse cycle has safely completed.
   - Hardware timeouts are configurable per pin/device (default 3000ms).

6. **Lean Public Facade with `CommandContext`**:
   - `IncidentOrchestrator` facade focuses strictly on incident operations: `ingestEvent`, `acknowledgeAlarm`, `resolveAlarm`, `getAlarm`, `listAlarms`, `drainOutbox`.
   - All mutations consume `CommandContext` (`tenantId`, `actorUserId`, `correlationId`, `permissions`), enforcing tenant boundaries and committing atomic `AuditChainService` records.
   - Internal submodules (`RuleEngine`, `AlarmLifecycle`, `ActionOutbox`, `RelayAdapter`, `NotificationAdapter`) remain private.

7. **Unified Event $\neq$ Alarm Mental Model**:
   - Events never spontaneously become alarms.
   - Alarms are created strictly through explicit rule actions (including built-in system rules for critical events).
