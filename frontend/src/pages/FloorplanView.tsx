import React, { useState, useEffect } from 'react';
import {
  Layers,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Plus,
  Camera as CameraIcon,
  X,
  Compass,
} from 'lucide-react';
import api from '../services/api';
import Button from '../components/ui/Button';
import Modal from '../components/ui/Modal';
import Input, { Select } from '../components/ui/Input';

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
  const [placementError, setPlacementError] = useState<string | null>(null);

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
      setPlacementError(null);
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
      setPlacementError(err.response?.data?.error || err.message || 'Failed to place camera');
    }
  };

  return (
    <div className="flex h-[calc(100vh-3rem)] bg-vms-bg text-vms-text overflow-hidden select-none font-sans">
      {/* Left Sidebar: Floor Level & Camera List */}
      <div className="w-72 border-r border-vms-border bg-vms-panel flex flex-col justify-between p-3 space-y-4 shrink-0">
        <div className="space-y-4">
          <div className="flex items-center justify-between border-b border-vms-border pb-2.5">
            <div className="flex items-center space-x-2">
              <Layers className="w-4 h-4 text-sky-400" />
              <h2 className="text-xs font-semibold uppercase tracking-wider text-vms-text font-mono">
                Facility Blueprints
              </h2>
            </div>
            <Button
              variant="secondary"
              size="xs"
              icon={Plus}
              onClick={() => setShowPlacementModal(true)}
              title="Add Camera Placement"
            >
              Place
            </Button>
          </div>

          {/* Floor Level Buttons */}
          <div className="space-y-1">
            <span className="text-[10px] uppercase font-mono tracking-wider text-vms-dim block px-1">
              Floor Levels
            </span>
            {floorplans.map((fp) => (
              <button
                key={fp.id}
                onClick={() => setActiveFloorplanId(fp.id)}
                className={`w-full text-left px-3 py-2 text-xs transition-colors flex items-center justify-between border rounded ${
                  activeFloorplanId === fp.id
                    ? 'bg-amber-500/10 text-amber-400 border-amber-500/40 font-semibold'
                    : 'bg-vms-surface text-vms-muted hover:bg-vms-hover hover:text-vms-text border-vms-border'
                }`}
              >
                <span className="truncate tracking-wide">{fp.name}</span>
                <span className="text-[10px] font-mono text-vms-dim">Level {fp.floorLevel}</span>
              </button>
            ))}

            {floorplans.length === 0 && (
              <div className="p-3 bg-vms-surface border border-dashed border-vms-border rounded text-center text-xs text-vms-dim">
                No floorplans configured. Default schematic active.
              </div>
            )}
          </div>

          {/* Camera list on this floor */}
          <div className="space-y-1.5 pt-2 border-t border-vms-border">
            <h3 className="text-[10px] uppercase font-mono tracking-wider text-vms-dim flex items-center justify-between px-1">
              <span className="flex items-center space-x-1.5">
                <CameraIcon className="w-3 h-3 text-vms-dim" />
                <span>Active Sensors</span>
              </span>
              <span>{currentFloorplan?.cameraPlacements?.length || 0}</span>
            </h3>

            <div className="max-h-64 overflow-y-auto space-y-1 text-xs">
              {currentFloorplan?.cameraPlacements?.map((cp) => (
                <div
                  key={cp.id}
                  onClick={() => setSelectedPlacement(cp)}
                  className={`p-2 cursor-pointer transition-colors flex items-center justify-between border rounded ${
                    selectedPlacement?.id === cp.id
                      ? 'bg-amber-500/15 text-white border-amber-500'
                      : 'bg-vms-surface text-vms-muted hover:bg-vms-hover hover:text-vms-text border-vms-border'
                  }`}
                >
                  <div className="flex items-center space-x-2 truncate">
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        cp.isOnline ? 'bg-emerald-400' : 'bg-slate-600'
                      }`}
                    />
                    <span className="truncate font-medium">{cp.cameraName || cp.cameraId}</span>
                  </div>
                  <span className="text-[10px] font-mono text-amber-400">{cp.headingDegrees}°</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Legend */}
        <div className="p-2.5 bg-vms-surface border border-vms-border rounded space-y-1.5 text-[10px] text-vms-muted font-mono uppercase">
          <div className="flex items-center space-x-2">
            <div className="w-2.5 h-2.5 bg-sky-500/20 border border-sky-400 rounded-sm" />
            <span>Optical FOV Vision Cone</span>
          </div>
          <div className="flex items-center space-x-2">
            <div className="w-2.5 h-2.5 rounded-full bg-rose-500 animate-pulse" />
            <span>Active Alarm Epicenter</span>
          </div>
        </div>
      </div>

      {/* Main Floorplan Canvas */}
      <div className="flex-1 bg-vms-bg relative overflow-hidden flex items-center justify-center">
        {/* Canvas Zoom Toolbar */}
        <div className="absolute top-4 right-4 z-20 flex items-center space-x-1 bg-vms-panel border border-vms-border p-1 rounded shadow-lg">
          <button
            onClick={() => setZoomScale((z) => Math.min(2.5, z + 0.2))}
            className="p-1.5 text-vms-muted hover:text-vms-text hover:bg-vms-hover rounded transition-colors"
            title="Zoom In"
            aria-label="Zoom In"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            onClick={() => setZoomScale((z) => Math.max(0.5, z - 0.2))}
            className="p-1.5 text-vms-muted hover:text-vms-text hover:bg-vms-hover rounded transition-colors"
            title="Zoom Out"
            aria-label="Zoom Out"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <button
            onClick={() => setZoomScale(1.0)}
            className="p-1.5 text-vms-muted hover:text-vms-text hover:bg-vms-hover rounded transition-colors"
            title="Reset Zoom"
            aria-label="Reset Zoom"
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
            className="bg-vms-panel border border-vms-border rounded shadow-2xl"
          >
            {/* Grid Pattern */}
            <defs>
              <pattern id="fp-grid" width="40" height="40" patternUnits="userSpaceOnUse">
                <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#1E293B" strokeWidth="0.8" />
              </pattern>
            </defs>
            <rect width="1000" height="700" fill="url(#fp-grid)" />

            {/* Architectural Walls */}
            <g stroke="#334155" strokeWidth="2.5" fill="none">
              <rect x="100" y="80" width="800" height="540" rx="4" />
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
                  fill={isSelected ? 'rgba(245, 158, 11, 0.25)' : 'rgba(56, 189, 248, 0.15)'}
                  stroke={isSelected ? '#F59E0B' : '#38BDF8'}
                  strokeWidth={isSelected ? '1.5' : '1'}
                  className="transition-colors duration-200 cursor-pointer"
                  onClick={() => setSelectedPlacement(cp)}
                />
              );
            })}

            {/* Active Alarm Epicenter Halos */}
            {currentFloorplan?.activeAlarms?.map((alarm) => (
              <g key={`alarm-${alarm.eventId}`}>
                <circle
                  cx={alarm.position.x}
                  cy={alarm.position.y}
                  r={alarm.pulseRadiusPixels}
                  fill="none"
                  stroke={alarm.haloColor || '#EF4444'}
                  strokeWidth="2"
                  className="animate-ping origin-center opacity-75"
                />
                <circle
                  cx={alarm.position.x}
                  cy={alarm.position.y}
                  r="6"
                  fill={alarm.haloColor || '#EF4444'}
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
                    fill={isSelected ? '#F59E0B' : '#141C2B'}
                    stroke={isSelected ? '#ffffff' : '#38BDF8'}
                    strokeWidth="2"
                  />
                  <CameraIcon
                    x="-4"
                    y="-4"
                    width="8"
                    height="8"
                    className={isSelected ? 'text-slate-950' : 'text-sky-400'}
                  />
                </g>
              );
            })}
          </svg>
        </div>

        {/* Selected Camera Details Floating Drawer */}
        {selectedPlacement && (
          <div className="absolute bottom-4 right-4 z-30 w-80 bg-vms-elevated border border-vms-border rounded p-4 shadow-2xl space-y-3">
            <div className="flex items-center justify-between border-b border-vms-border pb-2">
              <div className="flex items-center space-x-2">
                <CameraIcon className="w-4 h-4 text-amber-400" />
                <span className="text-xs font-semibold text-white truncate">
                  {selectedPlacement.cameraName || selectedPlacement.cameraId}
                </span>
              </div>
              <button
                onClick={() => setSelectedPlacement(null)}
                className="text-vms-muted hover:text-vms-text p-1 rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <span className="text-vms-dim block text-[10px] font-mono uppercase">COORDINATES</span>
                <span className="text-vms-text font-mono font-medium">
                  {selectedPlacement.x.toFixed(0)}, {selectedPlacement.y.toFixed(0)} px
                </span>
              </div>
              <div>
                <span className="text-vms-dim block text-[10px] font-mono uppercase">MOUNT HEIGHT</span>
                <span className="text-vms-text font-mono font-medium">{selectedPlacement.mountHeightMeters}m</span>
              </div>
              <div>
                <span className="text-vms-dim block text-[10px] font-mono uppercase">HEADING</span>
                <span className="text-amber-400 font-mono font-medium">
                  {selectedPlacement.headingDegrees}° Compass
                </span>
              </div>
              <div>
                <span className="text-vms-dim block text-[10px] font-mono uppercase">FOV / ZOOM</span>
                <span className="text-vms-text font-mono font-medium">
                  {selectedPlacement.fovHorizontalDegrees}° ({selectedPlacement.zoom}x)
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Place Camera Modal */}
      <Modal
        isOpen={showPlacementModal}
        onClose={() => setShowPlacementModal(false)}
        title="Place Camera on Blueprint"
        icon={<Compass className="w-4 h-4" />}
      >
        <form onSubmit={handleSavePlacement} className="space-y-4">
          {placementError && (
            <div className="p-2.5 bg-rose-950/40 border border-rose-800/80 rounded text-rose-300 text-xs font-mono">
              {placementError}
            </div>
          )}
          <Select
            label="SELECT CAMERA SENSOR"
            value={formCameraId}
            onChange={(e) => setFormCameraId(e.target.value)}
            required
          >
            <option value="">-- Choose Camera --</option>
            {availableCameras.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.streamPath})
              </option>
            ))}
          </Select>

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="CANVAS X (PX)"
              type="number"
              value={formX}
              onChange={(e) => setFormX(Number(e.target.value))}
            />
            <Input
              label="CANVAS Y (PX)"
              type="number"
              value={formY}
              onChange={(e) => setFormY(Number(e.target.value))}
            />
          </div>

          <div>
            <label className="text-[11px] font-mono text-vms-muted uppercase tracking-wider block mb-1">
              HEADING VECTOR ({formHeading}°)
            </label>
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
              <label className="text-[10px] font-mono text-vms-muted uppercase block mb-1">
                PITCH ({formPitch}°)
              </label>
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
              <label className="text-[10px] font-mono text-vms-muted uppercase block mb-1">
                FOV ({formFov}°)
              </label>
              <input
                type="range"
                min="30"
                max="120"
                value={formFov}
                onChange={(e) => setFormFov(Number(e.target.value))}
                className="w-full accent-sky-400"
              />
            </div>
            <div>
              <label className="text-[10px] font-mono text-vms-muted uppercase block mb-1">
                ZOOM ({formZoom}X)
              </label>
              <input
                type="range"
                min="1"
                max="5"
                step="0.5"
                value={formZoom}
                onChange={(e) => setFormZoom(Number(e.target.value))}
                className="w-full accent-emerald-400"
              />
            </div>
          </div>

          <div className="flex justify-end space-x-2 pt-3 border-t border-vms-border">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowPlacementModal(false)}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm">
              Save Placement
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
};

export default FloorplanView;
