import React, { useState, useEffect } from 'react';
import {
  HardDrive,
  AlertTriangle,
  CheckCircle,
  RefreshCw,
  Plus,
  Shield,
  Clock,
  Activity,
  Layers,
  FileCheck,
  AlertOctagon,
  Wrench,
  Sliders,
} from 'lucide-react';
import api from '../services/api';

export interface VolumeReport {
  id: string;
  name: string;
  path: string;
  deviceIdentifier: string | null;
  mountSource: string | null;
  filesystemType: string | null;
  isDefault: boolean;
  isReadOnly: boolean;
  status: 'HEALTHY' | 'DEGRADED' | 'READ_ONLY' | 'UNMOUNTED';
  sizeBytes: string;
  freeBytes: string;
  usedBytes: string;
  fillRatio: number;
  healthReason: string | null;
  cameraCount: number;
}

export interface CameraBreakdown {
  id: string;
  name: string;
  streamPath: string;
  recordingMode: string;
  effectiveRecordingMode: string;
  degradationReason: string;
  retentionPriority: 'HIGH' | 'NORMAL' | 'LOW';
  segmentCount: number;
  usedBytes: string;
  retentionDays: number;
  motionDays: number;
  maxStorageGigabytes: number | null;
}

export interface StorageStatus {
  state:
    | 'AVAILABLE'
    | 'WARNING'
    | 'CRITICAL'
    | 'EMERGENCY_PURGE'
    | 'EMERGENCY_PRESERVE_EVIDENCE'
    | 'PINNED_STORAGE_EXHAUSTION';
  sizeBytes: string;
  freeBytes: string;
  usedBytes: string;
  pinnedBytes: string;
  fillRatio: number;
  writeRateBytesPerHour: number;
  projectedExhaustionHours: number | null;
  cameraStats: {
    total: number;
    healthy: number;
    degraded: number;
    stopped: number;
  };
  cameraBreakdown: CameraBreakdown[];
  lastRecovery: {
    timestamp: string;
    filesExamined: number;
    filesRecovered: number;
    filesQuarantined: number;
    filesMissing: number;
    zeroBytePruned: number;
    durationMs: number;
  } | null;
}

