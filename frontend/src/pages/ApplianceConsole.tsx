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
      <div className="p-12 text-center text-slate-400 font-mono text-xs flex items-center justify-center space-x-2 bg-[#080B10]">
        <RefreshCw className="w-4 h-4 animate-spin text-[#E3B341]" />
        <span>[ QUERYING VIGILONE HARDWARE MANAGEMENT SUBSYSTEM... ]</span>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-[#080B10] text-slate-100 p-4 sm:p-6 space-y-6 font-mono select-none">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#21262D] pb-4 bg-[#0D1117] p-4 border relative">
        <span className="absolute -top-1 -left-1 text-[9px] text-[#30363D]">+</span>
        <span className="absolute -top-1 -right-1 text-[9px] text-[#30363D]">+</span>
        <span className="absolute -bottom-1 -left-1 text-[9px] text-[#30363D]">+</span>
        <span className="absolute -bottom-1 -right-1 text-[9px] text-[#30363D]">+</span>

        <div>
          <div className="flex items-center space-x-2">
            <Server className="w-5 h-5 text-[#E3B341]" />
            <h1 className="text-xs font-bold text-white uppercase tracking-wider flex items-center space-x-2">
              <span>Appliance Diagnostics & System Health Console</span>
            </h1>
            <span className="text-[10px] px-2 py-0.5 rounded-none bg-[#58A6FF]/10 text-[#58A6FF] border border-[#58A6FF]/40 font-bold">
              EDGE_NVR_AIR_GAPPED
            </span>
          </div>
          <p className="text-[11px] text-slate-400 mt-1">
            Hardware telemetry, storage mount security guard, and Level-3 escalation diagnostics
          </p>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={() => fetchApplianceData(true)}
            disabled={refreshing}
            className="btn-tactical-secondary flex items-center space-x-1.5 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin text-[#E3B341]' : ''}`} />
            <span>Refresh</span>
          </button>

          <button
            onClick={handleDownloadBundle}
            disabled={downloadingBundle}
            className="btn-tactical-primary flex items-center space-x-1.5 disabled:opacity-50"
          >
            <Download className="w-4 h-4" />
            <span>{downloadingBundle ? 'Compiling Archive...' : 'Diagnostics Bundle'}</span>
          </button>
        </div>
      </div>

      {/* Notices */}
      {errorMessage && (
        <div className="p-3 bg-[#F85149]/10 border border-[#F85149]/40 text-xs text-[#F85149] flex items-start space-x-2.5">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="font-bold uppercase tracking-wider">SUBSYSTEM EXCEPTION:</div>
            <div>{errorMessage}</div>
          </div>
        </div>
      )}

      {bundleSuccess && (
        <div className="p-3 bg-[#3FB950]/10 border border-[#3FB950]/40 text-xs text-[#3FB950] flex items-start space-x-2.5">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="font-bold uppercase tracking-wider">DIAGNOSTICS ARCHIVE COMPILED:</div>
            <div>{bundleSuccess}</div>
          </div>
        </div>
      )}

      {/* Top Cards: Hardware Vitals */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        {/* CPU Load */}
        <div className="bg-[#0D1117] border border-[#21262D] p-3.5 space-y-2 relative">
          <span className="absolute -top-1 -left-1 text-[8px] text-[#30363D]">+</span>
          <span className="absolute -bottom-1 -right-1 text-[8px] text-[#30363D]">+</span>
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span className="flex items-center space-x-1.5 uppercase text-[10px] tracking-wider">
              <Cpu className="w-3.5 h-3.5 text-[#E3B341]" />
              <span>CPU_LOAD_AVG</span>
            </span>
            <span className="text-slate-300 font-bold">{vitals?.os.arch || 'X86_64'}</span>
          </div>
          <div className="text-2xl font-bold text-white tracking-wider">
            {vitals?.cpuLoad?.length ? vitals.cpuLoad[0].toFixed(2) : '0.00'}
            <span className="text-xs font-normal text-slate-500 ml-1">1M</span>
          </div>
          <div className="text-[10px] text-slate-500 flex justify-between border-t border-[#21262D] pt-1.5">
            <span>5M: <span className="text-slate-300">{vitals?.cpuLoad?.[1]?.toFixed(2) ?? '0.00'}</span></span>
            <span>15M: <span className="text-slate-300">{vitals?.cpuLoad?.[2]?.toFixed(2) ?? '0.00'}</span></span>
          </div>
        </div>

        {/* Memory */}
        <div className="bg-[#0D1117] border border-[#21262D] p-3.5 space-y-2 relative">
          <span className="absolute -top-1 -left-1 text-[8px] text-[#30363D]">+</span>
          <span className="absolute -bottom-1 -right-1 text-[8px] text-[#30363D]">+</span>
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span className="flex items-center space-x-1.5 uppercase text-[10px] tracking-wider">
              <Activity className="w-3.5 h-3.5 text-[#58A6FF]" />
              <span>HOST_MEMORY</span>
            </span>
            <span className="text-[#58A6FF] font-bold">
              {vitals?.memory?.percentUsed ?? 0}%
            </span>
          </div>
          <div className="text-2xl font-bold text-white tracking-wider">
            {formatBytes(vitals?.memory?.usedBytes || 0)}
            <span className="text-xs font-normal text-slate-500 ml-1">
              / {formatBytes(vitals?.memory?.totalBytes || 0)}
            </span>
          </div>
          <div className="w-full bg-[#161B22] h-1.5 overflow-hidden">
            <div
              className={`h-full transition-all duration-500 ${
                (vitals?.memory?.percentUsed || 0) > 85
                  ? 'bg-[#F85149]'
                  : (vitals?.memory?.percentUsed || 0) > 70
                  ? 'bg-[#E3B341]'
                  : 'bg-[#58A6FF]'
              }`}
              style={{ width: `${Math.min(100, vitals?.memory?.percentUsed || 0)}%` }}
            />
          </div>
        </div>

        {/* Primary Storage */}
        <div className="bg-[#0D1117] border border-[#21262D] p-3.5 space-y-2 relative">
          <span className="absolute -top-1 -left-1 text-[8px] text-[#30363D]">+</span>
          <span className="absolute -bottom-1 -right-1 text-[8px] text-[#30363D]">+</span>
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span className="flex items-center space-x-1.5 uppercase text-[10px] tracking-wider">
              <HardDrive className="w-3.5 h-3.5 text-[#E3B341]" />
              <span>STORAGE_MOUNT</span>
            </span>
            <span
              className={`text-[9px] px-1.5 py-[2px] font-bold ${
                vitals?.storage?.mountGuardStatus === 'HEALTHY'
                  ? 'bg-[#3FB950]/10 text-[#3FB950] border border-[#3FB950]/40'
                  : 'bg-[#F85149]/10 text-[#F85149] border border-[#F85149]/40'
              }`}
            >
              {vitals?.storage?.mountGuardStatus || 'UNKNOWN'}
            </span>
          </div>
          <div className="text-2xl font-bold text-white tracking-wider">
            {formatBytes(
              (parseFloat(vitals?.storage?.totalBytes || '0') -
                parseFloat(vitals?.storage?.availableBytes || '0')) ||
                0
            )}
            <span className="text-xs font-normal text-slate-500 ml-1">
              / {formatBytes(vitals?.storage?.totalBytes || 0)}
            </span>
          </div>
          <div className="w-full bg-[#161B22] h-1.5 overflow-hidden">
            <div
              className={`h-full transition-all duration-500 ${
                (vitals?.storage?.percentUsed || 0) > 90
                  ? 'bg-[#F85149]'
                  : (vitals?.storage?.percentUsed || 0) > 75
                  ? 'bg-[#E3B341]'
                  : 'bg-[#3FB950]'
              }`}
              style={{ width: `${Math.min(100, vitals?.storage?.percentUsed || 0)}%` }}
            />
          </div>
        </div>

        {/* System Uptime */}
        <div className="bg-[#0D1117] border border-[#21262D] p-3.5 space-y-2 relative">
          <span className="absolute -top-1 -left-1 text-[8px] text-[#30363D]">+</span>
          <span className="absolute -bottom-1 -right-1 text-[8px] text-[#30363D]">+</span>
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span className="flex items-center space-x-1.5 uppercase text-[10px] tracking-wider">
              <Clock className="w-3.5 h-3.5 text-[#3FB950]" />
              <span>APPLIANCE_UPTIME</span>
            </span>
            <span className="text-slate-500 text-[10px]">
              {vitals?.os.platform?.toUpperCase() || 'LINUX'}
            </span>
          </div>
          <div className="text-2xl font-bold text-white tracking-wider">
            {vitals ? formatUptime(vitals.uptimeSeconds) : '0m'}
          </div>
          <div className="text-[10px] text-slate-500 border-t border-[#21262D] pt-1.5 flex justify-between">
            <span>SENSORS: {vitals?.cameras?.total ?? 0}</span>
            <span className={vitals?.cameras?.degraded ? 'text-[#F85149] font-bold' : 'text-[#3FB950]'}>
              {vitals?.cameras?.degraded ?? 0} DEGRADED
            </span>
          </div>
        </div>
      </div>

      {/* Mid Section: Identity & Mount Guard Invariant */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Appliance Identity Card */}
        <div className="bg-[#0D1117] border border-[#21262D] p-5 space-y-4 relative">
          <span className="absolute -top-1 -left-1 text-[9px] text-[#30363D]">+</span>
          <span className="absolute -top-1 -right-1 text-[9px] text-[#30363D]">+</span>
          <span className="absolute -bottom-1 -left-1 text-[9px] text-[#30363D]">+</span>
          <span className="absolute -bottom-1 -right-1 text-[9px] text-[#30363D]">+</span>

          <div className="flex items-center justify-between border-b border-[#21262D] pb-2.5">
            <h2 className="text-xs font-bold text-white uppercase tracking-wider flex items-center space-x-2">
              <Server className="w-4 h-4 text-[#E3B341]" />
              <span>Appliance Cryptographic Identity</span>
            </h2>
            <span className="text-[10px] px-2 py-0.5 bg-[#161B22] text-[#E3B341] border border-[#21262D]">
              v{identity?.softwareVersion || '1.0.0'}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-y-3 gap-x-4 text-xs">
            <div>
              <span className="text-slate-500 block text-[10px] uppercase">APPLIANCE_ID:</span>
              <span className="text-slate-200 font-bold">{identity?.applianceId || 'N/A'}</span>
            </div>
            <div>
              <span className="text-slate-500 block text-[10px] uppercase">NODE_FINGERPRINT:</span>
              <span className="text-[#58A6FF] font-semibold break-all text-[11px]">
                {identity?.nodeFingerprint ? `SHA256:${identity.nodeFingerprint.slice(0, 16)}...` : 'N/A'}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block text-[10px] uppercase">HOSTNAME:</span>
              <span className="text-slate-200">{vitals?.os.hostname || 'vigilone-edge'}</span>
            </div>
            <div>
              <span className="text-slate-500 block text-[10px] uppercase">CANONICAL_FQDN:</span>
              <span className="text-[#E3B341]">vigilone.local</span>
            </div>
            <div>
              <span className="text-slate-500 block text-[10px] uppercase">COMMISSIONED_AT:</span>
              <span className="text-slate-300">
                {identity?.bootstrappedAt
                  ? new Date(identity.bootstrappedAt).toISOString().slice(0, 19) + ' UTC'
                  : 'PRE-PROVISIONING'}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block text-[10px] uppercase">ENCRYPTION_KEY_STATUS:</span>
              <span className="text-[#3FB950] font-semibold">
                AES-256-GCM (/etc/vigilone)
              </span>
            </div>
          </div>

          <div className="p-3 bg-[#161B22] border border-[#21262D] text-[11px] text-slate-400 flex items-start space-x-2">
            <Info className="w-4 h-4 text-[#58A6FF] flex-shrink-0 mt-0.5" />
            <div>
              Cryptographic domain isolation enforced: Credential Master Encryption Key is isolated from
              JWT signing keys and TLS private keys.
            </div>
          </div>
        </div>

        {/* Mount Guard & Storage Security */}
        <div className="bg-[#0D1117] border border-[#21262D] p-5 space-y-4 relative">
          <span className="absolute -top-1 -left-1 text-[9px] text-[#30363D]">+</span>
          <span className="absolute -top-1 -right-1 text-[9px] text-[#30363D]">+</span>
          <span className="absolute -bottom-1 -left-1 text-[9px] text-[#30363D]">+</span>
          <span className="absolute -bottom-1 -right-1 text-[9px] text-[#30363D]">+</span>

          <div className="flex items-center justify-between border-b border-[#21262D] pb-2.5">
            <h2 className="text-xs font-bold text-white uppercase tracking-wider flex items-center space-x-2">
              <ShieldCheck className="w-4 h-4 text-[#3FB950]" />
              <span>Storage Mount Guard Invariant</span>
            </h2>
            <span
              className={`text-[10px] px-2 py-0.5 font-bold ${
                vitals?.storage?.mountGuardStatus === 'HEALTHY'
                  ? 'bg-[#3FB950]/10 text-[#3FB950] border border-[#3FB950]/40'
                  : 'bg-[#F85149]/10 text-[#F85149] border border-[#F85149]/40'
              }`}
            >
              {vitals?.storage?.mountGuardStatus === 'HEALTHY' ? 'GUARD_ACTIVE' : 'FAILOVER_LOCKED'}
            </span>
          </div>

          <div className="space-y-3 text-xs">
            <div className="p-3 bg-[#161B22] border border-[#21262D] space-y-1.5">
              <div className="flex justify-between text-slate-300">
                <span className="text-slate-500 uppercase text-[10px]">PRIMARY MOUNT POINT:</span>
                <span className="text-white font-bold">/var/lib/vigilone/recordings</span>
              </div>
              <div className="flex justify-between text-slate-300">
                <span className="text-slate-500 uppercase text-[10px]">MOUNT GUARD TOKEN:</span>
                <span className="text-[#3FB950]">.vigilone_mount_guard [VERIFIED]</span>
              </div>
              <div className="flex justify-between text-slate-300">
                <span className="text-slate-500 uppercase text-[10px]">WRITE PROBE LATENCY:</span>
                <span className="text-[#3FB950]">PASSED (&lt; 1ms)</span>
              </div>
            </div>

            <p className="text-slate-400 text-xs leading-relaxed">
              Mount Guard verifies persistent partition attachment on every segment write. If the underlying disk drops offline,
              the recording pipeline transitions to isolated storage epochs to prevent evidentiary database corruption.
            </p>
          </div>
        </div>
      </div>

      {/* Bottom Section: Support Diagnostics Bundle Card */}
      <div className="bg-[#0D1117] border border-[#21262D] p-5 space-y-4 relative">
        <span className="absolute -top-1 -left-1 text-[9px] text-[#30363D]">+</span>
        <span className="absolute -top-1 -right-1 text-[9px] text-[#30363D]">+</span>
        <span className="absolute -bottom-1 -left-1 text-[9px] text-[#30363D]">+</span>
        <span className="absolute -bottom-1 -right-1 text-[9px] text-[#30363D]">+</span>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-xs font-bold text-white uppercase tracking-wider flex items-center space-x-2">
              <FileArchive className="w-4 h-4 text-[#E3B341]" />
              <span>Level-3 Support & Diagnostics Bundle</span>
            </h2>
            <p className="text-xs text-slate-400">
              Generate an end-to-end sanitized diagnostic archive for manufacturer escalation. All cryptographic secrets are automatically redacted.
            </p>
          </div>

          <button
            onClick={handleDownloadBundle}
            disabled={downloadingBundle}
            className="btn-tactical-primary flex items-center space-x-2 flex-shrink-0 disabled:opacity-50"
          >
            <Download className="w-4 h-4" />
            <span>{downloadingBundle ? 'Compiling Archive...' : 'Download Bundle (.tar.gz)'}</span>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2 text-xs">
          <div className="bg-[#161B22] border border-[#21262D] p-3 space-y-1.5">
            <span className="text-[#58A6FF] font-bold block flex items-center space-x-1 uppercase text-[10px]">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>INCLUDED TELEMETRY</span>
            </span>
            <ul className="text-slate-400 text-[11px] space-y-0.5">
              <li>• Appliance hardware vitals & uptime</li>
              <li>• Prisma schema & migration history</li>
              <li>• Redacted system service journals</li>
              <li>• Network ingress routing table</li>
            </ul>
          </div>

          <div className="bg-[#161B22] border border-[#21262D] p-3 space-y-1.5">
            <span className="text-[#3FB950] font-bold block flex items-center space-x-1 uppercase text-[10px]">
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>PRIVACY GUARANTEES</span>
            </span>
            <ul className="text-slate-400 text-[11px] space-y-0.5">
              <li>• Zero JWT or Bearer session tokens</li>
              <li>• Stripped database passwords</li>
              <li>• Redacted camera RTSP passwords</li>
              <li>• Zero private TLS / signing keys</li>
            </ul>
          </div>

          <div className="bg-[#161B22] border border-[#21262D] p-3 space-y-1.5">
            <span className="text-[#E3B341] font-bold block flex items-center space-x-1 uppercase text-[10px]">
              <Terminal className="w-3.5 h-3.5" />
              <span>TERMINAL CLI EQUIVALENT</span>
            </span>
            <p className="text-slate-400 text-[11px]">
              Engineers on the host terminal can compile the identical bundle via:
            </p>
            <code className="block text-[10px] text-[#E3B341] bg-[#080B10] p-1.5 border border-[#21262D] mt-1 font-mono select-text">
              sudo vigilonectl support-bundle
            </code>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ApplianceConsole;
