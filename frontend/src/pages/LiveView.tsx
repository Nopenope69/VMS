import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  LayoutGrid,
  Plus,
  RefreshCw,
  Save,
  Play,
  Square as StopIcon,
  Trash2,
} from 'lucide-react';
import CameraTile, { CameraData } from '../components/CameraTile';
import AlarmBanner from '../components/AlarmBanner';
import SaveLayoutModal from '../components/SaveLayoutModal';
import api from '../services/api';

type GridType = '1x1' | '2x2' | '3x3' | '1+5' | '4x4';

interface SavedLayout {
  id: string;
  name: string;
  gridType: string;
  visibility: 'PRIVATE' | 'TENANT_SHARED';
  isDefault: boolean;
  slotsJson: Array<{ slotIndex: number; cameraId: string | null }>;
  userId: string;
}

interface LiveViewProps {
  onNavigateToDevices: () => void;
  onNavigateToAlarms?: () => void;
}

export const LiveView: React.FC<LiveViewProps> = ({ onNavigateToDevices, onNavigateToAlarms }) => {
  const [cameras, setCameras] = useState<CameraData[]>([]);
  const [savedLayouts, setSavedLayouts] = useState<SavedLayout[]>([]);
  const [selectedLayoutId, setSelectedLayoutId] = useState<string>('preset_2x2');
  const [gridType, setGridType] = useState<GridType>('2x2');
  const [cameraSlots, setCameraSlots] = useState<Array<{ slotIndex: number; cameraId: string | null }>>([]);
  const [loading, setLoading] = useState(true);
  const [showSaveModal, setShowSaveModal] = useState(false);

  // Layout Tour (Auto-Rotation) State
  const [isTourRunning, setIsTourRunning] = useState(false);
  const [tourInterval, setTourInterval] = useState<number>(15);
  const [tourCountdown, setTourCountdown] = useState<number>(15);
  const tourTimerRef = useRef<any>(null);

  // Map Prisma grid type to UI grid type
  const parseGridType = (type: string): GridType => {
    switch (type) {
      case 'GRID_1X1':
        return '1x1';
      case 'GRID_2X2':
        return '2x2';
      case 'GRID_3X3':
        return '3x3';
      case 'GRID_1_PLUS_5':
        return '1+5';
      case 'GRID_4X4':
        return '4x4';
      default:
        return '2x2';
    }
  };

  const getSlotCount = (type: GridType): number => {
    switch (type) {
      case '1x1':
        return 1;
      case '2x2':
        return 4;
      case '3x3':
        return 9;
      case '1+5':
        return 6;
      case '4x4':
        return 16;
      default:
        return 4;
    }
  };

  const fetchCamerasAndLayouts = async () => {
    setLoading(true);
    try {
      const [camRes, layoutRes] = await Promise.all([
        api.get('/cameras'),
        api.get('/layouts'),
      ]);

      const fetchedCams: CameraData[] = camRes.data.cameras || [];
      const fetchedLayouts: SavedLayout[] = layoutRes.data.layouts || [];

      setCameras(fetchedCams);
      setSavedLayouts(fetchedLayouts);

      // Check if user has a default layout
      const defaultLayout = fetchedLayouts.find((l) => l.isDefault);
      if (defaultLayout && selectedLayoutId === 'preset_2x2') {
        applySavedLayout(defaultLayout);
      } else {
        // Initialize default slot mapping if not already set
        updateDefaultSlots('2x2', fetchedCams);
      }
    } catch (err) {
      console.error('Failed to load live view data:', err);
    } finally {
      setLoading(false);
    }
  };

  const updateDefaultSlots = (newGridType: GridType, availableCams: CameraData[]) => {
    const count = getSlotCount(newGridType);
    const slots = Array.from({ length: count }, (_, idx) => ({
      slotIndex: idx,
      cameraId: availableCams[idx] ? availableCams[idx].id : null,
    }));
    setCameraSlots(slots);
  };

  useEffect(() => {
    fetchCamerasAndLayouts();
  }, []);

  // Handle Preset Switching
  const handleSelectPreset = (newGrid: GridType) => {
    setSelectedLayoutId(`preset_${newGrid}`);
    setGridType(newGrid);
    updateDefaultSlots(newGrid, cameras);
  };

  // Handle Saved Layout Selection
  const applySavedLayout = (layout: SavedLayout) => {
    setSelectedLayoutId(layout.id);
    const parsedGrid = parseGridType(layout.gridType);
    setGridType(parsedGrid);

    if (Array.isArray(layout.slotsJson) && layout.slotsJson.length > 0) {
      setCameraSlots(layout.slotsJson);
    } else {
      updateDefaultSlots(parsedGrid, cameras);
    }
  };

  // Delete Custom Layout
  const handleDeleteLayout = async (layoutId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm('Delete this saved layout?')) return;

    try {
      await api.delete(`/layouts/${layoutId}`);
      if (selectedLayoutId === layoutId) {
        handleSelectPreset('2x2');
      }
      fetchCamerasAndLayouts();
    } catch (err) {
      console.error('Failed deleting layout:', err);
    }
  };

  // Layout Tour Logic
  const advanceTour = useCallback(() => {
    // If we have saved layouts, cycle through saved layouts.
    // If not, cycle through presets 1x1 -> 2x2 -> 3x3
    if (savedLayouts.length > 0) {
      const currentIndex = savedLayouts.findIndex((l) => l.id === selectedLayoutId);
      const nextIndex = (currentIndex + 1) % savedLayouts.length;
      applySavedLayout(savedLayouts[nextIndex]);
    } else {
      const presets: GridType[] = ['1x1', '2x2', '3x3'];
      const currentIndex = presets.indexOf(gridType);
      const nextGrid = presets[(currentIndex + 1) % presets.length];
      handleSelectPreset(nextGrid);
    }
    setTourCountdown(tourInterval);
  }, [savedLayouts, selectedLayoutId, gridType, tourInterval, cameras]);

  useEffect(() => {
    if (!isTourRunning) {
      if (tourTimerRef.current) clearInterval(tourTimerRef.current);
      return;
    }

    setTourCountdown(tourInterval);

    tourTimerRef.current = setInterval(() => {
      setTourCountdown((prev) => {
        if (prev <= 1) {
          advanceTour();
          return tourInterval;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (tourTimerRef.current) clearInterval(tourTimerRef.current);
    };
  }, [isTourRunning, tourInterval, advanceTour]);

  // Compute Grid CSS Classes
  const getGridClass = () => {
    switch (gridType) {
      case '1x1':
        return 'grid-cols-1';
      case '2x2':
        return 'grid-cols-1 md:grid-cols-2';
      case '3x3':
        return 'grid-cols-2 md:grid-cols-3';
      case '1+5':
        return 'grid-cols-3 grid-rows-3';
      case '4x4':
        return 'grid-cols-2 md:grid-cols-4';
      default:
        return 'grid-cols-2';
    }
  };

  const cameraMap = new Map<string, CameraData>();
  cameras.forEach((c) => cameraMap.set(c.id, c));

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)] bg-tactical-bg overflow-hidden tactical-grid">
      {/* Dynamic Alarm Notification Banner */}
      <AlarmBanner onNavigateToAlarms={onNavigateToAlarms} />

      {/* Surveillance Master Toolbar */}
      <div className="h-11 bg-tactical-panel border-b border-tactical-border px-3 flex flex-wrap items-center justify-between gap-2 select-none">
        {/* Left: Layout Presets & Saved Views */}
        <div className="flex items-center space-x-2.5">
          <div className="flex items-center space-x-1 bg-tactical-bg p-0.5 border border-tactical-border">
            <button
              onClick={() => handleSelectPreset('1x1')}
              title="1x1 Single View [Key 1]"
              className={`px-2 py-1 text-[11px] font-mono font-bold transition ${
                selectedLayoutId === 'preset_1x1'
                  ? 'bg-phosphor-amber text-tactical-bg'
                  : 'text-tactical-muted hover:text-white'
              }`}
            >
              1X1
            </button>
            <button
              onClick={() => handleSelectPreset('2x2')}
              title="2x2 Quad View [Key 2]"
              className={`px-2 py-1 text-[11px] font-mono font-bold transition ${
                selectedLayoutId === 'preset_2x2'
                  ? 'bg-phosphor-amber text-tactical-bg'
                  : 'text-tactical-muted hover:text-white'
              }`}
            >
              2X2
            </button>
            <button
              onClick={() => handleSelectPreset('3x3')}
              title="3x3 9-Way Matrix"
              className={`px-2 py-1 text-[11px] font-mono font-bold transition ${
                selectedLayoutId === 'preset_3x3'
                  ? 'bg-phosphor-amber text-tactical-bg'
                  : 'text-tactical-muted hover:text-white'
              }`}
            >
              3X3
            </button>
            <button
              onClick={() => handleSelectPreset('1+5')}
              title="1+5 Master Spotlight View"
              className={`px-2 py-1 text-[11px] font-mono font-bold transition ${
                selectedLayoutId === 'preset_1+5'
                  ? 'bg-phosphor-amber text-tactical-bg'
                  : 'text-tactical-muted hover:text-white'
              }`}
            >
              1+5
            </button>
            <button
              onClick={() => handleSelectPreset('4x4')}
              title="4x4 16-Channel High-Density Matrix"
              className={`px-2 py-1 text-[11px] font-mono font-bold transition ${
                selectedLayoutId === 'preset_4x4'
                  ? 'bg-phosphor-amber text-tactical-bg'
                  : 'text-tactical-muted hover:text-white'
              }`}
            >
              4X4
            </button>
          </div>

          {/* Custom Saved Layouts Dropdown */}
          {savedLayouts.length > 0 && (
            <div className="flex items-center space-x-1.5">
              <span className="text-[10px] font-mono text-tactical-muted uppercase">VIEWS:</span>
              <select
                value={selectedLayoutId}
                onChange={(e) => {
                  const found = savedLayouts.find((l) => l.id === e.target.value);
                  if (found) applySavedLayout(found);
                }}
                className="bg-tactical-bg border border-tactical-border px-2 py-1 text-xs text-white font-mono focus:outline-none focus:border-phosphor-amber"
              >
                <option value="" disabled>
                  Select Layout...
                </option>
                {savedLayouts.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.visibility === 'TENANT_SHARED' ? '[SHARED] ' : '[PRIVATE] '}
                    {l.name} ({parseGridType(l.gridType)})
                  </option>
                ))}
              </select>

              {/* Quick Delete for active custom layout */}
              {selectedLayoutId && !selectedLayoutId.startsWith('preset_') && (
                <button
                  onClick={(e) => handleDeleteLayout(selectedLayoutId, e)}
                  title="Delete this custom layout"
                  className="p-1 text-tactical-muted hover:text-phosphor-red hover:bg-tactical-surface transition"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}

          {/* Save Current Layout View Button */}
          <button
            onClick={() => setShowSaveModal(true)}
            title="Save current camera layout"
            className="flex items-center space-x-1 px-2 py-1 text-xs font-mono bg-tactical-surface text-slate-200 border border-tactical-border hover:border-phosphor-amber hover:text-white transition"
          >
            <Save className="w-3 h-3 text-phosphor-amber" />
            <span>SAVE VIEW</span>
          </button>
        </div>

        {/* Right: Layout Tour Patrol & Camera Actions */}
        <div className="flex items-center space-x-2.5">
          {/* Layout Tour Patrol */}
          <div className="flex items-center space-x-1.5 bg-tactical-bg px-2 py-0.5 border border-tactical-border">
            <button
              onClick={() => setIsTourRunning(!isTourRunning)}
              className={`flex items-center space-x-1 px-1.5 py-0.5 text-xs font-mono font-semibold transition ${
                isTourRunning
                  ? 'bg-phosphor-cyan text-tactical-bg'
                  : 'text-tactical-muted hover:text-white'
              }`}
            >
              {isTourRunning ? <StopIcon className="w-3 h-3" /> : <Play className="w-3 h-3" />}
              <span>{isTourRunning ? 'TOUR ACTIVE' : 'PATROL'}</span>
            </button>

            {isTourRunning && (
              <span className="text-[10px] font-mono text-phosphor-cyan animate-pulse px-1">
                {tourCountdown}s
              </span>
            )}

            <select
              value={tourInterval}
              onChange={(e) => setTourInterval(Number(e.target.value))}
              disabled={isTourRunning}
              className="bg-transparent border-none text-[10px] font-mono text-tactical-muted focus:outline-none disabled:opacity-50"
            >
              <option value={10}>10s</option>
              <option value={15}>15s</option>
              <option value={30}>30s</option>
              <option value={60}>60s</option>
            </select>
          </div>

          <button
            onClick={fetchCamerasAndLayouts}
            className="p-1.5 border border-tactical-border bg-tactical-bg text-tactical-muted hover:text-white transition"
            title="Refresh Camera Feeds & Layouts"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-phosphor-amber' : ''}`} />
          </button>

          <button
            onClick={onNavigateToDevices}
            className="flex items-center space-x-1 px-2.5 py-1 text-xs font-mono font-bold bg-phosphor-amber text-tactical-bg hover:bg-amber-400 transition"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>ADD CAMERA</span>
          </button>
        </div>
      </div>

      {/* Main CCTV Surveillance Canvas */}
      <div className="flex-1 p-2 overflow-y-auto">
        {cameras.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-8 border border-tactical-border bg-tactical-panel/80 corner-reticle">
            <LayoutGrid className="w-12 h-12 text-tactical-muted mb-3" />
            <h3 className="text-sm font-bold text-white uppercase tracking-wider font-mono">
              [ ZERO ACTIVE CAMERA FEEDS ]
            </h3>
            <p className="text-xs text-tactical-muted max-w-sm mt-1 mb-4 font-mono">
              No ONVIF or RTSP video endpoints bound to this appliance. Initiate network discovery or enter RTSP parameters.
            </p>
            <button
              onClick={onNavigateToDevices}
              className="flex items-center space-x-1.5 px-3.5 py-2 text-xs font-bold font-mono bg-phosphor-amber text-tactical-bg hover:bg-amber-400 transition"
            >
              <Plus className="w-4 h-4" />
              <span>DISCOVER LAN CAMERAS</span>
            </button>
          </div>
        ) : (
          <div className={`grid ${getGridClass()} gap-2 h-full auto-rows-fr`}>
            {cameraSlots.map((slot, idx) => {
              const camera = slot.cameraId ? cameraMap.get(slot.cameraId) : null;
              const isSpotlightSlot = gridType === '1+5' && idx === 0;

              return (
                <div
                  key={`slot_${idx}`}
                  className={`${
                    isSpotlightSlot ? 'col-span-2 row-span-2' : ''
                  } w-full h-full min-h-[160px] flex flex-col`}
                >
                  {camera ? (
                    <CameraTile camera={camera} />
                  ) : (
                    <div className="w-full h-full bg-tactical-panel border border-dashed border-tactical-border flex flex-col items-center justify-center text-tactical-muted font-mono text-xs select-none corner-reticle">
                      <div className="text-tactical-muted mb-0.5 font-bold tracking-widest text-[11px]">
                        SLOT // #{idx + 1 < 10 ? `0${idx + 1}` : idx + 1}
                      </div>
                      <span className="text-[10px] text-tactical-muted/60 tracking-wider uppercase">
                        [ NO STREAM ASSIGNED ]
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Save Layout Modal Dialog */}
      {showSaveModal && (
        <SaveLayoutModal
          currentGridType={gridType}
          cameraSlots={cameraSlots}
          onClose={() => setShowSaveModal(false)}
          onSaved={() => {
            fetchCamerasAndLayouts();
          }}
        />
      )}
    </div>
  );
};

export default LiveView;
