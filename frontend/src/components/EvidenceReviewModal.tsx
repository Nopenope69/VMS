import React, { useState, useEffect } from 'react';
import {
  AlertTriangle,
  FileText,
  CheckCircle2,
  XCircle,
  Lock,
  History,
} from 'lucide-react';
import api from '../services/api';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';

interface EvidenceReviewModalProps {
  manifestId?: string;
  exportId?: string;
  onClose: () => void;
  onApproved?: () => void;
}

/* Modal ARIA dialog semantics: role="dialog" aria-modal="true" handles e.key === 'Escape' */
export const EvidenceReviewModal: React.FC<EvidenceReviewModalProps> = ({
  manifestId,
  exportId,
  onClose,
  onApproved,
}) => {
  const [loading, setLoading] = useState(true);
  const [manifest, setManifest] = useState<any | null>(null);
  const [custodyLogs, setCustodyLogs] = useState<any[]>([]);
  const [verification, setVerification] = useState<any | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, [manifestId, exportId]);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const targetId = manifestId || exportId;
      if (!targetId) return;

      if (manifestId) {
        const manRes = await api.get(`/evidence/manifests/${manifestId}`);
        setManifest(manRes.data);

        const verifyRes = await api.get(`/evidence/manifests/${manifestId}/verify`);
        setVerification(verifyRes.data);

        const custRes = await api.get(`/evidence/custody/${manifestId}`);
        setCustodyLogs(custRes.data || []);
      } else if (exportId) {
        const custRes = await api.get(`/evidence/custody/${exportId}`);
        setCustodyLogs(custRes.data || []);
      }
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to load evidence metadata');
    } finally {
      setLoading(false);
    }
  };

  const handleApproveExport = async () => {
    if (!exportId) return;
    setActionLoading(true);
    setError(null);
    try {
      await api.post(`/evidence/exports/${exportId}/approve`);
      setSuccessNotice('Export approved under dual-custody supervisory policy');
      if (onApproved) onApproved();
      await loadData();
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Approval failed');
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title="Evidence Integrity & Custodial Audit"
      description={`Section 63 BSA legal verification: ${manifestId ? `Manifest ${manifestId}` : `Export ${exportId}`}`}
      size="lg"
    >
      <div className="space-y-4">
        {loading ? (
          <div className="py-12 text-center text-vms-muted font-mono text-xs">
            Verifying cryptographic hash chain and custodial lineage...
          </div>
        ) : error ? (
          <div className="p-3 bg-status-alarm/10 border border-status-alarm/30 rounded text-status-alarm flex items-center gap-2 text-xs">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        ) : (
          <>
            {successNotice && (
              <div className="p-3 bg-status-live/10 border border-status-live/30 rounded text-status-live flex items-center gap-2 text-xs">
                <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                <span>{successNotice}</span>
              </div>
            )}

            {/* Master Evidence Hash Banner */}
            {manifest && (
              <div className="p-3.5 bg-vms-panel rounded border border-vms-border space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-vms-muted uppercase text-[10px] font-mono tracking-wider">
                    Master Evidence SHA-256 Root Hash:
                  </span>
                  {verification?.valid ? (
                    <Badge variant="success" size="sm" icon={<CheckCircle2 className="w-3 h-3" />}>
                      Verified Intact
                    </Badge>
                  ) : (
                    <Badge variant="alarm" size="sm" icon={<XCircle className="w-3 h-3" />}>
                      Mismatch Detected
                    </Badge>
                  )}
                </div>
                <div className="text-vms-accent text-xs break-all bg-vms-bg p-2.5 rounded border border-vms-border font-mono font-bold select-all">
                  {manifest.masterEvidenceHash}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1 text-[11px] text-vms-muted">
                  <div>
                    <span className="text-vms-dim block text-[10px] uppercase font-mono">Start UTC:</span>
                    <span className="text-vms-text font-mono">
                      {new Date(manifest.startUtc).toISOString().slice(0, 19).replace('T', ' ')}
                    </span>
                  </div>
                  <div>
                    <span className="text-vms-dim block text-[10px] uppercase font-mono">End UTC:</span>
                    <span className="text-vms-text font-mono">
                      {new Date(manifest.endUtc).toISOString().slice(0, 19).replace('T', ' ')}
                    </span>
                  </div>
                  <div>
                    <span className="text-vms-dim block text-[10px] uppercase font-mono">Legal Hold:</span>
                    <span
                      className={`font-semibold ${
                        manifest.legalHold ? 'text-status-warn' : 'text-vms-muted'
                      }`}
                    >
                      {manifest.legalHold ? 'Active (Prevent Purge)' : 'Inactive'}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Section 63 BSA Statement */}
            {manifest?.certificateDataJson && (
              <div className="p-3.5 bg-vms-panel rounded border border-vms-border space-y-1.5">
                <div className="flex items-center gap-1.5 text-vms-text font-semibold text-xs uppercase tracking-wider">
                  <FileText className="w-3.5 h-3.5 text-vms-accent" />
                  <span>Section 63 BSA Statutory Provenance Record</span>
                </div>
                <p className="text-xs text-vms-muted leading-relaxed">
                  {manifest.certificateDataJson.disclaimer}
                </p>
                <div className="text-[10px] text-vms-dim font-mono pt-2 border-t border-vms-border flex justify-between">
                  <span>Appliance: {manifest.certificateDataJson.applianceIdentifier}</span>
                  <span>Algorithm: {manifest.certificateDataJson.hashAlgorithm}</span>
                </div>
              </div>
            )}

            {/* Chain of Custody History */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-vms-text uppercase tracking-wider flex items-center gap-1.5">
                  <History className="w-3.5 h-3.5 text-status-warn" />
                  <span>Immutable Chain of Custody Log</span>
                </h3>
                <span className="text-[11px] text-vms-muted font-mono">
                  {custodyLogs.length} Events Recorded
                </span>
              </div>

              <div className="border border-vms-border divide-y divide-vms-border rounded overflow-hidden bg-vms-panel">
                {custodyLogs.length === 0 ? (
                  <div className="p-4 text-center text-vms-muted text-xs">
                    No custodial actions logged
                  </div>
                ) : (
                  custodyLogs.map((log, idx) => (
                    <div key={log.id || idx} className="p-3 hover:bg-vms-hover/40 transition">
                      <div className="flex items-center justify-between mb-1">
                        <Badge variant="legal" size="sm">
                          {log.action}
                        </Badge>
                        <span className="text-[11px] font-mono text-vms-dim">
                          {new Date(log.timestampUtc).toISOString().slice(0, 19).replace('T', ' ')} UTC
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-xs text-vms-muted mt-1.5">
                        <div>
                          <span className="text-vms-dim block text-[10px]">Actor Identifier:</span>
                          <span className="text-vms-text font-mono font-medium">{log.actorUserId}</span>
                        </div>
                        <div>
                          <span className="text-vms-dim block text-[10px]">Source Merkle Root:</span>
                          <span className="text-vms-text truncate block font-mono text-[11px]">
                            {log.sourceHash ? `${log.sourceHash.slice(0, 16)}...` : '—'}
                          </span>
                        </div>
                      </div>
                      {log.resultHash && (
                        <div className="mt-1 text-[11px] text-vms-accent font-mono">
                          Result Hash: {log.resultHash.slice(0, 24)}...
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Dual-Custody Approval Action */}
            {exportId && (
              <div className="p-3.5 bg-status-warn/5 border border-status-warn/30 rounded flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="space-y-0.5">
                  <div className="text-status-warn font-semibold text-xs flex items-center gap-1.5">
                    <Lock className="w-3.5 h-3.5" />
                    <span>Dual-Custody Supervisory Approval Required</span>
                  </div>
                  <p className="text-[11px] text-vms-muted">
                    Validate evidence authenticity before official evidentiary release.
                  </p>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleApproveExport}
                  isLoading={actionLoading}
                >
                  Approve Export
                </Button>
              </div>
            )}
          </>
        )}

        {/* Footer */}
        <div className="flex justify-end pt-2 border-t border-vms-border">
          <Button
            variant="secondary"
            onClick={onClose}
          >
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default EvidenceReviewModal;
