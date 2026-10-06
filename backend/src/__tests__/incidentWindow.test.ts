import { decideIncidentJoin, MAX_INCIDENT_SPAN_SECONDS } from '../services/incident/orchestrator/incidentWindow';

const t0 = new Date('2026-10-05T10:00:00Z');
const at = (s: number) => new Date(t0.getTime() + s * 1000);
const open = (over: Record<string, any> = {}) => ({
  state: 'ACTIVE' as const,
  severity: 'WARNING' as const,
  triggeredAt: t0,
  lastActivityAt: null as Date | null,
  ...over,
});

describe('decideIncidentJoin (ADR 0014)', () => {
  it('creates a new alarm when no window is asked for (today\'s behaviour)', () => {
    expect(decideIncidentJoin(open(), at(5), 0, 'WARNING')).toEqual({ action: 'CREATE' });
    expect(decideIncidentJoin(open(), at(5), undefined, 'WARNING')).toEqual({ action: 'CREATE' });
  });

  it('creates a new alarm when there is no open alarm', () => {
    expect(decideIncidentJoin(null, at(5), 300, 'WARNING')).toEqual({ action: 'CREATE' });
  });

  it('joins an open alarm whose last activity is inside the window', () => {
    expect(decideIncidentJoin(open(), at(200), 300, 'WARNING')).toEqual({ action: 'JOIN', escalate: false });
  });

  it('measures the window from the last activity, not from the first trigger', () => {
    const a = open({ lastActivityAt: at(1000) });
    expect(decideIncidentJoin(a, at(1200), 300, 'WARNING')).toEqual({ action: 'JOIN', escalate: false });
  });

  it('starts a new incident after a quiet gap longer than the window', () => {
    expect(decideIncidentJoin(open(), at(301), 300, 'WARNING')).toEqual({ action: 'CREATE' });
  });

  it('never joins a resolved alarm: the operator closed that incident', () => {
    expect(decideIncidentJoin(open({ state: 'RESOLVED' }), at(5), 300, 'WARNING')).toEqual({ action: 'CREATE' });
  });

  it('joins an acknowledged alarm', () => {
    expect(decideIncidentJoin(open({ state: 'ACKNOWLEDGED' }), at(5), 300, 'WARNING')).toEqual({
      action: 'JOIN',
      escalate: false,
    });
  });

  it('caps one incident\'s total span even when activity never stops', () => {
    const a = open({ lastActivityAt: at(MAX_INCIDENT_SPAN_SECONDS) });
    expect(decideIncidentJoin(a, at(MAX_INCIDENT_SPAN_SECONDS + 10), 300, 'WARNING')).toEqual({ action: 'CREATE' });
  });

  it('escalates the open alarm when the new trigger is more severe, and never lowers it', () => {
    expect(decideIncidentJoin(open(), at(5), 300, 'CRITICAL')).toEqual({ action: 'JOIN', escalate: true });
    expect(decideIncidentJoin(open({ severity: 'CRITICAL' }), at(5), 300, 'INFO')).toEqual({
      action: 'JOIN',
      escalate: false,
    });
  });

  it('ignores a clock that went backwards by treating it as inside the window', () => {
    expect(decideIncidentJoin(open({ lastActivityAt: at(100) }), at(50), 300, 'WARNING')).toEqual({
      action: 'JOIN',
      escalate: false,
    });
  });
});

describe('incidentWindowSeconds in a rule (ADR 0014)', () => {
  const { validateRuleInput } = require('../services/automation/ruleSchema');
  const rule = (config: Record<string, any>) => ({
    name: 'r',
    triggerType: 'MOTION_ZONE',
    actions: [{ id: 'a1', type: 'TRIGGER_ALARM', config }],
  });

  it('accepts a window from 0 to 24 hours, or none', () => {
    expect(() => validateRuleInput(rule({ incidentWindowSeconds: 300 }))).not.toThrow();
    expect(() => validateRuleInput(rule({ incidentWindowSeconds: 0 }))).not.toThrow();
    expect(() => validateRuleInput(rule({}))).not.toThrow();
  });

  it.each([-1, 86401, 1.5, '300', null])('rejects %p', (bad) => {
    expect(() => validateRuleInput(rule({ incidentWindowSeconds: bad }))).toThrow(/incidentWindowSeconds/);
  });
});
