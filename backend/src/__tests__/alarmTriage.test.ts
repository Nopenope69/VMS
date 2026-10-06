import {
  scoreAlarm,
  rankAlarms,
  proposeRuleChanges,
  MIN_REVIEWED_FOR_HISTORY,
  MIN_REVIEWED_FOR_PROPOSAL,
  TriageAlarm,
  PairHistory,
} from '../services/incident/triage/alarmTriage';

const NOW = new Date('2026-10-05T12:00:00Z');
const alarm = (over: Partial<TriageAlarm> = {}): TriageAlarm => ({
  id: 'a1',
  severity: 'WARNING',
  triggeredAt: new Date(NOW.getTime() - 60_000),
  ackDueAt: null,
  occurrenceCount: 1,
  ruleId: 'r1',
  cameraId: 'c1',
  vlmAnswer: null,
  ...over,
});
const hist = (reviewed: number, falseAlarms: number): PairHistory => ({ ruleId: 'r1', cameraId: 'c1', alarms: reviewed, reviewed, falseAlarms });
const codes = (a: TriageAlarm, h?: PairHistory) => scoreAlarm(a, NOW, h).reasons.map((r) => r.code);

describe('scoreAlarm: every point has a stated reason', () => {
  it('a plain alarm has no adjustments', () => {
    expect(scoreAlarm(alarm(), NOW)).toEqual({ adjustment: 0, reasons: [] });
  });

  it('repeat activity raises it, up to a cap', () => {
    expect(scoreAlarm(alarm({ occurrenceCount: 4 }), NOW).adjustment).toBe(3);
    expect(scoreAlarm(alarm({ occurrenceCount: 500 }), NOW).adjustment).toBe(10);
  });

  it('a passed acknowledge deadline raises it', () => {
    const a = alarm({ ackDueAt: new Date(NOW.getTime() - 1000) });
    expect(codes(a)).toEqual(['ACK_OVERDUE']);
    expect(scoreAlarm(a, NOW).adjustment).toBe(15);
    expect(codes(alarm({ ackDueAt: new Date(NOW.getTime() + 60_000) }))).toEqual([]);
  });

  it('the second opinion "no" lowers it, "yes" raises it, "unclear" does nothing, and each is labelled advisory', () => {
    expect(scoreAlarm(alarm({ vlmAnswer: 'no' }), NOW).adjustment).toBe(-15);
    expect(scoreAlarm(alarm({ vlmAnswer: 'yes' }), NOW).adjustment).toBe(10);
    expect(scoreAlarm(alarm({ vlmAnswer: 'unclear' }), NOW).adjustment).toBe(0);
    expect(scoreAlarm(alarm({ vlmAnswer: 'no' }), NOW).reasons[0].text).toMatch(/advisory/i);
  });

  it('history only counts once enough alarms were reviewed', () => {
    expect(codes(alarm(), hist(MIN_REVIEWED_FOR_HISTORY - 1, MIN_REVIEWED_FOR_HISTORY - 1))).toEqual([]);
    expect(scoreAlarm(alarm(), NOW, hist(MIN_REVIEWED_FOR_HISTORY, MIN_REVIEWED_FOR_HISTORY)).adjustment).toBe(-15);
    expect(scoreAlarm(alarm(), NOW, hist(MIN_REVIEWED_FOR_HISTORY, 0)).adjustment).toBe(10);
    expect(codes(alarm(), hist(MIN_REVIEWED_FOR_HISTORY, MIN_REVIEWED_FOR_HISTORY / 2))).toEqual([]);
  });
});

describe('rankAlarms: advice never hides or demotes across severity', () => {
  it('returns every alarm exactly once', () => {
    const list = [alarm({ id: 'a' }), alarm({ id: 'b' }), alarm({ id: 'c' })];
    expect(rankAlarms(list, NOW, []).map((r) => r.alarmId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('orders by severity first, so a CRITICAL alarm with every demotion still outranks a WARNING with every boost', () => {
    const crit = alarm({ id: 'crit', severity: 'CRITICAL', vlmAnswer: 'no' });
    const warn = alarm({ id: 'warn', severity: 'WARNING', vlmAnswer: 'yes', occurrenceCount: 99, ackDueAt: new Date(NOW.getTime() - 1) });
    const ranked = rankAlarms([warn, crit], NOW, [hist(50, 50), { ...hist(50, 0), ruleId: 'r1', cameraId: 'c1' }]);
    expect(ranked.map((r) => r.alarmId)).toEqual(['crit', 'warn']);
  });

  it('within a severity, the adjusted alarm moves and ties keep the oldest first', () => {
    const a = alarm({ id: 'old', triggeredAt: new Date(NOW.getTime() - 600_000) });
    const b = alarm({ id: 'new', triggeredAt: new Date(NOW.getTime() - 10_000) });
    const c = alarm({ id: 'doubted', triggeredAt: new Date(NOW.getTime() - 900_000), vlmAnswer: 'no' });
    expect(rankAlarms([b, c, a], NOW, []).map((r) => r.alarmId)).toEqual(['old', 'new', 'doubted']);
  });

  it('uses the history of the alarm\'s own rule and camera, and no other pair', () => {
    const a = alarm({ id: 'a', ruleId: 'r1', cameraId: 'c1' });
    const other = [{ ...hist(50, 50), cameraId: 'c2' }];
    expect(rankAlarms([a], NOW, other)[0].reasons).toEqual([]);
  });

  it('carries the reasons with the item', () => {
    const [r] = rankAlarms([alarm({ vlmAnswer: 'no' })], NOW, []);
    expect(r.reasons.map((x) => x.code)).toEqual(['SECOND_OPINION_NO']);
    expect(r.adjustment).toBe(-15);
  });
});

describe('proposeRuleChanges: proposals only, with evidence', () => {
  it('proposes nothing below the review count or the false-alarm share', () => {
    expect(proposeRuleChanges([hist(MIN_REVIEWED_FOR_PROPOSAL - 1, MIN_REVIEWED_FOR_PROPOSAL - 1)], new Map())).toEqual([]);
    expect(proposeRuleChanges([hist(MIN_REVIEWED_FOR_PROPOSAL, MIN_REVIEWED_FOR_PROPOSAL * 0.8)], new Map())).toEqual([]);
  });

  it('proposes an incident window for a rule that has none, with the numbers behind it, never applied', () => {
    const [p] = proposeRuleChanges([hist(30, 29)], new Map([['r1', { name: 'Gate motion', hasWindow: false }]]));
    expect(p).toMatchObject({
      kind: 'ADD_INCIDENT_WINDOW',
      ruleId: 'r1',
      cameraId: 'c1',
      applied: false,
      evidence: { reviewed: 30, falseAlarms: 29, trueAlarms: 1 },
    });
    expect(p.suggestion).toMatch(/dry run/i);
  });

  it('for a rule that already has a window, asks for a review of the rule instead of changing it', () => {
    const [p] = proposeRuleChanges([hist(30, 30)], new Map([['r1', { name: 'x', hasWindow: true }]]));
    expect(p.kind).toBe('REVIEW_RULE_SETTINGS');
    expect(p.applied).toBe(false);
  });

  it('skips pairs with no rule (alarms raised another way)', () => {
    expect(proposeRuleChanges([{ ...hist(30, 30), ruleId: null }], new Map())).toEqual([]);
  });
});
