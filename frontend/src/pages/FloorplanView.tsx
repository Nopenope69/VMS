import React, { useState, useEffect } from 'react';
import {
  Layers,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Plus,
  Camera as CameraIcon,
  X,
} from 'lucide-react';
import api from '../services/api';

interface CameraPlacement {
  id: string;
  cameraId: string;
  cameraName?: string;
  isOnline?: boolean;
  x: number;
  y: number;
  mountHeightMeters: number;
  headingDegrees: number;
  pitchDegrees: number;
  fovHorizontalDegrees: number;
  zoom: number;
  fovGeometry?: {
    svgPolygonPath: string;
    rangePixels: number;
    effectiveFovDegrees: number;
  };
}

interface SpatialAlarm {
  eventId: string;
  cameraId: string;
  type: string;
  severity: string;
  position: { x: number; y: number };
  pulseRadiusPixels: number;
  haloColor: string;
}

interface FloorplanItem {
  id: string;
  name: string;
  floorLevel: number;
  imageObjectKey: string;
  scalePixelsPerMeter: number;
  rotationDegrees: number;
  cameraPlacements?: CameraPlacement[];
  activeAlarms?: SpatialAlarm[];
}

export const FloorplanView: React.FC = () => {
  const [floorplans, setFloorplans] = useState<FloorplanItem[]>([]);
  const [activeFloorplanId, setActiveFloorplanId] = useState<string | null>(null);
  const [currentFloorplan, setCurrentFloorplan] = useState<FloorplanItem | null>(null);
  const [zoomScale, setZoomScale] = useState<number>(1.0);
  const [selectedPlacement, setSelectedPlacement] = useState<CameraPlacement | null>(null);
  const [showPlacementModal, setShowPlacementModal] = useState(false);
  const [availableCameras, setAvailableCameras] = useState<any[]>([]);

  // Camera Placement Form
  const [formCameraId, setFormCameraId] = useState('');
  const [formX, setFormX] = useState(400);
  const [formY, setFormY] = useState(300);
  const [formHeading, setFormHeading] = useState(90);
  const [formPitch, setFormPitch] = useState(30);
  const [formFov, setFormFov] = useState(85);
  const [formZoom, setFormZoom] = useState(1.0);

  // Load list of floorplans
  useEffect(() => {
    loadFloorplans();
    api.get('/cameras').then((res) => setAvailableCameras(res.data.cameras || []));
  }, []);

  const loadFloorplans = async () => {
    try {
      const res = await api.get('/floorplans');
      const list: FloorplanItem[] = res.data || [];
      setFloorplans(list);
      if (list.length > 0) {
        setActiveFloorplanId(list[0].id);
      }
    } catch (err) {
      console.error('Failed to load floorplans:', err);
    }
  };

  // Load detailed floorplan with placements and active alarms
  useEffect(() => {
    if (!activeFloorplanId) return;

    const fetchDetail = () => {
      api
        .get(`/floorplans/${activeFloorplanId}`)
        .then((res) => setCurrentFloorplan(res.data))
        .catch(() => {});
    };

    fetchDetail();
    const interval = setInterval(fetchDetail, 5000);
    return () => clearInterval(interval);
  }, [activeFloorplanId]);

  const handleSavePlacement = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeFloorplanId || !formCameraId) return;

    try {
      await api.post(`/floorplans/${activeFloorplanId}/cameras`, {
        cameraId: formCameraId,
        x: formX,
        y: formY,
        headingDegrees: formHeading,
        pitchDegrees: formPitch,
        fovHorizontalDegrees: formFov,
        zoom: formZoom,
      });
      setShowPlacementModal(false);
      // Reload floorplan
      const res = await api.get(`/floorplans/${activeFloorplanId}`);
      setCurrentFloorplan(res.data);
    } catch (err: any) {
      alert(err.response?.data?.error || err.message || 'Failed to place camera');
    }
  };

  return (
    <div className="flex h-[calc(100vh-3.5rem)] bg-graphite-900 text-slate-100 overflow-hidden font-sans select-none">
      {/* Left Sidebar: Floor Level & Camera List */}
      <div className="w-64 border-r border-slate-800 bg-graphite-900 flex flex-col justify-between p-3 space-y-4">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-cyan-400" />
              <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-200">
                Floor Plans
              </h2>
            </div>
            <button
              onClick={() => setShowPlacementModal(true)}
              className="p-1 text-slate-400 hover:text-amber-400 rounded hover:bg-slate-800 transition"
              title="Add Camera Placement"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>

          {/* Floor Level Buttons */}
          <div className="space-y-1">
            {floorplans.map((fp) => (
              <button
                key={fp.id}
                onClick={() => setActiveFloorplanId(fp.id)}
                className={`w-full text-left px-3 py-2 rounded text-xs font-mono transition flex items-center justify-between ${
                  activeFloorplanId === fp.id
                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                    : 'bg-slate-800/60 text-slate-400 hover:bg-slate-800 hover:text-slate-200 border border-slate-700/60'
                }`}
              >
                <span className="truncate">{fp.name}</span>
                <span className="text-[10px] text-slate-500">L{fp.floorLevel}</span>
              </button>
            ))}

            {floorplans.length === 0 && (
              <div className="p-3 bg-slate-800/40 border border-dashed border-slate-700 rounded text-center text-[11px] text-slate-500">
                No floorplans configured. Default architectural layout active.
              </div>
            )}
          </div>

          {/* Camera list on this floor */}
          <div className="space-y-1.5 pt-2 border-t border-slate-800">
            <h3 className="text-[11px] font-mono uppercase text-slate-400 flex items-center gap-1.5">
              <CameraIcon className="w-3.5 h-3.5 text-slate-500" />
              <span>Cameras on Map ({currentFloorplan?.cameraPlacements?.length || 0})</span>
            </h3>

            <div className="max-h-64 overflow-y-auto space-y-1 text-xs font-mono">
              {currentFloorplan?.cameraPlacements?.map((cp) => (
                <div
                  key={cp.id}
                  onClick={() => setSelectedPlacement(cp)}
                  className={`p-2 rounded cursor-pointer transition flex items-center justify-between ${
                    selectedPlacement?.id === cp.id
                      ? 'bg-slate-700 text-slate-100 border border-slate-600'
                      : 'bg-slate-800/40 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                  }`}
                >
                  <div className="flex items-center gap-2 truncate">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        cp.isOnline ? 'bg-emerald-400' : 'bg-slate-500'
                      }`}
                    />
                    <span className="truncate">{cp.cameraName || cp.cameraId}</span>
                  </div>
                  <span className="text-[10px] text-amber-400">{cp.headingDegrees}°</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Legend */}
        <div className="p-3 bg-graphite-800 border border-slate-800 rounded space-y-2 text-[10px] font-mono text-slate-400">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-cyan-400/30 border border-cyan-400" />
            <span>FOV Vision Field</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-rose-500 animate-ping opacity-75" />
            <span>Active Alarm Epicenter</span>
          </div>
        </div>
      </div>

      {/* Main Floorplan Canvas */}
      <div className="flex-1 bg-black relative overflow-hidden flex items-center justify-center">
        {/* Canvas Toolbar */}
        <div className="absolute top-4 right-4 z-20 flex items-center gap-1 bg-graphite-900/90 border border-slate-700 rounded p-1 shadow">
          <button
            onClick={() => setZoomScale((z) => Math.min(2.5, z + 0.2))}
            className="p-1.5 text-slate-300 hover:text-slate-100 hover:bg-slate-800 rounded transition"
            title="Zoom In"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            onClick={() => setZoomScale((z) => Math.max(0.5, z - 0.2))}
            className="p-1.5 text-slate-300 hover:text-slate-100 hover:bg-slate-800 rounded transition"
            title="Zoom Out"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <button
            onClick={() => setZoomScale(1.0)}
            className="p-1.5 text-slate-300 hover:text-slate-100 hover:bg-slate-800 rounded transition"
            title="Reset Zoom"
          >
            <Maximize2 className="w-4 h-4" />
          </button>
        </div>

        {/* Interactive SVG Floorplan Stage */}
        <div
          className="transition-transform duration-150 ease-out origin-center"
          style={{ transform: `scale(${zoomScale})` }}
        >
          <svg
            width="1000"
            height="700"
            className="bg-graphite-900/90 border border-slate-800 rounded shadow-2xl"
          >
            {/* Architectural Grid Background */}
            <defs>
              <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
                <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#1e293b" strokeWidth="0.8" />
              </pattern>
            </defs>
            <rect width="1000" height="700" fill="url(#grid)" />

            {/* Simulated Architectural Floor Walls */}
            <g stroke="#334155" strokeWidth="2.5" fill="none">
              <rect x="100" y="80" width="800" height="540" />
              <line x1="380" y1="80" x2="380" y2="400" />
              <line x1="620" y1="80" x2="620" y2="620" />
              <line x1="100" y1="400" x2="380" y2="400" />
            </g>

            {/* Camera FOV Vision Cones */}
            {currentFloorplan?.cameraPlacements?.map((cp) => {
              const path = cp.fovGeometry?.svgPolygonPath;
              if (!path) return null;
              const isSelected = selectedPlacement?.id === cp.id;

              return (
                <path
                  key={`fov-${cp.id}`}
                  d={path}
                  fill={isSelected ? 'rgba(245, 158, 11, 0.25)' : 'rgba(6, 182, 212, 0.15)'}
                  stroke={isSelected ? '#F59E0B' : '#06B6D4'}
                  strokeWidth={isSelected ? '1.5' : '1'}
                  className="transition-colors duration-200 cursor-pointer"
                  onClick={() => setSelectedPlacement(cp)}
                />
              );
            })}

            {/* Active Alarm Pulsing Halos */}
            {currentFloorplan?.activeAlarms?.map((alarm) => (
              <g key={`alarm-${alarm.eventId}`}>
                <circle
                  cx={alarm.position.x}
                  cy={alarm.position.y}
                  r={alarm.pulseRadiusPixels}
                  fill="none"
                  stroke={alarm.haloColor}
                  strokeWidth="2"
                  className="animate-ping origin-center opacity-75"
                />
                <circle
                  cx={alarm.position.x}
                  cy={alarm.position.y}
                  r="6"
                  fill={alarm.haloColor}
                  stroke="#ffffff"
                  strokeWidth="1.5"
                />
              </g>
            ))}

            {/* Camera Markers */}
            {currentFloorplan?.cameraPlacements?.map((cp) => {
              const isSelected = selectedPlacement?.id === cp.id;
              return (
                <g
                  key={`marker-${cp.id}`}
                  transform={`translate(${cp.x}, ${cp.y})`}
                  className="cursor-pointer"
                  onClick={() => setSelectedPlacement(cp)}
                >
                  <circle
                    r={isSelected ? 10 : 8}
                    fill={isSelected ? '#F59E0B' : '#1e293b'}
                    stroke={isSelected ? '#ffffff' : '#06B6D4'}
                    strokeWidth="2"
                  />
                  <CameraIcon
                    x="-5"
                    y="-5"
                    width="10"
                    height="10"
                    className={isSelected ? 'text-graphite-900' : 'text-cyan-400'}
                  />
                </g>
              );
            })}
          </svg>
        </div>

        {/* Selected Camera Details Floating Drawer */}
        {selectedPlacement && (
          <div className="absolute bottom-4 right-4 z-30 w-80 bg-graphite-800 border border-slate-700 rounded-lg p-4 shadow-2xl space-y-3">
            <div className="flex items-center justify-between border-b border-slate-700 pb-2">
              <div className="flex items-center gap-2">
                <CameraIcon className="w-4 h-4 text-amber-400" />
                <span className="font-mono text-xs font-semibold text-slate-100">
                  {selectedPlacement.cameraName || selectedPlacement.cameraId}
                </span>
              </div>
              <button
                onClick={() => setSelectedPlacement(null)}
                className="text-slate-400 hover:text-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2 text-[11px] font-mono text-slate-400">
              <div>
                <span className="text-slate-500 block">Position (X, Y):</span>
                <span className="text-slate-200">
                  {selectedPlacement.x.toFixed(0)}, {selectedPlacement.y.toFixed(0)} px
                </span>
              </div>
              <div>
                <span className="text-slate-500 block">Mount Height:</span>
                <span className="text-slate-200">{selectedPlacement.mountHeightMeters}m</span>
              </div>
              <div>
                <span className="text-slate-500 block">Heading:</span>
                <span className="text-amber-400 font-bold">
                  {selectedPlacement.headingDegrees}° Navigational
                </span>
              </div>
              <div>
                <span className="text-slate-500 block">Horizontal FOV:</span>
                <span className="text-slate-200">
                  {selectedPlacement.fovHorizontalDegrees}° (Zoom: {selectedPlacement.zoom}x)
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Place Camera Modal */}
      {showPlacementModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-graphite-800 border border-slate-700 rounded-lg max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-700 pb-3">
              <h3 className="text-sm font-semibold text-slate-100 uppercase tracking-wide">
                Place Camera on Floorplan
              </h3>
              <button
                onClick={() => setShowPlacementModal(false)}
                className="text-slate-400 hover:text-slate-200"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSavePlacement} className="space-y-4 text-xs font-mono">
              <div>
                <label className="text-slate-400 block mb-1">Select Camera</label>
                <select
                  value={formCameraId}
                  onChange={(e) => setFormCameraId(e.target.value)}
                  className="w-full bg-graphite-900 border border-slate-700 rounded p-2 text-slate-200 focus:outline-none focus:border-amber-400"
                  required
                >
                  <option value="">-- Choose Camera --</option>
                  {availableCameras.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.streamPath})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-slate-400 block mb-1">Canvas X (px)</label>
                  <input
                    type="number"
                    value={formX}
                    onChange={(e) => setFormX(Number(e.target.value))}
                    className="w-full bg-graphite-900 border border-slate-700 rounded p-2 text-slate-200"
                  />
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">Canvas Y (px)</label>
                  <input
                    type="number"
                    value={formY}
                    onChange={(e) => setFormY(Number(e.target.value))}
                    className="w-full bg-graphite-900 border border-slate-700 rounded p-2 text-slate-200"
                  />
                </div>
              </div>

              <div>
                <div className="flex justify-between text-slate-400 mb-1">
                  <span>Heading Angle ({formHeading}°)</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="360"
                  value={formHeading}
                  onChange={(e) => setFormHeading(Number(e.target.value))}
                  className="w-full accent-amber-500"
                />
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-slate-400 block mb-1">Pitch ({formPitch}°)</label>
                  <input
                    type="range"
                    min="10"
                    max="80"
                    value={formPitch}
                    onChange={(e) => setFormPitch(Number(e.target.value))}
                    className="w-full accent-amber-500"
                  />
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">FOV ({formFov}°)</label>
                  <input
                    type="range"
                    min="30"
                    max="120"
                    value={formFov}
                    onChange={(e) => setFormFov(Number(e.target.value))}
                    className="w-full accent-cyan-500"
                  />
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">Zoom ({formZoom}x)</label>
                  <input
                    type="range"
                    min="1"
                    max="5"
                    step="0.5"
                    value={formZoom}
                    onChange={(e) => setFormZoom(Number(e.target.value))}
                    className="w-full accent-emerald-500"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-700">
                <button
                  type="button"
                  onClick={() => setShowPlacementModal(false)}
                  className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-amber-500 hover:bg-amber-400 text-graphite-900 font-bold rounded"
                >
                  Save Placement
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default FloorplanView;
