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
    <div className="flex h-[calc(100vh-3.5rem)] bg-[#080B10] text-slate-100 overflow-hidden font-mono select-none">
      {/* Left Sidebar: Floor Level & Camera List */}
      <div className="w-72 border-r border-[#21262D] bg-[#0D1117] flex flex-col justify-between p-3 space-y-4">
        <div className="space-y-4">
          <div className="flex items-center justify-between border-b border-[#21262D] pb-2">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-[#58A6FF]" />
              <h2 className="text-xs font-bold uppercase tracking-wider text-white">
                [ 01 // BLUEPRINTS ]
              </h2>
            </div>
            <button
              onClick={() => setShowPlacementModal(true)}
              className="flex items-center gap-1 px-2 py-0.5 bg-[#161B22] hover:bg-[#E3B341] hover:text-[#080B10] text-slate-300 border border-[#21262D] text-[10px] uppercase font-bold transition rounded-none"
              title="Add Sensor Placement"
            >
              <Plus className="w-3 h-3" />
              <span>PLACE</span>
            </button>
          </div>

          {/* Floor Level Buttons */}
          <div className="space-y-1">
            {floorplans.map((fp) => (
              <button
                key={fp.id}
                onClick={() => setActiveFloorplanId(fp.id)}
                className={`w-full text-left px-3 py-2 text-xs transition flex items-center justify-between border rounded-none ${
                  activeFloorplanId === fp.id
                    ? 'bg-[#E3B341]/10 text-[#E3B341] border-[#E3B341]/60 font-bold'
                    : 'bg-[#161B22] text-slate-400 hover:bg-[#21262D] hover:text-white border-[#21262D]'
                }`}
              >
                <span className="truncate tracking-wide">{fp.name}</span>
                <span className="text-[10px] text-slate-500 font-bold">LVL_{String(fp.floorLevel).padStart(2, '0')}</span>
              </button>
            ))}

            {floorplans.length === 0 && (
              <div className="p-3 bg-[#161B22] border border-dashed border-[#21262D] text-center text-[10px] text-slate-500 uppercase tracking-wider">
                [ NO BLUEPRINT MAPPED // DEFAULT SCHEMATIC ACTIVE ]
              </div>
            )}
          </div>

          {/* Camera list on this floor */}
          <div className="space-y-1.5 pt-2 border-t border-[#21262D]">
            <h3 className="text-[10px] uppercase tracking-widest text-slate-500 flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <CameraIcon className="w-3.5 h-3.5 text-slate-500" />
                <span>ACTIVE_SENSORS</span>
              </span>
              <span className="text-slate-400">({currentFloorplan?.cameraPlacements?.length || 0})</span>
            </h3>

            <div className="max-h-64 overflow-y-auto space-y-1 text-xs">
              {currentFloorplan?.cameraPlacements?.map((cp) => (
                <div
                  key={cp.id}
                  onClick={() => setSelectedPlacement(cp)}
                  className={`p-2 cursor-pointer transition flex items-center justify-between border rounded-none ${
                    selectedPlacement?.id === cp.id
                      ? 'bg-[#E3B341]/15 text-white border-[#E3B341]'
                      : 'bg-[#161B22] text-slate-400 hover:bg-[#21262D] hover:text-slate-200 border-[#21262D]'
                  }`}
                >
                  <div className="flex items-center gap-2 truncate">
                    <span
                      className={`w-1.5 h-1.5 ${
                        cp.isOnline ? 'bg-[#3FB950]' : 'bg-slate-600'
                      }`}
                    />
                    <span className="truncate font-semibold tracking-wide">{cp.cameraName || cp.cameraId}</span>
                  </div>
                  <span className="text-[10px] text-[#E3B341]">{cp.headingDegrees}°</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Legend */}
        <div className="p-2.5 bg-[#161B22] border border-[#21262D] space-y-1.5 text-[10px] text-slate-400 uppercase">
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 bg-[#58A6FF]/20 border border-[#58A6FF]" />
            <span>OPTICAL FOV VISION CONE</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 bg-[#F85149] animate-pulse" />
            <span>ACTIVE ALARM EPICENTER</span>
          </div>
        </div>
      </div>

      {/* Main Floorplan Canvas */}
      <div className="flex-1 bg-[#080B10] relative overflow-hidden flex items-center justify-center tactical-grid">
        {/* Canvas Toolbar */}
        <div className="absolute top-4 right-4 z-20 flex items-center gap-1 bg-[#0D1117] border border-[#21262D] p-1 shadow-lg">
          <button
            onClick={() => setZoomScale((z) => Math.min(2.5, z + 0.2))}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-[#161B22] transition rounded-none"
            title="Zoom In"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            onClick={() => setZoomScale((z) => Math.max(0.5, z - 0.2))}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-[#161B22] transition rounded-none"
            title="Zoom Out"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <button
            onClick={() => setZoomScale(1.0)}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-[#161B22] transition rounded-none"
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
            className="bg-[#0D1117] border border-[#21262D] shadow-2xl"
          >
            {/* Architectural Grid Background */}
            <defs>
              <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
                <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#21262D" strokeWidth="0.8" />
              </pattern>
            </defs>
            <rect width="1000" height="700" fill="url(#grid)" />

            {/* Simulated Architectural Floor Walls */}
            <g stroke="#30363D" strokeWidth="2.5" fill="none">
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
                  fill={isSelected ? 'rgba(227, 179, 65, 0.25)' : 'rgba(88, 166, 255, 0.15)'}
                  stroke={isSelected ? '#E3B341' : '#58A6FF'}
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
                  stroke={alarm.haloColor || '#F85149'}
                  strokeWidth="2"
                  className="animate-ping origin-center opacity-75"
                />
                <circle
                  cx={alarm.position.x}
                  cy={alarm.position.y}
                  r="6"
                  fill={alarm.haloColor || '#F85149'}
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
                    fill={isSelected ? '#E3B341' : '#161B22'}
                    stroke={isSelected ? '#ffffff' : '#58A6FF'}
                    strokeWidth="2"
                  />
                  <CameraIcon
                    x="-5"
                    y="-5"
                    width="10"
                    height="10"
                    className={isSelected ? 'text-[#080B10]' : 'text-[#58A6FF]'}
                  />
                </g>
              );
            })}
          </svg>
        </div>

        {/* Selected Camera Details Floating Drawer */}
        {selectedPlacement && (
          <div className="absolute bottom-4 right-4 z-30 w-80 bg-[#0D1117] border border-[#21262D] p-4 shadow-2xl space-y-3 relative">
            <span className="absolute -top-1 -left-1 text-[8px] text-[#30363D]">+</span>
            <span className="absolute -top-1 -right-1 text-[8px] text-[#30363D]">+</span>
            <span className="absolute -bottom-1 -left-1 text-[8px] text-[#30363D]">+</span>
            <span className="absolute -bottom-1 -right-1 text-[8px] text-[#30363D]">+</span>

            <div className="flex items-center justify-between border-b border-[#21262D] pb-2">
              <div className="flex items-center gap-2">
                <CameraIcon className="w-4 h-4 text-[#E3B341]" />
                <span className="text-xs font-bold text-white uppercase tracking-wider">
                  {selectedPlacement.cameraName || selectedPlacement.cameraId}
                </span>
              </div>
              <button
                onClick={() => setSelectedPlacement(null)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-400">
              <div>
                <span className="text-slate-500 block uppercase text-[10px]">COORDINATES (X, Y):</span>
                <span className="text-white font-mono font-bold">
                  {selectedPlacement.x.toFixed(0)}, {selectedPlacement.y.toFixed(0)} PX
                </span>
              </div>
              <div>
                <span className="text-slate-500 block uppercase text-[10px]">MOUNT HEIGHT:</span>
                <span className="text-white font-mono font-bold">{selectedPlacement.mountHeightMeters}M</span>
              </div>
              <div>
                <span className="text-slate-500 block uppercase text-[10px]">HEADING VECTOR:</span>
                <span className="text-[#E3B341] font-bold font-mono">
                  {selectedPlacement.headingDegrees}° COMPASS
                </span>
              </div>
              <div>
                <span className="text-slate-500 block uppercase text-[10px]">HORIZONTAL FOV:</span>
                <span className="text-white font-mono font-bold">
                  {selectedPlacement.fovHorizontalDegrees}° ({selectedPlacement.zoom}X)
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Place Camera Modal */}
      {showPlacementModal && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 select-none">
          <div className="bg-[#0D1117] border border-[#21262D] rounded-none max-w-md w-full p-6 shadow-2xl space-y-4 relative">
            <span className="absolute -top-1 -left-1 text-[9px] text-[#30363D]">+</span>
            <span className="absolute -top-1 -right-1 text-[9px] text-[#30363D]">+</span>
            <span className="absolute -bottom-1 -left-1 text-[9px] text-[#30363D]">+</span>
            <span className="absolute -bottom-1 -right-1 text-[9px] text-[#30363D]">+</span>

            <div className="flex items-center justify-between border-b border-[#21262D] pb-3">
              <h3 className="text-xs font-bold text-white uppercase tracking-wider">
                [ PLACE CAMERA ON BLUEPRINT ]
              </h3>
              <button
                onClick={() => setShowPlacementModal(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSavePlacement} className="space-y-4 text-xs">
              <div>
                <label className="text-slate-400 block mb-1 uppercase tracking-wider">SELECT CAMERA</label>
                <select
                  value={formCameraId}
                  onChange={(e) => setFormCameraId(e.target.value)}
                  className="w-full bg-[#080B10] border border-[#21262D] rounded-none p-2 text-slate-200 focus:outline-none focus:border-[#E3B341] uppercase"
                  required
                >
                  <option value="">-- CHOOSE SENSOR --</option>
                  {availableCameras.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.streamPath})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-slate-400 block mb-1 uppercase tracking-wider">CANVAS X (PX)</label>
                  <input
                    type="number"
                    value={formX}
                    onChange={(e) => setFormX(Number(e.target.value))}
                    className="w-full bg-[#080B10] border border-[#21262D] rounded-none p-2 text-slate-200"
                  />
                </div>
                <div>
                  <label className="text-slate-400 block mb-1 uppercase tracking-wider">CANVAS Y (PX)</label>
                  <input
                    type="number"
                    value={formY}
                    onChange={(e) => setFormY(Number(e.target.value))}
                    className="w-full bg-[#080B10] border border-[#21262D] rounded-none p-2 text-slate-200"
                  />
                </div>
              </div>

              <div>
                <div className="flex justify-between text-slate-400 mb-1 uppercase tracking-wider">
                  <span>HEADING VECTOR ({formHeading}°)</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="360"
                  value={formHeading}
                  onChange={(e) => setFormHeading(Number(e.target.value))}
                  className="w-full accent-[#E3B341]"
                />
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-slate-400 block mb-1 uppercase tracking-wider">PITCH ({formPitch}°)</label>
                  <input
                    type="range"
                    min="10"
                    max="80"
                    value={formPitch}
                    onChange={(e) => setFormPitch(Number(e.target.value))}
                    className="w-full accent-[#E3B341]"
                  />
                </div>
                <div>
                  <label className="text-slate-400 block mb-1 uppercase tracking-wider">FOV ({formFov}°)</label>
                  <input
                    type="range"
                    min="30"
                    max="120"
                    value={formFov}
                    onChange={(e) => setFormFov(Number(e.target.value))}
                    className="w-full accent-[#58A6FF]"
                  />
                </div>
                <div>
                  <label className="text-slate-400 block mb-1 uppercase tracking-wider">ZOOM ({formZoom}X)</label>
                  <input
                    type="range"
                    min="1"
                    max="5"
                    step="0.5"
                    value={formZoom}
                    onChange={(e) => setFormZoom(Number(e.target.value))}
                    className="w-full accent-[#3FB950]"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-[#21262D]">
                <button
                  type="button"
                  onClick={() => setShowPlacementModal(false)}
                  className="px-3 py-1.5 bg-[#161B22] hover:bg-[#21262D] border border-[#21262D] text-slate-300 rounded-none uppercase"
                >
                  CANCEL
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-[#E3B341] hover:bg-amber-400 text-[#080B10] font-bold uppercase rounded-none shadow"
                >
                  RECORD PLACEMENT
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
