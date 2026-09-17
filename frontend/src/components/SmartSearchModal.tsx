import React, { useState, useRef, useEffect } from 'react';
import { X, Search, Crosshair, Car, Clock, ArrowRight, ShieldAlert } from 'lucide-react';
import api from '../services/api';
import Button from './ui/Button';
import Input from './ui/Input';

interface SmartSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  cameraId?: string;
  cameras: Array<{ id: string; name: string }>;
  onSeekToTimestamp?: (isoTimestamp: string) => void;
}

interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const SmartSearchModal: React.FC<SmartSearchModalProps> = ({
  isOpen,
  onClose,
  cameraId: defaultCameraId,
  cameras,
  onSeekToTimestamp,
}) => {
  const [activeTab, setActiveTab] = useState<'spatial' | 'plate'>('spatial');
  const [selectedCameraId, setSelectedCameraId] = useState<string>(defaultCameraId || (cameras[0]?.id || ''));
  const [startDate, setStartDate] = useState<string>(
    new Date(Date.now() - 86400000).toISOString().slice(0, 16)
  );
  const [endDate, setEndDate] = useState<string>(new Date().toISOString().slice(0, 16));
  const [minConfidence, setMinConfidence] = useState<number>(0.5);

  // Spatial ROI State
  const [roiBox, setRoiBox] = useState<BoundingBox>({ x: 0.2, y: 0.2, width: 0.6, height: 0.6 });
  const [isDrawing, setIsDrawing] = useState<boolean>(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Search Results
  const [searching, setSearching] = useState<boolean>(false);
  const [spatialResults, setSpatialResults] = useState<any[]>([]);
  const [plateQuery, setPlateQuery] = useState<string>('');
  const [selectedCategory, setSelectedCategory] = useState<string>('');
  const [plateResults, setPlateResults] = useState<any[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (defaultCameraId) {
      setSelectedCameraId(defaultCameraId);
    } else if (cameras.length > 0 && !selectedCameraId) {
      setSelectedCameraId(cameras[0].id);
    }
  }, [defaultCameraId, cameras]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Render Canvas ROI Box
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw dark semi-transparent grid overlay representing video frame
    ctx.fillStyle = '#0D0804';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Grid lines
    ctx.strokeStyle = '#38240D';
    ctx.lineWidth = 1;
    for (let x = 0; x < canvas.width; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y < canvas.height; y += 30) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }

    // Draw ROI Box
    const rx = roiBox.x * canvas.width;
    const ry = roiBox.y * canvas.height;
    const rw = roiBox.width * canvas.width;
    const rh = roiBox.height * canvas.height;

    // Highlight ROI zone
    ctx.fillStyle = 'rgba(192, 88, 0, 0.2)'; // VMS amber tint
    ctx.fillRect(rx, ry, rw, rh);

    ctx.strokeStyle = '#C05800';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(rx, ry, rw, rh);
    ctx.setLineDash([]);

    // Corner crosshairs
    ctx.fillStyle = '#C05800';
    const markerSize = 6;
    ctx.fillRect(rx - markerSize / 2, ry - markerSize / 2, markerSize, markerSize);
    ctx.fillRect(rx + rw - markerSize / 2, ry - markerSize / 2, markerSize, markerSize);
    ctx.fillRect(rx - markerSize / 2, ry + rh - markerSize / 2, markerSize, markerSize);
    ctx.fillRect(rx + rw - markerSize / 2, ry + rh - markerSize / 2, markerSize, markerSize);

    // Label
    ctx.font = '10px monospace';
    ctx.fillStyle = '#FDFBD4';
    ctx.fillText(
      `ROI: [${roiBox.x.toFixed(2)}, ${roiBox.y.toFixed(2)}] ${roiBox.width.toFixed(2)}x${roiBox.height.toFixed(2)}`,
      rx + 6,
      ry + 14
    );
  }, [roiBox, activeTab]);

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));

    setIsDrawing(true);
    setDrawStart({ x, y });
    setRoiBox({ x, y, width: 0.05, height: 0.05 });
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !drawStart) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const curX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const curY = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));

    const x = Math.min(drawStart.x, curX);
    const y = Math.min(drawStart.y, curY);
    const width = Math.max(0.05, Math.abs(curX - drawStart.x));
    const height = Math.max(0.05, Math.abs(curY - drawStart.y));

    setRoiBox({
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      width: Math.round(width * 100) / 100,
      height: Math.round(height * 100) / 100,
    });
  };

  const handleMouseUp = () => {
    setIsDrawing(false);
    setDrawStart(null);
  };

  const handleExecuteSpatialSearch = async () => {
    if (!selectedCameraId) {
      setErrorMessage('Please select a camera to search.');
      return;
    }
    setSearching(true);
    setErrorMessage(null);
    try {
      const res = await api.post('/search/spatial-motion', {
        cameraId: selectedCameraId,
        roi: roiBox,
        startTime: new Date(startDate).toISOString(),
        endTime: new Date(endDate).toISOString(),
        minConfidence,
      });
      setSpatialResults(res.data.events || []);
    } catch (err: any) {
      setErrorMessage(
        err.response?.data?.error || 'Spatial forensic search failed. Check license entitlement.'
      );
    } finally {
      setSearching(false);
    }
  };

  const handleExecutePlateSearch = async () => {
    setSearching(true);
    setErrorMessage(null);
    try {
      const params: any = {
        startTime: new Date(startDate).toISOString(),
        endTime: new Date(endDate).toISOString(),
      };
      if (plateQuery.trim()) params.plateQuery = plateQuery.trim();
      if (selectedCategory) params.category = selectedCategory;

      const res = await api.get('/search/anpr-plates', { params });
      setPlateResults(res.data.plates || []);
    } catch (err: any) {
      setErrorMessage(
        err.response?.data?.error || 'Forensic license plate query failed.'
      );
    } finally {
      setSearching(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="smartsearch-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-xs p-4 select-none"
    >
      <div className="bg-vms-elevated border border-vms-border w-full max-w-4xl max-h-[90vh] rounded shadow-2xl flex flex-col overflow-hidden text-vms-text font-sans">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-vms-border flex items-center justify-between bg-vms-panel">
          <div className="flex items-center space-x-2.5">
            <div className="p-1.5 rounded bg-vms-accent/20 border border-vms-accent/40 text-vms-accent">
              <Crosshair className="w-4 h-4" />
            </div>
            <div>
              <h2 id="smartsearch-modal-title" className="text-xs font-bold tracking-wider uppercase font-mono text-vms-text">
                Smart Spatial & Forensic Search
              </h2>
              <p className="text-[11px] text-vms-muted font-mono">
                Sub-second 2D AABB Intersection & Indian ANPR Wildcard Queries
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1 rounded text-vms-muted hover:text-vms-text hover:bg-vms-surface transition-colors"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs Bar */}
        <div className="flex border-b border-vms-border bg-vms-surface px-5 pt-2">
          <button
            onClick={() => setActiveTab('spatial')}
            className={`flex items-center space-x-2 py-2 px-4 text-xs font-mono font-semibold border-b-2 transition-colors ${
              activeTab === 'spatial'
                ? 'border-vms-accent text-vms-accent bg-vms-panel/50'
                : 'border-transparent text-vms-muted hover:text-vms-text'
            }`}
          >
            <Crosshair className="w-3.5 h-3.5" />
            <span>Spatial ROI Motion & Object Search</span>
          </button>
          <button
            onClick={() => setActiveTab('plate')}
            className={`flex items-center space-x-2 py-2 px-4 text-xs font-mono font-semibold border-b-2 transition-colors ${
              activeTab === 'plate'
                ? 'border-sky-400 text-sky-400 bg-vms-panel/50'
                : 'border-transparent text-vms-muted hover:text-vms-text'
            }`}
          >
            <Car className="w-3.5 h-3.5" />
            <span>Forensic License Plate Search</span>
          </button>
        </div>

        {/* Filters Bar */}
        <div className="p-4 bg-vms-panel border-b border-vms-border grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
          {/* Camera Picker */}
          <div>
            <label className="block text-[10px] uppercase font-mono text-vms-muted mb-1 tracking-wider">
              Target Camera
            </label>
            <select
              value={selectedCameraId}
              onChange={(e) => setSelectedCameraId(e.target.value)}
              className="w-full bg-vms-surface border border-vms-border rounded px-2 py-1.5 font-mono text-vms-text focus:border-vms-accent focus:outline-none text-xs"
            >
              {cameras.map((cam) => (
                <option key={cam.id} value={cam.id}>
                  {cam.name}
                </option>
              ))}
            </select>
          </div>

          {/* Start Time */}
          <div>
            <label className="block text-[10px] uppercase font-mono text-vms-muted mb-1 tracking-wider">
              From Timestamp
            </label>
            <Input
              type="datetime-local"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-full text-xs"
            />
          </div>

          {/* End Time */}
          <div>
            <label className="block text-[10px] uppercase font-mono text-vms-muted mb-1 tracking-wider">
              To Timestamp
            </label>
            <Input
              type="datetime-local"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-full text-xs"
            />
          </div>

          {/* Confidence Slider or Plate Filter */}
          {activeTab === 'spatial' ? (
            <div>
              <div className="flex justify-between text-[10px] uppercase font-mono text-vms-muted mb-1 tracking-wider">
                <span>Min Confidence</span>
                <span className="text-vms-accent">{Math.round(minConfidence * 100)}%</span>
              </div>
              <input
                type="range"
                min="0.1"
                max="1.0"
                step="0.05"
                value={minConfidence}
                onChange={(e) => setMinConfidence(parseFloat(e.target.value))}
                className="w-full accent-[#C05800] mt-2"
              />
            </div>
          ) : (
            <div>
              <label className="block text-[10px] uppercase font-mono text-vms-muted mb-1 tracking-wider">
                Watchlist Category
              </label>
              <select
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value)}
                className="w-full bg-vms-surface border border-vms-border rounded px-2 py-1.5 font-mono text-vms-text focus:border-vms-accent focus:outline-none text-xs"
              >
                <option value="">All Categories</option>
                <option value="HOTLIST_STOLEN">Hotlist / Stolen</option>
                <option value="SECURITY_BLOCKED">Security Blocked</option>
                <option value="VIP_EXEMPT">VIP / Whitelist</option>
                <option value="VISITOR">Visitor</option>
                <option value="SUSPICIOUS">Suspicious</option>
              </select>
            </div>
          )}
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {errorMessage && (
            <div className="p-3 bg-rose-950/70 border border-rose-800 rounded text-rose-300 text-xs font-mono flex items-center space-x-2">
              <ShieldAlert className="w-4 h-4 shrink-0 text-rose-400" />
              <span>{errorMessage}</span>
            </div>
          )}

          {activeTab === 'spatial' ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {/* ROI Canvas Selector */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-vms-text font-mono">
                    Draw Region of Interest (ROI)
                  </span>
                  <span className="text-[10px] font-mono text-vms-accent">
                    Click & Drag to define bounding box
                  </span>
                </div>
                <div className="relative rounded border border-vms-border overflow-hidden bg-black aspect-video flex items-center justify-center">
                  <canvas
                    ref={canvasRef}
                    width={400}
                    height={225}
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    className="w-full h-full cursor-crosshair"
                  />
                </div>

                <div className="mt-3 flex items-center justify-between">
                  <div className="text-[11px] font-mono text-vms-muted">
                    Box: X:{roiBox.x} Y:{roiBox.y} W:{roiBox.width} H:{roiBox.height}
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleExecuteSpatialSearch}
                    disabled={searching}
                    isLoading={searching}
                    icon={Search}
                  >
                    Run Spatial Search
                  </Button>
                </div>
              </div>

              {/* Spatial Results Feed */}
              <div className="flex flex-col h-full min-h-[300px]">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-vms-text font-mono">
                    Intersects Found ({spatialResults.length})
                  </span>
                </div>

                <div className="flex-1 bg-vms-panel border border-vms-border rounded p-2 overflow-y-auto space-y-2 max-h-[340px]">
                  {spatialResults.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-vms-dim py-10 font-mono text-xs">
                      <Crosshair className="w-8 h-8 mb-2 opacity-40 text-vms-accent" />
                      <span>No detection events match ROI yet</span>
                      <span className="text-[10px] text-vms-dim mt-1">Adjust ROI or widen time window</span>
                    </div>
                  ) : (
                    spatialResults.map((event) => (
                      <div
                        key={event.id}
                        className="bg-vms-surface p-2.5 rounded border border-vms-border hover:border-vms-accent transition-colors flex items-center justify-between text-xs"
                      >
                        <div className="flex items-center space-x-3">
                          <div className="w-2 h-2 rounded-full bg-vms-accent" />
                          <div>
                            <div className="font-semibold text-vms-text flex items-center space-x-2">
                              <span>{event.type}</span>
                              <span className="text-[10px] px-1.5 py-[2px] rounded bg-sky-500/20 text-sky-400 border border-sky-500/40 font-mono">
                                {Math.round(event.confidence * 100)}% conf
                              </span>
                            </div>
                            <div className="text-[10px] font-mono text-vms-muted mt-0.5 flex items-center space-x-1">
                              <Clock className="w-3 h-3 text-vms-dim" />
                              <span>{new Date(event.timestamp).toLocaleString()}</span>
                            </div>
                          </div>
                        </div>

                        {onSeekToTimestamp && (
                          <Button
                            variant="secondary"
                            size="xs"
                            icon={ArrowRight}
                            onClick={() => {
                              onSeekToTimestamp(event.timestamp);
                              onClose();
                            }}
                          >
                            Seek
                          </Button>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          ) : (
            /* Plate Search Tab */
            <div className="space-y-4">
              <div className="flex items-center space-x-3">
                <div className="flex-1 relative">
                  <input
                    type="text"
                    placeholder="Search by Plate (e.g. DL01*, MH12, KA05MB1234)..."
                    value={plateQuery}
                    onChange={(e) => setPlateQuery(e.target.value.toUpperCase())}
                    className="w-full bg-vms-surface border border-vms-border rounded px-3 py-2 font-mono text-xs uppercase tracking-wider text-vms-text focus:border-vms-accent focus:outline-none"
                  />
                  <Car className="w-4 h-4 text-vms-dim absolute right-3 top-2.5" />
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  icon={Search}
                  onClick={handleExecutePlateSearch}
                  disabled={searching}
                  isLoading={searching}
                >
                  Find Vehicles
                </Button>
              </div>

              {/* Plate Results List */}
              <div className="bg-vms-panel border border-vms-border rounded overflow-hidden">
                <div className="px-4 py-2.5 border-b border-vms-border bg-vms-surface flex justify-between items-center text-xs font-semibold text-vms-text font-mono uppercase tracking-wider">
                  <span>Detected Vehicle Observations ({plateResults.length})</span>
                </div>

                <div className="divide-y divide-vms-border max-h-[360px] overflow-y-auto">
                  {plateResults.length === 0 ? (
                    <div className="p-8 text-center text-vms-dim font-mono text-xs">
                      No vehicles found matching query filter. Enter wildcard like "DL*" or select a time range.
                    </div>
                  ) : (
                    plateResults.map((obs) => (
                      <div key={obs.id} className="p-3 hover:bg-vms-hover/40 transition-colors flex items-center justify-between text-xs">
                        <div className="flex items-center space-x-4">
                          {/* Plate Badge */}
                          <div className="bg-[#0D0804] border border-vms-border rounded px-2.5 py-1 font-mono text-sm font-bold tracking-widest text-vms-text flex items-center space-x-2">
                            <span className="text-[10px] text-vms-accent font-normal">IND</span>
                            <span>{obs.plateNumber}</span>
                          </div>

                          <div>
                            <div className="flex items-center space-x-2">
                              <span className="font-medium text-vms-text">{obs.stateName || 'Indian Vehicle'}</span>
                              <span className="text-[10px] px-1.5 py-[2px] rounded bg-vms-panel border border-vms-border font-mono text-vms-muted">
                                {obs.category || 'CAR'}
                              </span>
                              {obs.isWatchlistMatch && (
                                <span className="text-[10px] px-1.5 py-[2px] rounded bg-rose-500/20 text-rose-400 border border-rose-500/40 font-bold uppercase font-mono">
                                  Watchlist Hit
                                </span>
                              )}
                            </div>
                            <div className="text-[10px] font-mono text-vms-dim mt-0.5">
                              Seen {obs.observationCount}x • Best Conf: {Math.round(obs.bestConfidence * 100)}% • Last Seen: {new Date(obs.lastSeen).toLocaleString()}
                            </div>
                          </div>
                        </div>

                        {onSeekToTimestamp && (
                          <Button
                            variant="secondary"
                            size="xs"
                            icon={ArrowRight}
                            onClick={() => {
                              onSeekToTimestamp(obs.lastSeen);
                              onClose();
                            }}
                          >
                            Jump to Footage
                          </Button>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SmartSearchModal;
