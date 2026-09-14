import React, { useState, useEffect } from 'react';
import { ShieldCheck, AlertTriangle, FileText, CheckCircle2, XCircle, X, Lock, History } from 'lucide-react';
import api from '../services/api';

interface EvidenceReviewModalProps {
  manifestId?: string;
  exportId?: string;
  onClose: () => void;
  onApproved?: () => void;
}

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

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

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
      setSuccessNotice('Export approved under dual-custody policy');
      if (onApproved) onApproved();
      await loadData();
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Approval failed');
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="review-modal-title"
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 select-none font-mono"
    >
      <div className="bg-[#0D1117] border border-[#21262D] rounded-none max-w-3xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden relative">
        {/* Optical Corner Reticles */}
        <span className="absolute -top-1 -left-1 text-[9px] text-[#30363D] z-20">+</span>
        <span className="absolute -top-1 -right-1 text-[9px] text-[#30363D] z-20">+</span>
        <span className="absolute -bottom-1 -left-1 text-[9px] text-[#30363D] z-20">+</span>
        <span className="absolute -bottom-1 -right-1 text-[9px] text-[#30363D] z-20">+</span>

        {/* Header */}
        <div className="p-4 border-b border-[#21262D] flex items-center justify-between bg-[#161B22]">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="w-5 h-5 text-[#3FB950]" />
            <div>
              <h2 id="review-modal-title" className="text-xs font-bold text-white uppercase tracking-wider">
                Evidence Integrity & Custodial Audit — Section 63 BSA
              </h2>
              <p className="text-[10px] text-slate-400 font-mono tracking-wider">
                {manifestId ? `TARGET_MANIFEST: ${manifestId}` : `TARGET_EXPORT: ${exportId}`}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded-none hover:bg-[#21262D] transition"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto space-y-5 text-xs text-slate-300 bg-[#0D1117]">
          {loading ? (
            <div className="py-12 text-center text-slate-400 tracking-wider">
              [ VERIFYING CRYPTOGRAPHIC HASH CHAIN AND CUSTODIAL LINEAGE... ]
            </div>
          ) : error ? (
            <div className="p-3 bg-[#F85149]/10 border border-[#F85149]/40 text-[#F85149] flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          ) : (
            <>
              {successNotice && (
                <div className="p-3 bg-[#3FB950]/10 border border-[#3FB950]/40 text-[#3FB950] flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                  <span>{successNotice}</span>
                </div>
              )}

              {/* Master Evidence Hash Banner */}
              {manifest && (
                <div className="p-4 bg-[#161B22] border border-[#21262D] space-y-2 relative">
                  <span className="absolute -top-1 -left-1 text-[8px] text-[#30363D]">+</span>
                  <span className="absolute -bottom-1 -right-1 text-[8px] text-[#30363D]">+</span>

                  <div className="flex items-center justify-between">
                    <span className="text-slate-400 uppercase text-[10px] tracking-widest">
                      MASTER EVIDENCE SHA-256 ROOT HASH:
                    </span>
                    {verification?.valid ? (
                      <span className="px-2 py-0.5 text-[10px] bg-[#3FB950]/10 text-[#3FB950] border border-[#3FB950]/40 flex items-center gap-1 font-bold">
                        <CheckCircle2 className="w-3 h-3" /> [ VERIFIED_INTACT ]
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 text-[10px] bg-[#F85149]/10 text-[#F85149] border border-[#F85149]/40 flex items-center gap-1 font-bold">
                        <XCircle className="w-3 h-3" /> [ MISMATCH_DETECTED ]
                      </span>
                    )}
                  </div>
                  <div className="text-[#58A6FF] text-xs break-all bg-[#080B10] p-2.5 border border-[#21262D] select-text font-bold">
                    {manifest.masterEvidenceHash}
                  </div>
                  <div className="grid grid-cols-3 gap-2 pt-2 text-[11px] text-slate-400">
                    <div>
                      <span className="text-slate-500 block uppercase text-[10px]">START UTC:</span>
                      <span className="text-slate-200">
                        {new Date(manifest.startUtc).toISOString()}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-500 block uppercase text-[10px]">END UTC:</span>
                      <span className="text-slate-200">
                        {new Date(manifest.endUtc).toISOString()}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-500 block uppercase text-[10px]">LEGAL HOLD STATUS:</span>
                      <span
                        className={`font-bold ${
                          manifest.legalHold ? 'text-[#E3B341]' : 'text-slate-400'
                        }`}
                      >
                        {manifest.legalHold ? '[ ACTIVE // PREVENT PURGE ]' : '[ INACTIVE ]'}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Section 63 BSA Statement */}
              {manifest?.certificateDataJson && (
                <div className="p-3.5 bg-[#161B22] border border-[#21262D] space-y-1.5">
                  <div className="flex items-center gap-1.5 text-slate-200 font-bold text-[11px] uppercase tracking-wider">
                    <FileText className="w-3.5 h-3.5 text-[#58A6FF]" />
                    <span>SECTION 63 BSA STATUTORY PROVENANCE RECORD</span>
                  </div>
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    {manifest.certificateDataJson.disclaimer}
                  </p>
                  <div className="text-[10px] text-slate-500 pt-1 border-t border-[#21262D] mt-2 flex justify-between">
                    <span>APPLIANCE: {manifest.certificateDataJson.applianceIdentifier}</span>
                    <span>ALGORITHM: {manifest.certificateDataJson.hashAlgorithm}</span>
                  </div>
                </div>
              )}

              {/* Chain of Custody History */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
                    <History className="w-3.5 h-3.5 text-[#E3B341]" />
                    <span>IMMUTABLE CHAIN OF CUSTODY LOG</span>
                  </h3>
                  <span className="text-[10px] text-slate-500">
                    {custodyLogs.length} EVENTS RECORDED
                  </span>
                </div>

                <div className="border border-[#21262D] divide-y divide-[#21262D] bg-[#080B10]">
                  {custodyLogs.length === 0 ? (
                    <div className="p-4 text-center text-slate-500 text-xs uppercase tracking-widest">
                      [ NO CUSTODIAL ACTIONS LOGGED ]
                    </div>
                  ) : (
                    custodyLogs.map((log, idx) => (
                      <div key={log.id || idx} className="p-3 hover:bg-[#161B22] transition">
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-bold text-[#3FB950] text-[11px] tracking-wide">
                            [{log.action}]
                          </span>
                          <span className="text-[10px] text-slate-500">
                            {new Date(log.timestampUtc).toISOString()}
                          </span>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-[10px] text-slate-400">
                          <div>
                            <span className="text-slate-500 block">ACTOR IDENTIFIER:</span>
                            <span className="text-slate-300 font-bold">{log.actorUserId}</span>
                          </div>
                          <div>
                            <span className="text-slate-500 block">SOURCE MERKLE ROOT:</span>
                            <span className="text-slate-300 truncate block font-mono">
                              {log.sourceHash.slice(0, 16)}...
                            </span>
                          </div>
                        </div>
                        {log.resultHash && (
                          <div className="mt-1 text-[10px] text-[#58A6FF] font-mono">
                            RESULT HASH: {log.resultHash.slice(0, 24)}...
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Dual-Custody Approval Action */}
              {exportId && (
                <div className="p-3.5 bg-[#161B22] border border-[#E3B341]/40 flex items-center justify-between">
                  <div className="space-y-0.5">
                    <div className="text-[#E3B341] font-bold text-xs flex items-center gap-1.5 uppercase tracking-wider">
                      <Lock className="w-3.5 h-3.5" />
                      <span>DUAL-CUSTODY SUPERVISORY APPROVAL</span>
                    </div>
                    <p className="text-[11px] text-slate-400">
                      Validate evidence authenticity before official evidentiary release.
                    </p>
                  </div>
                  <button
                    onClick={handleApproveExport}
                    disabled={actionLoading}
                    className="btn-tactical-primary disabled:opacity-50"
                  >
                    {actionLoading ? 'Approving...' : 'Approve Export'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-[#21262D] bg-[#161B22] flex justify-end">
          <button
            onClick={onClose}
            className="btn-tactical-secondary"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default EvidenceReviewModal;
