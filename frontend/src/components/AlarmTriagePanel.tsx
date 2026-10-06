import React, { useCallback, useEffect, useState } from 'react';
import api from '../services/api';
import { Badge } from './ui/Badge';

type Severity = 'CRITICAL' | 'WARNING' | 'INFO';

interface Reason {
  code: string;
  delta: number;
  text: string;
}
interface QueueItem {
  alarmId: string;
  severity: Severity;
  adjustment: number;
  reasons: Reason[];
  title: string;
  cameraId: string | null;
  cameraName: string | null;
  triggeredAt: string;
  occurrenceCount: number;
}
interface CameraRow {
  cameraId: string | null;
  cameraName: string | null;
  alarms: number;
  reviewed: number;
  falseAlarms: number;
  falseAlarmRate: number | null;
}
interface Proposal {
  kind: 'ADD_INCIDENT_WINDOW' | 'REVIEW_RULE_SETTINGS';
  ruleId: string;
  ruleName: string | null;
  cameraId: string | null;
  applied: false;
  evidence: { alarms: number; reviewed: number; falseAlarms: number; trueAlarms: number; falseAlarmRate: number };
  suggestion: string;
}

const SEVERITY_VARIANT: Record<Severity, 'alarm' | 'warn' | 'neutral'> = { CRITICAL: 'alarm', WARNING: 'warn', INFO: 'neutral' };
const KIND_TITLE: Record<Proposal['kind'], string> = {
  ADD_INCIDENT_WINDOW: 'Group repeat alarms into one incident',
  REVIEW_RULE_SETTINGS: 'Review this rule\'s settings',
};
const pct = (r: number | null) => (r === null ? 'none reviewed' : `${Math.round(r * 100)}% false`);
const describeError = (err: any): string => err?.response?.data?.error || err?.message || 'backend unreachable';

/**
 * Alarm triage (feature ALARM_TRIAGE, ADR 0015). Read-only: the order of open alarms with the reasons for each
 * place, and proposals for quieter rules that nothing applies. Alarms are handled in the Active Alarms tab.
 */
