import React, { useCallback, useEffect, useState } from 'react';
import { ShieldAlert, RefreshCw } from 'lucide-react';
import api from '../services/api';
import { Badge } from '../components/ui/Badge';

interface Condition {
  id: string;
  changeType: 'OCCLUSION' | 'DEFOCUS' | 'DISPLACEMENT' | 'BLINDED';
  title: string;
  startedAt: string;
  confirmedAt: string;
  clearedAt: string | null;
  clearReason: 'RESTORED' | 'RELEARNED' | null;
  score: number;
  measurements: Record<string, number>;
}
interface CameraRow {
  cameraId: string;
  name: string;
  sabotage: { open: Condition[]; recent: Condition[] };
  seals: { count: number; lastSealedAt: string | null };
  heldSegments: number;
}
interface Overview {
  features: { cameraSabotage: boolean; footageSealing: boolean };
  recentDays: number;
  cameras: CameraRow[];
}
interface ChainProblem {
  sequence: number | null;
  problem: string;
  detail: string;
}
interface ChainReport {
  sealCount: number;
  valid: boolean;
  problems: ChainProblem[];
  segmentsGone: number;
  unanchoredSeals: number;
  lastAnchor: { sequence: number; at: string } | null;
  otherKeys: Array<{ keyFingerprint: string; count: number }>;
}

const SHORT: Record<Condition['changeType'], string> = {
  OCCLUSION: 'Covered',
  DEFOCUS: 'Out of focus',
  DISPLACEMENT: 'Moved',
  BLINDED: 'Blinded',
};
const when = (iso: string) => new Date(iso).toLocaleString();
const duration = (fromIso: string, toIso: string) => {
  const s = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000));
  return s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
};
const describeError = (err: any): string => err?.response?.data?.error || err?.message || 'backend unreachable';

/**
 * Footage integrity (ADR 0018 and 0019): per camera, whether its view looks tampered with (camera-sabotage detection),
 * whether its recordings are sealed, and how many are held by an integrity finding. Reads only; "Check chain" asks the
 * backend to walk that camera's seal chain now.
 */
