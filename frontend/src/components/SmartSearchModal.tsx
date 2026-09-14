import React, { useState, useRef, useEffect } from 'react';
import { X, Search, Crosshair, Car, Clock, ArrowRight, ShieldAlert } from 'lucide-react';
import api from '../services/api';

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
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Grid lines
    ctx.strokeStyle = '#1e293b';
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
    ctx.fillStyle = 'rgba(245, 158, 11, 0.15)'; // CCTV Amber tint
    ctx.fillRect(rx, ry, rw, rh);

    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(rx, ry, rw, rh);
    ctx.setLineDash([]);

    // Corner crosshairs
    ctx.fillStyle = '#f59e0b';
    const markerSize = 6;
    ctx.fillRect(rx - markerSize / 2, ry - markerSize / 2, markerSize, markerSize);
    ctx.fillRect(rx + rw - markerSize / 2, ry - markerSize / 2, markerSize, markerSize);
    ctx.fillRect(rx - markerSize / 2, ry + rh - markerSize / 2, markerSize, markerSize);
    ctx.fillRect(rx + rw - markerSize / 2, ry + rh - markerSize / 2, markerSize, markerSize);

    // Label
    ctx.font = '10px monospace';
    ctx.fillStyle = '#f59e0b';
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
      if (selectedCameraId) params.cameraId = selectedCameraId;

      const res = await api.get('/search/plates', { params });
      setPlateResults(res.data.observations || []);
    } catch (err: any) {
      setErrorMessage(
        err.response?.data?.error || 'Plate search failed. Check license entitlement.'
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-4"
    >
      <div className="bg-graphite-850 border border-graphite-700 w-full max-w-4xl max-h-[90vh] rounded-lg shadow-2xl flex flex-col overflow-hidden text-slate-100">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-graphite-700 flex items-center justify-between bg-graphite-900">
          <div className="flex items-center space-x-2.5">
            <div className="p-1.5 rounded bg-cctv-amber/20 border border-cctv-amber/40 text-cctv-amber">
              <Crosshair className="w-4 h-4" />
            </div>
            <div>
              <h2 id="smartsearch-modal-title" className="text-sm font-bold tracking-wide uppercase">Smart Spatial & Forensic Search</h2>
              <p className="text-[11px] text-slate-400 font-mono">
                Sub-second 2D AABB Intersection & Indian ANPR Wildcard Queries
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-graphite-700 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs Bar */}
        <div className="flex border-b border-graphite-700 bg-graphite-850 px-5 pt-2">
          <button
            onClick={() => setActiveTab('spatial')}
            className={`flex items-center space-x-2 py-2 px-4 text-xs font-semibold border-b-2 transition ${
              activeTab === 'spatial'
                ? 'border-cctv-amber text-cctv-amber bg-graphite-800/50'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Crosshair className="w-3.5 h-3.5" />
            <span>Spatial ROI Motion & Object Search</span>
          </button>
          <button
            onClick={() => setActiveTab('plate')}
            className={`flex items-center space-x-2 py-2 px-4 text-xs font-semibold border-b-2 transition ${
              activeTab === 'plate'
                ? 'border-cctv-teal text-cctv-teal bg-graphite-800/50'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Car className="w-3.5 h-3.5" />
            <span>Forensic License Plate Search</span>
          </button>
        </div>

        {/* Filters Bar */}
        <div className="p-4 bg-graphite-900 border-b border-graphite-700 grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
          {/* Camera Picker */}
          <div>
            <label className="block text-[10px] uppercase font-mono text-slate-400 mb-1">Target Camera</label>
            <select
              value={selectedCameraId}
              onChange={(e) => setSelectedCameraId(e.target.value)}
              className="w-full bg-graphite-800 border border-graphite-700 rounded px-2 py-1.5 font-mono text-slate-200 focus:border-cctv-amber focus:outline-none"
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
            <label className="block text-[10px] uppercase font-mono text-slate-400 mb-1">From Timestamp</label>
            <input
              type="datetime-local"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-full bg-graphite-800 border border-graphite-700 rounded px-2 py-1.5 font-mono text-slate-200 focus:border-cctv-amber focus:outline-none"
            />
          </div>

          {/* End Time */}
          <div>
            <label className="block text-[10px] uppercase font-mono text-slate-400 mb-1">To Timestamp</label>
            <input
              type="datetime-local"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-full bg-graphite-800 border border-graphite-700 rounded px-2 py-1.5 font-mono text-slate-200 focus:border-cctv-amber focus:outline-none"
            />
          </div>

          {/* Confidence Slider or Plate Filter */}
          {activeTab === 'spatial' ? (
            <div>
              <div className="flex justify-between text-[10px] uppercase font-mono text-slate-400 mb-1">
                <span>Min Confidence</span>
                <span className="text-cctv-amber">{Math.round(minConfidence * 100)}%</span>
              </div>
              <input
                type="range"
                min="0.1"
                max="1.0"
                step="0.05"
                value={minConfidence}
                onChange={(e) => setMinConfidence(parseFloat(e.target.value))}
                className="w-full accent-amber-500 mt-2"
              />
            </div>
          ) : (
            <div>
              <label className="block text-[10px] uppercase font-mono text-slate-400 mb-1">Watchlist Category</label>
              <select
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value)}
                className="w-full bg-graphite-800 border border-graphite-700 rounded px-2 py-1.5 font-mono text-slate-200 focus:border-cctv-teal focus:outline-none"
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
            <div className="p-3 bg-red-500/20 border border-red-500/50 rounded text-red-200 text-xs flex items-center space-x-2">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          {activeTab === 'spatial' ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {/* ROI Canvas Selector */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                    Draw Region of Interest (ROI)
                  </span>
                  <span className="text-[10px] font-mono text-cctv-amber">
                    Click & Drag to define bounding box
                  </span>
                </div>
                <div className="relative rounded border border-graphite-700 overflow-hidden bg-black aspect-video flex items-center justify-center">
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
                  <div className="text-[11px] font-mono text-slate-400">
                    Box: X:{roiBox.x} Y:{roiBox.y} W:{roiBox.width} H:{roiBox.height}
                  </div>
                  <button
                    onClick={handleExecuteSpatialSearch}
                    disabled={searching}
                    className="flex items-center space-x-1.5 px-4 py-2 rounded bg-cctv-amber text-graphite-900 font-bold text-xs hover:bg-amber-400 transition disabled:opacity-50"
                  >
                    <Search className="w-3.5 h-3.5" />
                    <span>{searching ? 'Querying Index...' : 'Run Spatial Search'}</span>
                  </button>
                </div>
              </div>

              {/* Spatial Results Feed */}
              <div className="flex flex-col h-full min-h-[300px]">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                    Intersects Found ({spatialResults.length})
                  </span>
                </div>

                <div className="flex-1 bg-graphite-900 border border-graphite-700 rounded p-2 overflow-y-auto space-y-2 max-h-[340px]">
                  {spatialResults.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-slate-500 py-10 font-mono text-xs">
                      <Crosshair className="w-8 h-8 mb-2 opacity-40" />
                      <span>No detection events match ROI yet</span>
                      <span className="text-[10px] text-slate-600 mt-1">Adjust ROI or widen time window</span>
                    </div>
                  ) : (
                    spatialResults.map((event) => (
                      <div
                        key={event.id}
                        className="bg-graphite-800 p-2.5 rounded border border-graphite-700 hover:border-cctv-amber/60 transition flex items-center justify-between text-xs"
                      >
                        <div className="flex items-center space-x-3">
                          <div className="w-2 h-2 rounded-full bg-cctv-amber" />
                          <div>
                            <div className="font-semibold text-slate-200 flex items-center space-x-2">
                              <span>{event.type}</span>
                              <span className="text-[10px] px-1.5 py-[2px] rounded bg-cctv-teal/20 text-cctv-teal border border-cctv-teal/40 font-mono">
                                {Math.round(event.confidence * 100)}% conf
                              </span>
                            </div>
                            <div className="text-[10px] font-mono text-slate-400 mt-0.5 flex items-center space-x-1">
                              <Clock className="w-3 h-3 text-slate-500" />
                              <span>{new Date(event.timestamp).toLocaleString()}</span>
                            </div>
                          </div>
                        </div>

                        {onSeekToTimestamp && (
                          <button
                            onClick={() => {
                              onSeekToTimestamp(event.timestamp);
                              onClose();
                            }}
                            className="flex items-center space-x-1 px-2.5 py-1 rounded bg-graphite-700 hover:bg-cctv-amber hover:text-graphite-900 text-[11px] font-medium transition"
                          >
                            <span>Seek</span>
                            <ArrowRight className="w-3 h-3" />
                          </button>
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
                    className="w-full bg-graphite-900 border border-graphite-700 rounded px-3 py-2 font-mono text-xs uppercase tracking-wider text-slate-100 focus:border-cctv-teal focus:outline-none"
                  />
                  <Car className="w-4 h-4 text-slate-500 absolute right-3 top-2.5" />
                </div>
                <button
                  onClick={handleExecutePlateSearch}
                  disabled={searching}
                  className="flex items-center space-x-1.5 px-5 py-2 rounded bg-cctv-teal text-graphite-900 font-bold text-xs hover:bg-teal-400 transition disabled:opacity-50"
                >
                  <Search className="w-3.5 h-3.5" />
                  <span>{searching ? 'Searching...' : 'Find Vehicles'}</span>
                </button>
              </div>

              {/* Plate Results List */}
              <div className="bg-graphite-900 border border-graphite-700 rounded overflow-hidden">
                <div className="px-4 py-2.5 border-b border-graphite-700 bg-graphite-850 flex justify-between items-center text-xs font-semibold text-slate-300">
                  <span>Detected Vehicle Observations ({plateResults.length})</span>
                </div>

                <div className="divide-y divide-graphite-800 max-h-[360px] overflow-y-auto">
                  {plateResults.length === 0 ? (
                    <div className="p-8 text-center text-slate-500 font-mono text-xs">
                      No vehicles found matching query filter. Enter wildcard like "DL*" or select a time range.
                    </div>
                  ) : (
                    plateResults.map((obs) => (
                      <div key={obs.id} className="p-3 hover:bg-graphite-800/60 transition flex items-center justify-between text-xs">
                        <div className="flex items-center space-x-4">
                          {/* Plate Badge */}
                          <div className="bg-graphite-950 border border-slate-700 rounded px-2.5 py-1 font-mono text-sm font-bold tracking-widest text-slate-100 flex items-center space-x-2">
                            <span className="text-[10px] text-cctv-amber font-normal">IND</span>
                            <span>{obs.plateNumber}</span>
                          </div>

                          <div>
                            <div className="flex items-center space-x-2">
                              <span className="font-medium text-slate-200">{obs.stateName || 'Indian Vehicle'}</span>
                              <span className="text-[10px] px-1.5 py-[2px] rounded bg-graphite-700 font-mono text-slate-300">
                                {obs.category || 'CAR'}
                              </span>
                              {obs.isWatchlistMatch && (
                                <span className="text-[10px] px-1.5 py-[2px] rounded bg-red-500/20 text-red-400 border border-red-500/40 font-bold uppercase">
                                  Watchlist Hit
                                </span>
                              )}
                            </div>
                            <div className="text-[10px] font-mono text-slate-400 mt-0.5">
                              Seen {obs.observationCount}x • Best Conf: {Math.round(obs.bestConfidence * 100)}% • Last Seen: {new Date(obs.lastSeen).toLocaleString()}
                            </div>
                          </div>
                        </div>

                        {onSeekToTimestamp && (
                          <button
                            onClick={() => {
                              onSeekToTimestamp(obs.lastSeen);
                              onClose();
                            }}
                            className="flex items-center space-x-1 px-3 py-1 rounded bg-graphite-700 hover:bg-cctv-teal hover:text-graphite-900 text-xs font-semibold transition"
                          >
                            <span>Jump to Footage</span>
                            <ArrowRight className="w-3.5 h-3.5" />
                          </button>
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
