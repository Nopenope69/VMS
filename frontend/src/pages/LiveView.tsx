import React, { useState, useEffect } from 'react';
import { LayoutGrid, Grid3X3, Grid2X2, Square, Plus, RefreshCw } from 'lucide-react';
import CameraTile, { CameraData } from '../components/CameraTile';
import api from '../services/api';

export const LiveView: React.FC<{ onNavigateToDevices: () => void }> = ({ onNavigateToDevices }) => {
  const [cameras, setCameras] = useState<CameraData[]>([]);
  const [layout, setLayout] = useState<'1x1' | '2x2' | '3x3' | '1+5'>('2x2');
  const [loading, setLoading] = useState(true);

  const fetchCameras = async () => {
    setLoading(true);
    try {
      const res = await api.get('/cameras');
      setCameras(res.data.cameras || []);
    } catch (err) {
      console.error('Failed to load cameras:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCameras();
  }, []);

  const getGridClass = () => {
    switch (layout) {
      case '1x1':
        return 'grid-cols-1';
      case '2x2':
        return 'grid-cols-1 md:grid-cols-2';
      case '3x3':
        return 'grid-cols-2 md:grid-cols-3';
      case '1+5':
        return 'grid-cols-1 md:grid-cols-3';
      default:
        return 'grid-cols-2';
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] bg-graphite-900 overflow-hidden">
      {/* Top Toolbar */}
      <div className="h-11 bg-graphite-850 border-b border-graphite-700 px-4 flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <span className="text-xs font-mono font-medium text-slate-300">Layout Presets:</span>
          <div className="flex space-x-1 bg-graphite-900 p-0.5 rounded border border-graphite-700">
            <button
              onClick={() => setLayout('1x1')}
              title="1x1 Single View"
              className={`p-1 rounded text-xs transition ${
                layout === '1x1' ? 'bg-cctv-amber text-graphite-900 font-bold' : 'text-slate-400 hover:text-white'
              }`}
            >
              <Square className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setLayout('2x2')}
              title="2x2 Quad View"
              className={`p-1 rounded text-xs transition ${
                layout === '2x2' ? 'bg-cctv-amber text-graphite-900 font-bold' : 'text-slate-400 hover:text-white'
              }`}
            >
              <Grid2X2 className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setLayout('3x3')}
              title="3x3 9-Way View"
              className={`p-1 rounded text-xs transition ${
                layout === '3x3' ? 'bg-cctv-amber text-graphite-900 font-bold' : 'text-slate-400 hover:text-white'
              }`}
            >
              <Grid3X3 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={fetchCameras}
            className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-graphite-700 transition"
            title="Refresh Camera Feeds"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={onNavigateToDevices}
            className="flex items-center space-x-1 px-2.5 py-1 rounded text-xs font-medium bg-cctv-teal/20 text-cctv-teal border border-cctv-teal/40 hover:bg-cctv-teal/30 transition"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Camera</span>
          </button>
        </div>
      </div>

      {/* Camera Grid Canvas */}
      <div className="flex-1 p-3 overflow-y-auto">
        {cameras.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-8 border border-dashed border-graphite-700 rounded bg-graphite-850/50">
            <LayoutGrid className="w-12 h-12 text-slate-500 mb-3" />
            <h3 className="text-sm font-semibold text-slate-200">No CCTV Cameras Configured</h3>
            <p className="text-xs text-slate-400 max-w-sm mt-1 mb-4">
              Onboard your first camera via ONVIF WS-Discovery or manual RTSP IP entry to start monitoring.
            </p>
            <button
              onClick={onNavigateToDevices}
              className="flex items-center space-x-1.5 px-3 py-1.5 rounded text-xs font-semibold bg-cctv-amber text-graphite-900 hover:bg-amber-400 transition"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Discover Cameras on LAN</span>
            </button>
          </div>
        ) : (
          <div className={`grid ${getGridClass()} gap-2.5 h-full`}>
            {cameras.map((camera) => (
              <CameraTile key={camera.id} camera={camera} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default LiveView;
