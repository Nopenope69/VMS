import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Plus,
  RefreshCw,
  Save,
  Play,
  Square as StopIcon,
  Trash2,
  Video,
  Layers,
  XCircle,
} from 'lucide-react';
import CameraTile, { CameraData } from '../components/CameraTile';
import CameraDrawer from '../components/CameraDrawer';
import AlarmBanner from '../components/AlarmBanner';
import SaveLayoutModal from '../components/SaveLayoutModal';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import { ConfirmModal } from '../components/ui/Modal';
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

export const DEMO_SAMPLE_CAMERAS: CameraData[] = [
  {
    id: 'demo-cam-01',
    name: 'Sector A — North Perimeter Gate',
    streamPath: 'live/north_gate',
    ipAddress: '192.168.10.101',
    hasPtz: true,
    recordingMode: 'CONTINUOUS',
    isOnline: true,
  },
  {
    id: 'demo-cam-02',
    name: 'Sector B — Terminal Concourse East',
    streamPath: 'live/concourse_east',
    ipAddress: '192.168.10.102',
    hasPtz: false,
    recordingMode: 'CONTINUOUS',
    isOnline: true,
  },
  {
    id: 'demo-cam-03',
    name: 'Sector C — Secure Evidence Vault',
    streamPath: 'live/vault_secure',
    ipAddress: '192.168.10.103',
    hasPtz: true,
    recordingMode: 'MOTION',
    isOnline: true,
  },
  {
    id: 'demo-cam-04',
    name: 'Sector D — Loading Dock Ingress',
    streamPath: 'live/loading_dock',
    ipAddress: '192.168.10.104',
    hasPtz: false,
    recordingMode: 'CONTINUOUS',
    isOnline: true,
  },
];

