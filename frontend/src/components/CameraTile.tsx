import React, { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, ZoomIn, ZoomOut } from 'lucide-react';
import { WhepClient } from '../services/whepPlayer';
import api from '../services/api';

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
    <div className="relative group bg-graphite-900 border border-graphite-700 rounded-sm overflow-hidden flex flex-col aspect-video select-none shadow-lg">
      {/* Video Canvas */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="w-full h-full object-contain bg-black"
      />

      {/* Authentic CCTV On-Screen Display (OSD) Overlay */}
      <div className="absolute top-2 left-2 right-2 flex justify-between items-start pointer-events-none text-white font-mono text-xs drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]">
        <div className="flex items-center space-x-2">
          {camera.recordingMode === 'CONTINUOUS' && (
            <div className="flex items-center space-x-1.5 px-1.5 py-0.5 rounded bg-black/60 border border-cctv-amber/40">
              <span className="w-2 h-2 rounded-full bg-cctv-amber animate-rec" />
              <span className="text-[10px] font-bold text-cctv-amber tracking-widest">REC</span>
            </div>
          )}
          <span className="bg-black/60 px-1.5 py-0.5 rounded border border-white/10 uppercase tracking-wider font-semibold">
            {camera.name}
          </span>
        </div>

        <div className="flex items-center space-x-2">
          {streamStatus !== 'connected' && (
            <span className="bg-cctv-amber/90 text-graphite-900 px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wider uppercase">
              {streamStatus}
            </span>
          )}
          <span className="bg-black/60 px-1.5 py-0.5 rounded border border-white/10">
            {clock}
          </span>
        </div>
      </div>

      {/* Tile Controls (Hover Overlay) */}
      <div className="absolute bottom-2 right-2 flex items-center space-x-1 opacity-0 group-hover:opacity-100 transition-opacity bg-black/70 p-1 rounded border border-white/10">
        {camera.hasPtz && (
          <button
            onClick={() => setShowPtz(!showPtz)}
            className={`px-2 py-0.5 rounded text-[11px] font-mono transition ${
              showPtz ? 'bg-cctv-teal text-graphite-900 font-bold' : 'text-slate-300 hover:text-white'
            }`}
          >
            PTZ
          </button>
        )}

        {onToggleFullscreen && (
          <button
            onClick={onToggleFullscreen}
            className="p-1 rounded text-slate-300 hover:text-white transition"
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
    </div>
  );
};

export default CameraTile;
