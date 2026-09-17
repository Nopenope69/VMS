import React, { useState, useEffect } from 'react';
import {
  Network,
  Server,
  ShieldCheck,
  Zap,
  Cloud,
  Key,
  RefreshCw,
  Copy,
  Check,
  Layers,
} from 'lucide-react';
import api from '../services/api';
import RelayControlWidget from '../components/RelayControlWidget';
import EventActionRuleModal from '../components/EventActionRuleModal';
import ObjectStorageArchiveModal from '../components/ObjectStorageArchiveModal';
import Modal from '../components/ui/Modal';
import Button from '../components/ui/Button';

interface FederatedNode {
  id: string;
  nodeUuid: string;
  name: string;
  state: 'ONLINE' | 'DEGRADED' | 'OFFLINE';
  softwareVersion: string;
  schemaVersion: string;
  protocolVersion: number;
  certificateFingerprint: string;
  configVersionApplied: number;
  desiredConfigVersion?: number;
  syncCursorEvent: string;
  syncCursorAudit: string;
  syncCursorAlarm: string;
  lastHeartbeat: string;
  capabilitiesJson?: any;
  activeCameras?: number;
  fpsTotal?: number;
  diskUsagePercent?: number;
  queueDepth?: number;
}

export const FederationConsole: React.FC = () => {
  const [nodes, setNodes] = useState<FederatedNode[]>([]);
  const [showPairModal, setShowPairModal] = useState(false);
  const [showAutomationModal, setShowAutomationModal] = useState(false);
  const [showArchiveModal, setShowArchiveModal] = useState(false);
  const [statusNotice, setStatusNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Pairing token state
  const [pairingToken, setPairingToken] = useState<string | null>(null);
  const [tokenTtl, setTokenTtl] = useState(600);
  const [copied, setCopied] = useState(false);

  // Desired config state
  const [desiredVersion, setDesiredVersion] = useState(1);
  const [syncingConfig, setSyncingConfig] = useState(false);

  const fetchNodes = async () => {
    try {
      const res = await api.get('/federation/nodes');
      setNodes(res.data.nodes || []);
      if (res.data.desiredVersion) {
        setDesiredVersion(res.data.desiredVersion);
      }
    } catch (err) {
      console.error('Failed to load federated nodes', err);
    }
  };

  useEffect(() => {
    fetchNodes();
    const interval = setInterval(fetchNodes, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleCreatePairingToken = async () => {
    try {
      setStatusNotice(null);
      const res = await api.post('/federation/pairing-token', { ttlSeconds: 600 });
      setPairingToken(res.data.pairingToken);
      setTokenTtl(res.data.expiresInSeconds);
      setShowPairModal(true);
      setCopied(false);
    } catch (err: any) {
      setStatusNotice({ type: 'error', message: err.response?.data?.error || 'Failed to generate pairing token' });
    }
  };

  const handleCopyToken = () => {
    if (!pairingToken) return;
    navigator.clipboard.writeText(pairingToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const handlePushDesiredConfig = async () => {
    try {
      setStatusNotice(null);
      setSyncingConfig(true);
      const nextVer = desiredVersion + 1;
      await api.post('/federation/config/desired', { desiredVersion: nextVer });
      setDesiredVersion(nextVer);
      setStatusNotice({ type: 'success', message: `Desired configuration v${nextVer} published to mesh nodes.` });
      fetchNodes();
    } catch (err: any) {
      setStatusNotice({ type: 'error', message: err.response?.data?.error || 'Failed to dispatch configuration' });
    } finally {
      setSyncingConfig(false);
    }
  };

  const onlineNodes = nodes.filter((n) => n.state === 'ONLINE').length;
  const degradedNodes = nodes.filter((n) => n.state === 'DEGRADED').length;
  const offlineNodes = nodes.filter((n) => n.state === 'OFFLINE').length;

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-6 font-sans text-vms-text">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-vms-border pb-4">
        <div>
          <div className="flex items-center space-x-2">
            <Network className="w-6 h-6 text-vms-accent" />
            <h1 className="text-xl font-bold tracking-wider uppercase text-vms-text">
              Enterprise Edge Federation Platform (CMS Mesh)
            </h1>
          </div>
          <p className="text-xs font-mono text-vms-muted mt-1">
            Autonomous distributed surveillance appliances • Reverse WSS control tunnels • Store-and-Forward sync
          </p>
        </div>

        <div className="flex items-center flex-wrap gap-2">
          <Button
            onClick={handleCreatePairingToken}
            variant="primary"
            size="sm"
            className="flex items-center space-x-1.5"
          >
            <Key className="w-3.5 h-3.5" />
            <span>Pair Edge Node</span>
          </Button>

          <Button
            onClick={handlePushDesiredConfig}
            disabled={syncingConfig}
            variant="secondary"
            size="sm"
            className="flex items-center space-x-1.5"
          >
            <Layers className="w-3.5 h-3.5 text-sky-400" />
            <span>Publish Config (v{desiredVersion + 1})</span>
          </Button>

          <Button
            onClick={() => setShowAutomationModal(true)}
            variant="secondary"
            size="sm"
            className="flex items-center space-x-1.5"
          >
            <Zap className="w-3.5 h-3.5 text-vms-accent" />
            <span>Automation Matrix</span>
          </Button>

          <Button
            onClick={() => setShowArchiveModal(true)}
            variant="secondary"
            size="sm"
            className="flex items-center space-x-1.5"
          >
            <Cloud className="w-3.5 h-3.5 text-sky-400" />
            <span>Object Storage Archive</span>
          </Button>
        </div>
      </div>

      {/* Status Notice Banner */}
      {statusNotice && (
        <div
          role="alert"
          className={`flex items-center justify-between px-3 py-2 rounded text-xs font-mono border ${
            statusNotice.type === 'error'
              ? 'bg-rose-500/10 border-rose-500/30 text-rose-300'
              : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
          }`}
        >
          <span>{statusNotice.message}</span>
          <button
            onClick={() => setStatusNotice(null)}
            className="ml-2 hover:opacity-75 font-bold"
            aria-label="Dismiss notice"
          >
            ✕
          </button>
        </div>
      )}

      {/* Mesh Health Metrics Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="p-3 bg-vms-surface border border-vms-border rounded-lg">
          <div className="text-[10px] font-mono text-vms-muted uppercase">Total Edge Appliances</div>
          <div className="text-xl font-bold font-mono text-vms-text mt-1">{nodes.length}</div>
          <div className="text-[10px] text-vms-dim font-mono mt-0.5">Distributed mesh nodes</div>
        </div>

        <div className="p-3 bg-vms-surface border border-vms-border rounded-lg">
          <div className="text-[10px] font-mono text-vms-muted uppercase">Operational Status</div>
          <div className="flex items-center space-x-2 mt-1">
            <span className="text-xl font-bold font-mono text-emerald-400">{onlineNodes}</span>
            <span className="text-xs text-vms-muted font-mono">/ {nodes.length} Online</span>
          </div>
          <div className="text-[10px] text-emerald-400/80 font-mono mt-0.5">WSS Control Tunnels Active</div>
        </div>

        <div className="p-3 bg-vms-surface border border-vms-border rounded-lg">
          <div className="text-[10px] font-mono text-vms-muted uppercase">Degraded / In-Recovery</div>
          <div className="text-xl font-bold font-mono text-amber-400 mt-1">{degradedNodes}</div>
          <div className="text-[10px] text-vms-dim font-mono mt-0.5">Disk &gt;95% or sync backlog</div>
        </div>

        <div className="p-3 bg-vms-surface border border-vms-border rounded-lg">
          <div className="text-[10px] font-mono text-vms-muted uppercase">Offline Appliances</div>
          <div className="text-xl font-bold font-mono text-rose-400 mt-1">{offlineNodes}</div>
          <div className="text-[10px] text-vms-dim font-mono mt-0.5">Heartbeat timeout &gt;30s</div>
        </div>
      </div>

      {/* Federated Nodes Grid */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Server className="w-4 h-4 text-vms-accent" />
            <h2 className="text-sm font-bold uppercase tracking-wider text-vms-text">
              Registered Edge Appliances
            </h2>
          </div>
          <button
            onClick={fetchNodes}
            className="text-xs font-mono text-sky-400 hover:underline flex items-center space-x-1"
          >
            <RefreshCw className="w-3 h-3" />
            <span>Refresh Mesh</span>
          </button>
        </div>

        {nodes.length === 0 ? (
          <div className="p-8 bg-vms-surface border border-vms-border rounded-lg text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-vms-panel text-vms-muted flex items-center justify-center mx-auto">
              <Network className="w-6 h-6" />
            </div>
            <div className="text-sm font-semibold text-vms-text">No Edge Appliances Paired</div>
            <p className="text-xs text-vms-muted max-w-md mx-auto">
              Deploy VigilOne edge appliances at your remote branches or facilities. Generate a pairing
              token above to connect an appliance via an outbound-only reverse WebSocket control tunnel.
            </p>
            <Button
              onClick={handleCreatePairingToken}
              variant="primary"
              size="sm"
            >
              Generate Pairing Token
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {nodes.map((node) => {
              const isOnline = node.state === 'ONLINE';
              const isDegraded = node.state === 'DEGRADED';
              const hasVersionSkew =
                node.desiredConfigVersion &&
                node.configVersionApplied !== node.desiredConfigVersion;

              return (
                <div
                  key={node.id}
                  className="p-4 bg-vms-surface border border-vms-border rounded-lg space-y-3"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center space-x-2">
                        <span className="font-bold text-sm text-vms-text">{node.name}</span>
                        <span
                          className={`text-[9px] px-2 py-0.5 rounded font-mono font-bold ${
                            isOnline
                              ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                              : isDegraded
                              ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40'
                              : 'bg-rose-500/20 text-rose-400 border border-rose-500/40'
                          }`}
                        >
                          {node.state}
                        </span>
                      </div>
                      <div className="font-mono text-[10px] text-vms-muted mt-0.5">
                        UUID: {node.nodeUuid}
                      </div>
                    </div>

                    <div className="text-right">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-vms-elevated text-vms-muted font-mono">
                        v{node.softwareVersion}
                      </span>
                    </div>
                  </div>

                  {/* Fingerprint & Hardware Identity */}
                  <div className="p-2.5 bg-vms-panel rounded border border-vms-border text-[10px] font-mono space-y-1">
                    <div className="flex items-center justify-between text-vms-muted">
                      <span className="flex items-center space-x-1">
                        <ShieldCheck className="w-3 h-3 text-sky-400" />
                        <span>Ed25519 Cert Fingerprint:</span>
                      </span>
                      <span className="text-vms-text font-bold truncate max-w-[200px]" title={node.certificateFingerprint}>
                        {node.certificateFingerprint.slice(0, 16)}...{node.certificateFingerprint.slice(-8)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-vms-muted">
                      <span>Config Synchronization:</span>
                      <span
                        className={
                          hasVersionSkew
                            ? 'text-amber-400 font-bold'
                            : 'text-emerald-400 font-bold'
                        }
                      >
                        Applied: v{node.configVersionApplied}{' '}
                        {hasVersionSkew ? `(Skew: Desired v${node.desiredConfigVersion})` : '✓ In Sync'}
                      </span>
                    </div>
                  </div>

                  {/* Sync Cursors Telemetry */}
                  <div className="grid grid-cols-3 gap-2 text-center text-[10px] font-mono">
                    <div className="p-2 bg-vms-bg/60 rounded border border-vms-border">
                      <div className="text-vms-dim">EVENT CURSOR</div>
                      <div className="font-bold text-vms-accent mt-0.5">#{node.syncCursorEvent}</div>
                    </div>
                    <div className="p-2 bg-vms-bg/60 rounded border border-vms-border">
                      <div className="text-vms-dim">AUDIT CURSOR</div>
                      <div className="font-bold text-sky-400 mt-0.5">#{node.syncCursorAudit}</div>
                    </div>
                    <div className="p-2 bg-vms-bg/60 rounded border border-vms-border">
                      <div className="text-vms-dim">ALARM CURSOR</div>
                      <div className="font-bold text-vms-text mt-0.5">#{node.syncCursorAlarm}</div>
                    </div>
                  </div>

                  {/* Resource & Telemetry Footer */}
                  <div className="flex items-center justify-between text-[11px] font-mono text-vms-muted pt-1 border-t border-vms-border">
                    <div className="flex items-center space-x-3">
                      <span>Cam: {node.activeCameras ?? 8}</span>
                      <span>FPS: {node.fpsTotal ?? 120}</span>
                      <span>Disk: {node.diskUsagePercent ?? 42}%</span>
                    </div>
                    <div>Heartbeat: {new Date(node.lastHeartbeat).toLocaleTimeString()}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Embedded Hardware I/O & Relay Matrix Section */}
      <div className="pt-4 border-t border-vms-border">
        <RelayControlWidget />
      </div>

      {/* Pairing Token Modal */}
      <Modal
        isOpen={showPairModal}
        onClose={() => setShowPairModal(false)}
        title="Single-Use Edge Pairing Token"
        maxWidth="md"
      >
        <div className="space-y-4 font-sans text-vms-text">
          <p className="text-xs text-vms-muted leading-relaxed">
            Run the following command on the remote VigilOne edge appliance terminal. The pairing
            token expires in <span className="font-bold font-mono text-vms-accent">{tokenTtl}s</span>{' '}
            and will be consumed upon registration:
          </p>

          <div className="p-3 bg-vms-bg border border-vms-border rounded font-mono text-xs break-all text-sky-400 select-all flex items-center justify-between">
            <span>{pairingToken}</span>
            <button
              onClick={handleCopyToken}
              className="ml-2 p-1.5 rounded bg-vms-surface hover:bg-vms-elevated text-vms-text transition"
              title="Copy pairing token"
              aria-label="Copy pairing token"
            >
              {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>

          <div className="p-3 bg-vms-surface rounded border border-vms-border text-[11px] font-mono text-vms-muted space-y-1">
            <div className="text-vms-text font-semibold">Registration Command:</div>
            <div className="text-vms-dim">
              vigilone-edge pair --token {pairingToken?.slice(0, 18)}...
            </div>
          </div>

          <div className="flex justify-end pt-2 border-t border-vms-border">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowPairModal(false)}
            >
              Done
            </Button>
          </div>
        </div>
      </Modal>

      {/* Automation Rules Modal */}
      <EventActionRuleModal
        isOpen={showAutomationModal}
        onClose={() => setShowAutomationModal(false)}
      />

      {/* Offsite Object Storage Modal */}
      <ObjectStorageArchiveModal
        isOpen={showArchiveModal}
        onClose={() => setShowArchiveModal(false)}
      />
    </div>
  );
};

export default FederationConsole;
