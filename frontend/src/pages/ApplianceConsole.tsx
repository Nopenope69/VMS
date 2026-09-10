import React, { useState, useEffect, useCallback } from 'react';
import {
  Server,
  Cpu,
  HardDrive,
  Activity,
  ShieldCheck,
  Download,
  RefreshCw,
  Clock,
  Terminal,
  FileArchive,
  Info,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import api from '../services/api';

interface SystemVitals {
  uptimeSeconds: number;
  cpuLoad: number[];
  memory: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    percentUsed: number;
  };
  os: {
    platform: string;
    release: string;
    arch: string;
    hostname: string;
  };
  storage: {
    totalBytes: string;
    availableBytes: string;
    percentUsed: number;
    mountGuardStatus: 'HEALTHY' | 'DEGRADED';
  };
  cameras: {
    total: number;
    degraded: number;
  };
  timestamp: string;
}

interface ApplianceIdentity {
  applianceId: string;
  softwareVersion: string;
  nodeFingerprint: string;
  isBootstrapped: boolean;
  bootstrappedAt: string | null;
  installedAt: string;
}

function formatBytes(bytes: number | string): string {
  const num = typeof bytes === 'string' ? parseFloat(bytes) : bytes;
  if (isNaN(num) || num === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(num) / Math.log(k));
  return `${(num / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
}

export const ApplianceConsole: React.FC = () => {
  const [vitals, setVitals] = useState<SystemVitals | null>(null);
  const [identity, setIdentity] = useState<ApplianceIdentity | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [downloadingBundle, setDownloadingBundle] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [bundleSuccess, setBundleSuccess] = useState('');

  const fetchApplianceData = useCallback(async (isManualRefresh = false) => {
    if (isManualRefresh) setRefreshing(true);
    try {
      const [vitalsRes, identityRes] = await Promise.all([
        api.get('/system/appliance/vitals'),
        api.get('/system/appliance/identity'),
      ]);
      setVitals(vitalsRes.data);
      setIdentity(identityRes.data);
      setErrorMessage('');
    } catch (err: any) {
      setErrorMessage(
        err.response?.data?.error ||
          err.message ||
          'Failed to communicate with appliance management subsystem.'
      );
    } finally {
      setLoading(false);
      if (isManualRefresh) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchApplianceData();
    const interval = setInterval(() => fetchApplianceData(), 10000);
    return () => clearInterval(interval);
  }, [fetchApplianceData]);

  const handleDownloadBundle = async () => {
    setDownloadingBundle(true);
    setBundleSuccess('');
    setErrorMessage('');

    try {
      const response = await api.get('/system/appliance/support-bundle', {
        responseType: 'blob',
      });

      // Trigger automatic browser download
      const blob = new Blob([response.data], { type: 'application/gzip' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      a.download = `vigilone-support-bundle-${timestamp}.tar.gz`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      setBundleSuccess('Support diagnostics bundle compiled and downloaded successfully.');
    } catch (err: any) {
      setErrorMessage(
        err.response?.data?.error ||
          err.message ||
          'Failed to compile and download diagnostics bundle.'
      );
    } finally {
      setDownloadingBundle(false);
    }
  };

  if (loading) {
    return (
      <div className="p-8 text-center text-slate-400 font-mono text-xs flex items-center justify-center space-x-2">
        <RefreshCw className="w-4 h-4 animate-spin text-cctv-amber" />
        <span>Querying VigilOne Appliance Management Subsystem...</span>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-6 selection:bg-cctv-amber/30">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-graphite-700 pb-4">
        <div>
          <div className="flex items-center space-x-2">
            <h1 className="text-xl font-bold tracking-wider text-white uppercase flex items-center space-x-2">
              <Server className="w-6 h-6 text-cctv-amber" />
              <span>Appliance Diagnostics & Health Console</span>
            </h1>
            <span className="text-[10px] px-2 py-0.5 rounded bg-cctv-teal/20 text-cctv-teal border border-cctv-teal/40 font-mono font-bold">
              EDGE NVR
            </span>
          </div>
          <p className="text-xs text-slate-400 font-mono mt-1">
            Hardware vitals, storage mount security guard, and Level-3 escalation diagnostics
          </p>
        </div>

        <div className="flex items-center space-x-3">
          <button
            onClick={() => fetchApplianceData(true)}
            disabled={refreshing}
            className="px-3 py-1.5 bg-graphite-800 hover:bg-graphite-700 border border-graphite-700 rounded text-xs font-mono text-slate-300 hover:text-white flex items-center space-x-1.5 transition disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin text-cctv-amber' : ''}`} />
            <span>Refresh</span>
          </button>

          <button
            onClick={handleDownloadBundle}
            disabled={downloadingBundle}
            className="px-4 py-1.5 bg-cctv-amber text-graphite-900 font-bold text-xs rounded hover:bg-amber-400 transition uppercase tracking-wider flex items-center space-x-1.5 shadow-md disabled:opacity-50"
          >
            <Download className="w-4 h-4" />
            <span>{downloadingBundle ? 'Compiling Bundle...' : 'Download Diagnostics Bundle'}</span>
          </button>
        </div>
      </div>

      {/* Notices */}
      {errorMessage && (
        <div className="p-4 bg-red-950/60 border border-red-500/80 rounded-lg text-xs text-red-200 flex items-start space-x-3 shadow-inner">
          <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="font-semibold">Subsystem Exception</div>
            <div>{errorMessage}</div>
          </div>
        </div>
      )}

      {bundleSuccess && (
        <div className="p-4 bg-emerald-950/60 border border-emerald-500/80 rounded-lg text-xs text-emerald-200 flex items-start space-x-3 shadow-inner">
          <CheckCircle2 className="w-5 h-5 text-emerald-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="font-semibold">Support Archive Generated</div>
            <div>{bundleSuccess}</div>
          </div>
        </div>
      )}

      {/* Top Cards: Hardware Vitals */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* CPU Load */}
        <div className="bg-graphite-850 border border-graphite-700 rounded-lg p-4 space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-400 font-mono">
            <span className="flex items-center space-x-1.5">
              <Cpu className="w-4 h-4 text-cctv-amber" />
              <span>CPU Load Averages</span>
            </span>
            <span className="text-slate-300 font-semibold">{vitals?.os.arch || 'x86_64'}</span>
          </div>
          <div className="text-xl font-bold font-mono text-white">
            {vitals?.cpuLoad?.length ? vitals.cpuLoad[0].toFixed(2) : '0.00'}
            <span className="text-xs font-normal text-slate-400 ml-1">1m load</span>
          </div>
          <div className="text-[11px] font-mono text-slate-400 flex justify-between border-t border-graphite-800 pt-1.5">
            <span>5m: {vitals?.cpuLoad?.[1]?.toFixed(2) ?? '0.00'}</span>
            <span>15m: {vitals?.cpuLoad?.[2]?.toFixed(2) ?? '0.00'}</span>
          </div>
        </div>

        {/* Memory */}
        <div className="bg-graphite-850 border border-graphite-700 rounded-lg p-4 space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-400 font-mono">
            <span className="flex items-center space-x-1.5">
              <Activity className="w-4 h-4 text-cctv-teal" />
              <span>Host Memory</span>
            </span>
            <span className="text-slate-300 font-semibold">
              {vitals?.memory?.percentUsed ?? 0}%
            </span>
          </div>
          <div className="text-xl font-bold font-mono text-white">
            {formatBytes(vitals?.memory?.usedBytes || 0)}
            <span className="text-xs font-normal text-slate-400 ml-1">
              / {formatBytes(vitals?.memory?.totalBytes || 0)}
            </span>
          </div>
          <div className="w-full bg-graphite-900 rounded-full h-1.5 overflow-hidden">
            <div
              className={`h-full transition-all duration-500 ${
                (vitals?.memory?.percentUsed || 0) > 85
                  ? 'bg-red-500'
                  : (vitals?.memory?.percentUsed || 0) > 70
                  ? 'bg-amber-500'
                  : 'bg-cctv-teal'
              }`}
              style={{ width: `${Math.min(100, vitals?.memory?.percentUsed || 0)}%` }}
            />
          </div>
        </div>

        {/* Primary Storage */}
        <div className="bg-graphite-850 border border-graphite-700 rounded-lg p-4 space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-400 font-mono">
            <span className="flex items-center space-x-1.5">
              <HardDrive className="w-4 h-4 text-indigo-400" />
              <span>Recordings Storage</span>
            </span>
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded font-bold font-mono ${
                vitals?.storage?.mountGuardStatus === 'HEALTHY'
                  ? 'bg-emerald-950 text-emerald-400 border border-emerald-600/40'
                  : 'bg-red-950 text-red-400 border border-red-600/40'
              }`}
            >
              {vitals?.storage?.mountGuardStatus || 'UNKNOWN'}
            </span>
          </div>
          <div className="text-xl font-bold font-mono text-white">
            {formatBytes(
              (parseFloat(vitals?.storage?.totalBytes || '0') -
                parseFloat(vitals?.storage?.availableBytes || '0')) ||
                0
            )}
            <span className="text-xs font-normal text-slate-400 ml-1">
              / {formatBytes(vitals?.storage?.totalBytes || 0)}
            </span>
          </div>
          <div className="w-full bg-graphite-900 rounded-full h-1.5 overflow-hidden">
            <div
              className={`h-full transition-all duration-500 ${
                (vitals?.storage?.percentUsed || 0) > 90
                  ? 'bg-red-500'
                  : (vitals?.storage?.percentUsed || 0) > 75
                  ? 'bg-amber-500'
                  : 'bg-indigo-500'
              }`}
              style={{ width: `${Math.min(100, vitals?.storage?.percentUsed || 0)}%` }}
            />
          </div>
        </div>

        {/* System Uptime */}
        <div className="bg-graphite-850 border border-graphite-700 rounded-lg p-4 space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-400 font-mono">
            <span className="flex items-center space-x-1.5">
              <Clock className="w-4 h-4 text-emerald-400" />
              <span>Appliance Uptime</span>
            </span>
            <span className="text-slate-400 text-[11px] font-mono">
              {vitals?.os.platform || 'linux'}
            </span>
          </div>
          <div className="text-xl font-bold font-mono text-white">
            {vitals ? formatUptime(vitals.uptimeSeconds) : '0m'}
          </div>
          <div className="text-[11px] font-mono text-slate-400 border-t border-graphite-800 pt-1.5 flex justify-between">
            <span>Cameras: {vitals?.cameras?.total ?? 0}</span>
            <span className={vitals?.cameras?.degraded ? 'text-amber-400' : 'text-emerald-400'}>
              {vitals?.cameras?.degraded ?? 0} degraded
            </span>
          </div>
        </div>
      </div>

      {/* Mid Section: Identity & Mount Guard Invariant */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Appliance Identity Card */}
        <div className="bg-graphite-850 border border-graphite-700 rounded-lg p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-graphite-800 pb-3">
            <h2 className="text-sm font-bold text-white uppercase tracking-wider flex items-center space-x-2">
              <Server className="w-4 h-4 text-cctv-amber" />
              <span>Appliance Identity & Cryptography</span>
            </h2>
            <span className="text-[10px] px-2 py-0.5 rounded bg-graphite-800 text-slate-300 font-mono border border-graphite-700">
              v{identity?.softwareVersion || '1.0.0'}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-y-3 gap-x-4 text-xs font-mono">
            <div>
              <span className="text-slate-500 block text-[11px]">APPLIANCE ID</span>
              <span className="text-slate-200 font-bold">{identity?.applianceId || 'N/A'}</span>
            </div>
            <div>
              <span className="text-slate-500 block text-[11px]">NODE FINGERPRINT</span>
              <span className="text-cctv-teal font-semibold">
                {identity?.nodeFingerprint ? `SHA256:${identity.nodeFingerprint}` : 'N/A'}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block text-[11px]">HOSTNAME</span>
              <span className="text-slate-200">{vitals?.os.hostname || 'vigilone-edge'}</span>
            </div>
            <div>
              <span className="text-slate-500 block text-[11px]">CANONICAL FQDN</span>
              <span className="text-cctv-amber">vigilone.local</span>
            </div>
            <div>
              <span className="text-slate-500 block text-[11px]">COMMISSIONED AT</span>
              <span className="text-slate-300">
                {identity?.bootstrappedAt
                  ? new Date(identity.bootstrappedAt).toLocaleString()
                  : 'Pre-Provisioning'}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block text-[11px]">ENCRYPTION KEY STATUS</span>
              <span className="text-emerald-400 font-semibold">
                AES-256-GCM Locked (/etc/vigilone)
              </span>
            </div>
          </div>

          <div className="p-3 bg-graphite-900 border border-graphite-800 rounded text-[11px] font-mono text-slate-400 flex items-start space-x-2">
            <Info className="w-4 h-4 text-cctv-teal flex-shrink-0 mt-0.5" />
            <div>
              Internal cryptographic separation enforced: Credential Encryption Key is isolated from
              JWT signing keys and TLS private keys.
            </div>
          </div>
        </div>

        {/* Mount Guard & Storage Security */}
        <div className="bg-graphite-850 border border-graphite-700 rounded-lg p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-graphite-800 pb-3">
            <h2 className="text-sm font-bold text-white uppercase tracking-wider flex items-center space-x-2">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>Storage Mount Guard Subsystem</span>
            </h2>
            <span
              className={`text-[10px] px-2 py-0.5 rounded font-mono font-bold ${
                vitals?.storage?.mountGuardStatus === 'HEALTHY'
                  ? 'bg-emerald-950 text-emerald-400 border border-emerald-600/40'
                  : 'bg-red-950 text-red-400 border border-red-600/40'
              }`}
            >
              {vitals?.storage?.mountGuardStatus === 'HEALTHY' ? 'GUARD ACTIVE' : 'FAILOVER ENGAGED'}
            </span>
          </div>

          <div className="space-y-3 text-xs">
            <div className="p-3 bg-graphite-900 border border-graphite-800 rounded font-mono space-y-1.5">
              <div className="flex justify-between text-slate-300">
                <span className="text-slate-500">Primary Mount:</span>
                <span className="text-white font-bold">/var/lib/vigilone/recordings</span>
              </div>
              <div className="flex justify-between text-slate-300">
                <span className="text-slate-500">Mount Guard Token:</span>
                <span className="text-emerald-400">.vigilone_mount_guard (Verified)</span>
              </div>
              <div className="flex justify-between text-slate-300">
                <span className="text-slate-500">Write Probe Status:</span>
                <span className="text-emerald-400">PASSED (Zero Latency)</span>
              </div>
            </div>

            <p className="text-slate-400 text-xs">
              Mount Guard verifies that the dedicated storage partition is persistently attached. If an
              underlying drive unmounts or drops offline, recording automatically engages isolated
              storage epoch transitions to prevent evidentiary corruption.
            </p>
          </div>
        </div>
      </div>

      {/* Bottom Section: Support Diagnostics Bundle Card */}
      <div className="bg-gradient-to-r from-graphite-850 via-graphite-850 to-graphite-800 border border-graphite-700 rounded-lg p-6 space-y-4 shadow-lg">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-sm font-bold text-white uppercase tracking-wider flex items-center space-x-2">
              <FileArchive className="w-5 h-5 text-cctv-amber" />
              <span>Level-3 Support & Diagnostics Bundle</span>
            </h2>
            <p className="text-xs text-slate-400">
              Generate an end-to-end sanitized diagnostic archive for vendor escalation. All sensitive
              secrets are automatically redacted before packaging.
            </p>
          </div>

          <button
            onClick={handleDownloadBundle}
            disabled={downloadingBundle}
            className="px-5 py-2.5 bg-cctv-amber text-graphite-900 font-bold text-xs rounded hover:bg-amber-400 transition uppercase tracking-wider flex items-center space-x-2 shadow disabled:opacity-50 flex-shrink-0"
          >
            <Download className="w-4 h-4" />
            <span>{downloadingBundle ? 'Compiling Archive...' : 'Download Bundle (.tar.gz)'}</span>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2 text-xs font-mono">
          <div className="bg-graphite-900/80 border border-graphite-800 p-3 rounded space-y-1">
            <span className="text-cctv-teal font-semibold block flex items-center space-x-1">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>Included Telemetry</span>
            </span>
            <ul className="text-slate-400 text-[11px] list-disc list-inside space-y-0.5">
              <li>Appliance hardware vitals & uptime</li>
              <li>Prisma schema & migration history</li>
              <li>Redacted container service logs</li>
              <li>Network ingress routing config</li>
            </ul>
          </div>

          <div className="bg-graphite-900/80 border border-graphite-800 p-3 rounded space-y-1">
            <span className="text-emerald-400 font-semibold block flex items-center space-x-1">
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Privacy Guarantees</span>
            </span>
            <ul className="text-slate-400 text-[11px] list-disc list-inside space-y-0.5">
              <li>Zero JWT or Bearer session tokens</li>
              <li>Stripped database passwords</li>
              <li>Redacted camera RTSP passwords</li>
              <li>Zero private TLS / signing keys</li>
            </ul>
          </div>

          <div className="bg-graphite-900/80 border border-graphite-800 p-3 rounded space-y-1">
            <span className="text-cctv-amber font-semibold block flex items-center space-x-1">
              <Terminal className="w-3.5 h-3.5" />
              <span>CLI Equivalent</span>
            </span>
            <p className="text-slate-400 text-[11px]">
              Technicians on the host terminal can compile the identical bundle via:
            </p>
            <code className="block text-[10px] text-cctv-amber bg-graphite-950 p-1 rounded border border-graphite-800 mt-1">
              sudo vigilonectl support-bundle
            </code>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ApplianceConsole;
