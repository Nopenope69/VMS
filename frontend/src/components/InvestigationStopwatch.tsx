import React, { useCallback, useEffect, useState } from 'react';
import { Timer, CheckCircle2, XCircle } from 'lucide-react';
import api from '../services/api';
import Button from './ui/Button';

/**
 * Time-to-answer stopwatch (backend feature INVESTIGATION_TIMING). The operator starts it when taking a question
 * and stops it as answered or abandoned; the page reports steps (searches, opened results, cameras, exports).
 * Every time that counts is taken by the backend clock. The elapsed time shown here is display only.
 */
export type TimingStep = 'SEARCH' | 'RESULT_OPENED' | 'CAMERA_VIEWED' | 'EXPORT';

interface Timing {
  id: string;
  startedAt: string;
  outcome: string;
  label: string | null;
  searches: number;
  resultsOpened: number;
  camerasViewed: number;
  exports: number;
}

export interface InvestigationTiming {
  enabled: boolean;
  timing: Timing | null;
  lastResult: { outcome: string; seconds: number } | null;
  error: string | null;
  start: (label?: string) => Promise<void>;
  finish: (outcome: 'ANSWERED' | 'ABANDONED') => Promise<void>;
  step: (kind: TimingStep) => void;
}

const message = (err: any, fallback: string) => err?.response?.data?.error || err?.message || fallback;

export function useInvestigationTiming(enabled: boolean): InvestigationTiming {
  const [timing, setTiming] = useState<Timing | null>(null);
  const [lastResult, setLastResult] = useState<{ outcome: string; seconds: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Resume a stopwatch left running (page reload, another tab).
  useEffect(() => {
    if (!enabled) return;
    api
      .get('/investigations/timings/current')
      .then((res) => setTiming(res.data.timing))
      .catch((err) => setError(message(err, 'Could not read the stopwatch')));
  }, [enabled]);

  const start = useCallback(async (label?: string) => {
    setError(null);
    setLastResult(null);
    try {
      const res = await api.post('/investigations/timings', label ? { label } : {});
      setTiming(res.data.timing);
    } catch (err: any) {
      setError(message(err, 'Could not start the stopwatch'));
    }
  }, []);

  const finish = useCallback(
    async (outcome: 'ANSWERED' | 'ABANDONED') => {
      if (!timing) return;
      try {
        const res = await api.post(`/investigations/timings/${timing.id}/finish`, { outcome });
        setLastResult({ outcome, seconds: res.data.timing.seconds });
        setTiming(null);
      } catch (err: any) {
        setError(message(err, 'Could not stop the stopwatch'));
      }
    },
    [timing]
  );

  const step = useCallback(
    (kind: TimingStep) => {
      if (!enabled || !timing) return;
      api
        .post(`/investigations/timings/${timing.id}/steps`, { kind })
        // A step answered after the stopwatch was stopped (or replaced) must not bring it back on screen.
        .then((res) => setTiming((cur) => (cur && cur.id === res.data.timing.id && res.data.timing.outcome === 'OPEN' ? res.data.timing : cur)))
        .catch((err) => setError(`Stopwatch step not recorded: ${message(err, kind)}`));
    },
    [enabled, timing]
  );

  return { enabled, timing, lastResult, error, start, finish, step };
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export const InvestigationStopwatch: React.FC<{ t: InvestigationTiming }> = ({ t }) => {
  const [now, setNow] = useState(Date.now());
  const [label, setLabel] = useState('');
  useEffect(() => {
    if (!t.timing) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [t.timing]);
  if (!t.enabled) return null;

  if (!t.timing) {
    return (
      <div className="flex items-center space-x-2" aria-label="Investigation stopwatch">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value.slice(0, 120))}
          placeholder="Question (optional)"
          aria-label="Question being investigated"
          className="bg-vms-surface border border-vms-border rounded px-2 py-1 text-xs text-vms-text w-44"
        />
        <Button variant="secondary" size="xs" icon={Timer} onClick={() => t.start(label.trim() || undefined).then(() => setLabel(''))}>
          Start stopwatch
        </Button>
        {t.lastResult && (
          <span className="text-xs font-mono text-vms-text-muted">
            {t.lastResult.outcome === 'ANSWERED' ? `Answered in ${mmss(t.lastResult.seconds)}` : 'Abandoned'}
          </span>
        )}
        {t.error && <span className="text-xs text-red-400">{t.error}</span>}
      </div>
    );
  }

  const elapsed = Math.max(0, (now - Date.parse(t.timing.startedAt)) / 1000);
  return (
    <div className="flex items-center space-x-2" aria-label="Investigation stopwatch">
      <span className={`text-xs font-mono ${elapsed > 60 ? 'text-amber-400' : 'text-emerald-400'}`} title="Time since the stopwatch started (target: 1 minute)">
        <Timer className="inline w-3.5 h-3.5 mr-1" />
        {mmss(elapsed)}
      </span>
      <span className="text-[10px] font-mono text-vms-text-muted" title="Searches, results opened, cameras viewed, exports">
        {t.timing.searches}S {t.timing.resultsOpened}R {t.timing.camerasViewed}C {t.timing.exports}E
      </span>
      <Button variant="primary" size="xs" icon={CheckCircle2} onClick={() => t.finish('ANSWERED')}>
        Answered
      </Button>
      <Button variant="secondary" size="xs" icon={XCircle} onClick={() => t.finish('ABANDONED')}>
        Abandon
      </Button>
      {t.error && <span className="text-xs text-red-400">{t.error}</span>}
    </div>
  );
};

export default InvestigationStopwatch;
