import { RuleTriggerType, RuleActionType } from '@prisma/client';
import { compileRuleIntent, RuleCompilerContext } from '../services/automation/ruleCompiler';
import { RuleIntentIR } from '../services/automation/ruleIntentTypes';
import { validateRuleInput } from '../services/automation/ruleSchema';

describe('ruleCompiler', () => {
  const tenantA = '11111111-1111-1111-1111-111111111111';
  const tenantB = '22222222-2222-2222-2222-222222222222';

  const cameraServerRoom = {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    name: 'Server Room North',
    tenantId: tenantA,
  };
  const cameraFrontGate = {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    name: 'Front Gate Camera',
    tenantId: tenantA,
  };
  const cameraBackGate = {
    id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    name: 'Back Gate Camera',
    tenantId: tenantA,
  };
  const cameraOtherTenant = {
    id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    name: 'Secret Lab Camera',
    tenantId: tenantB,
  };

  const zoneServerRoom = {
    id: 'zone-server-room',
    name: 'Server Room',
    tenantId: tenantA,
    cameraId: cameraServerRoom.id,
  };

  const baseContext: RuleCompilerContext = {
    tenantId: tenantA,
    cameras: [cameraServerRoom, cameraFrontGate, cameraBackGate],
    zones: [zoneServerRoom],
    timezone: 'Asia/Kolkata',
  };

  it('converts 5 minutes to 300s dwell threshold on loitering and validates schema', () => {
    const ir: RuleIntentIR = {
      suggestedName: 'Server Room Loitering Alert',
      behavior: 'LOITERING',
      targetClass: 'person',
      locationPhrase: 'server room',
      durationSeconds: 300,
      schedule: {
        type: 'ALWAYS',
        startTime: null,
        endTime: null,
        days: [0, 1, 2, 3, 4, 5, 6],
      },
      actionType: 'ALARM',
      severity: 'CRITICAL',
      unresolvedNotes: [],
    };

    const res = compileRuleIntent(ir, baseContext);
    expect(res.interpretation.status).toBe('ready_for_review');
    expect(res.draftRule).not.toBeNull();
    expect(res.draftRule?.triggerType).toBe(RuleTriggerType.PERSON_DETECTED);
    expect(res.draftRule?.triggerConfig.minDwellSeconds).toBe(300);
    expect(res.draftRule?.triggerConfig.zoneId).toBe('zone-server-room');
    expect(res.draftRule?.triggerConfig.cameraId).toBe(cameraServerRoom.id);

    // Schema validation must succeed
    expect(() => validateRuleInput(res.draftRule)).not.toThrow();
  });

  it('cleanly resolves location "server room" to zone "Server Room"', () => {
    const ir: RuleIntentIR = {
      suggestedName: 'Server Room Motion Alert',
      behavior: 'AREA_INTRUSION',
      targetClass: 'person',
      locationPhrase: 'server room',
      durationSeconds: null,
      schedule: {
        type: 'ALWAYS',
        startTime: null,
        endTime: null,
        days: [0, 1, 2, 3, 4, 5, 6],
      },
      actionType: 'ALARM',
      severity: 'CRITICAL',
      unresolvedNotes: [],
    };

    const res = compileRuleIntent(ir, baseContext);
    expect(res.interpretation.status).toBe('ready_for_review');
    expect(res.interpretation.resolvedEntities.zones).toHaveLength(1);
    expect(res.interpretation.resolvedEntities.zones[0].name).toBe('Server Room');
    expect(res.draftRule?.triggerConfig.zoneId).toBe('zone-server-room');
  });

  it('flags needs_clarification when multiple locations match ambiguously', () => {
    const ir: RuleIntentIR = {
      suggestedName: 'Gate Intrusion Alert',
      behavior: 'AREA_INTRUSION',
      targetClass: 'person',
      locationPhrase: 'gate',
      durationSeconds: null,
      schedule: {
        type: 'ALWAYS',
        startTime: null,
        endTime: null,
        days: [0, 1, 2, 3, 4, 5, 6],
      },
      actionType: 'ALARM',
      severity: 'CRITICAL',
      unresolvedNotes: [],
    };

    const res = compileRuleIntent(ir, baseContext);
    expect(res.interpretation.status).toBe('needs_clarification');
    expect(res.interpretation.unresolvedFields).toContain('locationPhrase');
    expect(res.interpretation.summary).toMatch(/multiple locations matched/i);
  });

  it('compiles "After 10 PM" to 22:00-06:00 with explicit assumption note', () => {
    const ir: RuleIntentIR = {
      suggestedName: 'Late Night Intrusion',
      behavior: 'AREA_INTRUSION',
      targetClass: 'person',
      locationPhrase: 'server room',
      durationSeconds: null,
      schedule: {
        type: 'AFTER',
        startTime: '22:00',
        endTime: null,
        days: [0, 1, 2, 3, 4, 5, 6],
      },
      actionType: 'ALARM',
      severity: 'CRITICAL',
      unresolvedNotes: [],
    };

    const res = compileRuleIntent(ir, baseContext);
    expect(res.interpretation.status).toBe('ready_for_review');
    expect(res.draftRule?.conditions).toHaveLength(1);
    const cond = res.draftRule?.conditions[0];
    expect(cond.type).toBe('TIME_SCHEDULE');
    expect(cond.value.windows[0].start).toBe('22:00');
    expect(cond.value.windows[0].end).toBe('06:00');
    expect(res.interpretation.assumptions.some((a: string) => a.includes('22:00') && a.includes('06:00'))).toBe(true);

    expect(() => validateRuleInput(res.draftRule)).not.toThrow();
  });

  it('compiles "Between 9 AM and 5 PM" with zero assumptions', () => {
    const ir: RuleIntentIR = {
      suggestedName: 'Business Hours Intrusion',
      behavior: 'AREA_INTRUSION',
      targetClass: 'person',
      locationPhrase: 'server room',
      durationSeconds: null,
      schedule: {
        type: 'BETWEEN',
        startTime: '09:00',
        endTime: '17:00',
        days: [1, 2, 3, 4, 5],
      },
      actionType: 'ALARM',
      severity: 'WARNING',
      unresolvedNotes: [],
    };

    const res = compileRuleIntent(ir, baseContext);
    expect(res.interpretation.status).toBe('ready_for_review');
    expect(res.interpretation.assumptions).toHaveLength(0);
    const cond = res.draftRule?.conditions[0];
    expect(cond.value.windows[0].start).toBe('09:00');
    expect(cond.value.windows[0].end).toBe('17:00');

    expect(() => validateRuleInput(res.draftRule)).not.toThrow();
  });

  it('rejects cross-tenant camera references to enforce tenant isolation', () => {
    const contextWithOtherTenant: RuleCompilerContext = {
      ...baseContext,
      cameras: [cameraOtherTenant], // camera from tenantB, but compiler context tenantId is tenantA
    };

    const ir: RuleIntentIR = {
      suggestedName: 'Cross Tenant Breach',
      behavior: 'AREA_INTRUSION',
      targetClass: 'person',
      locationPhrase: 'Secret Lab',
      durationSeconds: null,
      schedule: {
        type: 'ALWAYS',
        startTime: null,
        endTime: null,
        days: [0, 1, 2, 3, 4, 5, 6],
      },
      actionType: 'ALARM',
      severity: 'CRITICAL',
      unresolvedNotes: [],
    };

    const res = compileRuleIntent(ir, contextWithOtherTenant);
    expect(res.interpretation.status).toBe('needs_clarification');
    expect(res.interpretation.resolvedEntities.cameras).toHaveLength(0);
  });

  it('maps actions and groups alarms with incidentWindowSeconds', () => {
    const ir: RuleIntentIR = {
      suggestedName: 'Fence Breach Alert',
      behavior: 'FENCE_CLIMB',
      targetClass: 'person',
      locationPhrase: null,
      durationSeconds: null,
      schedule: {
        type: 'ALWAYS',
        startTime: null,
        endTime: null,
        days: [0, 1, 2, 3, 4, 5, 6],
      },
      actionType: 'ALARM',
      severity: 'CRITICAL',
      unresolvedNotes: [],
    };

    const res = compileRuleIntent(ir, baseContext);
    expect(res.draftRule).not.toBeNull();
    expect(res.draftRule?.actions).toHaveLength(1);
    expect(res.draftRule?.actions[0].type).toBe(RuleActionType.TRIGGER_ALARM);
    expect(res.draftRule?.actions[0].config.incidentWindowSeconds).toBe(300);

    expect(() => validateRuleInput(res.draftRule)).not.toThrow();
  });
});