export const AlarmTriagePanel: React.FC<{ refreshToken: number; onOpenAlarms: () => void }> = ({ refreshToken, onOpenAlarms }) => {
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [cameras, setCameras] = useState<CameraRow[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [reportState, setReportState] = useState<'loading' | 'ok' | 'denied' | 'error'>('loading');

  const load = useCallback(() => {
    api
      .get('/alarm-triage/queue')
      .then((res) => {
        setItems(res.data?.items || []);
        setQueueError(null);
      })
      .catch((err) => {
        setItems(null);
        setQueueError(describeError(err));
      });
    api
      .get('/alarm-triage/report')
      .then((res) => {
        setCameras(res.data?.byCamera || []);
        setProposals(res.data?.proposals || []);
        setReportState('ok');
      })
      .catch((err) => setReportState(err?.response?.status === 403 ? 'denied' : 'error'));
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, [load, refreshToken]);

  return (
    <div className="space-y-3" data-testid="alarm-triage-panel">
      <div className="px-3 py-2 bg-vms-surface border border-vms-border rounded text-xs text-vms-muted">
        <span className="font-semibold text-vms-text">Advisory order.</span> Every open alarm is listed. Severity always comes first; the AI second
        opinion and what operators decided on earlier alarms only move an alarm within its own severity. Nothing here acknowledges, resolves or
        hides an alarm.
      </div>

      {queueError && (
        <div role="alert" className="p-3 bg-status-alarm/10 border border-status-alarm/30 rounded text-xs text-status-alarm font-mono">
          TRIAGE UNAVAILABLE: {queueError}. The list is empty because it could not be loaded, not because there are no open alarms.
        </div>
      )}

      {items && items.length === 0 && !queueError && (
        <div className="p-6 text-center text-xs text-vms-muted border border-vms-border rounded bg-vms-surface" data-testid="triage-empty">
          No open alarms.
        </div>
      )}

      {items && items.length > 0 && (
        <ol className="space-y-2" data-testid="triage-queue">
          {items.map((it, i) => (
            <li key={it.alarmId} className="p-3 bg-vms-surface border border-vms-border rounded space-y-1.5" data-testid="triage-item">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-mono text-vms-dim w-5">{i + 1}.</span>
                <Badge variant={SEVERITY_VARIANT[it.severity]}>{it.severity}</Badge>
                <span className="text-sm font-semibold text-vms-text">{it.title}</span>
                {it.cameraName && <span className="text-xs text-vms-muted">{it.cameraName}</span>}
                <span className="text-[10px] font-mono text-vms-dim">{new Date(it.triggeredAt).toLocaleString()}</span>
                {it.occurrenceCount > 1 && <span className="text-[10px] font-mono text-vms-muted">x{it.occurrenceCount}</span>}
                {it.adjustment !== 0 && (
                  <span
                    className={`ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded ${it.adjustment > 0 ? 'bg-status-alarm/15 text-status-alarm' : 'bg-vms-elevated text-vms-muted'}`}
                    title="Position change inside this severity"
                  >
                    {it.adjustment > 0 ? 'raised' : 'lowered'} {it.adjustment > 0 ? '+' : ''}
                    {it.adjustment}
                  </span>
                )}
              </div>
              {it.reasons.length > 0 && (
                <ul className="pl-7 space-y-0.5">
                  {it.reasons.map((r) => (
                    <li key={r.code} className="text-xs text-vms-muted">
                      <span className="font-mono text-vms-dim">
                        {r.delta > 0 ? '+' : ''}
                        {r.delta}
                      </span>{' '}
                      {r.text}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}

      {items && items.length > 0 && (
        <button onClick={onOpenAlarms} className="text-xs text-vms-accent hover:underline">
          Handle these in Active Alarms
        </button>
      )}

      {reportState === 'ok' && (
        <div className="space-y-3 pt-2" data-testid="triage-report">
          <h2 className="text-xs font-bold uppercase font-mono text-vms-text">False alarms by camera (last 30 days)</h2>
          {cameras.length === 0 ? (
            <div className="text-xs text-vms-muted">No alarms in this period.</div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-vms-muted">
                  <th className="py-1 pr-2 font-normal">Camera</th>
                  <th className="py-1 pr-2 font-normal">Alarms</th>
                  <th className="py-1 pr-2 font-normal">Reviewed</th>
                  <th className="py-1 font-normal">Operators said</th>
                </tr>
              </thead>
              <tbody>
                {cameras.map((c) => (
                  <tr key={c.cameraId ?? 'none'} className="border-t border-vms-border text-vms-text">
                    <td className="py-1 pr-2">{c.cameraName ?? 'No camera'}</td>
                    <td className="py-1 pr-2 font-mono">{c.alarms}</td>
                    <td className="py-1 pr-2 font-mono">{c.reviewed}</td>
                    <td className="py-1 font-mono">{pct(c.falseAlarmRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h2 className="text-xs font-bold uppercase font-mono text-vms-text">Suggested rule changes</h2>
          {proposals.length === 0 ? (
            <div className="text-xs text-vms-muted">
              None. A suggestion appears when a rule on a camera has at least 20 reviewed alarms and almost all were marked false.
            </div>
          ) : (
            <ul className="space-y-2">
              {proposals.map((p) => (
                <li key={`${p.ruleId}-${p.cameraId}`} className="p-3 bg-vms-surface border border-vms-border rounded space-y-1" data-testid="triage-proposal">
                  <div className="text-sm font-semibold text-vms-text">{KIND_TITLE[p.kind]}</div>
                  <div className="text-xs text-vms-muted">
                    Rule {p.ruleName ?? p.ruleId}: {p.evidence.falseAlarms} of {p.evidence.reviewed} reviewed alarms were marked false.
                  </div>
                  <div className="text-xs text-vms-muted">{p.suggestion}</div>
                  <div className="text-[10px] font-mono text-vms-dim">Suggestion only. Nothing has been changed.</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {reportState === 'error' && <div className="text-xs text-vms-muted">The false-alarm report could not be loaded.</div>}
    </div>
  );
};
