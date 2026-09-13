import React, { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, ZoomIn, ZoomOut, Activity, Compass } from 'lucide-react';
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
    <div className="relative group bg-tactical-panel border border-tactical-border overflow-hidden flex flex-col aspect-video select-none corner-reticle">
      {/* Video Canvas */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="w-full h-full object-contain bg-black"
      />

      {/* Simulated Scanlines Overlay */}
      <div className="absolute inset-0 crt-scanlines opacity-40 pointer-events-none" />

      {/* Authentic CCTV Optical OSD Top Bar */}
      <div className="absolute top-2 left-2 right-2 flex justify-between items-start pointer-events-none text-white font-mono text-xs z-10">
        <div className="flex items-center space-x-1.5">
          {camera.recordingMode === 'CONTINUOUS' && (
            <div className="flex items-center space-x-1 px-1.5 py-0.5 bg-black/80 border border-phosphor-red/60 text-phosphor-red text-[10px] font-bold tracking-widest">
              <span className="w-1.5 h-1.5 bg-phosphor-red animate-rec" />
              <span>REC</span>
            </div>
          )}
          <div className="bg-black/80 px-2 py-0.5 border border-tactical-border text-white text-[11px] font-bold tracking-wider uppercase">
            CAM // {camera.name}
          </div>
          <div className="hidden sm:block bg-black/80 px-1.5 py-0.5 border border-tactical-border text-tactical-muted text-[10px]">
            {camera.ipAddress}
          </div>
        </div>

        <div className="flex items-center space-x-1.5">
          <span
            className={`px-1.5 py-0.5 text-[10px] font-bold tracking-wider uppercase border ${
              streamStatus === 'connected'
                ? 'bg-black/80 text-phosphor-green border-phosphor-green/40'
                : streamStatus === 'failed'
                ? 'bg-phosphor-red/20 text-phosphor-red border-phosphor-red'
                : 'bg-phosphor-amber/20 text-phosphor-amber border-phosphor-amber'
            }`}
          >
            {streamStatus === 'connected' ? 'LIVE' : streamStatus}
          </span>
          <span className="bg-black/80 px-2 py-0.5 border border-tactical-border text-slate-200 text-[10px] tracking-wide">
            {clock}
          </span>
        </div>
      </div>

      {/* Bottom Telemetry Bar */}
      <div className="absolute bottom-2 left-2 pointer-events-none flex items-center space-x-2 font-mono text-[10px] text-tactical-muted z-10">
        <span className="bg-black/70 px-1.5 py-0.5 border border-tactical-border">
          1080P25 // H.264
        </span>
        {camera.hasPtz && (
          <span className="bg-black/70 px-1.5 py-0.5 border border-phosphor-amber/40 text-phosphor-amber">
            PTZ // READY
          </span>
        )}
      </div>

      {/* Tile Controls (Hover Overlay) */}
      <div className="absolute bottom-2 right-2 flex items-center space-x-1 opacity-0 group-hover:opacity-100 transition-opacity bg-tactical-surface/90 p-1 border border-tactical-border z-20">
        <button
          onClick={() => setShowDiagModal(true)}
          title="Stream Quality & Diagnostics"
          className="p-1 text-tactical-muted hover:text-phosphor-cyan hover:bg-tactical-raised transition"
        >
          <Activity className="w-3.5 h-3.5" />
        </button>

        {camera.hasPtz && (
          <>
            <button
              onClick={() => setShowPtzModal(true)}
              title="PTZ Presets & Guard Tours"
              className="p-1 text-tactical-muted hover:text-phosphor-amber hover:bg-tactical-raised transition"
            >
              <Compass className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setShowPtz(!showPtz)}
              title="Quick D-Pad Overlay"
              className={`px-1.5 py-0.5 text-[10px] font-mono transition ${
                showPtz ? 'bg-phosphor-amber text-tactical-bg font-bold' : 'text-tactical-muted hover:text-white'
              }`}
            >
              PAD
            </button>
          </>
        )}

        {onToggleFullscreen && (
          <button
            onClick={onToggleFullscreen}
            className="p-1 text-tactical-muted hover:text-white hover:bg-tactical-raised transition"
          >
            {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>

      {/* PTZ Virtual Control Pad Overlay */}
      {showPtz && camera.hasPtz && (
        <div className="absolute bottom-10 right-2 bg-graphite-850/95 border border-graphite-600 rounded p-2 shadow-2xl backdrop-blur-sm flex flex-col items-center space-y-2 z-20">
          <div className="text-[10px] font-mono text-slate-400 uppercase tracking-wider">PTZ Controls</div>

          {/* D-Pad */}
          <div className="grid grid-cols-3 gap-1">
            <div />
            <button
              onMouseDown={() => handlePtz('move', 0, 1)}
              onMouseUp={() => handlePtz('stop')}
              className="p-1.5 bg-graphite-700 hover:bg-cctv-amber hover:text-graphite-900 rounded active:bg-amber-600 transition"
            >
              <ArrowUp className="w-4 h-4" />
            </button>
            <div />

            <button
              onMouseDown={() => handlePtz('move', -1, 0)}
              onMouseUp={() => handlePtz('stop')}
              className="p-1.5 bg-graphite-700 hover:bg-cctv-amber hover:text-graphite-900 rounded active:bg-amber-600 transition"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div className="w-4 h-4" />
            <button
              onMouseDown={() => handlePtz('move', 1, 0)}
              onMouseUp={() => handlePtz('stop')}
              className="p-1.5 bg-graphite-700 hover:bg-cctv-amber hover:text-graphite-900 rounded active:bg-amber-600 transition"
            >
              <ArrowRight className="w-4 h-4" />
            </button>

            <div />
            <button
              onMouseDown={() => handlePtz('move', 0, -1)}
              onMouseUp={() => handlePtz('stop')}
              className="p-1.5 bg-graphite-700 hover:bg-cctv-amber hover:text-graphite-900 rounded active:bg-amber-600 transition"
            >
              <ArrowDown className="w-4 h-4" />
            </button>
            <div />
          </div>

          {/* Zoom */}
          <div className="flex space-x-1 pt-1 border-t border-graphite-700 w-full justify-center">
            <button
              onMouseDown={() => handlePtz('move', 0, 0, 1)}
              onMouseUp={() => handlePtz('stop')}
              title="Zoom In"
              className="p-1 bg-graphite-700 hover:bg-cctv-teal hover:text-graphite-900 rounded transition"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <button
              onMouseDown={() => handlePtz('move', 0, 0, -1)}
              onMouseUp={() => handlePtz('stop')}
              title="Zoom Out"
              className="p-1 bg-graphite-700 hover:bg-cctv-teal hover:text-graphite-900 rounded transition"
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
