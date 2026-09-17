import React, { useState, useEffect } from 'react';
import {
  FileText,
  ShieldCheck,
  AlertOctagon,
  RefreshCw,
  Eye,
  Copy,
  Check,
  Filter,
} from 'lucide-react';
import api from '../services/api';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { EmptyState } from '../components/ui/EmptyState';

export const AuditLogs: React.FC = () => {
  const [events, setEvents] = useState<any[]>([]);
  const [verifyStatus, setVerifyStatus] = useState<any>(null);
  const [selectedEvent, setSelectedEvent] = useState<any | null>(null);
  const [actionFilter, setActionFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);

  const fetchAuditData = async () => {
    setLoading(true);
    try {
      const params: any = {};
      if (actionFilter) params.action = actionFilter;

      const [resEvents, resVerify] = await Promise.all([
        api.get('/audit', { params }),
        api.get('/audit/verify'),
      ]);

      setEvents(resEvents.data.events || []);
      setVerifyStatus(resVerify.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAuditData();
  }, [actionFilter]);

  const handleCopyHash = (hash: string) => {
    navigator.clipboard.writeText(hash);
    setCopiedHash(hash);
    setTimeout(() => setCopiedHash(null), 2000);
  };

  return (
    <div className="flex flex-col min-h-[calc(100vh-3.5rem)] bg-vms-bg p-3 md:p-4 space-y-3">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 border-b border-vms-border pb-3">
        <div className="flex items-center gap-2.5">
          <FileText className="w-5 h-5 text-vms-accent" />
          <h1 className="text-base md:text-lg font-bold text-vms-text tracking-tight uppercase font-mono">
            Cryptographic Audit Ledger
          </h1>
          {verifyStatus && (
            <Badge
              variant={verifyStatus.tamperEvidentStatus === 'INTACT' ? 'success' : 'alarm'}
              size="sm"
              icon={verifyStatus.tamperEvidentStatus === 'INTACT' ? <ShieldCheck className="w-3 h-3" /> : <AlertOctagon className="w-3 h-3" />}
            >
              {verifyStatus.tamperEvidentStatus === 'INTACT'
                ? `Chain Intact (${verifyStatus.verifiedCount} Records)`
                : `Tamper Detected (Seq #${verifyStatus.brokenSequence})`}
            </Badge>
          )}
        </div>

        <Button
          variant="secondary"
          size="sm"
          onClick={fetchAuditData}
          isLoading={loading}
          icon={<RefreshCw className="w-3.5 h-3.5" />}
        >
          Re-verify Chain
        </Button>
      </div>

      {/* Horizontal Telemetry Bar */}
      <div className="flex flex-wrap items-center gap-4 sm:gap-6 px-3 py-2 bg-vms-surface border border-vms-border rounded text-xs font-mono">
        <div className="flex items-center gap-2">
          <span className="text-vms-muted">CHAIN STATUS:</span>
          <span className={`font-bold ${verifyStatus?.tamperEvidentStatus === 'INTACT' ? 'text-emerald-400' : 'text-rose-400'}`}>
            {verifyStatus?.tamperEvidentStatus === 'INTACT' ? 'Intact' : 'Verifying'}
          </span>
        </div>
        <div className="h-3 w-px bg-vms-border hidden sm:block" />
        <div className="flex items-center gap-2">
          <span className="text-vms-muted">CHAINED RECORDS:</span>
          <span className="font-bold text-vms-text">{events.length}</span>
        </div>
        <div className="h-3 w-px bg-vms-border hidden sm:block" />
        <div className="flex items-center gap-2">
          <span className="text-vms-muted">VERIFIED BLOCKS:</span>
          <span className="font-bold text-emerald-400">{verifyStatus?.verifiedCount ?? '—'}</span>
        </div>
        <div className="h-3 w-px bg-vms-border hidden sm:block" />
        <div className="flex items-center gap-2">
          <span className="text-vms-muted">HASH ARCHITECTURE:</span>
          <span className="font-bold text-sky-400">SHA-256 Merkle</span>
        </div>
      </div>

      {/* Filter Bar */}
      <Card padding="sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Filter className="w-3.5 h-3.5 text-vms-dim" />
            <select
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              className="bg-vms-bg border border-vms-border rounded px-2.5 py-1 text-xs text-vms-text focus:outline-none focus:border-vms-accent"
            >
              <option value="">All Logged Actions</option>
              <option value="CAMERA_CREATE">CAMERA_CREATE</option>
              <option value="CAMERA_DELETE">CAMERA_DELETE</option>
              <option value="EXPORT_EVIDENCE_BSA63">EXPORT_EVIDENCE_BSA63</option>
              <option value="USER_CREATE">USER_CREATE</option>
              <option value="USER_DEACTIVATE">USER_DEACTIVATE</option>
              <option value="LOGIN_SUCCESS">LOGIN_SUCCESS</option>
              <option value="LICENSE_APPLY">LICENSE_APPLY</option>
            </select>
          </div>

          <div className="text-xs text-vms-muted font-mono">
            Chained Entries: <span className="text-vms-text font-semibold">{events.length}</span>
          </div>
        </div>
      </Card>

      {/* Audit Log Table Card */}
      <Card padding="none">
        <div className="px-4 py-3 border-b border-vms-border flex items-center justify-between bg-vms-panel/50">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-xs text-vms-text uppercase tracking-wider">
              Chained Ledger Entries ({events.length})
            </span>
          </div>
          <span className="text-[11px] text-vms-muted font-mono">
            Canonical SHA-256 Merkle Tree
          </span>
        </div>

        {events.length === 0 ? (
          <EmptyState
            icon={<FileText className="w-6 h-6" />}
            title="No audit records match query"
            description="All administrative, surveillance, and legal events are recorded in real-time."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-vms-panel/80 text-vms-muted uppercase text-[10px] border-b border-vms-border font-medium tracking-wider">
                <tr>
                  <th className="px-4 py-2.5">Seq #</th>
                  <th className="px-4 py-2.5">Action</th>
                  <th className="px-4 py-2.5">Actor</th>
                  <th className="px-4 py-2.5">Target Resource</th>
                  <th className="px-4 py-2.5">IP Address</th>
                  <th className="px-4 py-2.5">Timestamp (UTC)</th>
                  <th className="px-4 py-2.5">SHA-256 Leaf Hash</th>
                  <th className="px-4 py-2.5 text-right">Inspect</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-vms-border text-vms-text">
                {events.map((evt) => (
                  <tr key={evt.id} className="hover:bg-vms-hover/40 transition">
                    <td className="px-4 py-3 font-mono font-bold text-vms-accent whitespace-nowrap">
                      #{String(evt.sequenceNumber).padStart(6, '0')}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <Badge variant="outline" size="sm">
                        {evt.action}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 font-medium text-vms-text whitespace-nowrap">
                      {evt.user?.name || 'System Daemon'}
                    </td>
                    <td className="px-4 py-3 text-vms-muted whitespace-nowrap">
                      {evt.resourceType} {evt.resourceId ? `(${evt.resourceId.slice(0, 8)})` : ''}
                    </td>
                    <td className="px-4 py-3 text-vms-muted font-mono text-[11px] whitespace-nowrap">
                      {evt.ipAddress}
                    </td>
                    <td className="px-4 py-3 text-vms-muted font-mono text-[11px] whitespace-nowrap">
                      {new Date(evt.timestampUtc).toISOString().slice(0, 19).replace('T', ' ')}
                    </td>
                    <td className="px-4 py-3 font-mono text-status-telemetry text-[11px] whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <span>{evt.eventHash.slice(0, 14)}...</span>
                        <button
                          onClick={() => handleCopyHash(evt.eventHash)}
                          className="text-vms-dim hover:text-vms-accent transition"
                          title="Copy full event hash"
                        >
                          {copiedHash === evt.eventHash ? (
                            <Check className="w-3 h-3 text-status-live" />
                          ) : (
                            <Copy className="w-3 h-3" />
                          )}
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setSelectedEvent(evt)}
                        title="Inspect Block Cryptographic Signatures"
                        icon={<Eye className="w-3 h-3" />}
                      >
                        Inspect
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Inspect Event Modal */}
      {selectedEvent && (
        <Modal
          isOpen={true}
          onClose={() => setSelectedEvent(null)}
          title={`Audit Block #${String(selectedEvent.sequenceNumber).padStart(6, '0')} — Merkle Leaf Detail`}
          description={`Logged Action: ${selectedEvent.action}`}
          size="lg"
        >
          <div className="space-y-4 text-xs">
            <div>
              <span className="text-vms-muted uppercase text-[10px] font-mono tracking-wider block mb-1">
                Previous Block Hash (PREV_HASH)
              </span>
              <div className="p-2.5 bg-vms-panel rounded border border-vms-border text-vms-dim break-all text-[11px] font-mono select-all">
                {selectedEvent.prevHash || '0000000000000000000000000000000000000000000000000000000000000000'}
              </div>
            </div>

            <div>
              <span className="text-vms-muted uppercase text-[10px] font-mono tracking-wider block mb-1">
                Current Block Merkle Hash (EVENT_HASH)
              </span>
              <div className="p-2.5 bg-vms-panel rounded border border-vms-border text-vms-accent break-all text-[11px] font-mono font-bold select-all">
                {selectedEvent.eventHash}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-vms-panel p-3 rounded border border-vms-border">
              <div>
                <div className="text-vms-muted text-[10px] uppercase font-mono tracking-wider">Actor Identifier</div>
                <div className="text-vms-text font-semibold mt-0.5">{selectedEvent.user?.name || 'System Service'}</div>
                <div className="text-[11px] text-vms-muted font-mono">{selectedEvent.user?.email || 'N/A'}</div>
              </div>
              <div>
                <div className="text-vms-muted text-[10px] uppercase font-mono tracking-wider">Ingress Network IP</div>
                <div className="text-vms-text font-mono mt-0.5">{selectedEvent.ipAddress}</div>
                <div className="text-[11px] text-vms-dim truncate font-mono">{selectedEvent.userAgent || 'INTERNAL_IPC'}</div>
              </div>
            </div>

            <div>
              <span className="text-vms-muted uppercase text-[10px] font-mono tracking-wider block mb-1">
                Payload Metadata Attestation (JSON)
              </span>
              <pre className="p-3 bg-vms-panel rounded border border-vms-border text-[11px] text-vms-text overflow-x-auto select-all font-mono leading-relaxed max-h-48">
                {JSON.stringify(selectedEvent.metadataJson, null, 2)}
              </pre>
            </div>

            <div className="flex justify-end pt-2 border-t border-vms-border">
              <Button
                variant="secondary"
                onClick={() => setSelectedEvent(null)}
              >
                Close Inspector
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default AuditLogs;
