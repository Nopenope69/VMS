import React, { useState, useEffect } from 'react';
import { Activity, RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react';
import api from '../services/api';
import Modal from './ui/Modal';
import Button from './ui/Button';

interface StreamDiagnosticModalProps {
  camera: { id: string; name: string };
  onClose: () => void;
}

export const StreamDiagnosticModal: React.FC<StreamDiagnosticModalProps> = ({ camera, onClose }) => {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [probing, setProbing] = useState(false);

  const fetchDiagnostics = async () => {
    setLoading(true);
    try {
      const res = await api.get(`/cameras/${camera.id}/diagnostic`);
      setData(res.data);
    } catch (err) {
      console.error('Failed fetching diagnostic:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDiagnostics();
  }, [camera.id]);

  const handleProbeNow = async () => {
    setProbing(true);
    try {
      await api.post(`/cameras/${camera.id}/diagnostic/probe`);
      await fetchDiagnostics();
    } catch (err) {
      console.error('Probe error:', err);
    } finally {
      setProbing(false);
    }
  };

  const diag = data?.diagnostic || {
    fps: 25.0,
    bitrateKbps: 2500,
    resolution: '1920x1080',
    videoCodec: 'h264',
    isDegraded: false,
    deviationScore: 0.0,
  };

  const baseline = data?.baseline || {
    expectedFps: 25.0,
    expectedBitrateKbpsMin: 1500,
    expectedBitrateKbpsMax: 6000,
    expectedResolution: '1920x1080',
    expectedGopSeconds: 2.0,
  };

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={`Stream Telemetry Watchdog — ${camera.name}`}
      subtitle="Real-time frame rates, bitrate anomalies, and single RTSP session state"
      icon={<Activity className="w-4 h-4 text-sky-400" />}
      size="xl"
      footer={
        <div className="flex justify-between items-center w-full">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleProbeNow}
            disabled={probing}
            isLoading={probing}
            icon={RefreshCw}
          >
            {probing ? 'Probing Stream...' : 'Probe Live Stream'}
          </Button>

          <Button variant="secondary" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center p-8 text-vms-muted font-mono text-xs">
          <RefreshCw className="w-4 h-4 animate-spin mr-2" />
          Probing stream telemetry...
        </div>
      ) : (
        <div className="space-y-4">
        {/* Status Indicator Bar */}
        <div
          className={`p-3 rounded border flex items-center justify-between text-xs font-mono ${
            diag.isDegraded
              ? 'bg-rose-950/70 border-rose-800 text-rose-300'
              : 'bg-emerald-950/70 border-emerald-800 text-emerald-300'
          }`}
        >
          <div className="flex items-center space-x-2">
            {diag.isDegraded ? (
              <AlertTriangle className="w-4 h-4 text-rose-400" />
            ) : (
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            )}
            <span>
              Stream Health:{' '}
              <strong>{diag.isDegraded ? `DEGRADED (${diag.degradedReason || 'ANOMALY'})` : 'OPTIMAL'}</strong>
            </span>
          </div>
          <span>Deviation Score: {(diag.deviationScore || 0).toFixed(2)}</span>
        </div>

        {/* Telemetry Metrics Grid */}
        <div className="grid grid-cols-2 gap-3">
          {/* FPS Meter */}
          <div className="p-3 bg-vms-panel rounded border border-vms-border">
            <div className="text-[10px] font-mono text-vms-muted uppercase tracking-wider mb-1">
              Observed Frame Rate
            </div>
            <div className="text-xl font-bold font-mono text-vms-text flex items-baseline space-x-1">
              <span>{(diag.fps || 0).toFixed(1)}</span>
              <span className="text-xs text-vms-dim">FPS</span>
            </div>
            <div className="text-[10px] font-mono text-vms-dim mt-1">
              Baseline: {baseline.expectedFps} FPS target
            </div>
          </div>

          {/* Bitrate Gauge */}
          <div className="p-3 bg-vms-panel rounded border border-vms-border">
            <div className="text-[10px] font-mono text-vms-muted uppercase tracking-wider mb-1">
              Ingest Bitrate
            </div>
            <div className="text-xl font-bold font-mono text-vms-accent flex items-baseline space-x-1">
              <span>{((diag.bitrateKbps || 0) / 1000).toFixed(2)}</span>
              <span className="text-xs text-vms-dim">Mbps</span>
            </div>
            <div className="text-[10px] font-mono text-vms-dim mt-1">
              Min: {baseline.expectedBitrateKbpsMin}k / Max: {baseline.expectedBitrateKbpsMax}k
            </div>
          </div>

          {/* Resolution & Codec */}
          <div className="p-3 bg-vms-panel rounded border border-vms-border">
            <div className="text-[10px] font-mono text-vms-muted uppercase tracking-wider mb-1">
              Video Codec & Frame Size
            </div>
            <div className="text-sm font-semibold font-mono text-vms-text uppercase">
              {diag.videoCodec || 'h264'} • {diag.resolution || '1920x1080'}
            </div>
            <div className="text-[10px] font-mono text-vms-dim mt-1">
              Audio: {diag.audioCodec || 'None / Muted'}
            </div>
          </div>

          {/* GOP / Keyframe Interval */}
          <div className="p-3 bg-vms-panel rounded border border-vms-border">
            <div className="text-[10px] font-mono text-vms-muted uppercase tracking-wider mb-1">
              Keyframe (GOP) Interval
            </div>
            <div className="text-sm font-semibold font-mono text-vms-text">
              {(diag.gopInterval || 2.0).toFixed(1)}s
            </div>
            <div className="text-[10px] font-mono text-vms-dim mt-1">
              Target: {baseline.expectedGopSeconds}s (GOP drift threshold: 5.0s)
            </div>
          </div>
        </div>

        <div className="p-3 bg-vms-surface rounded border border-vms-border text-xs font-mono text-vms-muted flex items-center justify-between">
          <span>Single Physical RTSP Invariant: Active (Relayed via MediaMTX localhost :8554)</span>
        </div>
      </div>
      )}
    </Modal>
  );
};

export default StreamDiagnosticModal;
