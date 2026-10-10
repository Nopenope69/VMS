import {
  RuleIntentIRSchema,
  parseRuleIntentIR,
} from '../textllm/ruleIntentTypes';

describe('ruleIntentTypes', () => {
  it('parses a valid RuleIntentIR with complete fields', () => {
    const raw = {
      suggestedName: 'Server Room Loitering Alert After 10 PM',
      behavior: 'LOITERING',
      targetClass: 'person',
      locationPhrase: 'server room',
      durationSeconds: 300,
      schedule: {
        type: 'AFTER',
        startTime: '22:00',
        endTime: '06:00',
        days: [0, 1, 2, 3, 4, 5, 6],
      },
      actionType: 'ALARM',
      severity: 'CRITICAL',
      unresolvedNotes: [],
    };

    const parsed = parseRuleIntentIR(raw);
    expect(parsed.suggestedName).toBe('Server Room Loitering Alert After 10 PM');
    expect(parsed.behavior).toBe('LOITERING');
    expect(parsed.targetClass).toBe('person');
    expect(parsed.locationPhrase).toBe('server room');
    expect(parsed.durationSeconds).toBe(300);
    expect(parsed.schedule.type).toBe('AFTER');
    expect(parsed.schedule.startTime).toBe('22:00');
    expect(parsed.actionType).toBe('ALARM');
    expect(parsed.severity).toBe('CRITICAL');
  });

  it('supplies safe defaults for optional fields', () => {
    const raw = {
      suggestedName: 'Fence Breach Alert',
      behavior: 'FENCE_CLIMB',
    };

    const parsed = parseRuleIntentIR(raw);
    expect(parsed.behavior).toBe('FENCE_CLIMB');
    expect(parsed.targetClass).toBe('any');
    expect(parsed.locationPhrase).toBeNull();
    expect(parsed.durationSeconds).toBeNull();
    expect(parsed.schedule.type).toBe('ALWAYS');
    expect(parsed.schedule.days).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(parsed.actionType).toBe('ALARM');
    expect(parsed.severity).toBe('CRITICAL');
    expect(parsed.unresolvedNotes).toEqual([]);
  });

  it('rejects invalid behavior enums', () => {
    const raw = {
      suggestedName: 'Invalid Behavior Rule',
      behavior: 'TELEPORTATION',
    };

    expect(() => parseRuleIntentIR(raw)).toThrow();
  });

  it('rejects missing suggestedName', () => {
    const raw = {
      behavior: 'TRIPWIRE_CROSS',
    };

    expect(() => parseRuleIntentIR(raw)).toThrow();
  });
});
