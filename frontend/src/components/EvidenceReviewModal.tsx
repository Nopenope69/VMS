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
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-graphite-800 border border-slate-700 rounded-lg max-w-3xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="p-4 border-b border-slate-700 flex items-center justify-between bg-graphite-900">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-emerald-400" />
            <div>
              <h2 className="text-sm font-semibold text-slate-100 uppercase tracking-wide">
                Evidence Integrity & Custodial Audit
              </h2>
              <p className="text-xs text-slate-400 font-mono">
                {manifestId ? `MANIFEST ID: ${manifestId}` : `EXPORT ID: ${exportId}`}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-100 p-1 rounded hover:bg-slate-700/50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto space-y-6 text-xs text-slate-300">
          {loading ? (
            <div className="py-12 text-center text-slate-400 font-mono animate-pulse">
              Verifying cryptographic hash chain and custodial lineage...
            </div>
          ) : error ? (
            <div className="p-3 bg-rose-950/40 border border-rose-800/80 rounded text-rose-300 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          ) : (
            <>
              {successNotice && (
                <div className="p-3 bg-emerald-950/40 border border-emerald-800/80 rounded text-emerald-300 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                  <span>{successNotice}</span>
                </div>
              )}

              {/* Master Evidence Hash Banner */}
              {manifest && (
                <div className="p-4 bg-graphite-900 border border-slate-700 rounded space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400 uppercase text-[10px] font-mono">
                      Master Evidence SHA-256 Root Hash
                    </span>
                    {verification?.valid ? (
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" /> VERIFIED INTACT
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-rose-500/20 text-rose-400 border border-rose-500/40 flex items-center gap-1">
                        <XCircle className="w-3 h-3" /> MISMATCH DETECTED
                      </span>
                    )}
                  </div>
                  <div className="font-mono text-emerald-400 text-xs break-all bg-black/40 p-2 rounded border border-slate-800">
                    {manifest.masterEvidenceHash}
                  </div>
                  <div className="grid grid-cols-3 gap-2 pt-2 text-[11px] text-slate-400">
                    <div>
                      <span className="text-slate-500 block">Start UTC:</span>
                      <span className="font-mono text-slate-200">
                        {new Date(manifest.startUtc).toISOString()}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-500 block">End UTC:</span>
                      <span className="font-mono text-slate-200">
                        {new Date(manifest.endUtc).toISOString()}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-500 block">Legal Hold:</span>
                      <span
                        className={`font-mono font-medium ${
                          manifest.legalHold ? 'text-amber-400' : 'text-slate-300'
                        }`}
                      >
                        {manifest.legalHold ? 'ACTIVE (PREVENT PURGE)' : 'INACTIVE'}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Section 63 BSA Statement */}
              {manifest?.certificateDataJson && (
                <div className="p-3 bg-slate-900/60 border border-slate-700/60 rounded space-y-1.5">
                  <div className="flex items-center gap-1.5 text-slate-200 font-semibold text-[11px]">
                    <FileText className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Section 63 BSA Provenance Record</span>
                  </div>
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    {manifest.certificateDataJson.disclaimer}
                  </p>
                  <div className="font-mono text-[10px] text-slate-500 pt-1">
                    Appliance: {manifest.certificateDataJson.applianceIdentifier} | Algorithm:{' '}
                    {manifest.certificateDataJson.hashAlgorithm}
                  </div>
                </div>
              )}

              {/* Chain of Custody History */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-slate-200 uppercase tracking-wide flex items-center gap-1.5">
                    <History className="w-3.5 h-3.5 text-amber-400" />
                    <span>Immutable Chain of Custody Log</span>
                  </h3>
                  <span className="text-[10px] font-mono text-slate-400">
                    {custodyLogs.length} Events Recorded
                  </span>
                </div>

                <div className="border border-slate-700 rounded overflow-hidden divide-y divide-slate-800 bg-graphite-900">
                  {custodyLogs.length === 0 ? (
                    <div className="p-4 text-center text-slate-500 font-mono text-xs">
                      No custodial actions recorded yet.
                    </div>
                  ) : (
                    custodyLogs.map((log, idx) => (
                      <div key={log.id || idx} className="p-3 hover:bg-slate-800/40 transition">
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-mono font-semibold text-emerald-400 text-[11px]">
                            {log.action}
                          </span>
                          <span className="font-mono text-[10px] text-slate-500">
                            {new Date(log.timestampUtc).toISOString()}
                          </span>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-[10px] font-mono text-slate-400">
                          <div>
                            <span className="text-slate-600 block">Actor ID:</span>
                            <span className="text-slate-300">{log.actorUserId}</span>
                          </div>
                          <div>
                            <span className="text-slate-600 block">Source Hash:</span>
                            <span className="text-slate-300 truncate block">
                              {log.sourceHash.slice(0, 16)}...
                            </span>
                          </div>
                        </div>
                        {log.resultHash && (
                          <div className="mt-1 text-[10px] font-mono text-cyan-400">
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
                <div className="p-4 bg-amber-950/20 border border-amber-800/40 rounded flex items-center justify-between">
                  <div className="space-y-0.5">
                    <div className="text-amber-300 font-medium text-xs flex items-center gap-1.5">
                      <Lock className="w-3.5 h-3.5" />
                      <span>Dual-Custody Supervisory Approval</span>
                    </div>
                    <p className="text-[11px] text-slate-400">
                      Validate evidence authenticity before official evidentiary release.
                    </p>
                  </div>
                  <button
                    onClick={handleApproveExport}
                    disabled={actionLoading}
                    className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded font-mono text-xs transition disabled:opacity-50"
                  >
                    {actionLoading ? 'Approving...' : 'Approve Export'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-700 bg-graphite-900 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded font-mono text-xs transition"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default EvidenceReviewModal;
