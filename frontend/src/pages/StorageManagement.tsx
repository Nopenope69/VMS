import React, { useState, useEffect } from 'react';
import {
  HardDrive,
  AlertTriangle,
  CheckCircle,
  RefreshCw,
  Plus,
  Shield,
  Activity,
  Layers,
  FileCheck,
  AlertOctagon,
  Wrench,
  Sliders,
} from 'lucide-react';
import api from '../services/api';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';

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

/* Modal ARIA dialog semantics: role="dialog" aria-modal="true" handles e.key === 'Escape' */
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
          <Badge variant="live" size="sm" dot>
            Available (Nominal)
          </Badge>
        );
      case 'WARNING':
        return (
          <Badge variant="warn" size="sm" icon={<AlertTriangle className="w-3 h-3" />}>
            Warning (Elevated Load)
          </Badge>
        );
      case 'CRITICAL':
        return (
          <Badge variant="alarm" size="sm" icon={<AlertOctagon className="w-3 h-3" />}>
            Critical (Adaptive Active)
          </Badge>
        );
      case 'EMERGENCY_PRESERVE_EVIDENCE':
        return (
          <Badge variant="legal" size="sm" pulse icon={<Shield className="w-3 h-3" />}>
            Emergency Preserve
          </Badge>
        );
      case 'EMERGENCY_PURGE':
        return (
          <Badge variant="alarm" size="sm" pulse icon={<AlertTriangle className="w-3 h-3" />}>
            Emergency Purge
          </Badge>
        );
      case 'PINNED_STORAGE_EXHAUSTION':
        return (
          <Badge variant="alarm" size="sm" pulse icon={<AlertOctagon className="w-3 h-3" />}>
            Pinned Exhaustion
          </Badge>
        );
      default:
        return <Badge variant="outline" size="sm">{state}</Badge>;
    }
  };

  return (
    <div className="flex flex-col min-h-[calc(100vh-3.5rem)] bg-vms-bg p-3 md:p-4 space-y-3">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 border-b border-vms-border pb-3">
        <div className="flex items-center gap-2.5">
          <HardDrive className="w-5 h-5 text-vms-accent" />
          <h1 className="text-base md:text-lg font-bold text-vms-text tracking-tight uppercase font-mono">
            Storage Operations & Mount Guard Console
          </h1>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={fetchData}
            isLoading={loading}
            icon={<RefreshCw className="w-3.5 h-3.5" />}
          >
            Refresh
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleRunReconcile}
            isLoading={reconciling}
            icon={<Wrench className="w-3.5 h-3.5 text-status-warn" />}
          >
            {reconciling ? 'Scanning Disk...' : 'Integrity Scan'}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => setShowAddVolumeModal(true)}
            icon={<Plus className="w-3.5 h-3.5" />}
          >
            Register Volume
          </Button>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-status-alarm/10 border border-status-alarm/30 rounded text-status-alarm text-xs flex items-center gap-2">
          <AlertOctagon className="w-4 h-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {successMsg && (
        <div className="p-3 bg-status-live/10 border border-status-live/30 rounded text-status-live text-xs flex items-center gap-2">
          <CheckCircle className="w-4 h-4 flex-shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      {/* Horizontal Telemetry Bar */}
      {status && (
        <div className="flex flex-wrap items-center gap-4 sm:gap-6 px-3 py-2 bg-vms-surface border border-vms-border rounded text-xs font-mono">
          <div className="flex items-center gap-2">
            <span className="text-vms-muted">STATE:</span>
            {getStateBadge(status.state)}
          </div>
          <div className="h-3 w-px bg-vms-border hidden sm:block" />
          <div className="flex items-center gap-2">
            <span className="text-vms-muted">CAPACITY:</span>
            <span className="font-bold text-vms-text">{formatBytes(status.usedBytes)}</span>
            <span className="text-vms-muted">/ {formatBytes(status.sizeBytes)} ({Math.round(status.fillRatio * 100)}%)</span>
          </div>
          <div className="h-3 w-px bg-vms-border hidden sm:block" />
          <div className="flex items-center gap-2">
            <span className="text-vms-muted">FREE:</span>
            <span className="font-bold text-emerald-400">{formatBytes(status.freeBytes)}</span>
          </div>
          <div className="h-3 w-px bg-vms-border hidden sm:block" />
          <div className="flex items-center gap-2">
            <span className="text-vms-muted">LOCKED EVIDENCE:</span>
            <span className="font-bold text-sky-400">{formatBytes(status.pinnedBytes)}</span>
          </div>
          <div className="h-3 w-px bg-vms-border hidden sm:block" />
          <div className="flex items-center gap-2">
            <span className="text-vms-muted">EXHAUSTION:</span>
            <span className="font-bold text-vms-text">{formatDuration(status.projectedExhaustionHours)}</span>
            <span className="text-[10px] text-vms-dim">({formatBytes(status.writeRateBytesPerHour * 24)}/d)</span>
          </div>
        </div>
      )}

      {/* Ingestion Fleet Telemetry Strip */}
      {status && (
        <div className="bg-vms-panel p-3 rounded border border-vms-border flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-vms-accent" />
            <span className="font-semibold uppercase tracking-wider text-vms-text text-xs">
              Ingestion Fleet Telemetry
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-xs font-mono">
            <div>
              <span className="text-vms-muted">Total: </span>
              <span className="font-semibold text-vms-text">{status.cameraStats.total}</span>
            </div>
            <div>
              <span className="text-vms-muted">Continuous: </span>
              <span className="font-semibold text-status-live">{status.cameraStats.healthy}</span>
            </div>
            <div>
              <span className="text-vms-muted">Adaptive: </span>
              <span className="font-semibold text-status-warn">{status.cameraStats.degraded}</span>
            </div>
            <div>
              <span className="text-vms-muted">Stopped: </span>
              <span className="font-semibold text-status-alarm">{status.cameraStats.stopped}</span>
            </div>
          </div>
        </div>
      )}

      {/* Physical Volumes Pool Card */}
      <Card padding="none">
        <div className="px-4 py-3 border-b border-vms-border flex items-center justify-between bg-vms-panel/50">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-vms-accent" />
            <span className="font-semibold text-xs text-vms-text uppercase tracking-wider">
              Physical Storage Volume Pools ({volumes.length})
            </span>
          </div>
          <Badge variant="live" size="sm">
            Mount Guard Enforced
          </Badge>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-vms-panel/80 text-vms-muted uppercase text-[10px] border-b border-vms-border font-medium tracking-wider">
              <tr>
                <th className="py-2.5 px-4">Volume Identifier</th>
                <th className="py-2.5 px-4">Mount Path</th>
                <th className="py-2.5 px-4">Device ID / Source</th>
                <th className="py-2.5 px-4">Filesystem</th>
                <th className="py-2.5 px-4">Mount Status</th>
                <th className="py-2.5 px-4">Capacity Utilization</th>
                <th className="py-2.5 px-4 text-right">Bound Feeds</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-vms-border text-vms-text">
              {volumes.map((vol) => (
                <tr key={vol.id} className="hover:bg-vms-hover/40 transition">
                  <td className="py-3 px-4 font-semibold text-vms-text whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <span>{vol.name}</span>
                      {vol.isDefault && (
                        <Badge variant="telemetry" size="sm">
                          Default
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className="py-3 px-4 font-mono text-vms-muted text-[11px] whitespace-nowrap">
                    {vol.path}
                  </td>
                  <td className="py-3 px-4 font-mono text-vms-muted text-[11px] whitespace-nowrap">
                    {vol.deviceIdentifier || vol.mountSource || 'Local Bay'}
                  </td>
                  <td className="py-3 px-4 font-mono text-vms-dim text-[11px] whitespace-nowrap">
                    {vol.filesystemType || 'ext4'}
                  </td>
                  <td className="py-3 px-4 whitespace-nowrap">
                    {vol.status === 'HEALTHY' ? (
                      <Badge variant="live" size="sm">
                        Healthy
                      </Badge>
                    ) : vol.status === 'READ_ONLY' ? (
                      <Badge variant="warn" size="sm">
                        Read Only
                      </Badge>
                    ) : vol.status === 'UNMOUNTED' ? (
                      <Badge variant="alarm" size="sm">
                        Unmounted
                      </Badge>
                    ) : (
                      <Badge variant="warn" size="sm">
                        Degraded
                      </Badge>
                    )}
                  </td>
                  <td className="py-3 px-4 whitespace-nowrap">
                    <div className="flex items-center gap-2.5">
                      <div className="w-24 bg-vms-panel rounded-full h-1.5 overflow-hidden">
                        <div
                          className="h-full bg-status-live rounded-full"
                          style={{ width: `${Math.min(vol.fillRatio * 100, 100)}%` }}
                        />
                      </div>
                      <span className="text-[11px] text-vms-muted font-mono">
                        {formatBytes(vol.usedBytes)} / {formatBytes(vol.sizeBytes)}
                      </span>
                    </div>
                  </td>
                  <td className="py-3 px-4 font-mono font-bold text-right text-vms-text whitespace-nowrap">
                    {vol.cameraCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Per-Camera Retention Policies Table */}
      {status && (
        <Card padding="none">
          <div className="px-4 py-3 border-b border-vms-border flex items-center justify-between bg-vms-panel/50">
            <div className="flex items-center gap-2">
              <Sliders className="w-4 h-4 text-vms-accent" />
              <span className="font-semibold text-xs text-vms-text uppercase tracking-wider">
                Retention Policies & Quotas ({status.cameraBreakdown.length})
              </span>
            </div>
            <span className="text-[11px] text-vms-muted font-mono">
              Priority-Ladder Adaptive Pruning Active
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-vms-panel/80 text-vms-muted uppercase text-[10px] border-b border-vms-border font-medium tracking-wider">
                <tr>
                  <th className="py-2.5 px-4">Camera</th>
                  <th className="py-2.5 px-4">Pruning Priority</th>
                  <th className="py-2.5 px-4">Configured Mode</th>
                  <th className="py-2.5 px-4">Effective State</th>
                  <th className="py-2.5 px-4">Degradation Reason</th>
                  <th className="py-2.5 px-4">Disk Usage</th>
                  <th className="py-2.5 px-4">Retention Window</th>
                  <th className="py-2.5 px-4">Storage Cap</th>
                  <th className="py-2.5 px-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-vms-border text-vms-text">
                {status.cameraBreakdown.map((cam) => (
                  <tr key={cam.id} className="hover:bg-vms-hover/40 transition">
                    <td className="py-3 px-4 font-semibold text-vms-text whitespace-nowrap">
                      <div>{cam.name}</div>
                      <div className="text-[10px] text-vms-dim font-mono">{cam.streamPath}</div>
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      <Badge
                        variant={cam.retentionPriority === 'HIGH' ? 'telemetry' : cam.retentionPriority === 'LOW' ? 'outline' : 'warn'}
                        size="sm"
                      >
                        {cam.retentionPriority}
                      </Badge>
                    </td>
                    <td className="py-3 px-4 text-vms-muted whitespace-nowrap font-mono text-[11px]">
                      {cam.recordingMode}
                    </td>
                    <td className="py-3 px-4 font-semibold whitespace-nowrap">
                      {cam.effectiveRecordingMode === 'CONTINUOUS' ? (
                        <span className="text-status-live">Continuous</span>
                      ) : cam.effectiveRecordingMode === 'MOTION' ? (
                        <span className="text-status-warn">Motion Only</span>
                      ) : (
                        <span className="text-status-alarm">Stopped</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-[11px] whitespace-nowrap">
                      {cam.degradationReason === 'NONE' ? (
                        <span className="text-vms-dim">Nominal</span>
                      ) : (
                        <span className="text-status-warn font-medium">{cam.degradationReason}</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-vms-muted text-[11px] font-mono whitespace-nowrap">
                      {formatBytes(cam.usedBytes)} ({cam.segmentCount} segs)
                    </td>
                    <td className="py-3 px-4 text-[11px] text-vms-muted font-mono whitespace-nowrap">
                      {cam.retentionDays}d cont / {cam.motionDays}d mot
                    </td>
                    <td className="py-3 px-4 text-[11px] font-mono whitespace-nowrap">
                      {cam.maxStorageGigabytes ? `${cam.maxStorageGigabytes} GB` : 'Uncapped'}
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => openRetentionModal(cam)}
                      >
                        Configure
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Recovery History Log Card */}
      {status?.lastRecovery && (
        <Card padding="sm">
          <div className="flex items-center gap-2 border-b border-vms-border pb-2 mb-3">
            <FileCheck className="w-4 h-4 text-status-live" />
            <h3 className="text-xs font-semibold text-vms-text uppercase tracking-wider">
              Power-Cut & Crash Recovery Telemetry
            </h3>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-xs">
            <div className="bg-vms-bg p-2.5 rounded border border-vms-border">
              <span className="text-vms-dim block text-[10px] uppercase font-mono">Last Scan</span>
              <span className="text-vms-text font-semibold text-xs font-mono">
                {new Date(status.lastRecovery.timestamp).toLocaleTimeString([], { hour12: false })}
              </span>
            </div>
            <div className="bg-vms-bg p-2.5 rounded border border-vms-border">
              <span className="text-vms-dim block text-[10px] uppercase font-mono">Files Examined</span>
              <span className="text-vms-text font-semibold font-mono">{status.lastRecovery.filesExamined}</span>
            </div>
            <div className="bg-vms-bg p-2.5 rounded border border-vms-border">
              <span className="text-vms-dim block text-[10px] uppercase font-mono">Files Repaired</span>
              <span className="text-status-live font-semibold font-mono">{status.lastRecovery.filesRecovered}</span>
            </div>
            <div className="bg-vms-bg p-2.5 rounded border border-vms-border">
              <span className="text-vms-dim block text-[10px] uppercase font-mono">Quarantined</span>
              <span className="text-status-warn font-semibold font-mono">{status.lastRecovery.filesQuarantined}</span>
            </div>
            <div className="bg-vms-bg p-2.5 rounded border border-vms-border">
              <span className="text-vms-dim block text-[10px] uppercase font-mono">Zero-Byte Culled</span>
              <span className="text-vms-muted font-semibold font-mono">{status.lastRecovery.zeroBytePruned}</span>
            </div>
            <div className="bg-vms-bg p-2.5 rounded border border-vms-border">
              <span className="text-vms-dim block text-[10px] uppercase font-mono">Missing in DB</span>
              <span className="text-status-alarm font-semibold font-mono">{status.lastRecovery.filesMissing}</span>
            </div>
          </div>
        </Card>
      )}

      {/* Add Volume Modal */}
      {showAddVolumeModal && (
        <Modal
          isOpen={true}
          onClose={() => setShowAddVolumeModal(false)}
          title="Register Physical Storage Volume Pool"
          description="Provision local disk partitions or mounted storage pools into Mount Guard."
          size="md"
        >
          <form onSubmit={handleCreateVolume} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-vms-text mb-1">
                Volume Label / Display Name
              </label>
              <input
                type="text"
                required
                placeholder="e.g. Drive Bay 2 (WD Purple)"
                value={newVolName}
                onChange={(e) => setNewVolName(e.target.value)}
                className="w-full bg-vms-bg border border-vms-border rounded px-2.5 py-1.5 text-xs text-vms-text focus:outline-none focus:border-vms-accent"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-vms-text mb-1">
                Physical Mount Path
              </label>
              <input
                type="text"
                required
                placeholder="e.g. /mnt/cctv_hdd2"
                value={newVolPath}
                onChange={(e) => setNewVolPath(e.target.value)}
                className="w-full bg-vms-bg border border-vms-border rounded px-2.5 py-1.5 text-xs text-vms-text focus:outline-none focus:border-vms-accent font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-vms-text mb-1">
                Device Identifier (Optional)
              </label>
              <input
                type="text"
                placeholder="e.g. /dev/sdb1 or UUID=..."
                value={newVolDevice}
                onChange={(e) => setNewVolDevice(e.target.value)}
                className="w-full bg-vms-bg border border-vms-border rounded px-2.5 py-1.5 text-xs text-vms-text focus:outline-none focus:border-vms-accent font-mono"
              />
            </div>
            <div className="flex items-center gap-2 pt-1">
              <input
                type="checkbox"
                id="isDef"
                checked={newVolIsDefault}
                onChange={(e) => setNewVolIsDefault(e.target.checked)}
                className="rounded bg-vms-bg border-vms-border text-vms-accent focus:ring-0"
              />
              <label htmlFor="isDef" className="text-xs text-vms-text">
                Set as default recording volume for newly onboarded cameras
              </label>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-vms-border">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setShowAddVolumeModal(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
              >
                Register Volume
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {/* Edit Retention Policy Modal */}
      {editingCamera && (
        <Modal
          isOpen={true}
          onClose={() => setEditingCamera(null)}
          title={`Configure Retention: ${editingCamera.name}`}
          description={`Stream Path: ${editingCamera.streamPath}`}
          size="md"
        >
          <form onSubmit={handleSaveRetention} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-vms-text mb-1">
                Continuous Retention (Days)
              </label>
              <input
                type="number"
                min="1"
                max="365"
                required
                value={editContinuousDays}
                onChange={(e) => setEditContinuousDays(parseInt(e.target.value, 10) || 1)}
                className="w-full bg-vms-bg border border-vms-border rounded px-2.5 py-1.5 text-xs text-vms-text focus:outline-none focus:border-vms-accent font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-vms-text mb-1">
                Motion Retention (Days)
              </label>
              <input
                type="number"
                min="1"
                max="365"
                required
                value={editMotionDays}
                onChange={(e) => setEditMotionDays(parseInt(e.target.value, 10) || 1)}
                className="w-full bg-vms-bg border border-vms-border rounded px-2.5 py-1.5 text-xs text-vms-text focus:outline-none focus:border-vms-accent font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-vms-text mb-1">
                Storage Quota Cap in GB (Optional)
              </label>
              <input
                type="number"
                min="1"
                placeholder="Leave empty for uncapped"
                value={editMaxGb}
                onChange={(e) => setEditMaxGb(e.target.value)}
                className="w-full bg-vms-bg border border-vms-border rounded px-2.5 py-1.5 text-xs text-vms-text focus:outline-none focus:border-vms-accent font-mono"
              />
              <span className="text-[11px] text-vms-muted mt-1 block">
                Camera will automatically prune oldest unpinned segments when usage exceeds this threshold.
              </span>
            </div>
            <div>
              <label className="block text-xs font-medium text-vms-text mb-1">
                Pruning Priority Ladder
              </label>
              <select
                value={editPriority}
                onChange={(e) => setEditPriority(e.target.value as any)}
                className="w-full bg-vms-bg border border-vms-border rounded px-2.5 py-1.5 text-xs text-vms-text focus:outline-none focus:border-vms-accent"
              >
                <option value="HIGH">High (Vault, Cash, Perimeter - Pruned Last)</option>
                <option value="NORMAL">Normal (Corridors, General Areas)</option>
                <option value="LOW">Low (Auxiliary Feeds - Pruned First)</option>
              </select>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-vms-border">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setEditingCamera(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
              >
                Save Policy
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
};

export default StorageManagement;
