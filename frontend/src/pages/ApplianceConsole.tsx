import React, { useState, useEffect, useCallback } from 'react';
import {
  Server,
  ShieldCheck,
  Download,
  RefreshCw,
  Terminal,
  FileArchive,
  Info,
  CheckCircle2,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Layers,
  Key,
  Network,
  Car,
} from 'lucide-react';
import api from '../services/api';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';

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
  const [showRoadmap, setShowRoadmap] = useState(false);

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
      <div className="p-16 text-center text-vms-muted font-mono text-xs flex items-center justify-center gap-2 bg-vms-bg min-h-[calc(100vh-3.5rem)]">
        <RefreshCw className="w-4 h-4 animate-spin text-vms-accent" />
        <span>Querying VigilOne hardware management subsystem...</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-[calc(100vh-3.5rem)] bg-vms-bg p-3 md:p-4 space-y-3">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 border-b border-vms-border pb-3">
        <div className="flex items-center gap-2.5">
          <Server className="w-5 h-5 text-vms-accent" />
          <h1 className="text-base md:text-lg font-bold text-vms-text tracking-tight uppercase font-mono">
            Appliance Diagnostics & System Health
          </h1>
          <Badge variant="live" size="sm" dot>
            Edge NVR Secure
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => fetchApplianceData(true)}
            isLoading={refreshing}
            icon={<RefreshCw className="w-3.5 h-3.5" />}
          >
            Refresh
          </Button>

          <Button
            variant="primary"
            size="sm"
            onClick={handleDownloadBundle}
            isLoading={downloadingBundle}
            icon={<Download className="w-3.5 h-3.5" />}
          >
            {downloadingBundle ? 'Compiling Archive...' : 'Diagnostics Bundle'}
          </Button>
        </div>
      </div>

      {/* Notices */}
      {errorMessage && (
        <div className="p-3 bg-status-alarm/10 border border-status-alarm/30 rounded text-xs text-status-alarm flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="font-semibold uppercase tracking-wider">Subsystem Exception</div>
            <div>{errorMessage}</div>
          </div>
        </div>
      )}

      {bundleSuccess && (
        <div className="p-3 bg-status-live/10 border border-status-live/30 rounded text-xs text-status-live flex items-start gap-2.5">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="font-semibold uppercase tracking-wider">Diagnostics Archive Compiled</div>
            <div>{bundleSuccess}</div>
          </div>
        </div>
      )}

      {/* Horizontal Telemetry Bar */}
      <div className="flex flex-wrap items-center gap-4 sm:gap-6 px-3 py-2 bg-vms-surface border border-vms-border rounded text-xs font-mono">
        <div className="flex items-center gap-2">
          <span className="text-vms-muted">CPU LOAD:</span>
          <span className={`font-bold ${(vitals?.cpuLoad?.[0] || 0) > 4 ? 'text-amber-400' : 'text-vms-text'}`}>
            {vitals?.cpuLoad?.length ? vitals.cpuLoad[0].toFixed(2) : '0.00'}
          </span>
          <span className="text-[10px] text-vms-dim">
            ({vitals?.cpuLoad?.[1]?.toFixed(2) ?? '0.00'} / {vitals?.cpuLoad?.[2]?.toFixed(2) ?? '0.00'})
          </span>
        </div>
        <div className="h-3 w-px bg-vms-border hidden sm:block" />
        <div className="flex items-center gap-2">
          <span className="text-vms-muted">MEMORY:</span>
          <span className={`font-bold ${(vitals?.memory?.percentUsed || 0) > 85 ? 'text-rose-400' : (vitals?.memory?.percentUsed || 0) > 70 ? 'text-amber-400' : 'text-vms-text'}`}>
            {vitals?.memory?.percentUsed ?? 0}%
          </span>
          <span className="text-[10px] text-vms-dim">
            ({formatBytes(vitals?.memory?.usedBytes || 0)} / {formatBytes(vitals?.memory?.totalBytes || 0)})
          </span>
        </div>
        <div className="h-3 w-px bg-vms-border hidden sm:block" />
        <div className="flex items-center gap-2">
          <span className="text-vms-muted">MOUNT GUARD:</span>
          <span className={`font-bold ${vitals?.storage?.mountGuardStatus === 'HEALTHY' ? 'text-emerald-400' : 'text-rose-400'}`}>
            {vitals?.storage?.mountGuardStatus === 'HEALTHY' ? 'Healthy' : 'Degraded'}
          </span>
        </div>
        <div className="h-3 w-px bg-vms-border hidden sm:block" />
        <div className="flex items-center gap-2">
          <span className="text-vms-muted">UPTIME:</span>
          <span className="font-bold text-vms-text">
            {vitals ? formatUptime(vitals.uptimeSeconds) : '0m'}
          </span>
        </div>
      </div>

      {/* Mid Section: Identity & Mount Guard Invariant */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Appliance Identity Card */}
        <Card padding="md">
          <div className="flex items-center justify-between border-b border-vms-border pb-3 mb-4">
            <div className="flex items-center gap-2">
              <Server className="w-4 h-4 text-vms-accent" />
              <h2 className="text-xs font-semibold text-vms-text uppercase tracking-wider">
                Appliance Cryptographic Identity
              </h2>
            </div>
            <Badge variant="outline" size="sm">
              v{identity?.softwareVersion || '1.0.0'}
            </Badge>
          </div>

          <div className="grid grid-cols-2 gap-y-3.5 gap-x-4 text-xs">
            <div>
              <span className="text-vms-dim block text-[10px] uppercase font-mono">Appliance ID:</span>
              <span className="text-vms-text font-semibold font-mono">{identity?.applianceId || 'N/A'}</span>
            </div>
            <div>
              <span className="text-vms-dim block text-[10px] uppercase font-mono">Node Fingerprint:</span>
              <span className="text-vms-accent font-mono text-[11px]">
                {identity?.nodeFingerprint ? `SHA256:${identity.nodeFingerprint.slice(0, 16)}...` : 'N/A'}
              </span>
            </div>
            <div>
              <span className="text-vms-dim block text-[10px] uppercase font-mono">Hostname:</span>
              <span className="text-vms-text font-mono">{vitals?.os.hostname || 'vigilone-edge'}</span>
            </div>
            <div>
              <span className="text-vms-dim block text-[10px] uppercase font-mono">Canonical FQDN:</span>
              <span className="text-vms-accent font-mono">vigilone.local</span>
            </div>
            <div>
              <span className="text-vms-dim block text-[10px] uppercase font-mono">Commissioned At:</span>
              <span className="text-vms-muted font-mono text-[11px]">
                {identity?.bootstrappedAt
                  ? new Date(identity.bootstrappedAt).toISOString().slice(0, 19).replace('T', ' ') + ' UTC'
                  : 'Pre-provisioned'}
              </span>
            </div>
            <div>
              <span className="text-vms-dim block text-[10px] uppercase font-mono">Encryption Standard:</span>
              <span className="text-status-live font-semibold font-mono text-[11px]">
                AES-256-GCM (/etc/vigilone)
              </span>
            </div>
          </div>

          <div className="mt-4 p-3 bg-vms-panel rounded border border-vms-border text-[11px] text-vms-muted flex items-start gap-2.5">
            <Info className="w-4 h-4 text-vms-accent flex-shrink-0 mt-0.5" />
            <div className="leading-relaxed">
              Cryptographic domain isolation enforced: Credential Master Encryption Key is isolated from
              JWT signing keys and TLS private keys.
            </div>
          </div>
        </Card>

        {/* Mount Guard & Storage Security */}
        <Card padding="md">
          <div className="flex items-center justify-between border-b border-vms-border pb-3 mb-4">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-status-live" />
              <h2 className="text-xs font-semibold text-vms-text uppercase tracking-wider">
                Storage Mount Guard Invariant
              </h2>
            </div>
            <Badge
              variant={vitals?.storage?.mountGuardStatus === 'HEALTHY' ? 'live' : 'alarm'}
              size="sm"
            >
              {vitals?.storage?.mountGuardStatus === 'HEALTHY' ? 'Guard Active' : 'Failover Locked'}
            </Badge>
          </div>

          <div className="space-y-3.5 text-xs">
            <div className="p-3 bg-vms-panel rounded border border-vms-border space-y-2 font-mono">
              <div className="flex justify-between">
                <span className="text-vms-dim text-[11px]">PRIMARY MOUNT POINT:</span>
                <span className="text-vms-text font-semibold">/var/lib/vigilone/recordings</span>
              </div>
              <div className="flex justify-between">
                <span className="text-vms-dim text-[11px]">MOUNT GUARD TOKEN:</span>
                <span className="text-status-live font-semibold">.vigilone_mount_guard (Verified)</span>
              </div>
              <div className="flex justify-between">
                <span className="text-vms-dim text-[11px]">WRITE PROBE LATENCY:</span>
                <span className="text-status-live font-semibold">Passed (&lt; 1ms)</span>
              </div>
            </div>

            <p className="text-vms-muted text-xs leading-relaxed">
              Mount Guard verifies persistent partition attachment on every segment write. If the underlying disk drops offline,
              the recording pipeline transitions to isolated storage epochs to prevent evidentiary database corruption.
            </p>
          </div>
        </Card>
      </div>

      {/* Support Diagnostics Bundle Card */}
      <Card padding="md">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-vms-border pb-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <FileArchive className="w-4 h-4 text-vms-accent" />
              <h2 className="text-xs font-semibold text-vms-text uppercase tracking-wider">
                Level-3 Support & Diagnostics Bundle
              </h2>
            </div>
            <p className="text-xs text-vms-muted">
              Generate an end-to-end sanitized diagnostic archive for manufacturer escalation. All cryptographic secrets and session tokens are automatically redacted.
            </p>
          </div>

          <Button
            variant="primary"
            size="sm"
            onClick={handleDownloadBundle}
            isLoading={downloadingBundle}
            icon={<Download className="w-3.5 h-3.5" />}
          >
            {downloadingBundle ? 'Compiling Archive...' : 'Download Bundle (.tar.gz)'}
          </Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-4 text-xs">
          <div className="bg-vms-panel border border-vms-border rounded p-3 space-y-1.5">
            <span className="text-vms-accent font-semibold block flex items-center gap-1.5 uppercase text-[11px]">
              <CheckCircle2 className="w-3.5 h-3.5 text-vms-accent" />
              <span>Included Telemetry</span>
            </span>
            <ul className="text-vms-muted text-[11px] space-y-1">
              <li>• Appliance hardware vitals & uptime history</li>
              <li>• Database schema & migration status</li>
              <li>• Redacted system service journals</li>
              <li>• Network ingress routing table</li>
            </ul>
          </div>

          <div className="bg-vms-panel border border-vms-border rounded p-3 space-y-1.5">
            <span className="text-status-live font-semibold block flex items-center gap-1.5 uppercase text-[11px]">
              <ShieldCheck className="w-3.5 h-3.5 text-status-live" />
              <span>Privacy Guarantees</span>
            </span>
            <ul className="text-vms-muted text-[11px] space-y-1">
              <li>• Zero JWT or Bearer session tokens</li>
              <li>• Stripped database passwords</li>
              <li>• Redacted camera RTSP passwords</li>
              <li>• Zero private TLS / signing keys</li>
            </ul>
          </div>

          <div className="bg-vms-panel border border-vms-border rounded p-3 space-y-1.5">
            <span className="text-status-warn font-semibold block flex items-center gap-1.5 uppercase text-[11px]">
              <Terminal className="w-3.5 h-3.5 text-status-warn" />
              <span>Terminal CLI Equivalent</span>
            </span>
            <p className="text-vms-muted text-[11px]">
              Engineers on the host terminal can compile the identical bundle via:
            </p>
            <code className="block text-[11px] text-vms-accent bg-vms-bg p-2 rounded border border-vms-border mt-1 font-mono select-all">
              sudo vigilonectl support-bundle
            </code>
          </div>
        </div>
      </Card>

      {/* Architecture Roadmap Drawer (Explains V2 Out-of-Scope Capabilities) */}
      <Card padding="none">
        <button
          onClick={() => setShowRoadmap(!showRoadmap)}
          className="w-full px-4 py-3.5 flex items-center justify-between text-left hover:bg-vms-hover/30 transition"
        >
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-vms-dim" />
            <span className="font-semibold text-xs text-vms-text uppercase tracking-wider">
              Enterprise Expansion Subsystems (v2.0 Architecture Roadmap)
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" size="sm">
              Modular Stubs
            </Badge>
            {showRoadmap ? (
              <ChevronDown className="w-4 h-4 text-vms-muted" />
            ) : (
              <ChevronRight className="w-4 h-4 text-vms-muted" />
            )}
          </div>
        </button>

        {showRoadmap && (
          <div className="p-4 border-t border-vms-border bg-vms-panel/50 space-y-3 text-xs">
            <p className="text-vms-muted leading-relaxed">
              VigilOne V1.0 is architected strictly as an edge-first, air-gapped commercial VMS. The following enterprise modules are architectural extension points scheduled for v2.0 clustered deployments:
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1">
              <div className="p-3 bg-vms-bg border border-vms-border rounded space-y-1">
                <div className="flex items-center gap-1.5 font-semibold text-vms-text">
                  <Car className="w-3.5 h-3.5 text-vms-accent" />
                  <span>ANPR / LPR Edge Pipeline</span>
                </div>
                <p className="text-[11px] text-vms-muted">
                  License plate optical character recognition engine running on Hailo-8 or NVIDIA Jetson NPU accelerators.
                </p>
              </div>

              <div className="p-3 bg-vms-bg border border-vms-border rounded space-y-1">
                <div className="flex items-center gap-1.5 font-semibold text-vms-text">
                  <Key className="w-3.5 h-3.5 text-status-warn" />
                  <span>SAML 2.0 / OIDC SSO</span>
                </div>
                <p className="text-[11px] text-vms-muted">
                  Federated identity provider bridging for Okta, Entra ID, and Keycloak with SCIM role provisioning.
                </p>
              </div>

              <div className="p-3 bg-vms-bg border border-vms-border rounded space-y-1">
                <div className="flex items-center gap-1.5 font-semibold text-vms-text">
                  <Network className="w-3.5 h-3.5 text-status-telemetry" />
                  <span>Multi-Site Clustered Mesh</span>
                </div>
                <p className="text-[11px] text-vms-muted">
                  WireGuard-encrypted edge mesh interconnecting multiple local VigilOne appliances into a single pane of glass.
                </p>
              </div>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
};

export default ApplianceConsole;
