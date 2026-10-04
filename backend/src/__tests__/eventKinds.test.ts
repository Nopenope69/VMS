/**
 * The event-kind table (services/incident/orchestrator/eventKinds.ts) is the one place a VigilOneEvent kind is
 * described. These tests pin that the table is complete and that the derived views agree with each other.
 */
import { RuleTriggerType } from '@prisma/client';
import { EVENT_KINDS, EVENT_KIND_NAMES, RULE_TRIGGERS, isEventKind, matchesTriggerConfig, triggerTypeFor } from '../services/incident/orchestrator/eventKinds';
import { RuleEngine } from '../services/incident/orchestrator/ruleEngine';
import { createVigilOneEvent } from '../services/incident/orchestrator/events';
import { validateTriggerConfig, RuleValidationError, EVENT_TYPES } from '../services/automation/ruleSchema';
import { VIGILONE_EVENT_TO_V1 } from '../contracts/eventMapping.v1';

const ALL_KINDS = [
  'MOTION', 'TRIPWIRE_CROSS', 'LOITERING_DWELL', 'UNATTENDED_OBJECT', 'WRONG_WAY', 'ANPR_MATCH', 'CAMERA_OFFLINE', 'STREAM_DEGRADED',
  'DI_TRIGGER', 'SCENE_CHANGE', 'SYSTEM_ALERT', 'AI_OBJECT_DETECTED', 'CAMERA_ANALYTIC', 'DOOR_EVENT',
];

describe('event kinds', () => {
  it('has one entry per VigilOneEvent kind, and the rule schema, dry run and v1 mapping use the same list', () => {
    expect([...EVENT_KIND_NAMES].sort()).toEqual([...ALL_KINDS].sort());
    expect([...EVENT_TYPES].sort()).toEqual([...ALL_KINDS].sort());
    expect(Object.keys(VIGILONE_EVENT_TO_V1).sort()).toEqual([...ALL_KINDS].sort());
    expect(isEventKind('MOTION')).toBe(true);
    expect(isEventKind('toString')).toBe(false);
    expect(isEventKind('NOT_A_KIND')).toBe(false);
  });

  it('feeds every RuleTriggerType from exactly one kind', () => {
    expect(Object.keys(RULE_TRIGGERS).sort()).toEqual(Object.values(RuleTriggerType).sort());
    const fed = EVENT_KIND_NAMES.flatMap((k) => Object.keys(EVENT_KINDS[k].triggers));
    expect(fed.length).toBe(new Set(fed).size);
  });

  it('maps each event to the trigger type it fires, and that trigger is fed by the same kind', () => {
    const cases: Array<[string, any, RuleTriggerType | null]> = [
      ['MOTION', undefined, 'MOTION_ZONE'],
      ['TRIPWIRE_CROSS', undefined, 'TRIPWIRE_CROSS'],
      ['LOITERING_DWELL', undefined, 'LOITERING_DWELL'],
      ['ANPR_MATCH', undefined, 'ANPR_WATCHLIST'],
      ['DI_TRIGGER', undefined, 'DIGITAL_INPUT_STATE'],
      ['CAMERA_OFFLINE', undefined, 'CAMERA_OFFLINE'],
      ['SCENE_CHANGE', undefined, 'SCENE_CHANGE'],
      ['CAMERA_ANALYTIC', undefined, 'CAMERA_ANALYTIC'],
      ['DOOR_EVENT', undefined, 'DOOR_EVENT'],
      ['STREAM_DEGRADED', undefined, null],
      ['SYSTEM_ALERT', undefined, null],
      ['AI_OBJECT_DETECTED', { kind: 'AI_OBJECT_DETECTED', objectClass: 'person' }, 'PERSON_DETECTED'],
      ['AI_OBJECT_DETECTED', { kind: 'AI_OBJECT_DETECTED', objectClass: 'truck' }, 'VEHICLE_DETECTED'],
      ['AI_OBJECT_DETECTED', undefined, null],
    ];
    for (const [type, payload, expected] of cases) {
      expect([type, triggerTypeFor(type as any, payload)]).toEqual([type, expected]);
      expect(RuleEngine.mapEventTypeToTriggerType(type as any, payload)).toBe(expected);
      if (expected) expect(RULE_TRIGGERS[expected].eventKind).toBe(type);
    }
  });

  it('validates a trigger config with the schema of its own kind', () => {
    expect(validateTriggerConfig('DIGITAL_INPUT_STATE', { pinNumber: 3 })).toEqual({ pinNumber: 3 });
    expect(() => validateTriggerConfig('DIGITAL_INPUT_STATE', { doorIds: [] })).toThrow(RuleValidationError);
    expect(() => validateTriggerConfig('VEHICLE_DETECTED', { objectClasses: ['person'] })).toThrow(/vehicle classes/);
  });

  it('checks cameraId, zoneId and spatialRuleId for every kind before the kind-specific match', () => {
    const tripwire = createVigilOneEvent({
      tenantId: 't', cameraId: 'cam-1', source: 'SPATIAL_ANALYTICS', type: 'TRIPWIRE_CROSS',
      payload: { kind: 'TRIPWIRE_CROSS', tripwireId: 'tw-1', trackId: 'k', direction: 'FORWARD' },
    });
    expect(matchesTriggerConfig({}, tripwire)).toBe(true);
    expect(matchesTriggerConfig({ cameraId: 'cam-2' }, tripwire)).toBe(false);
    expect(matchesTriggerConfig({ spatialRuleId: 'tw-1' }, tripwire)).toBe(true);
    expect(matchesTriggerConfig({ spatialRuleId: 'tw-2' }, tripwire)).toBe(false);
    const door = createVigilOneEvent({
      tenantId: 't', source: 'HARDWARE_IO', type: 'DOOR_EVENT',
      payload: { kind: 'DOOR_EVENT', doorId: 'd1', doorName: 'Front', action: 'FORCED_OPEN' },
    });
    // A kind with no spatial rule never matches a spatialRuleId-scoped config.
    expect(matchesTriggerConfig({ spatialRuleId: 'tw-1' }, door)).toBe(false);
    expect(matchesTriggerConfig({ doorActions: ['FORCED_OPEN'] }, door)).toBe(true);
    expect(matchesTriggerConfig({ doorActions: ['OPENED'] }, door)).toBe(false);
  });
});