function formatBytes(bytesStr: string | number): string {
  const bytes = typeof bytesStr === 'string' ? parseFloat(bytesStr) : bytesStr;
  if (!bytes || isNaN(bytes) || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

function formatDuration(hours: number | null): string {
  if (hours === null || isNaN(hours) || !isFinite(hours)) return 'Indefinite';
  if (hours < 1) return `${Math.round(hours * 60)} minutes`;
  if (hours < 48) return `${hours.toFixed(1)} hours`;
  const days = Math.floor(hours / 24);
  const remHours = Math.round(hours % 24);
  return `${days}d ${remHours}h`;
}

export const StorageManagement: React.FC = () => {
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [volumes, setVolumes] = useState<VolumeReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [reconciling, setReconciling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Modals
  const [showAddVolumeModal, setShowAddVolumeModal] = useState(false);
  const [newVolName, setNewVolName] = useState('');
  const [newVolPath, setNewVolPath] = useState('');
  const [newVolDevice, setNewVolDevice] = useState('');
  const [newVolIsDefault, setNewVolIsDefault] = useState(false);

  const [editingCamera, setEditingCamera] = useState<CameraBreakdown | null>(null);
  const [editContinuousDays, setEditContinuousDays] = useState<number>(30);
  const [editMotionDays, setEditMotionDays] = useState<number>(90);
  const [editMaxGb, setEditMaxGb] = useState<string>('');
  const [editPriority, setEditPriority] = useState<'HIGH' | 'NORMAL' | 'LOW'>('NORMAL');

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [statusRes, volumesRes] = await Promise.all([
        api.get('/system/storage/status'),
        api.get('/system/storage/volumes'),
      ]);
      setStatus(statusRes.data);
      setVolumes(volumesRes.data);
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to load storage data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowAddVolumeModal(false);
        setEditingCamera(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleRunReconcile = async () => {
    setReconciling(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await api.post('/system/storage/reconcile');
      setSuccessMsg(
        `Integrity scan complete: ${res.data.filesRecovered} repaired, ${res.data.filesQuarantined} quarantined, ${res.data.filesMissing} missing, ${res.data.zeroBytePruned} zero-byte files removed in ${res.data.durationMs}ms.`
      );
      await fetchData();
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Integrity recovery scan failed');
    } finally {
      setReconciling(false);
    }
  };

  const handleCreateVolume = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/system/storage/volumes', {
        name: newVolName,
        path: newVolPath,
        deviceIdentifier: newVolDevice || undefined,
        isDefault: newVolIsDefault,
      });
      setShowAddVolumeModal(false);
      setNewVolName('');
      setNewVolPath('');
      setNewVolDevice('');
      setNewVolIsDefault(false);
      setSuccessMsg('Storage volume registered successfully.');
      await fetchData();
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to register volume');
    }
  };

  const handleSaveRetention = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingCamera) return;
    setError(null);
    try {
      await api.put('/system/storage/retention', {
        cameraId: editingCamera.id,
        continuousDays: editContinuousDays,
        motionDays: editMotionDays,
        maxStorageGigabytes: editMaxGb ? parseInt(editMaxGb, 10) : null,
        retentionPriority: editPriority,
      });
      setEditingCamera(null);
      setSuccessMsg(`Retention policy updated for ${editingCamera.name}.`);
      await fetchData();
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to update retention policy');
    }
  };

  const openRetentionModal = (cam: CameraBreakdown) => {
    setEditingCamera(cam);
    setEditContinuousDays(cam.retentionDays);
    setEditMotionDays(cam.motionDays);
    setEditMaxGb(cam.maxStorageGigabytes ? cam.maxStorageGigabytes.toString() : '');
    setEditPriority(cam.retentionPriority);
  };

  const getStateBadge = (state: string) => {
    switch (state) {
      case 'AVAILABLE':
        return (
          <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-bold bg-[#080B10] text-[#3FB950] border border-[#238636] uppercase tracking-wider">
            <CheckCircle className="w-3 h-3 mr-1 text-[#3FB950]" />
            [ AVAILABLE // NOMINAL ]
          </span>
        );
      case 'WARNING':
        return (
          <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-bold bg-[#080B10] text-[#E3B341] border border-[#E3B341] uppercase tracking-wider">
            <AlertTriangle className="w-3 h-3 mr-1 text-[#E3B341]" />
            [ WARNING // ELEVATED LOAD ]
          </span>
        );
      case 'CRITICAL':
        return (
          <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-bold bg-[#080B10] text-[#F85149] border border-[#F85149] uppercase tracking-wider">
            <AlertOctagon className="w-3 h-3 mr-1 text-[#F85149]" />
            [ CRITICAL // ADAPTIVE ACTIVE ]
          </span>
        );
      case 'EMERGENCY_PRESERVE_EVIDENCE':
        return (
          <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-bold bg-[#080B10] text-[#58A6FF] border border-[#58A6FF] uppercase tracking-wider animate-pulse">
            <Shield className="w-3 h-3 mr-1 text-[#58A6FF]" />
            [ EMERGENCY // PRESERVE EVIDENCE ]
          </span>
        );
      case 'EMERGENCY_PURGE':
        return (
          <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-bold bg-[#080B10] text-[#F85149] border border-[#F85149] uppercase tracking-wider animate-pulse">
            <AlertTriangle className="w-3 h-3 mr-1" />
            [ EMERGENCY PURGE ]
          </span>
        );
      case 'PINNED_STORAGE_EXHAUSTION':
        return (
          <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-bold bg-[#080B10] text-[#F85149] border border-[#F85149] uppercase tracking-wider animate-pulse">
            <AlertOctagon className="w-3 h-3 mr-1 text-[#F85149]" />
            [ PINNED STORAGE EXHAUSTION ]
          </span>
        );
      default:
        return <span className="text-[10px] text-[#8B949E] font-bold">[{state}]</span>;
    }
  };

  return (
    <div className="flex flex-col min-h-[calc(100vh-3.5rem)] bg-tactical-canvas p-4 space-y-3 font-mono text-tactical-text overflow-y-auto">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 bg-tactical-panel p-3.5 border border-tactical-border">
        <div>
          <div className="flex items-center space-x-2.5">
            <HardDrive className="w-5 h-5 text-phosphor-amber" />
            <div>
              <h1 className="text-sm font-bold text-tactical-bright uppercase tracking-wider font-mono">
                Storage Operations & Mount Guard Resilience Console
              </h1>
              <p className="text-[11px] text-tactical-muted font-sans mt-0.5">
                MULTI-VOLUME DRIVE REGISTRY • RATE-ADAPTIVE INGESTION • SECTION 63 LEGAL HOLD INVARIANCE
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={fetchData}
            disabled={loading}
            className="btn-tactical-secondary px-3 py-1.5 text-xs font-semibold uppercase tracking-wider flex items-center space-x-1.5 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-phosphor-amber' : ''}`} />
            <span>Refresh</span>
          </button>
          <button
            onClick={handleRunReconcile}
            disabled={reconciling}
            className="btn-tactical-secondary px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-phosphor-amber flex items-center space-x-1.5 transition-colors"
          >
            <Wrench className={`w-3.5 h-3.5 ${reconciling ? 'animate-spin' : ''}`} />
            <span>{reconciling ? 'Scanning...' : 'Integrity Scan'}</span>
          </button>
          <button
            onClick={() => setShowAddVolumeModal(true)}
            className="btn-tactical-primary px-3 py-1.5 text-xs font-bold uppercase tracking-wider flex items-center space-x-1.5 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>+ Register Volume</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="p-2.5 bg-[#080B10] border border-[#F85149] text-[#F85149] text-xs flex items-center space-x-2">
          <AlertOctagon className="w-4 h-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {successMsg && (
        <div className="p-2.5 bg-[#080B10] border border-[#3FB950] text-[#3FB950] text-xs flex items-center space-x-2">
          <CheckCircle className="w-4 h-4 flex-shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      {/* Top Vitals Cards */}
      {status && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          {/* Status Badge */}
          <div className="p-3 bg-[#0D1117] border border-[#21262D] flex flex-col justify-between space-y-2">
            <span className="text-[10px] uppercase tracking-wider text-[#8B949E]">SYSTEM_STATE:</span>
            <div>{getStateBadge(status.state)}</div>
            <span className="text-[9px] text-[#484F58]">Dynamic multi-signal guard</span>
          </div>

          {/* Capacity */}
          <div className="p-3 bg-[#0D1117] border border-[#21262D] flex flex-col justify-between space-y-2">
            <span className="text-[10px] uppercase tracking-wider text-[#8B949E]">STORAGE_CAPACITY:</span>
            <div>
              <span className="text-lg font-bold text-white">{formatBytes(status.usedBytes)}</span>
              <span className="text-xs text-[#8B949E]"> / {formatBytes(status.sizeBytes)}</span>
            </div>
            <div className="w-full bg-[#080B10] border border-[#30363D] h-2 p-0.5">
              <div
                className={`h-full ${
                  status.fillRatio > 0.9 ? 'bg-[#F85149]' : status.fillRatio > 0.8 ? 'bg-[#E3B341]' : 'bg-[#3FB950]'
                }`}
                style={{ width: `${Math.min(status.fillRatio * 100, 100)}%` }}
              />
            </div>
          </div>

          {/* Free Headroom */}
          <div className="p-3 bg-[#0D1117] border border-[#21262D] flex flex-col justify-between space-y-2">
            <span className="text-[10px] uppercase tracking-wider text-[#8B949E]">FREE_HEADROOM:</span>
            <div>
              <span className="text-lg font-bold text-[#3FB950]">{formatBytes(status.freeBytes)}</span>
              <span className="text-xs text-[#8B949E] ml-1">({((1 - status.fillRatio) * 100).toFixed(1)}%)</span>
            </div>
            <span className="text-[9px] text-[#484F58]">Usable disk allocation</span>
          </div>

          {/* Section 63 Evidence Locked */}
          <div className="p-3 bg-[#0D1117] border border-[#21262D] flex flex-col justify-between space-y-2">
            <span className="text-[10px] uppercase tracking-wider text-[#8B949E] flex items-center gap-1">
              <Shield className="w-3 h-3 text-[#E3B341]" />
              LOCKED_EVIDENCE:
            </span>
            <div>
              <span className="text-lg font-bold text-[#E3B341]">{formatBytes(status.pinnedBytes)}</span>
            </div>
            <span className="text-[9px] text-[#484F58]">Sec. 63 Legal Hold Immune</span>
          </div>

          {/* Projected Exhaustion */}
          <div className="p-3 bg-[#0D1117] border border-[#21262D] flex flex-col justify-between space-y-2">
            <span className="text-[10px] uppercase tracking-wider text-[#8B949E] flex items-center gap-1">
              <Clock className="w-3 h-3 text-[#58A6FF]" />
              PROJECTED_EXHAUSTION:
            </span>
            <div>
              <span className="text-lg font-bold text-white">
                {formatDuration(status.projectedExhaustionHours)}
              </span>
            </div>
            <span className="text-[9px] text-[#484F58]">
              Rate: {formatBytes(status.writeRateBytesPerHour * 24)}/day
            </span>
          </div>
        </div>
      )}

      {/* Ingestion Fleet Status Banner */}
      {status && (
        <div className="bg-[#0D1117] p-2.5 border border-[#21262D] flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center space-x-2">
            <Activity className="w-4 h-4 text-[#58A6FF]" />
            <span className="font-bold uppercase tracking-wider text-[#C9D1D9]">INGESTION FLEET TELEMETRY:</span>
          </div>
          <div className="flex items-center space-x-6 text-[11px]">
            <div>
              <span className="text-[#8B949E]">TOTAL: </span>
              <span className="font-bold text-white">{status.cameraStats.total}</span>
            </div>
            <div>
              <span className="text-[#8B949E]">HEALTHY CONTINUOUS: </span>
              <span className="font-bold text-[#3FB950]">{status.cameraStats.healthy}</span>
            </div>
            <div>
              <span className="text-[#8B949E]">ADAPTIVE DEGRADED: </span>
              <span className="font-bold text-[#E3B341]">{status.cameraStats.degraded}</span>
            </div>
            <div>
              <span className="text-[#8B949E]">STOPPED: </span>
              <span className="font-bold text-[#F85149]">{status.cameraStats.stopped}</span>
            </div>
          </div>
        </div>
      )}

      {/* Physical Volumes Table */}
      <div className="bg-[#0D1117] border border-[#21262D] flex flex-col">
        <div className="p-3 border-b border-[#21262D] bg-[#161B22] flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Layers className="w-4 h-4 text-[#E3B341]" />
            <h2 className="text-xs font-bold text-[#C9D1D9] uppercase tracking-wider">
              PHYSICAL STORAGE VOLUME POOLS ({volumes.length})
            </h2>
          </div>
          <span className="text-[10px] bg-[#080B10] border border-[#238636] text-[#3FB950] px-1.5 py-0.5 font-bold">
            MOUNT GUARD: ENFORCED
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#080B10] text-[#8B949E] uppercase text-[10px] border-b border-[#21262D] tracking-wider">
              <tr>
                <th className="py-2 px-3.5">VOLUME_NAME</th>
                <th className="py-2 px-3.5">MOUNT_PATH</th>
                <th className="py-2 px-3.5">DEVICE_IDENTIFIER</th>
                <th className="py-2 px-3.5">FILESYSTEM</th>
                <th className="py-2 px-3.5">MOUNT_STATUS</th>
                <th className="py-2 px-3.5">CAPACITY_UTILIZATION</th>
                <th className="py-2 px-3.5">FEEDS_BOUND</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#21262D] text-[#C9D1D9]">
              {volumes.map((vol) => (
                <tr key={vol.id} className="hover:bg-[#161B22] transition-colors">
                  <td className="py-2.5 px-3.5 font-bold flex items-center space-x-2">
                    <span>{vol.name}</span>
                    {vol.isDefault && (
                      <span className="text-[9px] px-1 py-[2px] bg-[#161B22] border border-[#58A6FF] text-[#58A6FF] font-bold">
                        DEFAULT
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 px-3.5 text-[#8B949E]">{vol.path}</td>
                  <td className="py-2.5 px-3.5 text-[#8B949E] text-[11px]">{vol.deviceIdentifier || vol.mountSource || 'N/A'}</td>
                  <td className="py-2.5 px-3.5 text-[#8B949E] text-[11px]">{vol.filesystemType || 'ext4'}</td>
                  <td className="py-2.5 px-3.5">
                    {vol.status === 'HEALTHY' ? (
                      <span className="px-1.5 py-0.5 bg-[#080B10] border border-[#238636] text-[#3FB950] text-[10px] font-bold">
                        HEALTHY
                      </span>
                    ) : vol.status === 'READ_ONLY' ? (
                      <span className="px-1.5 py-0.5 bg-[#080B10] border border-[#E3B341] text-[#E3B341] text-[10px] font-bold">
                        READ_ONLY
                      </span>
                    ) : vol.status === 'UNMOUNTED' ? (
                      <span className="px-1.5 py-0.5 bg-[#080B10] border border-[#F85149] text-[#F85149] text-[10px] font-bold">
                        UNMOUNTED
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.5 bg-[#080B10] border border-[#E3B341] text-[#E3B341] text-[10px] font-bold">
                        DEGRADED
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 px-3.5">
                    <div className="flex items-center space-x-2">
                      <div className="w-20 bg-[#080B10] border border-[#30363D] h-1.5">
                        <div
                          className="h-full bg-[#3FB950]"
                          style={{ width: `${Math.min(vol.fillRatio * 100, 100)}%` }}
                        />
                      </div>
                      <span className="text-[11px] text-[#8B949E]">
                        {formatBytes(vol.usedBytes)} / {formatBytes(vol.sizeBytes)}
                      </span>
                    </div>
                  </td>
                  <td className="py-2.5 px-3.5 text-[#C9D1D9] font-bold">{vol.cameraCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Per-Camera Retention & Quotas Table */}
      {status && (
        <div className="bg-[#0D1117] border border-[#21262D] flex flex-col">
          <div className="p-3 border-b border-[#21262D] bg-[#161B22] flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Sliders className="w-4 h-4 text-[#E3B341]" />
              <h2 className="text-xs font-bold text-[#C9D1D9] uppercase tracking-wider">
                RETENTION POLICIES & QUOTAS ({status.cameraBreakdown.length})
              </h2>
            </div>
            <span className="text-[10px] text-[#8B949E]">PRIORITY-LADDER PRUNING ACTIVE</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#080B10] text-[#8B949E] uppercase text-[10px] border-b border-[#21262D] tracking-wider">
                <tr>
                  <th className="py-2 px-3.5">CAMERA</th>
                  <th className="py-2 px-3.5">PRIORITY</th>
                  <th className="py-2 px-3.5">CONFIGURED_MODE</th>
                  <th className="py-2 px-3.5">EFFECTIVE_MODE</th>
                  <th className="py-2 px-3.5">DEGRADATION_REASON</th>
                  <th className="py-2 px-3.5">USED_ON_DISK</th>
                  <th className="py-2 px-3.5">RETENTION_WINDOW</th>
                  <th className="py-2 px-3.5">STORAGE_QUOTA</th>
                  <th className="py-2 px-3.5 text-right">ACTIONS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#21262D] text-[#C9D1D9]">
                {status.cameraBreakdown.map((cam) => (
                  <tr key={cam.id} className="hover:bg-[#161B22] transition-colors">
                    <td className="py-2.5 px-3.5 font-bold">
                      <div>{cam.name}</div>
                      <div className="text-[10px] text-[#484F58]">{cam.streamPath}</div>
                    </td>
                    <td className="py-2.5 px-3.5">
                      <span
                        className={`text-[9px] px-1.5 py-0.5 border font-bold ${
                          cam.retentionPriority === 'HIGH'
                            ? 'bg-[#080B10] text-[#58A6FF] border-[#58A6FF]'
                            : cam.retentionPriority === 'LOW'
                            ? 'bg-[#080B10] text-[#8B949E] border-[#30363D]'
                            : 'bg-[#080B10] text-[#E3B341] border-[#E3B341]'
                        }`}
                      >
                        {cam.retentionPriority}
                      </span>
                    </td>
                    <td className="py-2.5 px-3.5 text-[#8B949E]">{cam.recordingMode}</td>
                    <td className="py-2.5 px-3.5 font-bold">
                      {cam.effectiveRecordingMode === 'CONTINUOUS' ? (
                        <span className="text-[#3FB950]">CONTINUOUS</span>
                      ) : cam.effectiveRecordingMode === 'MOTION' ? (
                        <span className="text-[#E3B341]">MOTION ONLY</span>
                      ) : (
                        <span className="text-[#F85149]">STOPPED</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3.5 text-[10px]">
                      {cam.degradationReason === 'NONE' ? (
                        <span className="text-[#484F58]">NOMINAL</span>
                      ) : (
                        <span className="text-[#E3B341] font-bold">{cam.degradationReason}</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3.5 text-[#8B949E] text-[11px]">
                      {formatBytes(cam.usedBytes)} ({cam.segmentCount} segs)
                    </td>
                    <td className="py-2.5 px-3.5 text-[11px] text-[#8B949E]">
                      {cam.retentionDays}d cont / {cam.motionDays}d mot
                    </td>
                    <td className="py-2.5 px-3.5 text-[11px]">
                      {cam.maxStorageGigabytes ? `${cam.maxStorageGigabytes} GB` : 'UNCAPPED'}
                    </td>
                    <td className="py-2.5 px-3.5 text-right">
                      <button
                        onClick={() => openRetentionModal(cam)}
                        className="px-2 py-1 text-[10px] font-bold uppercase bg-[#161B22] hover:bg-[#21262D] text-[#C9D1D9] hover:text-white border border-[#30363D] transition-colors"
                      >
                        [ CONFIGURE ]
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recovery History Log Card */}
      {status?.lastRecovery && (
        <div className="bg-[#0D1117] p-3.5 border border-[#21262D]">
          <div className="flex items-center space-x-2 border-b border-[#21262D] pb-2 mb-2.5">
            <FileCheck className="w-4 h-4 text-[#3FB950]" />
            <h3 className="text-xs font-bold text-[#C9D1D9] uppercase tracking-wider">
              POWER-CUT & CRASH RECOVERY LOG
            </h3>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-xs">
            <div className="bg-[#161B22] p-2 border border-[#21262D]">
              <span className="text-[#8B949E] block text-[9px] uppercase">LAST_SCAN:</span>
              <span className="text-white font-bold text-[11px]">
                {new Date(status.lastRecovery.timestamp).toLocaleTimeString([], { hour12: false })}
              </span>
            </div>
            <div className="bg-[#161B22] p-2 border border-[#21262D]">
              <span className="text-[#8B949E] block text-[9px] uppercase">FILES_EXAMINED:</span>
              <span className="text-white font-bold">{status.lastRecovery.filesExamined}</span>
            </div>
            <div className="bg-[#161B22] p-2 border border-[#21262D]">
              <span className="text-[#8B949E] block text-[9px] uppercase">FILES_REPAIRED:</span>
              <span className="text-[#3FB950] font-bold">{status.lastRecovery.filesRecovered}</span>
            </div>
            <div className="bg-[#161B22] p-2 border border-[#21262D]">
              <span className="text-[#8B949E] block text-[9px] uppercase">QUARANTINED:</span>
              <span className="text-[#E3B341] font-bold">{status.lastRecovery.filesQuarantined}</span>
            </div>
            <div className="bg-[#161B22] p-2 border border-[#21262D]">
              <span className="text-[#8B949E] block text-[9px] uppercase">ZERO_BYTE_CULLED:</span>
              <span className="text-[#8B949E] font-bold">{status.lastRecovery.zeroBytePruned}</span>
            </div>
            <div className="bg-[#161B22] p-2 border border-[#21262D]">
              <span className="text-[#8B949E] block text-[9px] uppercase">MISSING_IN_DB:</span>
              <span className="text-[#F85149] font-bold">{status.lastRecovery.filesMissing}</span>
            </div>
          </div>
        </div>
      )}

      {/* Add Volume Modal */}
      {showAddVolumeModal && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 bg-black/85 flex items-center justify-center p-4 z-50 font-mono"
        >
          <div className="bg-tactical-panel border border-tactical-border rounded-none p-5 max-w-md w-full shadow-2xl">
            <h3 className="text-xs font-bold text-tactical-bright uppercase tracking-wider mb-3 flex items-center gap-2 border-b border-tactical-border pb-2 font-mono">
              <HardDrive className="w-4 h-4 text-phosphor-amber" />
              Register Physical Storage Volume Pool
            </h3>
            <form onSubmit={handleCreateVolume} className="space-y-3 text-xs">
              <div>
                <label className="block text-tactical-muted uppercase text-[10px] mb-1 font-mono">VOLUME_NAME:</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Drive Bay 2 (WD Purple)"
                  value={newVolName}
                  onChange={(e) => setNewVolName(e.target.value)}
                  className="input-tactical w-full px-2.5 py-1.5"
                />
              </div>
              <div>
                <label className="block text-tactical-muted uppercase text-[10px] mb-1 font-mono">PHYSICAL_MOUNT_PATH:</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. /mnt/cctv_hdd2"
                  value={newVolPath}
                  onChange={(e) => setNewVolPath(e.target.value)}
                  className="input-tactical w-full px-2.5 py-1.5"
                />
              </div>
              <div>
                <label className="block text-tactical-muted uppercase text-[10px] mb-1 font-mono">DEVICE_IDENTIFIER (OPTIONAL):</label>
                <input
                  type="text"
                  placeholder="e.g. /dev/sdb1 or UUID=..."
                  value={newVolDevice}
                  onChange={(e) => setNewVolDevice(e.target.value)}
                  className="input-tactical w-full px-2.5 py-1.5"
                />
              </div>
              <div className="flex items-center space-x-2 pt-1">
                <input
                  type="checkbox"
                  id="isDef"
                  checked={newVolIsDefault}
                  onChange={(e) => setNewVolIsDefault(e.target.checked)}
                  className="border-tactical-border bg-tactical-canvas text-phosphor-amber rounded-none"
                />
                <label htmlFor="isDef" className="text-[11px] text-tactical-text font-sans">
                  Set as default recording volume for new cameras
                </label>
              </div>

              <div className="flex justify-end space-x-2 pt-3 border-t border-tactical-border">
                <button
                  type="button"
                  onClick={() => setShowAddVolumeModal(false)}
                  className="btn-tactical-secondary px-3 py-1.5 uppercase font-bold text-xs"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-tactical-primary px-4 py-1.5 uppercase font-bold text-xs"
                >
                  Register Volume
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Retention Policy Modal */}
      {editingCamera && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 bg-black/85 flex items-center justify-center p-4 z-50 font-mono"
        >
          <div className="bg-tactical-panel border border-tactical-border rounded-none p-5 max-w-md w-full shadow-2xl">
            <h3 className="text-xs font-bold text-tactical-bright uppercase tracking-wider mb-1 flex items-center gap-2 font-mono">
              <Sliders className="w-4 h-4 text-phosphor-amber" />
              Configure Retention: {editingCamera.name}
            </h3>
            <p className="text-[10px] text-tactical-muted mb-3 pb-2 border-b border-tactical-border font-mono">
              STREAM_PATH: {editingCamera.streamPath}
            </p>
            <form onSubmit={handleSaveRetention} className="space-y-3 text-xs">
              <div>
                <label className="block text-tactical-muted uppercase text-[10px] mb-1 font-mono">CONTINUOUS_RETENTION_DAYS:</label>
                <input
                  type="number"
                  min="1"
                  max="365"
                  required
                  value={editContinuousDays}
                  onChange={(e) => setEditContinuousDays(parseInt(e.target.value, 10) || 1)}
                  className="input-tactical w-full px-2.5 py-1.5"
                />
              </div>
              <div>
                <label className="block text-tactical-muted uppercase text-[10px] mb-1 font-mono">MOTION_RETENTION_DAYS:</label>
                <input
                  type="number"
                  min="1"
                  max="365"
                  required
                  value={editMotionDays}
                  onChange={(e) => setEditMotionDays(parseInt(e.target.value, 10) || 1)}
                  className="input-tactical w-full px-2.5 py-1.5"
                />
              </div>
              <div>
                <label className="block text-tactical-muted uppercase text-[10px] mb-1 font-mono">STORAGE_QUOTA_CAP_GB (OPTIONAL):</label>
                <input
                  type="number"
                  min="1"
                  placeholder="Leave empty for uncapped"
                  value={editMaxGb}
                  onChange={(e) => setEditMaxGb(e.target.value)}
                  className="input-tactical w-full px-2.5 py-1.5"
                />
                <span className="text-[11px] text-tactical-muted mt-1 block font-sans">
                  Camera will prune oldest unpinned footage when consumption exceeds this cap.
                </span>
              </div>
              <div>
                <label className="block text-tactical-muted uppercase text-[10px] mb-1 font-mono">PRUNING_PRIORITY:</label>
                <select
                  value={editPriority}
                  onChange={(e) => setEditPriority(e.target.value as any)}
                  className="input-tactical w-full px-2.5 py-1.5"
                >
                  <option value="HIGH">HIGH (Vault, Cash, Perimeter - Pruned Last)</option>
                  <option value="NORMAL">NORMAL (General Areas, Corridors)</option>
                  <option value="LOW">LOW (Auxiliary Feeds - Pruned First)</option>
                </select>
              </div>

              <div className="flex justify-end space-x-2 pt-3 border-t border-tactical-border">
                <button
                  type="button"
                  onClick={() => setEditingCamera(null)}
                  className="btn-tactical-secondary px-3 py-1.5 uppercase font-bold text-xs"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-tactical-primary px-4 py-1.5 uppercase font-bold text-xs"
                >
                  Save Policy
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default StorageManagement;
