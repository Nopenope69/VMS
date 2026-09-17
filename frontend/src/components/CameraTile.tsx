import React, { useEffect, useRef, useState } from 'react';
import {
  Maximize2,
  Minimize2,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ZoomIn,
  ZoomOut,
  Activity,
  Compass,
  Navigation,
} from 'lucide-react';
import { WhepClient } from '../services/whepPlayer';
import api from '../services/api';
import PtzControlModal from './PtzControlModal';
import StreamDiagnosticModal from './StreamDiagnosticModal';

export interface CameraData {
  id: string;
  name: string;
  streamPath: string;
  ipAddress: string;
  hasPtz: boolean;
  recordingMode: string;
  isOnline: boolean;
}

interface CameraTileProps {
  camera: CameraData;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
}

export const CameraTile: React.FC<CameraTileProps> = ({ camera, isFullscreen, onToggleFullscreen }) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [streamStatus, setStreamStatus] = useState<'connecting' | 'connected' | 'reconnecting' | 'failed'>('connecting');
  const [clock, setClock] = useState('');
  const [showPtz, setShowPtz] = useState(false);
  const [showPtzModal, setShowPtzModal] = useState(false);
  const [showDiagModal, setShowDiagModal] = useState(false);

  // Live CCTV OSD clock update
  useEffect(() => {
    const updateClock = () => {
      const now = new Date();
      const pad = (n: number) => n.toString().padStart(2, '0');
      const timeStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
        now.getHours()
      )}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
      setClock(timeStr);
    };

    updateClock();
    const timer = setInterval(updateClock, 1000);
    return () => clearInterval(timer);
  }, []);

  // Initialize WebRTC WHEP connection
  useEffect(() => {
    if (camera.id.startsWith('demo-')) {
      setStreamStatus('connected');
      return;
    }

    if (!videoRef.current) return;

    const client = new WhepClient({
      cameraId: camera.id,
      videoElement: videoRef.current,
      onStatusChange: (status) => setStreamStatus(status),
      onError: (err) => console.warn(`[WHEP ${camera.name}] stream notice:`, err.message),
    });

    client.start();

    return () => {
      client.destroy();
    };
  }, [camera.id, camera.name]);

  // PTZ continuous move handlers
  const handlePtz = async (action: 'move' | 'stop', x = 0, y = 0, zoom = 0) => {
    if (!camera.hasPtz) return;
    try {
      await api.post(`/cameras/${camera.id}/ptz`, { action, x, y, zoom });
    } catch (err) {
      console.error('PTZ call failed:', err);
    }
  };

  return (
    <div
      onDoubleClick={onToggleFullscreen}
      className={`relative group bg-black border border-vms-border rounded overflow-hidden flex flex-col aspect-video select-none shadow-sm ${
        onToggleFullscreen ? 'cursor-pointer' : ''
      }`}
      title={onToggleFullscreen ? (isFullscreen ? 'Double-click to restore grid' : 'Double-click to maximize') : undefined}
    >
      {/* Video Canvas - Video First Primary Surface */}
      {camera.id.startsWith('demo-') ? (
        <div className="w-full h-full bg-[#0d121c] relative flex items-center justify-center overflow-hidden select-none">
          {/* Subtle Grid Reticle */}
          <div className="absolute inset-0 bg-[radial-gradient(#1e293b_1px,transparent_1px)] [background-size:24px_24px] opacity-35" />
          <div className="absolute inset-x-8 top-1/2 h-px bg-cyan-500/15" />
          <div className="absolute inset-y-8 left-1/2 w-px bg-cyan-500/15" />
          <div className="relative text-center space-y-1 text-vms-muted font-mono px-4">
            <div className="text-xs font-semibold tracking-wider text-vms-accent uppercase">
              {camera.name}
            </div>
            <div className="text-[10px] text-vms-dim">
              RTSP H.264 • 25.0 FPS • 4,200 Kbps • {camera.ipAddress}
            </div>
          </div>
        </div>
      ) : (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-contain bg-black"
        />
      )}

      {/* Top OSD Bar: Quiet, high-contrast, non-interfering */}
      <div className="absolute top-2 left-2 right-2 flex justify-between items-start pointer-events-none text-white font-mono text-xs z-10">
        <div className="flex items-center space-x-1.5">
          {camera.recordingMode === 'CONTINUOUS' && (
            <div className="flex items-center space-x-1 px-1.5 py-0.5 bg-slate-950/85 border border-rose-500/50 text-rose-400 text-[10px] font-bold rounded tracking-wider">
              <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-rec" />
              <span>REC</span>
            </div>
          )}
          <div className="bg-slate-950/85 px-2 py-0.5 border border-vms-border text-white text-[11px] font-medium rounded tracking-wide font-sans">
            {camera.name}
          </div>
          <div className="hidden sm:block bg-slate-950/85 px-1.5 py-0.5 border border-vms-border text-vms-muted text-[10px] font-mono rounded">
            {camera.ipAddress}
          </div>
        </div>

        <div className="flex items-center space-x-1.5">
          <span
            className={`px-1.5 py-0.5 text-[10px] font-mono font-semibold uppercase tracking-wider rounded border ${
              streamStatus === 'connected'
                ? 'bg-slate-950/85 text-emerald-400 border-emerald-500/40'
                : streamStatus === 'failed'
                ? 'bg-rose-500/20 text-rose-400 border-rose-500'
                : 'bg-amber-500/20 text-amber-400 border-amber-500/60'
            }`}
          >
            {streamStatus === 'connected' ? 'LIVE' : streamStatus}
          </span>
          <span className="bg-slate-950/85 px-2 py-0.5 border border-vms-border text-slate-300 text-[10px] font-mono rounded">
            {clock}
          </span>
        </div>
      </div>

      {/* Bottom Telemetry Bar */}
      <div className="absolute bottom-2 left-2 pointer-events-none flex items-center space-x-1.5 font-mono text-[10px] text-vms-muted z-10">
        <span className="bg-slate-950/80 px-1.5 py-0.5 border border-vms-border rounded text-vms-dim">
          1080P • H.264
        </span>
        {camera.hasPtz && (
          <span className="bg-slate-950/80 px-1.5 py-0.5 border border-amber-500/30 text-amber-400 rounded">
            PTZ
          </span>
        )}
      </div>

      {/* Action Controls Overlay (Appears on Hover) */}
      <div className="absolute bottom-2 right-2 flex items-center space-x-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity bg-vms-elevated/95 p-1 border border-vms-border rounded shadow-lg z-20">
        <button
          onClick={() => setShowDiagModal(true)}
          title="Stream Quality & Diagnostics"
          aria-label="Stream Diagnostics"
          className="p-1 rounded text-vms-muted hover:text-sky-400 hover:bg-vms-hover transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-400"
        >
          <Activity className="w-3.5 h-3.5" />
        </button>

        {camera.hasPtz && (
          <>
            <button
              onClick={() => setShowPtzModal(true)}
              title="PTZ Presets & Guard Patrols"
              aria-label="PTZ Presets"
              className="p-1 rounded text-vms-muted hover:text-amber-400 hover:bg-vms-hover transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-400"
            >
              <Compass className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setShowPtz(!showPtz)}
              title="Quick D-Pad Overlay"
              aria-label="Toggle D-Pad Overlay"
              className={`p-1 rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-400 ${
                showPtz
                  ? 'bg-amber-500 text-slate-950'
                  : 'text-vms-muted hover:text-vms-text hover:bg-vms-hover'
              }`}
            >
              <Navigation className="w-3.5 h-3.5" />
            </button>
          </>
        )}

        {onToggleFullscreen && (
          <button
            onClick={onToggleFullscreen}
            title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
            aria-label={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
            className="p-1 rounded text-vms-muted hover:text-vms-text hover:bg-vms-hover transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-400"
          >
            {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>

      {/* PTZ Virtual Control Pad Overlay */}
      {showPtz && camera.hasPtz && (
        <div className="absolute bottom-11 right-2 bg-vms-elevated border border-vms-border rounded p-2.5 shadow-2xl flex flex-col items-center space-y-2 z-20">
          <div className="text-[10px] font-mono font-medium text-vms-muted uppercase tracking-wider">
            PTZ Controls
          </div>

          {/* D-Pad */}
          <div className="grid grid-cols-3 gap-1">
            <div />
            <button
              onMouseDown={() => handlePtz('move', 0, 1)}
              onMouseUp={() => handlePtz('stop')}
              title="Tilt Up"
              className="p-1.5 bg-vms-surface hover:bg-amber-500 hover:text-slate-950 active:bg-amber-600 rounded text-vms-text transition-colors border border-vms-border"
            >
              <ArrowUp className="w-4 h-4" />
            </button>
            <div />

            <button
              onMouseDown={() => handlePtz('move', -1, 0)}
              onMouseUp={() => handlePtz('stop')}
              title="Pan Left"
              className="p-1.5 bg-vms-surface hover:bg-amber-500 hover:text-slate-950 active:bg-amber-600 rounded text-vms-text transition-colors border border-vms-border"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div className="w-4 h-4" />
            <button
              onMouseDown={() => handlePtz('move', 1, 0)}
              onMouseUp={() => handlePtz('stop')}
              title="Pan Right"
              className="p-1.5 bg-vms-surface hover:bg-amber-500 hover:text-slate-950 active:bg-amber-600 rounded text-vms-text transition-colors border border-vms-border"
            >
              <ArrowRight className="w-4 h-4" />
            </button>

            <div />
            <button
              onMouseDown={() => handlePtz('move', 0, -1)}
              onMouseUp={() => handlePtz('stop')}
              title="Tilt Down"
              className="p-1.5 bg-vms-surface hover:bg-amber-500 hover:text-slate-950 active:bg-amber-600 rounded text-vms-text transition-colors border border-vms-border"
            >
              <ArrowDown className="w-4 h-4" />
            </button>
            <div />
          </div>

          {/* Zoom */}
          <div className="flex space-x-1 pt-1.5 border-t border-vms-border w-full justify-center">
            <button
              onMouseDown={() => handlePtz('move', 0, 0, 1)}
              onMouseUp={() => handlePtz('stop')}
              title="Optical Zoom In"
              className="p-1 bg-vms-surface hover:bg-sky-500 hover:text-slate-950 rounded transition-colors text-vms-text border border-vms-border"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <button
              onMouseDown={() => handlePtz('move', 0, 0, -1)}
              onMouseUp={() => handlePtz('stop')}
              title="Optical Zoom Out"
              className="p-1 bg-vms-surface hover:bg-sky-500 hover:text-slate-950 rounded transition-colors text-vms-text border border-vms-border"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {showDiagModal && (
        <StreamDiagnosticModal
          camera={camera}
          onClose={() => setShowDiagModal(false)}
        />
      )}

      {showPtzModal && camera.hasPtz && (
        <PtzControlModal
          camera={camera}
          onClose={() => setShowPtzModal(false)}
        />
      )}
    </div>
  );
};

export default CameraTile;
