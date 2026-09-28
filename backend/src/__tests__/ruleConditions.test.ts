/**
 * P3.5 / P3.6 rule condition logic: time schedules in IANA zones (overnight windows, DST) and
 * rule validation. The expected local times below were computed independently from the tz
 * database offsets (IST = UTC+05:30 fixed; New York EDT = UTC-4 until 2026-11-01 06:00Z, then
 * EST = UTC-5).
 */
import { inSchedule, localClock } from '../services/automation/ruleConditions';
import { validateRuleInput, validateConditions, RuleValidationError } from '../services/automation/ruleSchema';

const night = [{ days: [0, 1, 2, 3, 4, 5, 6], start: '22:00', end: '06:00' }];

describe('localClock / inSchedule', () => {
  it('uses the zone offset, including half-hour zones', () => {
    // 2026-09-27 (Sunday) 17:00Z = 22:30 IST
    expect(localClock(new Date('2026-09-27T17:00:00Z'), 'Asia/Kolkata')).toEqual({ day: 0, minute: 22 * 60 + 30 });
    expect(inSchedule(new Date('2026-09-27T17:00:00Z'), 'Asia/Kolkata', night)).toBe(true);
    // 06:00Z = 11:30 IST
    expect(inSchedule(new Date('2026-09-27T06:00:00Z'), 'Asia/Kolkata', night)).toBe(false);
  });

  it('overnight windows belong to the day they start; end is exclusive', () => {
    const friNight = [{ days: [5], start: '22:00', end: '06:00' }];
    // Sat 2026-10-03 02:00 IST (Fri night) = Fri 20:30Z
    expect(inSchedule(new Date('2026-10-02T20:30:00Z'), 'Asia/Kolkata', friNight)).toBe(true);
    // Sun 2026-10-04 02:00 IST (Sat night) = Sat 20:30Z
    expect(inSchedule(new Date('2026-10-03T20:30:00Z'), 'Asia/Kolkata', friNight)).toBe(false);
    // Sat 06:00 IST exactly = Sat 00:30Z -> outside (end exclusive); 05:59 inside
    expect(inSchedule(new Date('2026-10-03T00:30:00Z'), 'Asia/Kolkata', friNight)).toBe(false);
    expect(inSchedule(new Date('2026-10-03T00:29:00Z'), 'Asia/Kolkata', friNight)).toBe(true);
  });

  it('follows DST: 09:00 local is 13:00Z before and 14:00Z after the November change', () => {
    const office = [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }];
    // Fri 2026-10-30 13:00Z = 09:00 EDT
    expect(inSchedule(new Date('2026-10-30T13:00:00Z'), 'America/New_York', office)).toBe(true);
    expect(inSchedule(new Date('2026-10-30T12:59:00Z'), 'America/New_York', office)).toBe(false);
    // Mon 2026-11-02 13:30Z = 08:30 EST -> outside; 14:00Z = 09:00 EST -> inside
    expect(inSchedule(new Date('2026-11-02T13:30:00Z'), 'America/New_York', office)).toBe(false);
    expect(inSchedule(new Date('2026-11-02T14:00:00Z'), 'America/New_York', office)).toBe(true);
  });
});

describe('rule validation', () => {
  const base = { name: 'r', triggerType: 'PERSON_DETECTED', actions: [{ id: 'a1', type: 'TRIGGER_ALARM', config: {} }] };

  it('accepts a complete AI rule with schedule and correlation conditions', () => {
    const v = validateRuleInput({
      ...base,
      triggerConfig: { minConfidence: 0.6, minDwellSeconds: 10 },
      conditions: [
        { type: 'TIME_SCHEDULE', operator: 'BETWEEN', value: { windows: night, timezone: 'Asia/Kolkata' } },
        { type: 'NOT_PRECEDED_BY', value: { eventTypes: ['DI_TRIGGER'], withinSeconds: 30 } },
      ],
    });
    expect(v.conditions[1]).toEqual({ type: 'NOT_PRECEDED_BY', value: { eventTypes: ['DI_TRIGGER'], withinSeconds: 30, scope: 'SAME_CAMERA' } });
  });

  it.each([
    [{ triggerConfig: { objectClasses: ['car'] } }, /triggerConfig.objectClasses/],
    [{ triggerType: 'VEHICLE_DETECTED', triggerConfig: { objectClasses: ['person'] } }, /vehicle classes/],
    [{ triggerConfig: { minConfidence: 1.5 } }, /minConfidence/],
    [{ triggerConfig: { unknownKey: 1 } }, /Unrecognized key/],
    [{ conditions: [{ type: 'CAMERA_TAG', operator: 'EQUALS', value: 'x' }] }, /conditions.0/],
    [{ conditions: [{ type: 'TIME_SCHEDULE', operator: 'BETWEEN', value: { windows: [{ days: [1], start: '25:00', end: '06:00' }] } }] }, /HH:MM/],
    [{ conditions: [{ type: 'TIME_SCHEDULE', operator: 'BETWEEN', value: { windows: night, timezone: 'Mars/Olympus' } }] }, /time zone/],
    [{ conditions: [{ type: 'PRECEDED_BY', value: { eventTypes: ['DI_TRIGGER'], withinSeconds: 30, scope: 'CAMERA' } }] }, /cameraId is required/],
    [{ actions: [{ id: 'a', type: 'TRIGGER_ALARM', config: {} }, { id: 'a', type: 'DISPATCH_NOTIFICATION', config: {} }] }, /unique/],
    [{ actions: [] }, /actions/],
  ])('rejects %j', (over, msg) => {
    expect(() => validateRuleInput({ ...base, ...over })).toThrow(RuleValidationError);
    expect(() => validateRuleInput({ ...base, ...over })).toThrow(msg);
  });

  it('keeps the historical SEVERITY_THRESHOLD shape valid', () => {
    expect(validateConditions([{ type: 'SEVERITY_THRESHOLD', operator: 'EQUALS', value: 'WARNING' }])).toHaveLength(1);
  });
});