export const LiveView: React.FC<LiveViewProps> = ({ onNavigateToDevices, onNavigateToAlarms }) => {
  const [cameras, setCameras] = useState<CameraData[]>([]);
  const [savedLayouts, setSavedLayouts] = useState<SavedLayout[]>([]);
  const [selectedLayoutId, setSelectedLayoutId] = useState<string>('preset_2x2');
  const [gridType, setGridType] = useState<GridType>('2x2');
  const [cameraSlots, setCameraSlots] = useState<Array<{ slotIndex: number; cameraId: string | null }>>([]);
  const [loading, setLoading] = useState(true);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [maximizedCameraId, setMaximizedCameraId] = useState<string | null>(null);
  const [layoutToDelete, setLayoutToDelete] = useState<string | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(true);
  const [selectedSlotIndex, setSelectedSlotIndex] = useState<number>(0);

  const handleAssignCameraToSlot = (cameraId: string, slotIndex: number) => {
    setCameraSlots((prev) => {
      const next = [...prev];
      const existingIndex = next.findIndex((s) => s.slotIndex === slotIndex);
      if (existingIndex !== -1) {
        next[existingIndex] = { ...next[existingIndex], cameraId };
      } else {
        next.push({ slotIndex, cameraId });
      }
      return next;
    });
  };

  const handleClearSlot = (slotIndex: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setCameraSlots((prev) =>
      prev.map((s) => (s.slotIndex === slotIndex ? { ...s, cameraId: null } : s))
    );
  };

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
        api.get('/cameras').catch(() => ({ data: { cameras: [] } })),
        api.get('/layouts').catch(() => ({ data: { layouts: [] } })),
      ]);

      let fetchedCams: CameraData[] = camRes.data.cameras || [];
      const fetchedLayouts: SavedLayout[] = layoutRes.data.layouts || [];

      if (fetchedCams.length === 0) {
        fetchedCams = DEMO_SAMPLE_CAMERAS;
      }

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
      setCameras(DEMO_SAMPLE_CAMERAS);
      updateDefaultSlots('2x2', DEMO_SAMPLE_CAMERAS);
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

  // Delete Custom Layout with Non-blocking Confirm Modal
  const handleDeleteLayout = (layoutId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setLayoutToDelete(layoutId);
  };

  const confirmDeleteLayout = async () => {
    if (!layoutToDelete) return;
    try {
      await api.delete(`/layouts/${layoutToDelete}`);
      if (selectedLayoutId === layoutToDelete) {
        handleSelectPreset('2x2');
      }
      fetchCamerasAndLayouts();
    } catch (err) {
      console.error('Failed deleting layout:', err);
    } finally {
      setLayoutToDelete(null);
    }
  };

  // Dedicated single-stroke hotkeys 1-5 for instant camera grid switching
  useEffect(() => {
    const handleLiveKeyDown = (e: KeyboardEvent) => {
      const activeTag = (document.activeElement?.tagName || '').toLowerCase();
      if (
        activeTag === 'input' ||
        activeTag === 'textarea' ||
        activeTag === 'select' ||
        (document.activeElement as HTMLElement)?.isContentEditable
      ) {
        return;
      }
      // If Alt, Ctrl, or Meta is held, leave for global browser/app hotkeys
      if (e.altKey || e.ctrlKey || e.metaKey) return;

      if (e.key === '1') {
        e.preventDefault();
        setMaximizedCameraId(null);
        handleSelectPreset('1x1');
      } else if (e.key === '2') {
        e.preventDefault();
        setMaximizedCameraId(null);
        handleSelectPreset('2x2');
      } else if (e.key === '3') {
        e.preventDefault();
        setMaximizedCameraId(null);
        handleSelectPreset('3x3');
      } else if (e.key === '4') {
        e.preventDefault();
        setMaximizedCameraId(null);
        handleSelectPreset('4x4');
      } else if (e.key === '5') {
        e.preventDefault();
        setMaximizedCameraId(null);
        handleSelectPreset('1+5');
      } else if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        setIsDrawerOpen((prev) => !prev);
      } else if (e.key === 'Escape' && maximizedCameraId) {
        e.preventDefault();
        setMaximizedCameraId(null);
      }
    };

    window.addEventListener('keydown', handleLiveKeyDown);
    return () => window.removeEventListener('keydown', handleLiveKeyDown);
  }, [maximizedCameraId, cameras]);

  // Layout Tour Logic
  const advanceTour = useCallback(() => {
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

  const presets: { id: GridType; label: string; tooltip: string }[] = [
    { id: '1x1', label: '1×1', tooltip: 'Single Stream Focus [Key 1]' },
    { id: '2x2', label: '2×2', tooltip: 'Quad View [Key 2]' },
    { id: '3x3', label: '3×3', tooltip: '9-Camera Matrix [Key 3]' },
    { id: '4x4', label: '4×4', tooltip: '16-Camera Matrix [Key 4]' },
    { id: '1+5', label: '1+5', tooltip: 'Spotlight + 5 Peripherals [Key 5]' },
  ];

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)] bg-vms-bg overflow-hidden">
      {/* Priority Alarm Banner */}
      <AlarmBanner onNavigateToAlarms={onNavigateToAlarms} />

      {/* Surveillance Master Toolbar */}
      <div className="h-11 bg-vms-panel border-b border-vms-border px-3 flex flex-wrap items-center justify-between gap-3 select-none shrink-0">
        {/* Left: Layout Presets & Views */}
        <div className="flex items-center space-x-2">
          {/* Segmented Grid Presets */}
          <div className="flex items-center space-x-0.5 bg-vms-surface p-0.5 rounded border border-vms-border">
            {presets.map((p) => {
              const active = selectedLayoutId === `preset_${p.id}` || (selectedLayoutId.startsWith('preset_') && gridType === p.id);
              return (
                <button
                  key={p.id}
                  onClick={() => handleSelectPreset(p.id)}
                  title={p.tooltip}
                  aria-pressed={active}
                  className={`px-2.5 py-1 text-xs font-mono font-medium rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-400 ${
                    active
                      ? 'bg-amber-500 text-slate-950 font-bold shadow-sm'
                      : 'text-vms-muted hover:text-vms-text hover:bg-vms-hover'
                  }`}
                >
                  {p.label}
                </button>
              );
            })}
          </div>

          {/* Saved Layouts Dropdown */}
          {savedLayouts.length > 0 && (
            <div className="flex items-center space-x-1.5 pl-2 border-l border-vms-border">
              <span className="text-[11px] font-mono text-vms-dim uppercase hidden sm:inline">VIEW:</span>
              <select
                value={selectedLayoutId}
                onChange={(e) => {
                  const found = savedLayouts.find((l) => l.id === e.target.value);
                  if (found) applySavedLayout(found);
                }}
                className="bg-vms-surface border border-vms-border px-2 py-1 text-xs text-vms-text font-sans rounded focus:outline-none focus:border-sky-500"
              >
                <option value="" disabled>
                  Select Layout...
                </option>
                {savedLayouts.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.visibility === 'TENANT_SHARED' ? '[Shared] ' : ''}
                    {l.name} ({parseGridType(l.gridType)})
                  </option>
                ))}
              </select>

              {selectedLayoutId && !selectedLayoutId.startsWith('preset_') && (
                <button
                  onClick={(e) => handleDeleteLayout(selectedLayoutId, e)}
                  title="Delete this saved view"
                  aria-label="Delete saved view"
                  className="p-1 rounded text-vms-dim hover:text-rose-400 hover:bg-vms-surface transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-rose-400"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}

          {/* Save Layout Button */}
          <Button
            variant="ghost"
            size="xs"
            icon={Save}
            onClick={() => setShowSaveModal(true)}
            title="Save current grid view"
            className="text-vms-muted hover:text-vms-text"
          >
            Save View
          </Button>
        </div>

        {/* Right: Layout Tour Patrol & Camera Fleet Actions */}
        <div className="flex items-center space-x-2">
          {/* Layout Tour Patrol Control */}
          <div className="flex items-center space-x-1.5 bg-vms-surface px-2 py-0.5 rounded border border-vms-border">
            <button
              onClick={() => setIsTourRunning(!isTourRunning)}
              className={`flex items-center space-x-1.5 px-2 py-0.5 text-xs font-sans font-medium rounded transition-colors ${
                isTourRunning
                  ? 'bg-sky-500 text-slate-950 font-semibold'
                  : 'text-vms-muted hover:text-vms-text hover:bg-vms-hover'
              }`}
            >
              {isTourRunning ? <StopIcon className="w-3 h-3" /> : <Play className="w-3 h-3" />}
              <span>{isTourRunning ? 'Patrol Active' : 'Patrol'}</span>
            </button>

            {isTourRunning && (
              <span className="text-[10px] font-mono text-sky-400 animate-pulse px-1">
                {tourCountdown}s
              </span>
            )}

            <select
              value={tourInterval}
              onChange={(e) => setTourInterval(Number(e.target.value))}
              disabled={isTourRunning}
              aria-label="Patrol interval"
              className="bg-transparent border-none text-[11px] font-mono text-vms-muted focus:outline-none disabled:opacity-50"
            >
              <option value={10}>10s</option>
              <option value={15}>15s</option>
              <option value={30}>30s</option>
              <option value={60}>60s</option>
            </select>
          </div>

          {/* Camera Directory Toggle */}
          <button
            onClick={() => setIsDrawerOpen(!isDrawerOpen)}
            title="Toggle Camera Directory [C]"
            aria-label="Toggle Camera Directory"
            className={`px-2.5 py-1 text-xs font-sans font-medium rounded border transition-colors flex items-center space-x-1.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-500 ${
              isDrawerOpen
                ? 'bg-vms-elevated border-amber-500/50 text-amber-400 font-semibold shadow-sm'
                : 'bg-vms-surface border-vms-border text-vms-muted hover:text-vms-text hover:bg-vms-hover'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>Directory ({cameras.length})</span>
          </button>

          <button
            onClick={fetchCamerasAndLayouts}
            className="p-1.5 rounded border border-vms-border bg-vms-surface text-vms-muted hover:text-vms-text hover:bg-vms-hover transition-colors"
            title="Refresh Camera Feeds & Layouts"
            aria-label="Refresh Camera Feeds"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-amber-400' : ''}`} />
          </button>

          <Button
            variant="primary"
            size="xs"
            icon={Plus}
            onClick={onNavigateToDevices}
          >
            Add Camera
          </Button>
        </div>
      </div>

      {/* Main Video Surveillance Canvas & Camera Directory Drawer */}
      <div className="flex-1 flex overflow-hidden">
        <CameraDrawer
          isOpen={isDrawerOpen}
          onClose={() => setIsDrawerOpen(false)}
          cameras={cameras}
          selectedSlotIndex={selectedSlotIndex}
          cameraSlots={cameraSlots}
          onAssignCameraToSlot={handleAssignCameraToSlot}
          onSelectSlot={(idx) => setSelectedSlotIndex(idx)}
          slotCount={getSlotCount(gridType)}
        />

        <div className="flex-1 p-2 overflow-y-auto">
          {cameras.length === 0 ? (
            <EmptyState
              icon={Video}
              title="Zero Active Camera Streams"
              description="No ONVIF or RTSP camera endpoints are configured on this appliance. Run network discovery or onboard an IP camera stream."
              actionLabel="Discover LAN Cameras"
              onAction={onNavigateToDevices}
            />
          ) : maximizedCameraId && cameraMap.has(maximizedCameraId) ? (
            <div className="w-full h-full flex flex-col">
              <CameraTile
                camera={cameraMap.get(maximizedCameraId)!}
                isFullscreen={true}
                onToggleFullscreen={() => setMaximizedCameraId(null)}
              />
            </div>
          ) : (
            <div className={`grid ${getGridClass()} gap-2 h-full auto-rows-fr`}>
              {cameraSlots.map((slot, idx) => {
                const camera = slot.cameraId ? cameraMap.get(slot.cameraId) : null;
                const isSpotlightSlot = gridType === '1+5' && idx === 0;
                const isSelected = selectedSlotIndex === idx;

                return (
                  <div
                    key={`slot_${idx}`}
                    onClick={() => setSelectedSlotIndex(idx)}
                    className={`${
                      isSpotlightSlot ? 'col-span-2 row-span-2' : ''
                    } w-full h-full min-h-[160px] flex flex-col relative rounded transition-all duration-150 group ${
                      isSelected
                        ? 'ring-2 ring-amber-500/90 ring-offset-1 ring-offset-vms-panel'
                        : 'hover:ring-1 hover:ring-vms-border'
                    }`}
                  >
                    {camera ? (
                      <div className="relative w-full h-full flex flex-col">
                        <CameraTile
                          camera={camera}
                          isFullscreen={false}
                          onToggleFullscreen={() => setMaximizedCameraId(camera.id)}
                        />
                        {/* Hover Quick Action: Unassign slot */}
                        <div className="absolute top-2 right-12 z-20 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={(e) => handleClearSlot(idx, e)}
                            title={`Clear Slot ${idx + 1}`}
                            aria-label={`Clear Slot ${idx + 1}`}
                            className="p-1 rounded bg-vms-panel/90 text-vms-dim hover:text-rose-400 border border-vms-border text-[10px] shadow"
                          >
                            <XCircle className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="w-full h-full bg-vms-surface/40 border border-dashed border-vms-border rounded flex flex-col items-center justify-center text-vms-dim font-mono text-xs select-none hover:bg-vms-surface/60 transition-colors p-3 text-center">
                        <div className="text-vms-muted mb-0.5 font-semibold text-[11px]">
                          SLOT {idx + 1 < 10 ? `0${idx + 1}` : idx + 1}
                        </div>
                        <span className="text-[10px] uppercase tracking-wider text-vms-dim">
                          No Stream Assigned
                        </span>
                        <span className="text-[10px] text-amber-500/90 mt-1 font-sans">
                          {isSelected ? 'Active Target • Choose camera in directory' : 'Click to target this slot'}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
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

      {/* Delete Layout Confirmation Modal */}
      <ConfirmModal
        isOpen={!!layoutToDelete}
        onClose={() => setLayoutToDelete(null)}
        onConfirm={confirmDeleteLayout}
        title="Delete Saved Layout"
        message="Are you sure you want to delete this custom surveillance layout? This action cannot be undone."
        confirmLabel="Delete Layout"
        variant="danger"
      />
    </div>
  );
};

export default LiveView;
