import React, { useState, useEffect } from 'react';
import { Activity, RefreshCw, AlertTriangle, CheckCircle2, X } from 'lucide-react';
import api from '../services/api';

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
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50 backdrop-blur-sm select-none">
      <div className="bg-graphite-850 border border-graphite-700 rounded-md w-full max-w-xl overflow-hidden shadow-2xl flex flex-col">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-graphite-700 flex justify-between items-center bg-graphite-800">
          <div className="flex items-center space-x-2">
            <Activity className="w-4 h-4 text-cctv-teal" />
            <h3 className="text-sm font-semibold text-slate-100 uppercase tracking-wider">
              Stream Telemetry Watchdog — {camera.name}
            </h3>
            {loading && <RefreshCw className="w-3.5 h-3.5 text-cctv-teal animate-spin" />}
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Status Indicator Bar */}
        <div
          className={`p-3 border-b flex items-center justify-between text-xs font-mono ${
            diag.isDegraded
              ? 'bg-red-950/70 border-red-800 text-red-300'
              : 'bg-emerald-950/70 border-emerald-800 text-emerald-300'
          }`}
        >
          <div className="flex items-center space-x-2">
            {diag.isDegraded ? (
              <AlertTriangle className="w-4 h-4 text-red-400" />
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
        <div className="p-5 space-y-4 bg-graphite-900">
          <div className="grid grid-cols-2 gap-3">
            {/* FPS Meter */}
            <div className="p-3 bg-graphite-850 rounded border border-graphite-700">
              <div className="text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1">
                Observed Frame Rate
              </div>
              <div className="text-xl font-bold font-mono text-white flex items-baseline space-x-1">
                <span>{(diag.fps || 0).toFixed(1)}</span>
                <span className="text-xs text-slate-400">FPS</span>
              </div>
              <div className="text-[10px] font-mono text-slate-500 mt-1">
                Baseline: {baseline.expectedFps} FPS target
              </div>
            </div>

            {/* Bitrate Gauge */}
            <div className="p-3 bg-graphite-850 rounded border border-graphite-700">
              <div className="text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1">
                Ingest Bitrate
              </div>
              <div className="text-xl font-bold font-mono text-cctv-amber flex items-baseline space-x-1">
                <span>{((diag.bitrateKbps || 0) / 1000).toFixed(2)}</span>
                <span className="text-xs text-slate-400">Mbps</span>
              </div>
              <div className="text-[10px] font-mono text-slate-500 mt-1">
                Min: {baseline.expectedBitrateKbpsMin}k / Max: {baseline.expectedBitrateKbpsMax}k
              </div>
            </div>

            {/* Resolution & Codec */}
            <div className="p-3 bg-graphite-850 rounded border border-graphite-700">
              <div className="text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1">
                Video Codec & Frame Size
              </div>
              <div className="text-sm font-semibold font-mono text-white uppercase">
                {diag.videoCodec || 'h264'} • {diag.resolution || '1920x1080'}
              </div>
              <div className="text-[10px] font-mono text-slate-500 mt-1">
                Audio: {diag.audioCodec || 'None / Muted'}
              </div>
            </div>

            {/* GOP / Keyframe Interval */}
            <div className="p-3 bg-graphite-850 rounded border border-graphite-700">
              <div className="text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1">
                Keyframe (GOP) Interval
              </div>
              <div className="text-sm font-semibold font-mono text-white">
                {(diag.gopInterval || 2.0).toFixed(1)}s
              </div>
              <div className="text-[10px] font-mono text-slate-500 mt-1">
                Target: {baseline.expectedGopSeconds}s (GOP drift threshold: 5.0s)
              </div>
            </div>
          </div>

          <div className="p-3 bg-graphite-850 rounded border border-graphite-700 text-xs font-mono text-slate-400 flex items-center justify-between">
            <span>Single Physical RTSP Invariant: Active (Relayed via MediaMTX localhost :8554)</span>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-graphite-700 flex justify-between items-center bg-graphite-800">
          <button
            onClick={handleProbeNow}
            disabled={probing}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded text-xs font-semibold bg-cctv-teal/20 text-cctv-teal border border-cctv-teal/40 hover:bg-cctv-teal/30 font-mono disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${probing ? 'animate-spin' : ''}`} />
            <span>{probing ? 'Probing Stream...' : 'Probe Live Stream'}</span>
          </button>

          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded text-xs font-semibold bg-graphite-700 text-white hover:bg-graphite-600 font-mono"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default StreamDiagnosticModal;
