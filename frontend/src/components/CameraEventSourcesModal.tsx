import React, { useEffect, useState } from 'react';
import api from '../services/api';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';

/**
 * Camera-native event feeds for one camera (P3.1/P3.2), behind VIGILONE_FEATURE_CAMERA_EVENTS.
 * Shows each feed's real state as the backend reports it (RUNNING / BACKOFF / FAILED with the
 * error) and the measured clock skew interval, never an optimistic "connected".
 */
const PROTOCOLS: Array<[string, string]> = [
  ['ONVIF_PULLPOINT', 'ONVIF PullPoint (any ONVIF camera)'],
  ['HIKVISION_ISAPI', 'Hikvision ISAPI alert stream'],
  ['DAHUA_EVENT_MANAGER', 'Dahua event manager'],
];

export const CameraEventSourcesModal: React.FC<{ camera: { id: string; name: string }; onClose: () => void }> = ({ camera, onClose }) => {
  const [sources, setSources] = useState<any[]>([]);
  const [protocol, setProtocol] = useState('ONVIF_PULLPOINT');
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await api.get('/camera-events/sources');
      setSources((res.data.sources || []).filter((s: any) => s.cameraId === camera.id));
    } catch (err: any) {
      setError(err.response?.data?.error || 'Could not load camera event sources');
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [camera.id]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Request failed');
    }
  };

  const skewText = (s: any) => {
    const k = s.runtime?.skew;
    if (k) return `clock ${k.lowerMs}..${k.upperMs} ms vs appliance (${k.verdict})`;
    return s.clockSkewMs !== null && s.clockSkewMs !== undefined ? `clock skew ~${s.clockSkewMs} ms` : 'clock skew not measured';
  };

  return (
    <Modal isOpen onClose={onClose} title="Camera events" subtitle={camera.name} maxWidth="2xl">
      <div className="space-y-3 text-xs font-mono">
        {error && <div className="text-rose-400">{error}</div>}
        {sources.length === 0 && <div className="text-vms-dim">No event feed configured for this camera.</div>}
        {sources.map((s) => (
          <div key={s.id} className="p-3 border border-vms-border rounded bg-vms-panel flex justify-between items-start gap-3">
            <div className="space-y-0.5">
              <div className="text-vms-text font-semibold">{s.protocol}</div>
              <div>
                status{' '}
                <span className={s.status === 'RUNNING' ? 'text-emerald-400' : s.status === 'FAILED' ? 'text-rose-400' : 'text-amber-300'}>{s.status}</span>
                {s.enabled ? '' : ' (disabled)'}
                {s.lastEventAt ? ` • last event ${new Date(s.lastEventAt).toLocaleString()}` : ''}
              </div>
              {s.protocol === 'ONVIF_PULLPOINT' && <div className="text-vms-muted">{skewText(s)}</div>}
              {s.lastError && <div className="text-rose-400 break-all">{s.lastError}</div>}
            </div>
            <div className="flex gap-1.5">
              <Button size="xs" variant="secondary" onClick={() => act(() => api.patch(`/camera-events/sources/${s.id}`, { enabled: !s.enabled }))}>
                {s.enabled ? 'Disable' : 'Enable'}
              </Button>
              <Button size="xs" variant="secondary" disabled={!s.enabled || s.status !== 'FAILED'} onClick={() => act(() => api.patch(`/camera-events/sources/${s.id}`, { enabled: true }))}>
                Retry
              </Button>
              <Button size="xs" variant="danger" onClick={() => act(() => api.delete(`/camera-events/sources/${s.id}`))}>
                Remove
              </Button>
            </div>
          </div>
        ))}
        <div className="flex gap-2 items-center pt-2 border-t border-vms-border">
          <select value={protocol} onChange={(e) => setProtocol(e.target.value)} className="bg-vms-surface border border-vms-border rounded p-1.5 text-vms-text">
            {PROTOCOLS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <Button size="xs" variant="primary" onClick={() => act(() => api.post('/camera-events/sources', { cameraId: camera.id, protocol }))}>
            Add feed
          </Button>
          <span className="text-vms-dim">Uses the camera's stored credentials and ONVIF/HTTP port.</span>
        </div>
      </div>
    </Modal>
  );
};

export default CameraEventSourcesModal;