const FootageIntegrity: React.FC = () => {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chains, setChains] = useState<Record<string, { state: 'checking' } | { state: 'done'; report: ChainReport } | { state: 'error'; message: string }>>({});

  const load = useCallback(() => {
    api
      .get('/footage-integrity/cameras')
      .then((res) => {
        setData(res.data);
        setError(null);
      })
      .catch((err) => setError(describeError(err)));
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, [load]);

  const checkChain = (cameraId: string) => {
    setChains((c) => ({ ...c, [cameraId]: { state: 'checking' } }));
    api
      .get(`/segment-seals/cameras/${cameraId}/verify`)
      .then((res) => setChains((c) => ({ ...c, [cameraId]: { state: 'done', report: res.data.report } })))
      .catch((err) => setChains((c) => ({ ...c, [cameraId]: { state: 'error', message: describeError(err) } })));
  };

  const tampered = data?.cameras.filter((c) => c.sabotage.open.length > 0).length ?? 0;

  return (
    <div className="flex flex-col min-h-[calc(100vh-3.5rem)] bg-vms-bg p-3 md:p-4 space-y-3" data-testid="footage-integrity-page">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 border-b border-vms-border pb-3">
        <div className="flex items-center gap-2.5">
          <ShieldAlert className="w-5 h-5 text-vms-accent" />
          <h1 className="text-base md:text-lg font-bold text-vms-text tracking-tight uppercase font-mono">Footage Integrity</h1>
          {data && (
            <Badge variant={tampered > 0 ? 'alarm' : 'success'} size="sm">
              {tampered > 0 ? `${tampered} camera${tampered === 1 ? '' : 's'} suspected tampered` : 'No camera suspected tampered'}
            </Badge>
          )}
        </div>
        <button onClick={load} className="flex items-center gap-1.5 text-xs text-vms-muted hover:text-vms-text" aria-label="Refresh">
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

      <div className="px-3 py-2 bg-vms-surface border border-vms-border rounded text-xs text-vms-muted">
        <span className="font-semibold text-vms-text">Advisory.</span> Tamper status comes from classical image measurements on each camera&apos;s
        substream and has not been measured on real sites: check the live view before acting. Seals show whether recordings were changed after
        they were written. Nothing on this page changes a camera, a recording or an alarm.
      </div>

      {error && (
        <div role="alert" className="p-3 bg-status-alarm/10 border border-status-alarm/30 rounded text-xs text-status-alarm font-mono">
          FOOTAGE INTEGRITY UNAVAILABLE: {error}. Nothing is shown because it could not be loaded, not because all is well.
        </div>
      )}

      {data && (
        <div className="flex flex-wrap gap-2 text-[11px]" data-testid="integrity-features">
          {!data.features.cameraSabotage && (
            <span className="px-2 py-1 rounded border border-vms-border bg-vms-surface text-vms-muted" data-testid="sabotage-off">
              Camera-sabotage detection is off (VIGILONE_FEATURE_CAMERA_SABOTAGE and AI_SABOTAGE_DETECTION); tamper status is not being checked.
            </span>
          )}
          {!data.features.footageSealing && (
            <span className="px-2 py-1 rounded border border-vms-border bg-vms-surface text-vms-muted" data-testid="sealing-off">
              Footage sealing is off (VIGILONE_FEATURE_FOOTAGE_SEALING); new recordings are not sealed.
            </span>
          )}
        </div>
      )}

      {data && data.cameras.length === 0 && <div className="p-6 text-center text-xs text-vms-muted border border-vms-border rounded bg-vms-surface">No cameras.</div>}

      {data && data.cameras.length > 0 && (
        <ul className="space-y-2">
          {data.cameras.map((cam) => {
            const chain = chains[cam.cameraId];
            return (
              <li key={cam.cameraId} className="p-3 bg-vms-surface border border-vms-border rounded space-y-2" data-testid="integrity-camera">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-vms-text">{cam.name}</span>
                  {!data.features.cameraSabotage ? (
                    <Badge variant="neutral" size="sm">View not checked</Badge>
                  ) : cam.sabotage.open.length > 0 ? (
                    cam.sabotage.open.map((c) => (
                      <Badge key={c.id} variant="alarm" size="sm">
                        {SHORT[c.changeType]}
                      </Badge>
                    ))
                  ) : (
                    <Badge variant="success" size="sm">View normal</Badge>
                  )}
                  {cam.heldSegments > 0 && (
                    <Badge variant="warn" size="sm">
                      {cam.heldSegments} recording{cam.heldSegments === 1 ? '' : 's'} held
                    </Badge>
                  )}
                </div>

                {cam.sabotage.open.map((c) => (
                  <div key={c.id} className="pl-2 border-l-2 border-status-alarm text-xs text-vms-text" data-testid="open-condition">
                    <span className="font-semibold">{c.title}</span> since {when(c.startedAt)} ({duration(c.startedAt, new Date().toISOString())} so far).
                  </div>
                ))}

                <div className="grid md:grid-cols-2 gap-2 text-xs">
                  <div className="text-vms-muted" data-testid="seal-summary">
                    {cam.seals.count === 0 ? (
                      <span>No sealed recordings.</span>
                    ) : (
                      <span>
                        {cam.seals.count} sealed recording{cam.seals.count === 1 ? '' : 's'}, last sealed {when(cam.seals.lastSealedAt!)}.
                      </span>
                    )}
                    {data.features.footageSealing && cam.seals.count > 0 && (
                      <button
                        onClick={() => checkChain(cam.cameraId)}
                        disabled={chain?.state === 'checking'}
                        className="ml-2 px-2 py-0.5 rounded border border-vms-border text-vms-text hover:bg-vms-elevated disabled:opacity-50"
                        data-testid="check-chain"
                      >
                        {chain?.state === 'checking' ? 'Checking…' : 'Check chain'}
                      </button>
                    )}
                    {cam.heldSegments > 0 && (
                      <div className="mt-1">
                        A held recording changed after it was written (or its stored hash did); it is kept as found and cannot be exported. See the
                        recording-integrity note.
                      </div>
                    )}
                  </div>
                  <div className="text-vms-muted" data-testid="recent-conditions">
                    {cam.sabotage.recent.length === 0 ? (
                      <span>No tamper conditions ended in the last {data.recentDays} days.</span>
                    ) : (
                      <ul className="space-y-0.5">
                        {cam.sabotage.recent.map((c) => (
                          <li key={c.id}>
                            {SHORT[c.changeType]} {when(c.startedAt)}, {duration(c.startedAt, c.clearedAt!)},{' '}
                            {c.clearReason === 'RELEARNED' ? 'new view accepted' : 'restored'}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>

                {chain?.state === 'error' && (
                  <div role="alert" className="text-xs text-status-alarm font-mono" data-testid="chain-result">
                    Chain check failed: {chain.message}
                  </div>
                )}
                {chain?.state === 'done' && (
                  <div className="text-xs space-y-0.5" data-testid="chain-result">
                    {chain.report.valid ? (
                      <div className="text-status-live">
                        Chain intact: {chain.report.sealCount} seals checked.
                        {chain.report.lastAnchor ? ` Last anchored in the audit log ${when(chain.report.lastAnchor.at)}.` : ' Not yet anchored in the audit log.'}
                        {chain.report.unanchoredSeals > 0 && ` ${chain.report.unanchoredSeals} newer seals are not anchored yet.`}
                      </div>
                    ) : (
                      <>
                        <div className="text-status-alarm font-semibold">Chain problems found ({chain.report.problems.length}):</div>
                        <ul className="pl-3 space-y-0.5">
                          {chain.report.problems.map((p, i) => (
                            <li key={i} className="text-status-alarm font-mono">
                              {p.problem}
                              {p.sequence !== null ? ` at seal ${p.sequence}` : ''}: {p.detail}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    {chain.report.segmentsGone > 0 && (
                      <div className="text-vms-muted">{chain.report.segmentsGone} sealed recordings have since been deleted (retention); their seals remain.</div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default FootageIntegrity;
