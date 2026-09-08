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
      const res = await api.post('/federation/pairing-token', { ttlSeconds: 600 });
      setPairingToken(res.data.pairingToken);
      setTokenTtl(res.data.expiresInSeconds);
      setShowPairModal(true);
      setCopied(false);
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to generate pairing token');
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
      setSyncingConfig(true);
      const nextVer = desiredVersion + 1;
      await api.post('/federation/config/desired', { desiredVersion: nextVer });
      setDesiredVersion(nextVer);
      alert(`Desired configuration v${nextVer} published to mesh nodes.`);
      fetchNodes();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to dispatch configuration');
    } finally {
      setSyncingConfig(false);
    }
  };

  const onlineNodes = nodes.filter((n) => n.state === 'ONLINE').length;
  const degradedNodes = nodes.filter((n) => n.state === 'DEGRADED').length;
  const offlineNodes = nodes.filter((n) => n.state === 'OFFLINE').length;

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-6 font-sans text-slate-100">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-graphite-750 pb-4">
        <div>
          <div className="flex items-center space-x-2">
            <Network className="w-6 h-6 text-cctv-amber" />
            <h1 className="text-xl font-bold tracking-wider uppercase text-slate-100">
              Enterprise Edge Federation Platform (CMS Mesh)
            </h1>
          </div>
          <p className="text-xs font-mono text-slate-400 mt-1">
            Autonomous distributed surveillance appliances • Reverse WSS control tunnels • Store-and-Forward sync
          </p>
        </div>

        <div className="flex items-center flex-wrap gap-2">
          <button
            onClick={handleCreatePairingToken}
            className="px-3 py-1.5 rounded bg-cctv-amber text-graphite-900 font-bold text-xs hover:bg-amber-400 transition flex items-center space-x-1.5"
          >
            <Key className="w-3.5 h-3.5" />
            <span>Pair Edge Node</span>
          </button>

          <button
            onClick={handlePushDesiredConfig}
            disabled={syncingConfig}
            className="px-3 py-1.5 rounded bg-graphite-800 border border-graphite-700 text-slate-200 font-semibold text-xs hover:bg-graphite-700 transition flex items-center space-x-1.5"
          >
            <Layers className="w-3.5 h-3.5 text-cctv-teal" />
            <span>Publish Config (v{desiredVersion + 1})</span>
          </button>

          <button
            onClick={() => setShowAutomationModal(true)}
            className="px-3 py-1.5 rounded bg-graphite-800 border border-graphite-700 text-slate-200 font-semibold text-xs hover:bg-graphite-700 transition flex items-center space-x-1.5"
          >
            <Zap className="w-3.5 h-3.5 text-cctv-amber" />
            <span>Automation Matrix</span>
          </button>

          <button
            onClick={() => setShowArchiveModal(true)}
            className="px-3 py-1.5 rounded bg-graphite-800 border border-graphite-700 text-slate-200 font-semibold text-xs hover:bg-graphite-700 transition flex items-center space-x-1.5"
          >
            <Cloud className="w-3.5 h-3.5 text-cctv-teal" />
            <span>Object Storage Archive</span>
          </button>
        </div>
      </div>

      {/* Mesh Health Metrics Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="p-3 bg-graphite-850 border border-graphite-700 rounded-lg">
          <div className="text-[10px] font-mono text-slate-400 uppercase">Total Edge Appliances</div>
          <div className="text-xl font-bold font-mono text-slate-100 mt-1">{nodes.length}</div>
          <div className="text-[10px] text-slate-500 font-mono mt-0.5">Distributed mesh nodes</div>
        </div>

        <div className="p-3 bg-graphite-850 border border-graphite-700 rounded-lg">
          <div className="text-[10px] font-mono text-slate-400 uppercase">Operational Status</div>
          <div className="flex items-center space-x-2 mt-1">
            <span className="text-xl font-bold font-mono text-emerald-400">{onlineNodes}</span>
            <span className="text-xs text-slate-400 font-mono">/ {nodes.length} Online</span>
          </div>
          <div className="text-[10px] text-emerald-400/80 font-mono mt-0.5">WSS Control Tunnels Active</div>
        </div>

        <div className="p-3 bg-graphite-850 border border-graphite-700 rounded-lg">
          <div className="text-[10px] font-mono text-slate-400 uppercase">Degraded / In-Recovery</div>
          <div className="text-xl font-bold font-mono text-amber-400 mt-1">{degradedNodes}</div>
          <div className="text-[10px] text-slate-500 font-mono mt-0.5">Disk &gt;95% or sync backlog</div>
        </div>

        <div className="p-3 bg-graphite-850 border border-graphite-700 rounded-lg">
          <div className="text-[10px] font-mono text-slate-400 uppercase">Offline Appliances</div>
          <div className="text-xl font-bold font-mono text-rose-400 mt-1">{offlineNodes}</div>
          <div className="text-[10px] text-slate-500 font-mono mt-0.5">Heartbeat timeout &gt;30s</div>
        </div>
      </div>

      {/* Federated Nodes Grid */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Server className="w-4 h-4 text-cctv-amber" />
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-200">
              Registered Edge Appliances
            </h2>
          </div>
          <button
            onClick={fetchNodes}
            className="text-xs font-mono text-cctv-teal hover:underline flex items-center space-x-1"
          >
            <RefreshCw className="w-3 h-3" />
            <span>Refresh Mesh</span>
          </button>
        </div>

        {nodes.length === 0 ? (
          <div className="p-8 bg-graphite-850 border border-graphite-700 rounded-lg text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-graphite-800 text-slate-400 flex items-center justify-center mx-auto">
              <Network className="w-6 h-6" />
            </div>
            <div className="text-sm font-semibold text-slate-200">No Edge Appliances Paired</div>
            <p className="text-xs text-slate-400 max-w-md mx-auto">
              Deploy VigilOne edge appliances at your remote branches or facilities. Generate a pairing
              token above to connect an appliance via an outbound-only reverse WebSocket control tunnel.
            </p>
            <button
              onClick={handleCreatePairingToken}
              className="px-4 py-2 rounded bg-cctv-amber text-graphite-900 font-bold text-xs hover:bg-amber-400 transition"
            >
              Generate Pairing Token
            </button>
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
                  className="p-4 bg-graphite-850 border border-graphite-700 rounded-lg space-y-3"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center space-x-2">
                        <span className="font-bold text-sm text-slate-100">{node.name}</span>
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
                      <div className="font-mono text-[10px] text-slate-400 mt-0.5">
                        UUID: {node.nodeUuid}
                      </div>
                    </div>

                    <div className="text-right">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-graphite-800 text-slate-400 font-mono">
                        v{node.softwareVersion}
                      </span>
                    </div>
                  </div>

                  {/* Fingerprint & Hardware Identity */}
                  <div className="p-2.5 bg-graphite-900 rounded border border-graphite-750 text-[10px] font-mono space-y-1">
                    <div className="flex items-center justify-between text-slate-400">
                      <span className="flex items-center space-x-1">
                        <ShieldCheck className="w-3 h-3 text-cctv-teal" />
                        <span>Ed25519 Cert Fingerprint:</span>
                      </span>
                      <span className="text-slate-300 font-bold truncate max-w-[200px]" title={node.certificateFingerprint}>
                        {node.certificateFingerprint.slice(0, 16)}...{node.certificateFingerprint.slice(-8)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-slate-400">
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
                    <div className="p-2 bg-graphite-900/60 rounded border border-graphite-750">
                      <div className="text-slate-500">EVENT CURSOR</div>
                      <div className="font-bold text-cctv-amber mt-0.5">#{node.syncCursorEvent}</div>
                    </div>
                    <div className="p-2 bg-graphite-900/60 rounded border border-graphite-750">
                      <div className="text-slate-500">AUDIT CURSOR</div>
                      <div className="font-bold text-cctv-teal mt-0.5">#{node.syncCursorAudit}</div>
                    </div>
                    <div className="p-2 bg-graphite-900/60 rounded border border-graphite-750">
                      <div className="text-slate-500">ALARM CURSOR</div>
                      <div className="font-bold text-slate-200 mt-0.5">#{node.syncCursorAlarm}</div>
                    </div>
                  </div>

                  {/* Resource & Telemetry Footer */}
                  <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 pt-1 border-t border-graphite-750">
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
      <div className="pt-4 border-t border-graphite-750">
        <RelayControlWidget />
      </div>

      {/* Pairing Token Modal */}
      {showPairModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-graphite-900 border border-graphite-700 rounded-xl shadow-2xl w-full max-w-md p-6 space-y-4 font-sans text-slate-100">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Key className="w-5 h-5 text-cctv-amber" />
                <h3 className="font-bold text-sm uppercase tracking-wider text-slate-100">
                  Single-Use Edge Pairing Token
                </h3>
              </div>
              <button
                onClick={() => setShowPairModal(false)}
                className="text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed">
              Run the following command on the remote VigilOne edge appliance terminal. The pairing
              token expires in <span className="font-bold font-mono text-cctv-amber">{tokenTtl}s</span>{' '}
              and will be consumed upon registration:
            </p>

            <div className="p-3 bg-graphite-950 border border-graphite-750 rounded font-mono text-xs break-all text-cctv-teal select-all flex items-center justify-between">
              <span>{pairingToken}</span>
              <button
                onClick={handleCopyToken}
                className="ml-2 p-1.5 rounded bg-graphite-800 hover:bg-graphite-700 text-slate-200 transition"
              >
                {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>

            <div className="p-3 bg-graphite-850 rounded border border-graphite-750 text-[11px] font-mono text-slate-400 space-y-1">
              <div className="text-slate-300 font-semibold">Registration Command:</div>
              <div className="text-slate-400">
                vigilone-edge pair --token {pairingToken?.slice(0, 18)}...
              </div>
            </div>

            <div className="flex justify-end">
              <button
                onClick={() => setShowPairModal(false)}
                className="px-4 py-1.5 rounded bg-graphite-800 hover:bg-graphite-700 text-xs font-semibold"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

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
