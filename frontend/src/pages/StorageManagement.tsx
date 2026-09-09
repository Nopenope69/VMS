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
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-950/80 text-emerald-400 border border-emerald-800/60">
            <CheckCircle className="w-3.5 h-3.5 mr-1" />
            AVAILABLE (HEALTHY)
          </span>
        );
      case 'WARNING':
        return (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-950/80 text-amber-400 border border-amber-800/60">
            <AlertTriangle className="w-3.5 h-3.5 mr-1" />
            WARNING (ELEVATED WRITE LOAD)
          </span>
        );
      case 'CRITICAL':
        return (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-orange-950/80 text-orange-400 border border-orange-800/60">
            <AlertOctagon className="w-3.5 h-3.5 mr-1" />
            CRITICAL (ADAPTIVE INGESTION ACTIVE)
          </span>
        );
      case 'EMERGENCY_PRESERVE_EVIDENCE':
        return (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-purple-950/90 text-purple-300 border border-purple-700 animate-pulse">
            <Shield className="w-3.5 h-3.5 mr-1 text-purple-400" />
            EMERGENCY: PRESERVE EVIDENCE
          </span>
        );
      case 'EMERGENCY_PURGE':
        return (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-950/90 text-red-400 border border-red-800 animate-pulse">
            <AlertTriangle className="w-3.5 h-3.5 mr-1" />
            EMERGENCY PURGE
          </span>
        );
      case 'PINNED_STORAGE_EXHAUSTION':
        return (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-950 text-red-200 border border-red-600 animate-pulse">
            <AlertOctagon className="w-3.5 h-3.5 mr-1 text-red-500" />
            PINNED STORAGE EXHAUSTION
          </span>
        );
      default:
        return <span className="text-xs text-slate-400">{state}</span>;
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-graphite-700 pb-4">
        <div>
          <div className="flex items-center space-x-3">
            <div className="p-2 bg-cctv-teal/10 rounded border border-cctv-teal/30">
              <HardDrive className="w-6 h-6 text-cctv-teal" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
                Storage Operations & Resilience Console
              </h1>
              <p className="text-xs text-slate-400">
                Multi-Volume Drive Registry • Rate-Adaptive Ingestion • Section 63 Legal Hold Invariance
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          <button
            onClick={fetchData}
            disabled={loading}
            className="px-3 py-1.5 text-xs font-medium rounded bg-graphite-800 hover:bg-graphite-700 text-slate-200 border border-graphite-600 flex items-center space-x-1.5 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
          <button
            onClick={handleRunReconcile}
            disabled={reconciling}
            className="px-3 py-1.5 text-xs font-medium rounded bg-cctv-amber/20 hover:bg-cctv-amber/30 text-cctv-amber border border-cctv-amber/50 flex items-center space-x-1.5 transition-colors"
          >
            <Wrench className={`w-3.5 h-3.5 ${reconciling ? 'animate-spin' : ''}`} />
            <span>{reconciling ? 'Scanning...' : 'Run Integrity Scan'}</span>
          </button>
          <button
            onClick={() => setShowAddVolumeModal(true)}
            className="px-3 py-1.5 text-xs font-medium rounded bg-cctv-teal text-graphite-950 font-semibold hover:bg-teal-400 flex items-center space-x-1.5 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Volume</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded bg-red-950/50 border border-red-800 text-red-300 text-xs flex items-center space-x-2">
          <AlertOctagon className="w-4 h-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {successMsg && (
        <div className="p-3 rounded bg-emerald-950/50 border border-emerald-800 text-emerald-300 text-xs flex items-center space-x-2">
          <CheckCircle className="w-4 h-4 flex-shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      {/* Top Vitals Cards */}
      {status && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {/* Status Badge */}
          <div className="p-4 rounded bg-graphite-800 border border-graphite-700 flex flex-col justify-between">
            <span className="text-[11px] font-mono uppercase tracking-wider text-slate-400">System State</span>
            <div className="mt-2">{getStateBadge(status.state)}</div>
            <span className="text-[10px] text-slate-500 mt-2 font-mono">Dynamic multi-signal guard</span>
          </div>

          {/* Capacity */}
          <div className="p-4 rounded bg-graphite-800 border border-graphite-700 flex flex-col justify-between">
            <span className="text-[11px] font-mono uppercase tracking-wider text-slate-400">Storage Capacity</span>
            <div className="mt-1">
              <span className="text-xl font-bold text-slate-100">{formatBytes(status.usedBytes)}</span>
              <span className="text-xs text-slate-400"> / {formatBytes(status.sizeBytes)}</span>
            </div>
            <div className="w-full bg-graphite-700 h-1.5 rounded-full overflow-hidden mt-2">
              <div
                className={`h-full ${
                  status.fillRatio > 0.9 ? 'bg-red-500' : status.fillRatio > 0.8 ? 'bg-amber-500' : 'bg-cctv-teal'
                }`}
                style={{ width: `${Math.min(status.fillRatio * 100, 100)}%` }}
              />
            </div>
          </div>

          {/* Free Headroom */}
          <div className="p-4 rounded bg-graphite-800 border border-graphite-700 flex flex-col justify-between">
            <span className="text-[11px] font-mono uppercase tracking-wider text-slate-400">Free Headroom</span>
            <div className="mt-1">
              <span className="text-xl font-bold text-emerald-400">{formatBytes(status.freeBytes)}</span>
              <span className="text-xs text-slate-400 ml-1">({((1 - status.fillRatio) * 100).toFixed(1)}%)</span>
            </div>
            <span className="text-[10px] text-slate-500 mt-2 font-mono">Usable disk remaining</span>
          </div>

          {/* Section 63 Evidence Locked */}
          <div className="p-4 rounded bg-graphite-800 border border-graphite-700 flex flex-col justify-between">
            <span className="text-[11px] font-mono uppercase tracking-wider text-slate-400 flex items-center gap-1">
              <Shield className="w-3.5 h-3.5 text-cctv-amber" />
              Locked Evidence
            </span>
            <div className="mt-1">
              <span className="text-xl font-bold text-cctv-amber">{formatBytes(status.pinnedBytes)}</span>
            </div>
            <span className="text-[10px] text-slate-500 mt-2 font-mono">Section 63 Legal Hold Immune</span>
          </div>

          {/* Projected Exhaustion */}
          <div className="p-4 rounded bg-graphite-800 border border-graphite-700 flex flex-col justify-between">
            <span className="text-[11px] font-mono uppercase tracking-wider text-slate-400 flex items-center gap-1">
              <Clock className="w-3.5 h-3.5 text-slate-400" />
              Projected Full
            </span>
            <div className="mt-1">
              <span className="text-xl font-bold text-slate-100">
                {formatDuration(status.projectedExhaustionHours)}
              </span>
            </div>
            <span className="text-[10px] text-slate-400 mt-2 font-mono">
              Burn rate: {formatBytes(status.writeRateBytesPerHour * 24)}/day
            </span>
          </div>
        </div>
      )}

      {/* Camera Recording States Banner */}
      {status && (
        <div className="bg-graphite-850 p-4 rounded border border-graphite-700 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center space-x-2">
            <Activity className="w-4 h-4 text-cctv-teal" />
            <span className="text-xs font-semibold text-slate-200">Active Ingestion Fleet Status:</span>
          </div>
          <div className="flex items-center space-x-6 text-xs font-mono">
            <div>
              <span className="text-slate-400">Total: </span>
              <span className="font-bold text-slate-100">{status.cameraStats.total}</span>
            </div>
            <div>
              <span className="text-slate-400">Healthy Continuous: </span>
              <span className="font-bold text-emerald-400">{status.cameraStats.healthy}</span>
            </div>
            <div>
              <span className="text-slate-400">Adaptive Degraded: </span>
              <span className="font-bold text-amber-400">{status.cameraStats.degraded}</span>
            </div>
            <div>
              <span className="text-slate-400">Stopped: </span>
              <span className="font-bold text-red-400">{status.cameraStats.stopped}</span>
            </div>
          </div>
        </div>
      )}

      {/* Physical Volumes Table */}
      <div className="bg-graphite-850 rounded border border-graphite-700 overflow-hidden">
        <div className="p-4 border-b border-graphite-700 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Layers className="w-4 h-4 text-slate-400" />
            <h2 className="text-sm font-semibold text-slate-200 uppercase tracking-wide">
              Physical Storage Volume Pools ({volumes.length})
            </h2>
          </div>
          <span className="text-[11px] font-mono text-slate-400">Mount Guard Active</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-graphite-800 text-slate-400 uppercase font-mono text-[10px]">
              <tr>
                <th className="py-2.5 px-4">Volume Name</th>
                <th className="py-2.5 px-4">Mount Path</th>
                <th className="py-2.5 px-4">Device Identity</th>
                <th className="py-2.5 px-4">Filesystem</th>
                <th className="py-2.5 px-4">Mount Status</th>
                <th className="py-2.5 px-4">Capacity Used</th>
                <th className="py-2.5 px-4">Cameras Bound</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-graphite-700 text-slate-200">
              {volumes.map((vol) => (
                <tr key={vol.id} className="hover:bg-graphite-800/50">
                  <td className="py-3 px-4 font-medium flex items-center space-x-2">
                    <span>{vol.name}</span>
                    {vol.isDefault && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-cctv-teal/20 text-cctv-teal font-mono">
                        DEFAULT
                      </span>
                    )}
                  </td>
                  <td className="py-3 px-4 font-mono text-slate-300">{vol.path}</td>
                  <td className="py-3 px-4 font-mono text-slate-400">{vol.deviceIdentifier || vol.mountSource || 'N/A'}</td>
                  <td className="py-3 px-4 font-mono text-slate-400">{vol.filesystemType || 'ext4'}</td>
                  <td className="py-3 px-4">
                    {vol.status === 'HEALTHY' ? (
                      <span className="px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 text-[10px] font-mono font-semibold">
                        HEALTHY
                      </span>
                    ) : vol.status === 'READ_ONLY' ? (
                      <span className="px-2 py-0.5 rounded bg-amber-950 text-amber-400 text-[10px] font-mono font-semibold">
                        READ_ONLY
                      </span>
                    ) : vol.status === 'UNMOUNTED' ? (
                      <span className="px-2 py-0.5 rounded bg-red-950 text-red-400 text-[10px] font-mono font-semibold">
                        UNMOUNTED
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded bg-orange-950 text-orange-400 text-[10px] font-mono font-semibold">
                        DEGRADED
                      </span>
                    )}
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex items-center space-x-2">
                      <div className="w-24 bg-graphite-700 h-1.5 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-cctv-teal"
                          style={{ width: `${Math.min(vol.fillRatio * 100, 100)}%` }}
                        />
                      </div>
                      <span className="font-mono text-[11px] text-slate-300">
                        {formatBytes(vol.usedBytes)} / {formatBytes(vol.sizeBytes)}
                      </span>
                    </div>
                  </td>
                  <td className="py-3 px-4 font-mono">{vol.cameraCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Per-Camera Retention & Quotas Table */}
      {status && (
        <div className="bg-graphite-850 rounded border border-graphite-700 overflow-hidden">
          <div className="p-4 border-b border-graphite-700 flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Sliders className="w-4 h-4 text-cctv-amber" />
              <h2 className="text-sm font-semibold text-slate-200 uppercase tracking-wide">
                Camera Retention Policies & Storage Quotas ({status.cameraBreakdown.length})
              </h2>
            </div>
            <span className="text-[11px] text-slate-400 font-mono">Priority-Ladder Pruning</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-graphite-800 text-slate-400 uppercase font-mono text-[10px]">
                <tr>
                  <th className="py-2.5 px-4">Camera</th>
                  <th className="py-2.5 px-4">Priority</th>
                  <th className="py-2.5 px-4">Configured Mode</th>
                  <th className="py-2.5 px-4">Effective Mode</th>
                  <th className="py-2.5 px-4">Degradation Status</th>
                  <th className="py-2.5 px-4">Used on Disk</th>
                  <th className="py-2.5 px-4">Retention Window</th>
                  <th className="py-2.5 px-4">Storage Quota</th>
                  <th className="py-2.5 px-4">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-graphite-700 text-slate-200">
                {status.cameraBreakdown.map((cam) => (
                  <tr key={cam.id} className="hover:bg-graphite-800/50">
                    <td className="py-3 px-4 font-medium">
                      <div>{cam.name}</div>
                      <div className="text-[10px] font-mono text-slate-500">{cam.streamPath}</div>
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`text-[10px] font-mono px-2 py-0.5 rounded font-semibold ${
                          cam.retentionPriority === 'HIGH'
                            ? 'bg-purple-950 text-purple-300 border border-purple-800/60'
                            : cam.retentionPriority === 'LOW'
                            ? 'bg-graphite-700 text-slate-300'
                            : 'bg-blue-950 text-blue-300 border border-blue-800/60'
                        }`}
                      >
                        {cam.retentionPriority}
                      </span>
                    </td>
                    <td className="py-3 px-4 font-mono">{cam.recordingMode}</td>
                    <td className="py-3 px-4 font-mono font-semibold">
                      {cam.effectiveRecordingMode === 'CONTINUOUS' ? (
                        <span className="text-emerald-400">CONTINUOUS</span>
                      ) : cam.effectiveRecordingMode === 'MOTION' ? (
                        <span className="text-amber-400">MOTION ONLY</span>
                      ) : (
                        <span className="text-red-400">STOPPED</span>
                      )}
                    </td>
                    <td className="py-3 px-4 font-mono text-[11px]">
                      {cam.degradationReason === 'NONE' ? (
                        <span className="text-slate-500">NORMAL</span>
                      ) : (
                        <span className="text-amber-400 font-semibold">{cam.degradationReason}</span>
                      )}
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-300">
                      {formatBytes(cam.usedBytes)} ({cam.segmentCount} segs)
                    </td>
                    <td className="py-3 px-4 font-mono">
                      {cam.retentionDays}d continuous / {cam.motionDays}d motion
                    </td>
                    <td className="py-3 px-4 font-mono">
                      {cam.maxStorageGigabytes ? `${cam.maxStorageGigabytes} GB` : 'Uncapped'}
                    </td>
                    <td className="py-3 px-4">
                      <button
                        onClick={() => openRetentionModal(cam)}
                        className="px-2 py-1 text-[11px] rounded bg-graphite-700 hover:bg-graphite-600 text-slate-200 border border-graphite-600"
                      >
                        Configure
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
        <div className="bg-graphite-850 p-4 rounded border border-graphite-700">
          <div className="flex items-center space-x-2 border-b border-graphite-700 pb-2 mb-3">
            <FileCheck className="w-4 h-4 text-cctv-teal" />
            <h3 className="text-xs font-semibold text-slate-200 uppercase tracking-wide">
              Power-Cut & Crash Recovery Event History
            </h3>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 text-xs font-mono">
            <div>
              <span className="text-slate-400 block text-[10px]">Last Recovery Scan:</span>
              <span className="text-slate-200 font-semibold">
                {new Date(status.lastRecovery.timestamp).toLocaleString()}
              </span>
            </div>
            <div>
              <span className="text-slate-400 block text-[10px]">Files Examined:</span>
              <span className="text-slate-200 font-semibold">{status.lastRecovery.filesExamined}</span>
            </div>
            <div>
              <span className="text-slate-400 block text-[10px]">Files Repaired:</span>
              <span className="text-emerald-400 font-semibold">{status.lastRecovery.filesRecovered}</span>
            </div>
            <div>
              <span className="text-slate-400 block text-[10px]">Files Quarantined:</span>
              <span className="text-amber-400 font-semibold">{status.lastRecovery.filesQuarantined}</span>
            </div>
            <div>
              <span className="text-slate-400 block text-[10px]">Zero-Byte Culled:</span>
              <span className="text-slate-300 font-semibold">{status.lastRecovery.zeroBytePruned}</span>
            </div>
            <div>
              <span className="text-slate-400 block text-[10px]">Missing In DB:</span>
              <span className="text-red-400 font-semibold">{status.lastRecovery.filesMissing}</span>
            </div>
          </div>
        </div>
      )}

      {/* Add Volume Modal */}
      {showAddVolumeModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-graphite-850 border border-graphite-700 rounded-lg p-6 max-w-md w-full">
            <h3 className="text-sm font-bold text-slate-100 uppercase tracking-wider mb-4 flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-cctv-teal" />
              Register Storage Volume
            </h3>
            <form onSubmit={handleCreateVolume} className="space-y-4 text-xs">
              <div>
                <label className="block text-slate-400 mb-1">Volume Name</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Drive Bay 2 (WD Purple)"
                  value={newVolName}
                  onChange={(e) => setNewVolName(e.target.value)}
                  className="w-full px-3 py-2 bg-graphite-900 border border-graphite-700 rounded text-slate-100 font-mono"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Physical Mount Path</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. /mnt/cctv_hdd2"
                  value={newVolPath}
                  onChange={(e) => setNewVolPath(e.target.value)}
                  className="w-full px-3 py-2 bg-graphite-900 border border-graphite-700 rounded text-slate-100 font-mono"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Device Identifier (Optional)</label>
                <input
                  type="text"
                  placeholder="e.g. /dev/sdb1 or UUID=..."
                  value={newVolDevice}
                  onChange={(e) => setNewVolDevice(e.target.value)}
                  className="w-full px-3 py-2 bg-graphite-900 border border-graphite-700 rounded text-slate-100 font-mono"
                />
              </div>
              <div className="flex items-center space-x-2 pt-2">
                <input
                  type="checkbox"
                  id="isDef"
                  checked={newVolIsDefault}
                  onChange={(e) => setNewVolIsDefault(e.target.checked)}
                  className="rounded border-graphite-700 bg-graphite-900 text-cctv-teal"
                />
                <label htmlFor="isDef" className="text-slate-300">
                  Set as default recording volume for new cameras
                </label>
              </div>

              <div className="flex justify-end space-x-3 pt-4 border-t border-graphite-700">
                <button
                  type="button"
                  onClick={() => setShowAddVolumeModal(false)}
                  className="px-3 py-1.5 rounded bg-graphite-700 hover:bg-graphite-600 text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded bg-cctv-teal text-graphite-950 font-semibold hover:bg-teal-400"
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
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-graphite-850 border border-graphite-700 rounded-lg p-6 max-w-md w-full">
            <h3 className="text-sm font-bold text-slate-100 uppercase tracking-wider mb-2 flex items-center gap-2">
              <Sliders className="w-4 h-4 text-cctv-amber" />
              Configure Retention & Quota: {editingCamera.name}
            </h3>
            <p className="text-[11px] text-slate-400 mb-4 font-mono">
              Stream Path: {editingCamera.streamPath}
            </p>
            <form onSubmit={handleSaveRetention} className="space-y-4 text-xs">
              <div>
                <label className="block text-slate-400 mb-1">Continuous Retention (Days)</label>
                <input
                  type="number"
                  min="1"
                  max="365"
                  required
                  value={editContinuousDays}
                  onChange={(e) => setEditContinuousDays(parseInt(e.target.value, 10) || 1)}
                  className="w-full px-3 py-2 bg-graphite-900 border border-graphite-700 rounded text-slate-100 font-mono"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Motion Retention (Days)</label>
                <input
                  type="number"
                  min="1"
                  max="365"
                  required
                  value={editMotionDays}
                  onChange={(e) => setEditMotionDays(parseInt(e.target.value, 10) || 1)}
                  className="w-full px-3 py-2 bg-graphite-900 border border-graphite-700 rounded text-slate-100 font-mono"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Max Storage Quota Cap (GB, Optional)</label>
                <input
                  type="number"
                  min="1"
                  placeholder="Leave empty for uncapped"
                  value={editMaxGb}
                  onChange={(e) => setEditMaxGb(e.target.value)}
                  className="w-full px-3 py-2 bg-graphite-900 border border-graphite-700 rounded text-slate-100 font-mono"
                />
                <span className="text-[10px] text-slate-500 mt-1 block">
                  Camera will prune oldest unpinned footage when total consumption exceeds this GB limit.
                </span>
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Retention & Evidentiary Priority</label>
                <select
                  value={editPriority}
                  onChange={(e) => setEditPriority(e.target.value as any)}
                  className="w-full px-3 py-2 bg-graphite-900 border border-graphite-700 rounded text-slate-100 font-mono"
                >
                  <option value="HIGH">HIGH (Vault, Perimeter, Cash - Pruned Last)</option>
                  <option value="NORMAL">NORMAL (General Areas, Entrances)</option>
                  <option value="LOW">LOW (Auxiliary, Low-motion Hallways - Pruned First)</option>
                </select>
              </div>

              <div className="flex justify-end space-x-3 pt-4 border-t border-graphite-700">
                <button
                  type="button"
                  onClick={() => setEditingCamera(null)}
                  className="px-3 py-1.5 rounded bg-graphite-700 hover:bg-graphite-600 text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded bg-cctv-amber text-graphite-950 font-semibold hover:bg-amber-400"
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
