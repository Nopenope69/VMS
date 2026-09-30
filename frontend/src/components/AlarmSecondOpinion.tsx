import React, { useEffect, useState } from 'react';
import api from '../services/api';

interface SecondOpinion {
  targetClass: string;
  answer: 'yes' | 'no' | 'unclear';
  reason: string;
  modelName: string;
  modelVersion: string;
  latencyMs: number;
}

const LABEL: Record<SecondOpinion['answer'], { text: string; tone: string }> = {
  yes: { text: 'sees', tone: 'text-vms-accent' },
  no: { text: 'does not see', tone: 'text-amber-400' },
  unclear: { text: 'cannot tell whether there is', tone: 'text-vms-muted' },
};

/**
 * The local AI model's advisory second opinion on an alarm (Phase 5 Wave C). Shows nothing when the feature
 * is off; it never suggests a verdict and never changes the alarm.
 */
export const AlarmSecondOpinion: React.FC<{ alarmId: string }> = ({ alarmId }) => {
  const [state, setState] = useState<{ status: 'loading' | 'off' | 'none' | 'ok' | 'error'; opinion?: SecondOpinion }>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    api
      .get(`/alarms/${alarmId}/second-opinion`)
      .then((res) => {
        if (cancelled) return;
        const first: SecondOpinion | undefined = res.data?.secondOpinions?.[0];
        setState(first ? { status: 'ok', opinion: first } : { status: 'none' });
      })
      .catch((err) => {
        if (!cancelled) setState({ status: err?.response?.status === 501 ? 'off' : 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [alarmId]);

  if (state.status === 'off' || state.status === 'loading') return null;
  return (
    <div className="p-3 bg-vms-panel rounded border border-vms-border space-y-1" data-testid="alarm-second-opinion">
      <div className="text-[10px] text-vms-muted uppercase tracking-wider font-mono">AI second opinion (advisory)</div>
      {state.status === 'ok' && state.opinion ? (
        <>
          <div className="text-xs text-vms-text">
            The model <span className={LABEL[state.opinion.answer].tone}>{LABEL[state.opinion.answer].text}</span> a {state.opinion.targetClass} in the picture.
          </div>
          {state.opinion.reason && <div className="text-xs text-vms-muted">"{state.opinion.reason}"</div>}
          <div className="text-[10px] text-vms-dim font-mono">
            {state.opinion.modelName} {state.opinion.modelVersion}. It can be wrong; check the footage yourself.
          </div>
        </>
      ) : state.status === 'none' ? (
        <div className="text-xs text-vms-muted">No second opinion for this alarm (not asked yet, or no picture to check).</div>
      ) : (
        <div className="text-xs text-vms-muted">The second opinion could not be loaded.</div>
      )}
    </div>
  );
};
