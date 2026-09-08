import {
  IncidentOrchestrator,
  VigilOneEvent,
  createVigilOneEvent,
  fromMotionEvent,
  fromTripwireCrossing,
  fromLoiteringResult,
  fromAnprObservation,
  fromDigitalInput,
  fromCameraOffline,
  deriveChildEvent,
  MAX_EVENT_ACTION_DEPTH,
  MAX_ACTIONS_PER_CORRELATION,
  RelayConfirmationMode,
} from '../services/incident/orchestrator';
import {
  EventSeverity,
  AlarmState,
  RuleTriggerType,
  RuleActionType,
  RelayCommandState,
} from '@prisma/client';

describe('Candidate 04: Authoritative IncidentOrchestrator Deep-Module', () => {
  let orchestrator: IncidentOrchestrator;
  let mockPrisma: any;

  // In-memory data tables
  let rulesStore: any[] = [];
  let ruleExecutionsStore: any[] = [];
  let actionExecutionsStore: any[] = [];
  let alarmsStore: any[] = [];
  let digitalPinsStore: any[] = [];
  let relayLogsStore: any[] = [];
  let notificationChannelsStore: any[] = [];
  let notificationJobsStore: any[] = [];
  let notificationLogsStore: any[] = [];
  let auditEventsStore: any[] = [];

  const tenantId = 'tenant_incident_test';

  beforeEach(() => {
    rulesStore = [];
    ruleExecutionsStore = [];
    actionExecutionsStore = [];
    alarmsStore = [];
    digitalPinsStore = [];
    relayLogsStore = [];
    notificationChannelsStore = [];
    notificationJobsStore = [];
    notificationLogsStore = [];
    auditEventsStore = [];

    mockPrisma = {
      $transaction: jest.fn(async (arg: any) => {
        if (Array.isArray(arg)) {
          return Promise.all(arg);
        }
        if (typeof arg === 'function') {
          return await arg(mockPrisma);
        }
        return arg;
      }),
      $executeRaw: jest.fn().mockResolvedValue(1),

      automationRule: {
        findMany: jest.fn().mockImplementation(({ where }) => {
          return Promise.resolve(
            rulesStore.filter((r) => {
              if (r.tenantId !== where.tenantId) return false;
              if (where.enabled !== undefined && r.enabled !== where.enabled) return false;
              if (where.triggerType?.in && !where.triggerType.in.includes(r.triggerType)) return false;
              return true;
            })
          );
        }),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const r = rulesStore.find((item) => item.id === where.id);
          if (r) Object.assign(r, data);
          return Promise.resolve(r);
        }),
      },

      ruleExecutionRecord: {
        create: jest.fn().mockImplementation(({ data }) => {
          // Idempotency: @@unique([ruleId, triggerEventId])
          if (data.triggerEventId) {
            const existing = ruleExecutionsStore.find(
              (r) => r.ruleId === data.ruleId && r.triggerEventId === data.triggerEventId
            );
            if (existing) {
              const err: any = new Error('Unique constraint failed on ruleId_triggerEventId');
              err.code = 'P2002';
              throw err;
            }
          }
          const record = { id: `rule_exec_${ruleExecutionsStore.length + 1}`, ...data };
          ruleExecutionsStore.push(record);
          return Promise.resolve(record);
        }),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const rec = ruleExecutionsStore.find((r) => r.id === where.id);
          if (rec) Object.assign(rec, data);
          return Promise.resolve(rec);
        }),
        count: jest.fn().mockImplementation(() => Promise.resolve(ruleExecutionsStore.length)),
      },

      actionExecutionRecord: {
        create: jest.fn().mockImplementation(({ data }) => {
          // Idempotency: @@unique([ruleExecutionId, actionId])
          const existing = actionExecutionsStore.find(
            (a) => a.ruleExecutionId === data.ruleExecutionId && a.actionId === data.actionId
          );
          if (existing) {
            const err: any = new Error('Unique constraint failed on ruleExecutionId_actionId');
            err.code = 'P2002';
            throw err;
          }
          const record = {
            id: `act_exec_${actionExecutionsStore.length + 1}`,
            attempt: 1,
            durationMs: 0,
            startedAt: new Date(),
            ...data,
          };
          actionExecutionsStore.push(record);
          return Promise.resolve(record);
        }),
        findMany: jest.fn().mockImplementation(({ where }) => {
          let list = [...actionExecutionsStore];
          if (where?.status) {
            list = list.filter((a) => a.status === where.status);
          }
          if (where?.ruleExecutionId) {
            list = list.filter((a) => a.ruleExecutionId === where.ruleExecutionId);
          }
          // Attach ruleExecution relation
          return Promise.resolve(
            list.map((a) => ({
              ...a,
              ruleExecution: ruleExecutionsStore.find((re) => re.id === a.ruleExecutionId),
            }))
          );
        }),
        updateMany: jest.fn().mockImplementation(({ where, data }) => {
          let count = 0;
          for (const a of actionExecutionsStore) {
            if (a.id === where.id && (where.status === undefined || a.status === where.status)) {
              Object.assign(a, data);
              count++;
            }
          }
          return Promise.resolve({ count });
        }),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const a = actionExecutionsStore.find((item) => item.id === where.id);
          if (a) Object.assign(a, data);
          return Promise.resolve(a);
        }),
        count: jest.fn().mockImplementation(({ where }) => {
          let count = 0;
          const corr = where?.ruleExecution?.correlationId;
          for (const a of actionExecutionsStore) {
            const parent = ruleExecutionsStore.find((re) => re.id === a.ruleExecutionId);
            if (!corr || parent?.correlationId === corr) {
              count++;
            }
          }
          return Promise.resolve(count);
        }),
      },

      alarm: {
        findUnique: jest.fn().mockImplementation(({ where }) => {
          return Promise.resolve(alarmsStore.find((a) => a.id === where.id) || null);
        }),
        findMany: jest.fn().mockImplementation(({ where }) => {
          return Promise.resolve(
            alarmsStore.filter((a) => {
              if (a.tenantId !== where.tenantId) return false;
              if (where.state && a.state !== where.state) return false;
              if (where.severity && a.severity !== where.severity) return false;
              return true;
            })
          );
        }),
        create: jest.fn().mockImplementation(({ data }) => {
          const alarm = {
            id: `alarm_${alarmsStore.length + 1}`,
            state: AlarmState.ACTIVE,
            triggeredAt: new Date(),
            ...data,
          };
          alarmsStore.push(alarm);
          return Promise.resolve(alarm);
        }),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const a = alarmsStore.find((item) => item.id === where.id);
          if (a) Object.assign(a, data);
          return Promise.resolve(a);
        }),
      },

      digitalIoPin: {
        findUnique: jest.fn().mockImplementation(({ where }) => {
          if (where.tenantId_pinNumber) {
            const p = digitalPinsStore.find(
              (pin) =>
                pin.tenantId === where.tenantId_pinNumber.tenantId &&
                pin.pinNumber === where.tenantId_pinNumber.pinNumber
            );
            return Promise.resolve(p || null);
          }
          return Promise.resolve(null);
        }),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const p = digitalPinsStore.find((pin) => pin.id === where.id);
          if (p) Object.assign(p, data);
          return Promise.resolve(p);
        }),
      },

      relayCommandLog: {
        create: jest.fn().mockImplementation(({ data }) => {
          const log = { id: `log_${relayLogsStore.length + 1}`, ...data };
          relayLogsStore.push(log);
          return Promise.resolve(log);
        }),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const l = relayLogsStore.find((item) => item.id === where.id);
          if (l) Object.assign(l, data);
          return Promise.resolve(l);
        }),
      },

      notificationChannel: {
        findMany: jest.fn().mockImplementation(({ where }) => {
          return Promise.resolve(
            notificationChannelsStore.filter((c) => c.tenantId === where.tenantId && c.enabled)
          );
        }),
      },

      notificationJob: {
        upsert: jest.fn().mockImplementation(({ where, create }) => {
          const existing = notificationJobsStore.find(
            (j) => j.idempotencyKey === where.idempotencyKey
          );
          if (existing) return Promise.resolve(existing);
          const job = { id: `njob_${notificationJobsStore.length + 1}`, ...create };
          notificationJobsStore.push(job);
          return Promise.resolve(job);
        }),
        findMany: jest.fn().mockImplementation(() => Promise.resolve(notificationJobsStore)),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const j = notificationJobsStore.find((item) => item.id === where.id);
          if (j) Object.assign(j, data);
          return Promise.resolve(j);
        }),
      },

      notificationLog: {
        create: jest.fn().mockImplementation(({ data }) => {
          notificationLogsStore.push(data);
          return Promise.resolve(data);
        }),
      },

      auditEvent: {
        findFirst: jest.fn().mockImplementation(({ where }) => {
          const filtered = auditEventsStore.filter((a) => a.tenantId === where.tenantId);
          return Promise.resolve(filtered[filtered.length - 1] || null);
        }),
        create: jest.fn().mockImplementation(({ data }) => {
          const ev = { id: `audit_${auditEventsStore.length + 1}`, ...data };
          auditEventsStore.push(ev);
          return Promise.resolve(ev);
        }),
        findMany: jest.fn().mockImplementation(({ where }) => {
          return Promise.resolve(auditEventsStore.filter((a) => a.tenantId === where.tenantId));
        }),
      },

      camera: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };

    orchestrator = new IncidentOrchestrator(mockPrisma);
  });

  afterEach(() => {
    orchestrator.stop();
  });

  // --- Requirement 1: Strongly-Typed VigilOneEvent & Factory Adapters ---
  describe('Requirement 1: Strongly-Typed Canonical Contracts & Normalization', () => {
    it('creates and normalizes motion, tripwire, loitering, and ANPR events without any', () => {
      const motion = fromMotionEvent({
        tenantId,
        score: 0.94,
        bbox: [100, 150, 200, 300],
        label: 'person',
      });
      expect(motion.type).toBe('MOTION');
      expect(motion.payload.kind).toBe('MOTION');
      expect(motion.payload.score).toBe(0.94);
      expect(motion.payload.bbox).toEqual([100, 150, 200, 300]);
      expect(motion.correlationId).toMatch(/^corr_/);
      expect(motion.depth).toBe(0);

      const tripwire = fromTripwireCrossing({
        tenantId,
        tripwireId: 'tw_gate_north',
        trackId: 'trk_99',
        direction: 'FORWARD',
        velocity: 2.3,
      });
      expect(tripwire.type).toBe('TRIPWIRE_CROSS');
      expect(tripwire.payload.kind).toBe('TRIPWIRE_CROSS');
      expect(tripwire.payload.direction).toBe('FORWARD');

      const loiter = fromLoiteringResult({
        tenantId,
        zoneId: 'zone_restricted',
        trackId: 'trk_99',
        dwellTimeSeconds: 45,
        thresholdSeconds: 30,
      });
      expect(loiter.type).toBe('LOITERING_DWELL');
      expect(loiter.payload.dwellTimeSeconds).toBe(45);

      const anpr = fromAnprObservation({
        tenantId,
        plateText: 'DL01AB1234',
        confidence: 0.98,
        watchlistCategory: 'STOLEN_VEHICLE',
      });
      expect(anpr.type).toBe('ANPR_MATCH');
      expect(anpr.payload.plateText).toBe('DL01AB1234');
      expect(anpr.severity).toBe(EventSeverity.WARNING);
    });

    it('derives child events maintaining correlationId, rootEventId, and incrementing depth', () => {
      const parent = createVigilOneEvent({
        id: 'ev_root_001',
        tenantId,
        source: 'VISION_AI',
        type: 'MOTION',
        payload: { kind: 'MOTION', score: 0.9 },
      });

      const child = deriveChildEvent(parent, {
        source: 'HARDWARE_IO',
        type: 'DI_TRIGGER',
        payload: { kind: 'DI_TRIGGER', pinNumber: 3, state: 'HIGH' },
      });

      expect(child.correlationId).toBe(parent.correlationId);
      expect(child.rootEventId).toBe('ev_root_001');
      expect(child.depth).toBe(1);
    });
  });

  // --- Requirement 2: Multi-Level Database-Enforced Idempotency ---
  describe('Requirement 2: Multi-Level Database-Enforced Idempotency', () => {
    it('does NOT execute duplicate rules or actions when duplicate event ID is ingested', async () => {
      rulesStore.push({
        id: 'rule_tripwire_alarm',
        tenantId,
        enabled: true,
        triggerType: RuleTriggerType.TRIPWIRE_CROSS,
        cooldownSeconds: 0,
        lastTriggeredAt: null,
        triggerConfigJson: {},
        conditionsJson: [],
        actionsJson: [
          {
            id: 'act_alarm_01',
            type: RuleActionType.TRIGGER_ALARM,
            config: { title: 'Intrusion Alarm' },
          },
        ],
      });

      const event = fromTripwireCrossing({
        id: 'ev_unique_idempotent_01',
        tenantId,
        tripwireId: 'tw_01',
        trackId: 'trk_01',
        direction: 'FORWARD',
      });

      // 1. First Ingestion
      const res1 = await orchestrator.ingestEvent(event);
      expect(res1.rulesTriggered).toBe(1);
      expect(res1.actionsQueued).toBe(1);
      expect(ruleExecutionsStore).toHaveLength(1);
      expect(actionExecutionsStore).toHaveLength(1);

      // 2. Replay with identical event.id
      const res2 = await orchestrator.ingestEvent(event);
      expect(res2.rulesTriggered).toBe(0);
      expect(res2.actionsQueued).toBe(0);

      // Invariant: RuleExecutionRecord count must remain exactly 1
      expect(ruleExecutionsStore).toHaveLength(1);
      expect(actionExecutionsStore).toHaveLength(1);
    });
  });

  // --- Requirement 3: Worker Crash and Outbox Resume ---
  describe('Requirement 3: Persistent Action Outbox & Crash Recovery', () => {
    it('resumes and drains pending actions safely after a worker restart', async () => {
      // Simulate persisted pending action records from a previous crash
      const ruleExecId = 'exec_crash_recovery_01';
      ruleExecutionsStore.push({
        id: ruleExecId,
        tenantId,
        ruleId: 'rule_01',
        overallStatus: 'PENDING',
        correlationId: 'corr_crash_01',
        rule: {
          actionsJson: [
            {
              id: 'act_01',
              type: RuleActionType.START_HIGH_RES_RECORDING,
              config: { cameraId: 'cam_crash_01' },
            },
          ],
        },
      });

      actionExecutionsStore.push({
        id: 'act_pending_01',
        ruleExecutionId: ruleExecId,
        actionId: 'act_01',
        actionType: RuleActionType.START_HIGH_RES_RECORDING,
        status: 'PENDING',
        attempt: 1,
        startedAt: new Date(Date.now() - 10000),
      });

      // New orchestrator instance starts up (simulating process restart)
      const freshOrchestrator = new IncidentOrchestrator(mockPrisma);
      const drained = await freshOrchestrator.drainOutbox();

      expect(drained).toBe(1);
      const action = actionExecutionsStore.find((a) => a.id === 'act_pending_01');
      expect(action.status).toBe('SUCCESS');
      expect(action.completedAt).toBeDefined();

      const rule = ruleExecutionsStore.find((r) => r.id === ruleExecId);
      expect(rule.overallStatus).toBe('SUCCESS');
    });
  });

  // --- Requirement 4: Cascade Loop & Depth Protection ---
  describe('Requirement 4: Cascade Loop and Action Flood Protection', () => {
    it('terminates cascade safely when event depth exceeds MAX_EVENT_ACTION_DEPTH (5)', async () => {
      rulesStore.push({
        id: 'rule_cascade_relay',
        tenantId,
        enabled: true,
        triggerType: RuleTriggerType.DIGITAL_INPUT_STATE,
        cooldownSeconds: 0,
        triggerConfigJson: {},
        conditionsJson: [],
        actionsJson: [{ id: 'act_01', type: RuleActionType.FIRE_DO_RELAY, config: { pinNumber: 1 } }],
      });

      // Construct an event with depth = 6 (exceeding limit of 5)
      const deepEvent = fromDigitalInput({
        tenantId,
        pinNumber: 1,
        state: 'HIGH',
        depth: MAX_EVENT_ACTION_DEPTH + 1,
        correlationId: 'corr_loop_deep',
      });

      const res = await orchestrator.ingestEvent(deepEvent);

      expect(res.cascadeTerminated).toBe(true);
      expect(res.rulesTriggered).toBe(0);
      expect(res.actionsQueued).toBe(0);

      const terminatedRecord = ruleExecutionsStore.find(
        (r) => r.overallStatus === 'CASCADE_TERMINATED'
      );
      expect(terminatedRecord).toBeDefined();
      expect(terminatedRecord.error).toContain(`exceeded limit of ${MAX_EVENT_ACTION_DEPTH}`);
    });

    it('terminates cascade when cumulative actions under one correlationId exceeds limit (25)', async () => {
      const correlationId = 'corr_flood_01';

      // Seed 25 existing action executions for this correlationId
      const parentExecId = 'exec_flood_parent';
      ruleExecutionsStore.push({
        id: parentExecId,
        tenantId,
        correlationId,
        overallStatus: 'PROCESSING',
      });

      for (let i = 0; i < MAX_ACTIONS_PER_CORRELATION; i++) {
        actionExecutionsStore.push({
          id: `act_flood_${i}`,
          ruleExecutionId: parentExecId,
          actionId: `act_${i}`,
          actionType: RuleActionType.FIRE_DO_RELAY,
          status: 'SUCCESS',
        });
      }

      rulesStore.push({
        id: 'rule_motion_more',
        tenantId,
        enabled: true,
        triggerType: RuleTriggerType.MOTION_ZONE,
        cooldownSeconds: 0,
        triggerConfigJson: {},
        conditionsJson: [],
        actionsJson: [{ id: 'act_new', type: RuleActionType.DISPATCH_NOTIFICATION, config: {} }],
      });

      const event = fromMotionEvent({
        tenantId,
        score: 0.99,
        correlationId,
        depth: 2,
      });

      const res = await orchestrator.ingestEvent(event);

      expect(res.cascadeTerminated).toBe(true);
      expect(res.actionsQueued).toBe(0);

      const floodRecord = ruleExecutionsStore.find(
        (r) => r.overallStatus === 'CASCADE_TERMINATED' && r.correlationId === correlationId
      );
      expect(floodRecord).toBeDefined();
      expect(floodRecord.error).toContain(`exceeded limit of ${MAX_ACTIONS_PER_CORRELATION}`);
    });
  });

  // --- Requirement 5: Adapter-Specific Relay Confirmation Semantics ---
  describe('Requirement 5: Relay Confirmation Modes (ACK_ONLY vs STATE_FEEDBACK vs PULSE_COMPLETION)', () => {
    it('ACK_ONLY mode confirms driver ACK but NEVER reports STATE_CONFIRMED', async () => {
      digitalPinsStore.push({
        id: 'pin_ack_only',
        tenantId,
        pinNumber: 4,
        direction: 'OUTPUT',
        name: 'Gate Trigger (Open Loop)',
        state: 'LOW',
        confirmationMode: RelayConfirmationMode.ACK_ONLY,
        timeoutMs: 1000,
      });

      const res = await orchestrator.executeRelayCommand({
        tenantId,
        pinNumber: 4,
        command: 'SET_HIGH',
        issuedBy: 'admin',
      });

      expect(res.lifecycleState).toBe(RelayCommandState.COMMAND_ACK);
      expect(res.lifecycleState).not.toBe(RelayCommandState.STATE_CONFIRMED);
      expect(res.confirmationMode).toBe(RelayConfirmationMode.ACK_ONLY);
    });

    it('STATE_FEEDBACK mode transitions to STATE_CONFIRMED when driver provides feedback', async () => {
      digitalPinsStore.push({
        id: 'pin_feedback',
        tenantId,
        pinNumber: 5,
        direction: 'OUTPUT',
        name: 'Deadbolt Lock',
        state: 'LOW',
        confirmationMode: RelayConfirmationMode.STATE_FEEDBACK,
        timeoutMs: 1000,
      });

      orchestrator.setHardwareDriver(async (pinNumber, targetState) => {
        expect(pinNumber).toBe(5);
        expect(targetState).toBe('HIGH');
        return { confirmed: true };
      });

      const res = await orchestrator.executeRelayCommand({
        tenantId,
        pinNumber: 5,
        command: 'SET_HIGH',
      });

      expect(res.lifecycleState).toBe(RelayCommandState.STATE_CONFIRMED);
      expect(res.confirmedAt).toBeDefined();
    });

    it('STATE_FEEDBACK mode fails when hardware contact does not confirm', async () => {
      digitalPinsStore.push({
        id: 'pin_feedback_fail',
        tenantId,
        pinNumber: 6,
        direction: 'OUTPUT',
        name: 'Access Barrier',
        state: 'LOW',
        confirmationMode: RelayConfirmationMode.STATE_FEEDBACK,
        timeoutMs: 1000,
      });

      orchestrator.setHardwareDriver(async () => {
        return { confirmed: false, error: 'Feedback contact remained open' };
      });

      const res = await orchestrator.executeRelayCommand({
        tenantId,
        pinNumber: 6,
        command: 'SET_HIGH',
      });

      expect(res.lifecycleState).toBe(RelayCommandState.COMMAND_FAILED);
      expect(res.error).toContain('Feedback contact remained open');
    });

    it('PULSE_COMPLETION mode confirms upon timed pulse cycle completion', async () => {
      digitalPinsStore.push({
        id: 'pin_pulse',
        tenantId,
        pinNumber: 7,
        direction: 'OUTPUT',
        name: 'Turnstile Strobe',
        state: 'LOW',
        confirmationMode: RelayConfirmationMode.PULSE_COMPLETION,
        pulseDurationMs: 100,
        timeoutMs: 1000,
      });

      let pulseHigh = false;
      let pulseLow = false;

      orchestrator.setHardwareDriver(async (_, targetState) => {
        if (targetState === 'HIGH') pulseHigh = true;
        if (targetState === 'LOW') pulseLow = true;
        return { confirmed: true };
      });

      const res = await orchestrator.executeRelayCommand({
        tenantId,
        pinNumber: 7,
        command: 'PULSE',
        pulseDurationMs: 50,
      });

      expect(res.lifecycleState).toBe(RelayCommandState.STATE_CONFIRMED);
      expect(pulseHigh).toBe(true);
      expect(pulseLow).toBe(true);
    });
  });

  // --- Requirement 6: Atomic Alarm State and Audit Log Commit ---
  describe('Requirement 6: Atomic Alarm State & Audit Chain Serialization', () => {
    it('acknowledges alarm and records AuditChainEvent in transaction', async () => {
      alarmsStore.push({
        id: 'alarm_test_ack',
        tenantId,
        title: 'Unauthorized Entry',
        severity: EventSeverity.CRITICAL,
        state: AlarmState.ACTIVE,
      });

      const updated = await orchestrator.acknowledgeAlarm('alarm_test_ack', {
        tenantId,
        actorUserId: 'operator_dan',
        clientIp: '10.0.0.42',
      });

      expect(updated.state).toBe(AlarmState.ACKNOWLEDGED);
      expect(mockPrisma.$transaction).toHaveBeenCalled();

      expect(auditEventsStore).toHaveLength(1);
      expect(auditEventsStore[0].action).toBe('ALARM_ACKNOWLEDGE');
      expect(auditEventsStore[0].resourceId).toBe('alarm_test_ack');
      expect(auditEventsStore[0].userId).toBe('operator_dan');
      expect(auditEventsStore[0].eventHash).toBeDefined();
    });

    it('resolves alarm with resolution notes and commits audit event', async () => {
      alarmsStore.push({
        id: 'alarm_test_resolve',
        tenantId,
        title: 'Glass Break Sensor',
        severity: EventSeverity.CRITICAL,
        state: AlarmState.ACKNOWLEDGED,
      });

      const resolved = await orchestrator.resolveAlarm(
        'alarm_test_resolve',
        'False trigger verified by guard on site',
        {
          tenantId,
          actorUserId: 'supervisor_alice',
        }
      );

      expect(resolved.state).toBe(AlarmState.RESOLVED);
      expect(resolved.resolutionNotes).toBe('False trigger verified by guard on site');

      const resolveAudit = auditEventsStore.find((a) => a.action === 'ALARM_RESOLVE');
      expect(resolveAudit).toBeDefined();
      expect(resolveAudit.resourceId).toBe('alarm_test_resolve');
      expect(resolveAudit.userId).toBe('supervisor_alice');
    });

    it('rejects acknowledging an already resolved alarm', async () => {
      alarmsStore.push({
        id: 'alarm_resolved_already',
        tenantId,
        title: 'Door Forced Open',
        severity: EventSeverity.CRITICAL,
        state: AlarmState.RESOLVED,
      });

      await expect(
        orchestrator.acknowledgeAlarm('alarm_resolved_already', { tenantId })
      ).rejects.toThrow('Cannot acknowledge an already resolved alarm');
    });
  });

  // --- Requirement 7 & 8: Event != Alarm Mental Model & Automatic Elevation ---
  describe('Requirement 7 & 8: Event != Alarm Invariant & Built-in System Rules', () => {
    it('does NOT raise an alarm for routine INFO events with no explicit rule', async () => {
      const routineEvent = fromMotionEvent({
        tenantId,
        score: 0.4,
        severity: EventSeverity.INFO,
      });

      const res = await orchestrator.ingestEvent(routineEvent);

      expect(res.rulesTriggered).toBe(0);
      expect(res.alarmCreated).toBe(false);
      expect(alarmsStore).toHaveLength(0);
    });

    it('automatically promotes CRITICAL events via built-in system policy', async () => {
      const criticalEvent = fromCameraOffline({
        tenantId,
        cameraId: 'cam_vault_primary',
        lastSeenUtc: new Date(),
        reason: 'Heartbeat ping timeout (3 missed)',
      });

      const res = await orchestrator.ingestEvent(criticalEvent);

      expect(res.alarmCreated).toBe(true);
      expect(res.alarmId).toBeDefined();
      expect(alarmsStore).toHaveLength(1);
      expect(alarmsStore[0].severity).toBe(EventSeverity.CRITICAL);
      expect(alarmsStore[0].title).toContain('Camera Offline: cam_vault_primary');
    });
  });
});
