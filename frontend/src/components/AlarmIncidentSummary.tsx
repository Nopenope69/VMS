import React, { useCallback, useEffect, useState } from 'react';
import api from '../services/api';

interface Sentence {
  text: string;
  cites: string[];
}
interface Fact {
  id: string;
  atUtc: string;
  kind: string;
}
interface SummaryRecord {
  summaryId: string;
  generatedAtUtc: string;
  recordSha256: string;
  templateVersion: string;
  sentences: Sentence[];
  facts: { timeline: Fact[] };
}

type State = { status: 'loading' | 'off' | 'none' | 'ok' | 'error'; record?: SummaryRecord; message?: string };

const describe = (err: any): string => err?.response?.data?.error || err?.message || 'backend unreachable';

/**
 * The written story of an alarm (feature INCIDENT_SUMMARY, ADR 0016). Every sentence ends with the recorded facts it rests
 * on. It is generated from those facts by a fixed template, not by a model, and it never repeats plate text, typed notes or
 * a description of a person. Shows nothing when the feature is off. Each press of the button takes a new snapshot of the
 * incident; older snapshots are kept.
 */
export const AlarmIncidentSummary: React.FC<{ alarmId: string }> = ({ alarmId }) => {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get(`/incident-summaries/alarms/${alarmId}`)
      .then((res) => !cancelled && setState({ status: 'ok', record: res.data.record }))
      .catch((err) => {
        if (cancelled) return;
        if (err?.response?.status === 501) setState({ status: 'off' });
        else if (err?.response?.data?.code === 'NO_SUMMARY') setState({ status: 'none' });
        else setState({ status: 'error', message: describe(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [alarmId]);

  const generate = useCallback(() => {
    setBusy(true);
    api
      .post(`/incident-summaries/alarms/${alarmId}`)
      .then((res) => setState({ status: 'ok', record: res.data.record }))
      .catch((err) => setState((s) => ({ ...s, status: s.record ? 'ok' : 'error', message: describe(err) })))
      .finally(() => setBusy(false));
  }, [alarmId]);

  if (state.status === 'off' || state.status === 'loading') return null;
  const rec = state.record;
  return (
    <div className="p-3 bg-vms-panel rounded border border-vms-border space-y-2" data-testid="alarm-incident-summary">
      <div className="flex items-center justify-between">
        <div className="text-[10px] text-vms-muted uppercase tracking-wider font-mono">Incident summary (from recorded facts)</div>
        <button type="button" onClick={generate} disabled={busy} className="text-[11px] text-vms-accent hover:underline disabled:opacity-50">
          {busy ? 'Writing...' : rec ? 'Update summary' : 'Write summary'}
        </button>
      </div>
      {state.message && (
        <div role="alert" className="text-xs text-status-alarm">
          {state.message}
        </div>
      )}
      {!rec && state.status === 'none' && <div className="text-xs text-vms-muted">No summary has been written for this alarm yet.</div>}
      {rec && (
        <>
          <ol className="space-y-1" data-testid="incident-summary-sentences">
            {rec.sentences.map((s, i) => (
              <li key={i} className="text-xs text-vms-text">
                {s.text}
                {s.cites.length > 0 && (
                  <span className="ml-1 font-mono text-[10px] text-vms-accent" data-testid="incident-summary-cites">
                    [{s.cites.join(', ')}]
                  </span>
                )}
              </li>
            ))}
          </ol>
          <details className="text-xs text-vms-muted">
            <summary className="cursor-pointer">Recorded facts ({rec.facts.timeline.length})</summary>
            <ul className="mt-1 space-y-0.5 font-mono text-[10px]" data-testid="incident-summary-facts">
              {rec.facts.timeline.map((f) => (
                <li key={f.id}>
                  {f.id} {f.atUtc} {f.kind}
                </li>
              ))}
            </ul>
          </details>
          <div className="text-[10px] text-vms-dim font-mono">
            Snapshot of {rec.generatedAtUtc}, record {rec.recordSha256.slice(0, 12)}. It is in the audit chain and goes into evidence packages, where it can be re-checked offline. It is not a model opinion.
          </div>
        </>
      )}
    </div>
  );
};
