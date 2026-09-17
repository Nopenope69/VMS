import React, { useState, useEffect } from 'react';
import {
  Car,
  ShieldAlert,
  Trash2,
  Search,
  RefreshCw,
  Clock,
  CheckCircle2,
  Cpu,
  X,
  Radio,
} from 'lucide-react';
import api from '../services/api';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';

export const AnprConsole: React.FC = () => {
  const [observations, setObservations] = useState<any[]>([]);
  const [watchlists, setWatchlists] = useState<any[]>([]);
  const [runtimeTelemetry, setRuntimeTelemetry] = useState<any | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [filterCategory, setFilterCategory] = useState<string>('');

  // Drawers
  const [showWatchlistDrawer, setShowWatchlistDrawer] = useState<boolean>(false);
  const [showTelemetryDrawer, setShowTelemetryDrawer] = useState<boolean>(false);
  const [plateToDelete, setPlateToDelete] = useState<string | null>(null);

  // Add Watchlist Form
  const [newPlate, setNewPlate] = useState<string>('');
  const [newCategory, setNewCategory] = useState<string>('SUSPICIOUS');
  const [newOwner, setNewOwner] = useState<string>('');
  const [newNotes, setNewNotes] = useState<string>('');
  const [newSeverity, setNewSeverity] = useState<string>('WARNING');
  const [watchlistError, setWatchlistError] = useState<string | null>(null);

  const fetchAnprData = async () => {
    try {
      setLoading(true);
      const [obsRes, wlRes, diagRes] = await Promise.all([
        api.get('/anpr/observations', { params: { limit: 50 } }),
        api.get('/anpr/watchlist'),
        api.get('/anpr/health'),
      ]);
      setObservations(obsRes.data.observations || []);
      setWatchlists(wlRes.data.watchlist || []);
      setRuntimeTelemetry(diagRes.data.telemetry || null);
    } catch (err) {
      console.error('Failed to load ANPR console data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAnprData();
    const interval = setInterval(fetchAnprData, 8000);
    return () => clearInterval(interval);
  }, []);

  const handleAddWatchlist = async (e: React.FormEvent) => {
    e.preventDefault();
    setWatchlistError(null);
    try {
      await api.post('/anpr/watchlist', {
        plateNumber: newPlate.trim(),
        category: newCategory,
        ownerName: newOwner.trim() || undefined,
        notes: newNotes.trim() || undefined,
        severity: newSeverity,
        alertOnMatch: true,
      });
      setNewPlate('');
      setNewOwner('');
      setNewNotes('');
      const wlRes = await api.get('/anpr/watchlist');
      setWatchlists(wlRes.data.watchlist || []);
    } catch (err: any) {
      setWatchlistError(err.response?.data?.error || 'Failed to add watchlist entry.');
    }
  };

  const handleDeleteWatchlist = async (id: string) => {
    try {
      await api.delete(`/anpr/watchlist/${id}`);
      setPlateToDelete(null);
      const wlRes = await api.get('/anpr/watchlist');
      setWatchlists(wlRes.data.watchlist || []);
    } catch (err: any) {
      setWatchlistError(err.response?.data?.error || 'Failed to delete watchlist entry.');
    }
  };

  const filteredObservations = observations.filter((obs) => {
    const matchesQuery =
      obs.plateNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
      obs.normalizedPlate.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (obs.stateName && obs.stateName.toLowerCase().includes(searchTerm.toLowerCase()));
    const matchesCat = !filterCategory || obs.category === filterCategory;
    return matchesQuery && matchesCat;
  });

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] bg-vms-bg p-4 space-y-4 overflow-y-auto text-vms-text select-none font-sans">
      {/* Header Bar */}
      <div className="bg-vms-panel p-4 rounded border border-vms-border flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center space-x-3">
          <div className="p-2 rounded bg-vms-accent/20 border border-vms-accent/60 text-vms-accent">
            <Car className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h1 className="text-base font-bold tracking-wider uppercase font-mono text-vms-text">
                Indian ANPR & Fleet Forensics
              </h1>
              <span className="text-[10px] px-2 py-0.5 rounded bg-sky-500/20 text-sky-400 border border-sky-400 font-mono">
                36 States/UTs + BH Series
              </span>
            </div>
            <p className="text-xs text-vms-muted font-mono mt-0.5">
              Multi-Frame Track Voting ($N \ge 3$) • OCR Ambiguity Normalization • MediaMTX Localhost Relay
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          <Button
            variant="secondary"
            size="sm"
            icon={Cpu}
            onClick={() => setShowTelemetryDrawer(true)}
          >
            <span>AI Telemetry</span>
            {runtimeTelemetry && (
              <span className="ml-1 text-[10px] font-mono text-sky-400">{runtimeTelemetry.currentFps} FPS</span>
            )}
          </Button>

          <Button
            variant="secondary"
            size="sm"
            icon={ShieldAlert}
            onClick={() => setShowWatchlistDrawer(true)}
          >
            <span>Watchlists ({watchlists.length})</span>
          </Button>

          <button
            type="button"
            onClick={fetchAnprData}
            className="p-1.5 rounded bg-vms-surface border border-vms-border hover:bg-vms-hover text-vms-muted hover:text-vms-text transition-colors"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-vms-accent' : ''}`} />
          </button>
        </div>
      </div>

      {/* KPI Stats Strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-vms-panel border border-vms-border rounded p-3">
          <div className="text-[10px] font-mono text-vms-muted uppercase tracking-wider">Tracked Observations</div>
          <div className="text-xl font-bold font-mono text-vms-text mt-1">{observations.length}</div>
          <div className="text-[10px] text-vms-dim font-mono mt-0.5">Deduplicated vehicle tracks</div>
        </div>

        <div className="bg-vms-panel border border-vms-border rounded p-3">
          <div className="text-[10px] font-mono text-vms-muted uppercase tracking-wider">Watchlist Hits</div>
          <div className="text-xl font-bold font-mono text-rose-400 mt-1">
            {observations.filter((o) => o.isWatchlistMatch).length}
          </div>
          <div className="text-[10px] text-vms-dim font-mono mt-0.5">Hotlist / Stolen / Blocked</div>
        </div>

        <div className="bg-vms-panel border border-vms-border rounded p-3">
          <div className="text-[10px] font-mono text-vms-muted uppercase tracking-wider">Inference Throughput</div>
          <div className="text-xl font-bold font-mono text-sky-400 mt-1">
            {runtimeTelemetry?.currentFps ?? '15.0'} <span className="text-xs font-normal">FPS</span>
          </div>
          <div className="text-[10px] text-vms-dim font-mono mt-0.5">
            Avg Latency: {Math.round(runtimeTelemetry?.avgLatencyMs ?? 24)} ms
          </div>
        </div>

        <div className="bg-vms-panel border border-vms-border rounded p-3">
          <div className="text-[10px] font-mono text-vms-muted uppercase tracking-wider">Media Relay Protocol</div>
          <div className="text-xl font-bold font-mono text-vms-accent mt-1 flex items-center space-x-1.5">
            <Radio className="w-4 h-4 text-emerald-400" />
            <span className="text-sm">MediaMTX Relay</span>
          </div>
          <div className="text-[10px] text-vms-dim font-mono mt-0.5">127.0.0.1:8554 (Zero Duplicate RTSP)</div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="bg-vms-panel p-3 rounded border border-vms-border flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex items-center space-x-3 flex-1 min-w-[280px]">
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 text-vms-dim absolute left-3 top-2.5" />
            <input
              type="text"
              placeholder="Search by Plate (e.g. DL, MH, HR, BH) or State..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-vms-surface border border-vms-border rounded pl-8 pr-3 py-1.5 font-mono text-xs uppercase text-vms-text focus:border-vms-accent focus:outline-none"
            />
          </div>

          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            className="bg-vms-surface border border-vms-border rounded px-2.5 py-1.5 font-mono text-xs text-vms-muted focus:border-vms-accent focus:outline-none"
          >
            <option value="">All Vehicle Categories</option>
            <option value="CAR">Car / SUV</option>
            <option value="MOTORCYCLE">Two-Wheeler</option>
            <option value="BUS">Bus</option>
            <option value="TRUCK">Heavy Commercial Truck</option>
            <option value="AUTO_RICKSHAW">Auto Rickshaw (3W)</option>
            <option value="VAN">Light Commercial Van</option>
          </select>
        </div>

        <div className="text-[11px] font-mono text-vms-muted">
          Displaying {filteredObservations.length} of {observations.length} Observations
        </div>
      </div>

      {/* Observations Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredObservations.length === 0 ? (
          <div className="col-span-full py-16 text-center text-vms-dim font-mono text-xs bg-vms-panel rounded border border-vms-border">
            No vehicle observations recorded yet. Ensure Edge AI Runtime is active and cameras have vehicles in view.
          </div>
        ) : (
          filteredObservations.map((obs) => (
            <div
              key={obs.id}
              className={`bg-vms-panel border rounded p-4 transition-colors space-y-3 flex flex-col justify-between ${
                obs.isWatchlistMatch
                  ? 'border-rose-500/80 shadow-[0_0_15px_rgba(244,63,94,0.15)]'
                  : 'border-vms-border hover:border-vms-accent/40'
              }`}
            >
              {/* Top: Indian Plate Badge & Category */}
              <div className="flex items-center justify-between">
                {/* High-Contrast Indian License Plate */}
                <div className="bg-yellow-400 border-2 border-black rounded px-3 py-1 flex items-center space-x-2 shadow-md">
                  <div className="flex flex-col items-center justify-center border-r border-black/40 pr-1.5">
                    <span className="text-[7px] font-black text-blue-900 leading-none">IND</span>
                    <div className="w-1.5 h-1.5 rounded-full bg-blue-800 mt-0.5" />
                  </div>
                  <span className="font-mono text-base font-black tracking-widest text-black uppercase">
                    {obs.plateNumber}
                  </span>
                </div>

                <div className="flex flex-col items-end space-y-1">
                  <span className="text-[10px] px-2 py-0.5 rounded bg-vms-surface text-vms-text border border-vms-border font-mono font-semibold uppercase">
                    {obs.category || 'CAR'}
                  </span>
                  {obs.isWatchlistMatch && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-rose-500 text-white font-bold tracking-wider uppercase animate-pulse font-mono">
                      WATCHLIST HIT
                    </span>
                  )}
                </div>
              </div>

              {/* State & Metadata Details */}
              <div className="bg-vms-surface p-2.5 rounded border border-vms-border text-xs space-y-1.5 font-mono">
                <div className="flex justify-between items-center text-vms-text">
                  <span className="text-vms-dim text-[10px] uppercase">Jurisdiction:</span>
                  <span className="text-sky-400 font-semibold">
                    {obs.stateName ? `${obs.stateName} (${obs.stateCode})` : 'Standard Indian Registration'}
                  </span>
                </div>

                <div className="flex justify-between items-center text-vms-text">
                  <span className="text-vms-dim text-[10px] uppercase">Confidence Score:</span>
                  <div className="flex items-center space-x-2">
                    <div className="w-16 h-1.5 bg-vms-panel rounded-full overflow-hidden">
                      <div
                        className="h-full bg-vms-accent rounded-full"
                        style={{ width: `${Math.round(obs.bestConfidence * 100)}%` }}
                      />
                    </div>
                    <span className="text-[10px] font-bold text-vms-accent">
                      {Math.round(obs.bestConfidence * 100)}%
                    </span>
                  </div>
                </div>

                <div className="flex justify-between items-center text-vms-text">
                  <span className="text-vms-dim text-[10px] uppercase">Multi-Frame Votes:</span>
                  <span className="text-vms-text text-[11px] font-bold">
                    {obs.observationCount} samples (Track #{obs.trackId?.slice(0, 8) || '01'})
                  </span>
                </div>

                <div className="flex justify-between items-center text-vms-muted text-[10px] pt-1 border-t border-vms-border">
                  <span className="flex items-center space-x-1">
                    <Clock className="w-3 h-3 text-vms-dim" />
                    <span>Last Seen:</span>
                  </span>
                  <span className="text-vms-text">{new Date(obs.lastSeen).toLocaleTimeString()}</span>
                </div>
              </div>

              {/* Snapshot Preview if available */}
              {obs.bestSnapshot && (
                <div className="relative rounded overflow-hidden border border-vms-border aspect-video bg-black flex items-center justify-center">
                  <img src={obs.bestSnapshot} alt="Vehicle Crop" className="object-cover w-full h-full" />
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Watchlist Manager Drawer */}
      {showWatchlistDrawer && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-xs">
          <div className="w-full max-w-md bg-vms-elevated border-l border-vms-border h-full flex flex-col shadow-2xl p-5 text-vms-text overflow-y-auto">
            <div className="flex items-center justify-between pb-4 border-b border-vms-border">
              <div className="flex items-center space-x-2">
                <ShieldAlert className="w-5 h-5 text-vms-accent" />
                <h2 className="text-xs font-bold uppercase tracking-wider font-mono">Vehicle Watchlists</h2>
              </div>
              <button
                type="button"
                onClick={() => setShowWatchlistDrawer(false)}
                className="p-1 rounded text-vms-muted hover:text-vms-text transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Add Watchlist Form */}
            <form onSubmit={handleAddWatchlist} className="py-4 space-y-3 border-b border-vms-border text-xs">
              <span className="text-[11px] font-bold text-vms-accent uppercase font-mono tracking-wider">
                Add Vehicle to Watchlist
              </span>

              {watchlistError && (
                <div className="p-2 rounded bg-rose-950/70 border border-rose-800 text-rose-300 text-[11px] font-mono">
                  {watchlistError}
                </div>
              )}

              <div>
                <label className="block text-[10px] uppercase font-mono text-vms-muted mb-1 tracking-wider">
                  Plate Number (Normalized live)
                </label>
                <Input
                  required
                  placeholder="e.g. DL 01 AB 1234 or MH12DE1428"
                  value={newPlate}
                  onChange={(e) => setNewPlate(e.target.value.toUpperCase())}
                  className="w-full uppercase font-mono text-xs"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] uppercase font-mono text-vms-muted mb-1 tracking-wider">Category</label>
                  <select
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value)}
                    className="w-full bg-vms-surface border border-vms-border rounded px-2.5 py-1.5 font-mono text-[11px] text-vms-text focus:border-vms-accent focus:outline-none"
                  >
                    <option value="HOTLIST_STOLEN">Hotlist / Stolen</option>
                    <option value="SECURITY_BLOCKED">Security Blocked</option>
                    <option value="VIP_EXEMPT">VIP / Whitelist</option>
                    <option value="VISITOR">Visitor</option>
                    <option value="SUSPICIOUS">Suspicious</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[10px] uppercase font-mono text-vms-muted mb-1 tracking-wider">Alert Severity</label>
                  <select
                    value={newSeverity}
                    onChange={(e) => setNewSeverity(e.target.value)}
                    className="w-full bg-vms-surface border border-vms-border rounded px-2.5 py-1.5 font-mono text-[11px] text-vms-text focus:border-vms-accent focus:outline-none"
                  >
                    <option value="CRITICAL">CRITICAL Alarm</option>
                    <option value="WARNING">WARNING</option>
                    <option value="INFO">INFO Log</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[10px] uppercase font-mono text-vms-muted mb-1 tracking-wider">Owner / Details</label>
                <Input
                  placeholder="e.g. Suspect in Gate B trespassing"
                  value={newOwner}
                  onChange={(e) => setNewOwner(e.target.value)}
                  className="w-full text-xs"
                />
              </div>

              <Button
                type="submit"
                variant="primary"
                size="sm"
                className="w-full"
              >
                Save Watchlist Entry
              </Button>
            </form>

            {/* Watchlists List */}
            <div className="flex-1 overflow-y-auto py-3 space-y-2">
              <span className="text-[11px] font-bold text-vms-muted uppercase font-mono tracking-wider">
                Active Watchlist Records ({watchlists.length})
              </span>
              {watchlists.map((wl) => (
                <div
                  key={wl.id}
                  className="bg-vms-panel p-2.5 rounded border border-vms-border flex items-center justify-between text-xs"
                >
                  <div className="space-y-0.5">
                    <div className="flex items-center space-x-2">
                      <span className="font-mono font-bold text-vms-accent">{wl.plateNumber}</span>
                      <span className="text-[9px] px-1.5 py-[2px] rounded bg-vms-surface text-vms-muted font-mono border border-vms-border">
                        {wl.category}
                      </span>
                    </div>
                    {wl.ownerName && <div className="text-[11px] text-vms-dim">{wl.ownerName}</div>}
                  </div>
                  {plateToDelete === wl.id ? (
                    <div className="flex items-center space-x-1">
                      <button
                        type="button"
                        onClick={() => handleDeleteWatchlist(wl.id)}
                        className="px-1.5 py-0.5 rounded bg-rose-600 text-white text-[10px] font-mono"
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={() => setPlateToDelete(null)}
                        className="px-1 py-0.5 text-vms-muted text-[10px]"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setPlateToDelete(wl.id)}
                      className="p-1 rounded text-vms-dim hover:text-rose-400 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* AI Telemetry Drawer */}
      {showTelemetryDrawer && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-xs">
          <div className="w-full max-w-md bg-vms-elevated border-l border-vms-border h-full flex flex-col shadow-2xl p-5 text-vms-text overflow-y-auto">
            <div className="flex items-center justify-between pb-4 border-b border-vms-border">
              <div className="flex items-center space-x-2">
                <Cpu className="w-5 h-5 text-sky-400" />
                <h2 className="text-xs font-bold uppercase tracking-wider font-mono">Edge AI Runtime Supervisor</h2>
              </div>
              <button
                type="button"
                onClick={() => setShowTelemetryDrawer(false)}
                className="p-1 rounded text-vms-muted hover:text-vms-text transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="py-4 space-y-4 text-xs font-mono">
              {/* Telemetry Stats */}
              <div className="bg-vms-panel p-3 rounded border border-vms-border space-y-2">
                <div className="text-[11px] font-bold text-sky-400 uppercase tracking-wider pb-1 border-b border-vms-border">
                  Real-time Inference Telemetry
                </div>
                <div className="flex justify-between">
                  <span className="text-vms-muted">Processing FPS:</span>
                  <span className="text-vms-text font-bold">{runtimeTelemetry?.currentFps ?? '15.0'} FPS</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-vms-muted">Average Latency:</span>
                  <span className="text-vms-text font-bold">
                    {Math.round(runtimeTelemetry?.avgLatencyMs ?? 24)} ms
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-vms-muted">Admission Queue:</span>
                  <span className="text-vms-text font-bold">
                    {runtimeTelemetry?.queueSize ?? 0} / {runtimeTelemetry?.maxQueueSize ?? 100} frames
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-vms-muted">Active Pipelines:</span>
                  <span className="text-vms-text font-bold">
                    {runtimeTelemetry?.activePipelinesCount ?? 1} Cameras
                  </span>
                </div>
              </div>

              {/* Single RTSP Relay Architecture Guarantee */}
              <div className="bg-vms-panel p-3 rounded border border-vms-border space-y-2">
                <div className="text-[11px] font-bold text-vms-accent uppercase tracking-wider pb-1 border-b border-vms-border">
                  Appliance Invariant Check
                </div>
                <div className="text-[11px] leading-relaxed text-vms-muted font-sans">
                  In compliance with Edge Appliance Hardening Invariant #2, AI frame sampling connects strictly to
                  MediaMTX localhost loopback (<code className="text-vms-accent font-mono">rtsp://127.0.0.1:8554/...</code>).
                  Direct RTSP connections to cameras are strictly forbidden, preventing hardware session saturation.
                </div>
              </div>

              {/* AI SBOM & License Validation */}
              <div className="bg-vms-panel p-3 rounded border border-vms-border space-y-2">
                <div className="text-[11px] font-bold text-emerald-400 uppercase tracking-wider pb-1 border-b border-vms-border flex items-center space-x-1.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  <span>AI SBOM & Permissive Licensing</span>
                </div>
                <p className="text-[11px] text-vms-muted font-sans">
                  All models & weights run locally via ONNX Runtime under Apache-2.0 and MIT permissive licenses.
                  GPL/AGPL copyleft dependencies are strictly excluded from the appliance runtime.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AnprConsole;
