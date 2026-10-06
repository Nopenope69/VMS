import { EventSeverity } from '@prisma/client';

/**
 * ADR 0015: alarm triage. Pure rules, no database. The ranking only ORDERS open alarms: nothing is hidden,
 * acknowledged or resolved, and the AI answer and the history only move an alarm inside its own severity. Every
 * point of an adjustment comes with a stated reason the operator can read. Changes to rules are PROPOSED with
 * their evidence; nothing here applies one.
 */

/** Reviewed alarms of one rule on one camera needed before their history moves an alarm. */
export const MIN_REVIEWED_FOR_HISTORY = 10;
/** Reviewed alarms needed before a rule change is proposed. */
export const MIN_REVIEWED_FOR_PROPOSAL = 20;
const HISTORY_FALSE_RATE = 0.8;
const HISTORY_TRUE_RATE = 0.2;
const PROPOSAL_FALSE_RATE = 0.9;
const MAX_REPEAT_POINTS = 10;

const SEVERITY_RANK: Record<EventSeverity, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };

export interface TriageAlarm {
  id: string;
  severity: EventSeverity;
  triggeredAt: Date;
  ackDueAt: Date | null;
  occurrenceCount: number;
  ruleId: string | null;
  cameraId: string | null;
  /** The local VLM's yes/no/unclear on whether the detected object is visible. Advisory. */
  vlmAnswer: 'yes' | 'no' | 'unclear' | null;
}

export interface PairHistory {
  ruleId: string | null;
  cameraId: string | null;
  alarms: number;
  reviewed: number;
  falseAlarms: number;
}

export interface TriageReason {
  code: 'REPEAT_ACTIVITY' | 'ACK_OVERDUE' | 'SECOND_OPINION_NO' | 'SECOND_OPINION_YES' | 'HISTORY_MOSTLY_FALSE' | 'HISTORY_MOSTLY_TRUE';
  delta: number;
  text: string;
}

export interface RankedAlarm {
  alarmId: string;
  severity: EventSeverity;
  adjustment: number;
  reasons: TriageReason[];
}

export function scoreAlarm(a: TriageAlarm, now: Date, history?: PairHistory): { adjustment: number; reasons: TriageReason[] } {
  const reasons: TriageReason[] = [];

  if (a.occurrenceCount > 1) {
    const delta = Math.min(MAX_REPEAT_POINTS, a.occurrenceCount - 1);
    reasons.push({ code: 'REPEAT_ACTIVITY', delta, text: `Activity repeated ${a.occurrenceCount} times in this incident` });
  }
  if (a.ackDueAt && a.ackDueAt.getTime() < now.getTime()) {
    reasons.push({ code: 'ACK_OVERDUE', delta: 15, text: 'The acknowledge deadline has passed' });
  }
  if (a.vlmAnswer === 'no') {
    reasons.push({ code: 'SECOND_OPINION_NO', delta: -15, text: 'Advisory: the second-opinion model could not see the detected object' });
  } else if (a.vlmAnswer === 'yes') {
    reasons.push({ code: 'SECOND_OPINION_YES', delta: 10, text: 'Advisory: the second-opinion model sees the detected object' });
  }
  if (history && history.reviewed >= MIN_REVIEWED_FOR_HISTORY) {
    const falseRate = history.falseAlarms / history.reviewed;
    if (falseRate >= HISTORY_FALSE_RATE) {
      reasons.push({
        code: 'HISTORY_MOSTLY_FALSE',
        delta: -15,
        text: `Operators marked ${history.falseAlarms} of ${history.reviewed} earlier alarms of this rule on this camera as false`,
      });
    } else if (falseRate <= HISTORY_TRUE_RATE) {
      reasons.push({
        code: 'HISTORY_MOSTLY_TRUE',
        delta: 10,
        text: `Operators confirmed ${history.reviewed - history.falseAlarms} of ${history.reviewed} earlier alarms of this rule on this camera`,
      });
    }
  }

  return { adjustment: reasons.reduce((n, r) => n + r.delta, 0), reasons };
}

/**
 * Severity first, so no history or model answer can put a WARNING above a CRITICAL. Inside a severity, the higher
 * adjustment first, then the oldest first.
 */
export function rankAlarms(alarms: TriageAlarm[], now: Date, history: PairHistory[]): RankedAlarm[] {
  const byPair = new Map(history.map((h) => [`${h.ruleId}|${h.cameraId}`, h]));
  return alarms
    .map((a) => ({ a, s: scoreAlarm(a, now, byPair.get(`${a.ruleId}|${a.cameraId}`)) }))
    .sort(
      (x, y) =>
        SEVERITY_RANK[y.a.severity] - SEVERITY_RANK[x.a.severity] ||
        y.s.adjustment - x.s.adjustment ||
        x.a.triggeredAt.getTime() - y.a.triggeredAt.getTime()
    )
    .map(({ a, s }) => ({ alarmId: a.id, severity: a.severity, adjustment: s.adjustment, reasons: s.reasons }));
}

export interface RuleChangeProposal {
  kind: 'ADD_INCIDENT_WINDOW' | 'REVIEW_RULE_SETTINGS';
  ruleId: string;
  ruleName: string | null;
  cameraId: string | null;
  /** Always false: a proposal is never applied by the system. */
  applied: false;
  evidence: { alarms: number; reviewed: number; falseAlarms: number; trueAlarms: number; falseAlarmRate: number };
  suggestion: string;
}

export function proposeRuleChanges(
  history: PairHistory[],
  rules: Map<string, { name: string | null; hasWindow: boolean }>
): RuleChangeProposal[] {
  const out: RuleChangeProposal[] = [];
  for (const h of history) {
    if (!h.ruleId || h.reviewed < MIN_REVIEWED_FOR_PROPOSAL) continue;
    const falseRate = h.falseAlarms / h.reviewed;
    if (falseRate < PROPOSAL_FALSE_RATE) continue;
    const rule = rules.get(h.ruleId);
    const evidence = { alarms: h.alarms, reviewed: h.reviewed, falseAlarms: h.falseAlarms, trueAlarms: h.reviewed - h.falseAlarms, falseAlarmRate: falseRate };
    const base = { ruleId: h.ruleId, ruleName: rule?.name ?? null, cameraId: h.cameraId, applied: false as const, evidence };
    if (rule && !rule.hasWindow) {
      out.push({
        ...base,
        kind: 'ADD_INCIDENT_WINDOW',
        suggestion:
          'Group repeat triggers into one alarm by adding an incident window (for example 300 seconds) to this rule. Check it with the rule dry run on last week\'s events before saving.',
      });
    } else {
      out.push({
        ...base,
        kind: 'REVIEW_RULE_SETTINGS',
        suggestion:
          'Almost every alarm of this rule on this camera was marked false. Review its zone, schedule, class filter or minimum confidence, and check the change with the rule dry run before saving.',
      });
    }
  }
  return out.sort((a, b) => b.evidence.falseAlarms - a.evidence.falseAlarms);
}
