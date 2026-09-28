import React, { useState, useEffect } from 'react';
import {
  Car,
  ShieldAlert,
  Trash2,
  Search,
  RefreshCw,
  Clock,
  Cpu,
  X,
  Video,
} from 'lucide-react';
import api from '../services/api';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';

const PURPOSES: Array<{ id: string; label: string; needsReference: boolean }> = [
  { id: 'SECURITY_INCIDENT_INVESTIGATION', label: 'Security incident investigation', needsReference: false },
  { id: 'LAW_ENFORCEMENT_REQUEST', label: 'Law-enforcement request', needsReference: true },
  { id: 'ACCESS_CONTROL', label: 'Access control', needsReference: false },
  { id: 'SAFETY_EMERGENCY', label: 'Safety emergency', needsReference: false },
  { id: 'LEGAL_CLAIM', label: 'Legal claim', needsReference: true },
  { id: 'AUDIT_REVIEW', label: 'Audit review', needsReference: false },
];

const readSession = (k: string) => {
  try {
    return sessionStorage.getItem(k) || '';
  } catch {
    return '';
  }
};

export const AnprConsole: React.FC = () => {
  // DPDP (P4.6): plate data is shown only for a declared purpose, which the backend audits.
  const [purpose, setPurpose] = useState<string>(() => readSession('vigilone.anpr.purpose'));
  const [purposeRef, setPurposeRef] = useState<string>(() => readSession('vigilone.anpr.purposeRef'));
  const [accessError, setAccessError] = useState<string | null>(null);
  const purposeDef = PURPOSES.find((p) => p.id === purpose);
  const purposeReady = Boolean(purposeDef) && (!purposeDef!.needsReference || purposeRef.trim().length > 0);
  const purposeHeaders = () => ({ 'X-VigilOne-Purpose': purpose, ...(purposeRef.trim() ? { 'X-VigilOne-Purpose-Reference': purposeRef.trim() } : {}) });
  const [observations, setObservations] = useState<any[]>([]);
  const [watchlists, setWatchlists] = useState<any[]>([]);
  const [anprStatus, setAnprStatus] = useState<any | null>(null);
  const [cameras, setCameras] = useState<any[]>([]);
  const [lprError, setLprError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [filterCategory, setFilterCategory] = useState<string>('');

  // Drawers
  const [showWatchlistDrawer, setShowWatchlistDrawer] = useState<boolean>(false);
  const [showTelemetryDrawer, setShowTelemetryDrawer] = useState<boolean>(false);
  const [plateToDelete, setPlateToDelete] = useState<string | null>(null);

  // Add Watchlist Form
  const [newPlate, setNewPlate] = useState<string>('');
  const [newCategory, setNewCategory] = useState<string>('SUSPECT');
  const [newMatchType, setNewMatchType] = useState<'EXACT' | 'WILDCARD' | 'REGEX'>('EXACT');
  const [newOwner, setNewOwner] = useState<string>('');
  const [newNotes, setNewNotes] = useState<string>('');
  const [newSeverity, setNewSeverity] = useState<string>('WARNING');
  const [watchlistError, setWatchlistError] = useState<string | null>(null);

  const fetchAnprData = async () => {
    try {
      setLoading(true);
      const statusRes = await api.get('/anpr/health');
      setAnprStatus(statusRes.data.status || null);
      if (!purposeReady) return;
      const [obsRes, wlRes] = await Promise.all([
        api.get('/anpr/observations', { params: { limit: 50 }, headers: purposeHeaders() }),
        api.get('/anpr/watchlist', { headers: purposeHeaders() }),
      ]);
      setObservations(obsRes.data.observations || []);
      setWatchlists(wlRes.data.watchlist || []);
      setAccessError(null);
    } catch (err: any) {
      const code = err?.response?.data?.code;
      if (err?.response?.status === 403 || (code && String(code).startsWith('PURPOSE_'))) {
        setAccessError(err.response.data.error || 'Access to plate data was refused');
        setObservations([]);
        setWatchlists([]);
      }
      console.error('Failed to load ANPR console data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    try {
      sessionStorage.setItem('vigilone.anpr.purpose', purpose);
      sessionStorage.setItem('vigilone.anpr.purposeRef', purposeRef);
    } catch {
      // per-tab convenience only
    }
    if (!purposeReady) {
      setObservations([]);
      setWatchlists([]);
    }
    fetchAnprData();
    const interval = setInterval(fetchAnprData, 8000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [purpose, purposeRef]);

  const handleAddWatchlist = async (e: React.FormEvent) => {
    e.preventDefault();
    setWatchlistError(null);
    try {
      await api.post('/anpr/watchlist', {
        plateNumber: newPlate.trim(),
        matchType: newMatchType,
        category: newCategory,
        ownerName: newOwner.trim() || undefined,
        notes: newNotes.trim() || undefined,
        severity: newSeverity,
        alertOnMatch: true,
      });
      setNewPlate('');
      setNewOwner('');
      setNewNotes('');
      const wlRes = await api.get('/anpr/watchlist', { headers: purposeHeaders() });
      setWatchlists(wlRes.data.watchlist || []);
    } catch (err: any) {
      setWatchlistError(err.response?.data?.error || 'Failed to add watchlist entry.');
    }
  };

  const handleDeleteWatchlist = async (id: string) => {
    try {
      await api.delete(`/anpr/watchlist/${id}`);
      setPlateToDelete(null);
      const wlRes = await api.get('/anpr/watchlist', { headers: purposeHeaders() });
      setWatchlists(wlRes.data.watchlist || []);
    } catch (err: any) {
      setWatchlistError(err.response?.data?.error || 'Failed to delete watchlist entry.');
    }
  };

  const openStatusDrawer = async () => {
    setShowTelemetryDrawer(true);
    setLprError(null);
    try {
      const res = await api.get('/cameras');
      setCameras(res.data.cameras || []);
    } catch (err: any) {
      setLprError(err?.response?.data?.error || 'Failed to load cameras');
    }
  };

  const setLprMode = async (camera: any, lprMode: boolean) => {
    setLprError(null);
    try {
      const existing = (anprStatus?.lprCameras || []).find((c: any) => c.id === camera.id)?.lprConfigJson || {};
      await api.put(`/anpr/cameras/${camera.id}/lpr`, { ...existing, lprMode });
      await Promise.all([openStatusDrawer(), fetchAnprData()]);
    } catch (err: any) {
      setLprError(err?.response?.data?.error || 'Failed to change LPR mode');
    }
  };

  const lprCameraIds = new Set((anprStatus?.lprCameras || []).map((c: any) => c.id));
  const activePipeline = anprStatus?.pipelines?.[0] ?? null;

  const filteredObservations = observations.filter((obs) => {
    const matchesQuery =
      obs.plateNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
      obs.normalizedPlate.toLowerCase().includes(searchTerm.toLowerCase().replace(/[^a-z0-9]/g, '')) ||
      (obs.stateCode && obs.stateCode.toLowerCase().includes(searchTerm.toLowerCase()));
    const matchesCat = !filterCategory || obs.vehicleCategory === filterCategory;
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
                Indian formats: State/UT, BH, diplomatic
              </span>
            </div>
            <p className="text-xs text-vms-muted font-mono mt-0.5">
              Multi-frame voting per plate session • positional letter/digit correction • LPR cameras via MediaMTX loopback
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          <Button
            variant="secondary"
            size="sm"
            icon={Cpu}
            onClick={openStatusDrawer}
          >
            <span>Pipeline & LPR cameras</span>
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

      {/* Purpose of access (DPDP): required before any plate data is loaded; every query is audited */}
      <div className="bg-vms-panel p-3 rounded border border-vms-border flex flex-wrap items-center gap-3 text-xs">
        <span className="font-mono uppercase tracking-wider text-vms-muted">Purpose of access</span>
        <select
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          className="bg-vms-surface border border-vms-border rounded px-2 py-1 text-vms-text"
        >
          <option value="">Select a purpose…</option>
          {PURPOSES.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        {purposeDef?.needsReference && (
          <input
            value={purposeRef}
            onChange={(e) => setPurposeRef(e.target.value)}
            placeholder="Case / request reference (required)"
            maxLength={200}
            className="bg-vms-surface border border-vms-border rounded px-2 py-1 text-vms-text w-64"
          />
        )}
        <span className="text-vms-dim">
          {purposeReady ? 'Plate queries are logged with this purpose.' : 'Plate reads and known-plate lists stay hidden until a purpose is declared.'}
        </span>
        {accessError && <span className="text-rose-400">{accessError}</span>}
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
            {observations.filter((o) => o.matchedWatchlist).length}
          </div>
          <div className="text-[10px] text-vms-dim font-mono mt-0.5">Hotlist / Stolen / Blocked</div>
        </div>

        <div className="bg-vms-panel border border-vms-border rounded p-3">
          <div className="text-[10px] font-mono text-vms-muted uppercase tracking-wider">Reads (last hour)</div>
          <div className="text-xl font-bold font-mono text-sky-400 mt-1">{anprStatus ? anprStatus.readsLastHour : '—'}</div>
          <div className="text-[10px] text-vms-dim font-mono mt-0.5">
            Last read: {anprStatus?.lastReadAt ? new Date(anprStatus.lastReadAt).toLocaleString() : 'none recorded'}
          </div>
        </div>

        <div className="bg-vms-panel border border-vms-border rounded p-3">
          <div className="text-[10px] font-mono text-vms-muted uppercase tracking-wider">Recognition pipeline</div>
          <div className="text-sm font-bold font-mono mt-1 flex items-center space-x-1.5">
            <Video className="w-4 h-4 text-vms-accent" />
            <span className={activePipeline ? 'text-vms-accent' : 'text-amber-400'}>
              {activePipeline ? `${activePipeline.name} ${activePipeline.version}` : 'Not registered'}
            </span>
          </div>
          <div className="text-[10px] text-vms-dim font-mono mt-0.5">{anprStatus ? `${lprCameraIds.size} LPR camera(s)` : '—'}</div>
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
            <option value="TWO_WHEELER">Two-wheeler</option>
            <option value="FOUR_WHEELER">Four-wheeler</option>
            <option value="HEAVY_COMMERCIAL">Heavy commercial</option>
            <option value="EMERGENCY">Emergency</option>
            <option value="UNKNOWN">Unknown</option>
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
                obs.matchedWatchlist
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
                    {obs.vehicleCategory || 'UNKNOWN'}
                  </span>
                  {obs.matchedWatchlist && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-rose-500 text-white font-bold tracking-wider uppercase animate-pulse font-mono">
                      {obs.matchedWatchlist.category} LIST
                    </span>
                  )}
                </div>
              </div>

              {/* State & Metadata Details */}
              <div className="bg-vms-surface p-2.5 rounded border border-vms-border text-xs space-y-1.5 font-mono">
                <div className="flex justify-between items-center text-vms-text">
                  <span className="text-vms-dim text-[10px] uppercase">Jurisdiction:</span>
                  <span className="text-sky-400 font-semibold">
                    {obs.plateFormat === 'BH' ? 'Bharat series (BH)' : obs.plateFormat === 'DIPLOMATIC' ? 'Diplomatic' : obs.stateCode || 'Format not recognised'}
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
                    {obs.observationCount} read{obs.observationCount === 1 ? '' : 's'}{obs.lines === 2 ? ' (two-line plate)' : ''}
                  </span>
                </div>

                <div className="flex justify-between items-center text-vms-muted text-[10px] pt-1 border-t border-vms-border">
                  <span className="flex items-center space-x-1">
                    <Clock className="w-3 h-3 text-vms-dim" />
                    <span>Last Seen:</span>
                  </span>
                  <span className="text-vms-text">{new Date(obs.lastSeenAt).toLocaleString()}</span>
                </div>
                {obs.provenanceJson && (
                  <div className="text-[10px] text-vms-dim truncate" title={JSON.stringify(obs.provenanceJson.components || [])}>
                    read by {obs.provenanceJson.modelName} {obs.provenanceJson.modelVersion} ({String(obs.provenanceJson.modelSha256).slice(0, 12)})
                  </div>
                )}
              </div>

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
                <div className="flex gap-2 mb-1">
                  {(['EXACT', 'WILDCARD', 'REGEX'] as const).map((m) => (
                    <label key={m} className="flex items-center gap-1 text-[10px] font-mono text-vms-muted">
                      <input type="radio" checked={newMatchType === m} onChange={() => setNewMatchType(m)} />
                      {m === 'EXACT' ? 'Exact plate' : m === 'WILDCARD' ? 'Wildcard (* ?)' : 'Pattern (regex)'}
                    </label>
                  ))}
                </div>
                <label className="block text-[10px] uppercase font-mono text-vms-muted mb-1 tracking-wider">
                  {newMatchType === 'EXACT' ? 'Plate number' : 'Pattern'}
                </label>
                <Input
                  required
                  placeholder={newMatchType === 'EXACT' ? 'e.g. DL 01 AB 1234 or 22 BH 4567 AA' : newMatchType === 'WILDCARD' ? 'e.g. MH12* or KA05?7788' : 'e.g. [0-9]{2}BH[0-9]{4}[A-Z]{1,2}'}
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
                    <option value="BLACKLIST">Blacklist</option>
                    <option value="SUSPECT">Suspect</option>
                    <option value="VIP">VIP</option>
                    <option value="WHITELIST">Whitelist</option>
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
                      {wl.matchType && wl.matchType !== 'EXACT' && (
                        <span className="text-[9px] px-1.5 py-[2px] rounded bg-sky-900/40 text-sky-300 font-mono border border-sky-800">{wl.matchType}</span>
                      )}
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
                <h2 className="text-xs font-bold uppercase tracking-wider font-mono">ANPR pipeline & LPR cameras</h2>
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
              <div className="bg-vms-panel p-3 rounded border border-vms-border space-y-2">
                <div className="text-[11px] font-bold text-sky-400 uppercase tracking-wider pb-1 border-b border-vms-border">
                  Registered plate_recognition pipelines
                </div>
                {(anprStatus?.pipelines || []).length === 0 && (
                  <p className="text-amber-400 font-sans text-[11px]">
                    No ANPR pipeline is registered. The anpr-worker registers one at start-up once its candidate models
                    have a recorded licence approval.
                  </p>
                )}
                {(anprStatus?.pipelines || []).map((p: any) => (
                  <div key={p.sha256} className="space-y-0.5">
                    <div className="text-vms-text font-bold">{p.name} {p.version}</div>
                    <div className="text-[10px] text-vms-dim break-all">sha256 {p.sha256}</div>
                  </div>
                ))}
                <p className="text-[10px] text-vms-dim font-sans">
                  Throughput and latency are exported by the anpr-worker at /metrics (vigilone_anpr_*).
                </p>
              </div>

              <div className="bg-vms-panel p-3 rounded border border-vms-border space-y-2">
                <div className="text-[11px] font-bold text-vms-accent uppercase tracking-wider pb-1 border-b border-vms-border">
                  LPR cameras
                </div>
                <p className="text-[11px] text-vms-muted font-sans">
                  Plates are read only on cameras in LPR mode. Frames come from the MediaMTX loopback, so no second
                  RTSP session is opened to the camera. Every change is audited.
                </p>
                {lprError && <p className="text-rose-400 text-[11px]">{lprError}</p>}
                {cameras.map((c: any) => (
                  <label key={c.id} className="flex items-center justify-between py-1 border-b border-vms-border/40">
                    <span className="text-vms-text">{c.name}</span>
                    <input
                      type="checkbox"
                      checked={lprCameraIds.has(c.id)}
                      onChange={(e) => setLprMode(c, e.target.checked)}
                    />
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AnprConsole;
