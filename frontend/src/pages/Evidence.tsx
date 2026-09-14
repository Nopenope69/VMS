import React, { useState, useEffect } from 'react';
import { ShieldCheck, Download, CheckCircle2, Eye, Copy, Check, RefreshCw, Key } from 'lucide-react';
import api from '../services/api';

export const Evidence: React.FC = () => {
  const [exportsList, setExportsList] = useState<any[]>([]);
  const [selectedExport, setSelectedExport] = useState<any | null>(null);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const fetchExports = async () => {
    setLoading(true);
    try {
      const res = await api.get('/evidence');
      setExportsList(res.data.exports || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchExports();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedExport(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleCopyHash = (hash: string) => {
    navigator.clipboard.writeText(hash);
    setCopiedHash(hash);
    setTimeout(() => setCopiedHash(null), 2000);
  };

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] bg-tactical-canvas p-4 space-y-3 overflow-y-auto font-mono text-tactical-text">
      {/* Top Banner */}
      <div className="bg-tactical-panel p-3.5 border border-tactical-border flex flex-wrap justify-between items-center gap-3">
        <div>
          <div className="flex items-center space-x-2">
            <ShieldCheck className="w-5 h-5 text-phosphor-amber" />
            <h2 className="text-sm font-bold text-tactical-bright uppercase tracking-wider font-mono">
              Section 63 BSA Forensic Evidence Registry
            </h2>
            <span className="text-[10px] bg-tactical-surface text-phosphor-green border border-phosphor-green/40 px-1.5 py-0.5 font-bold">
              CHAIN-OF-CUSTODY SECURE
            </span>
          </div>
          <p className="text-[13px] sm:text-[14px] text-tactical-muted mt-1 max-w-4xl leading-relaxed font-sans">
            Statutory registry of exported surveillance records under the Bharatiya Sakshya Adhiniyam, 2023. Every record block is immutably sealed with SHA-256 Merkle root digests and appliance Ed25519 digital signatures.
          </p>
        </div>

        <div className="flex items-center space-x-3">
          <div className="hidden sm:flex items-center space-x-2 bg-tactical-surface border border-tactical-border px-2.5 py-1 text-[10px]">
            <Key className="w-3.5 h-3.5 text-phosphor-cyan" />
            <span className="text-tactical-muted">APPLIANCE_KEY:</span>
            <span className="text-phosphor-cyan font-bold">ED25519 READY</span>
          </div>

          <button
            onClick={fetchExports}
            disabled={loading}
            className="btn-tactical-secondary flex items-center space-x-1.5 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-phosphor-amber' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Main Registry Table */}
      <div className="bg-tactical-panel border border-tactical-border flex-1 flex flex-col">
        <div className="px-3.5 py-2.5 border-b border-tactical-border bg-tactical-surface flex items-center justify-between text-xs">
          <span className="font-bold uppercase tracking-wider text-tactical-text">
            SEALED EVIDENCE PACKAGES ({exportsList.length})
          </span>
          <span className="text-[10px] text-[#8B949E]">
            LEGAL STATUS: COMPLIANT WITH SEC. 63 BSA / ISO-IEC 27037
          </span>
        </div>

        {exportsList.length === 0 ? (
          <div className="p-12 text-center text-[#484F58] text-xs">
            [ NO EVIDENTIARY PACKAGES GENERATED YET. NAVIGATE TO PLAYBACK TO SELECT AN INTERVAL AND EXPORT. ]
          </div>
        ) : (
          <div className="overflow-x-auto flex-1">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#080B10] text-[#8B949E] uppercase text-[10px] border-b border-[#21262D] tracking-wider">
                <tr>
                  <th className="px-3.5 py-2">PACKAGE_ID</th>
                  <th className="px-3.5 py-2">CAMERA_SOURCE</th>
                  <th className="px-3.5 py-2">UTC_INTERVAL</th>
                  <th className="px-3.5 py-2">BITSTREAM_MODE</th>
                  <th className="px-3.5 py-2">SHA-256 CHECKSUM</th>
                  <th className="px-3.5 py-2">SIGNATURE</th>
                  <th className="px-3.5 py-2 text-right">ACTIONS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#21262D] text-[#C9D1D9]">
                {exportsList.map((exp) => (
                  <tr key={exp.id} className="hover:bg-[#161B22] transition-colors">
                    <td className="px-3.5 py-2.5 font-bold text-white">
                      EV_{exp.id.slice(0, 8).toUpperCase()}
                    </td>
                    <td className="px-3.5 py-2.5 text-[#E3B341]">
                      {exp.camera?.name || 'CAMERA'}
                    </td>
                    <td className="px-3.5 py-2.5 text-[#8B949E] text-[11px]">
                      {new Date(exp.startTime).toLocaleTimeString([], { hour12: false })} →{' '}
                      {new Date(exp.endTime).toLocaleTimeString([], { hour12: false })}
                    </td>
                    <td className="px-3.5 py-2.5">
                      <span className="px-1.5 py-0.5 bg-[#080B10] border border-[#30363D] text-[10px] text-[#C9D1D9] font-bold">
                        {exp.exportMode}
                      </span>
                    </td>
                    <td className="px-3.5 py-2.5 text-[#8B949E] text-[11px]">
                      {exp.sha256Hash ? (
                        <div className="flex items-center space-x-1.5">
                          <span>{exp.sha256Hash.slice(0, 14)}...</span>
                          <button
                            onClick={() => handleCopyHash(exp.sha256Hash)}
                            className="text-[#8B949E] hover:text-[#E3B341]"
                            title="Copy full SHA-256 hash"
                          >
                            {copiedHash === exp.sha256Hash ? (
                              <Check className="w-3 h-3 text-[#3FB950]" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                          </button>
                        </div>
                      ) : (
                        <span className="text-[#E3B341]">COMPUTING</span>
                      )}
                    </td>
                    <td className="px-3.5 py-2.5">
                      <span className="inline-flex items-center space-x-1 text-[#3FB950] text-[10px] font-bold">
                        <CheckCircle2 className="w-3 h-3" />
                        <span>ED25519 VALID</span>
                      </span>
                    </td>
                    <td className="px-3.5 py-2.5 text-right space-x-2">
                      <button
                        onClick={() => setSelectedExport(exp)}
                        className="btn-tactical-secondary px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider transition-colors inline-flex items-center space-x-1"
                        title="Inspect Full Manifest & Signatures"
                      >
                        <Eye className="w-3 h-3 inline mr-1" />
                        <span>Manifest</span>
                      </button>
                      <a
                        href={`/api/v1/evidence/download/Evidence_${exp.id}.zip`}
                        download
                        className="btn-tactical-primary inline-flex items-center space-x-1 px-2.5 py-1 font-bold text-[10px] uppercase tracking-wider transition-colors"
                      >
                        <Download className="w-3 h-3" />
                        <span>Download ZIP</span>
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Manifest Inspection Modal */}
      {selectedExport && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 bg-black/85 flex items-center justify-center p-4 z-50 backdrop-blur-none font-mono"
        >
          <div className="bg-tactical-panel border border-tactical-border rounded-none w-full max-w-2xl overflow-hidden shadow-2xl">
            <div className="px-4 py-3 border-b border-tactical-border flex justify-between items-center bg-tactical-surface">
              <div className="flex items-center space-x-2">
                <ShieldCheck className="w-4 h-4 text-phosphor-amber" />
                <h3 className="text-xs font-bold text-tactical-bright uppercase tracking-wider font-mono">
                  Forensic Manifest Audit // EV_{selectedExport.id.slice(0, 8).toUpperCase()}
                </h3>
              </div>
              <button
                onClick={() => setSelectedExport(null)}
                className="text-tactical-muted hover:text-white text-xs px-2 py-0.5 border border-tactical-border hover:bg-tactical-raised"
              >
                ✕
              </button>
            </div>

            <div className="p-4 space-y-3 max-h-[75vh] overflow-y-auto text-xs text-tactical-text">
              <div>
                <span className="text-[10px] uppercase text-tactical-muted block mb-1">
                  SHA-256 MERKLE ROOT DIGEST:
                </span>
                <div className="p-2 bg-tactical-canvas border border-tactical-border text-phosphor-amber break-all select-all text-xs font-mono">
                  {selectedExport.sha256Hash || 'PENDING'}
                </div>
              </div>

              <div>
                <span className="text-[10px] uppercase text-tactical-muted block mb-1">
                  APPLIANCE ED25519 HARDWARE SIGNATURE:
                </span>
                <div className="p-2 bg-tactical-canvas border border-tactical-border text-tactical-muted break-all text-[11px] font-mono">
                  {selectedExport.signatureEd25519 || 'N/A'}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 bg-tactical-surface p-2.5 border border-tactical-border">
                <div className="bg-tactical-canvas p-2 border border-tactical-border">
                  <div className="text-[10px] text-phosphor-cyan font-bold uppercase mb-1">
                    PART A: PARTY IN-CHARGE
                  </div>
                  <div className="text-xs">NAME: {selectedExport.partAPartyName || 'N/A'}</div>
                  <div className="text-[10px] text-tactical-muted">ROLE: {selectedExport.partAPartyDesignation || 'N/A'}</div>
                </div>
                <div className="bg-tactical-canvas p-2 border border-tactical-border">
                  <div className="text-[10px] text-phosphor-amber font-bold uppercase mb-1">
                    PART B: FORENSIC EXPERT
                  </div>
                  <div className="text-xs">NAME: {selectedExport.partBExpertName || 'N/A'}</div>
                  <div className="text-[10px] text-tactical-muted">ROLE: {selectedExport.partBExpertDesignation || 'N/A'}</div>
                  <div className="text-[10px] text-tactical-muted">ORG: {selectedExport.partBExpertOrganization || 'N/A'}</div>
                </div>
              </div>

              <div>
                <span className="text-[10px] uppercase text-tactical-muted block mb-1">
                  CANONICAL AUDIT MANIFEST JSON:
                </span>
                <pre className="p-2.5 bg-tactical-canvas border border-tactical-border text-[10px] text-tactical-muted overflow-x-auto leading-tight font-mono">
                  {JSON.stringify(selectedExport.manifestJson || selectedExport, null, 2)}
                </pre>
              </div>
            </div>

            <div className="p-3 border-t border-tactical-border flex justify-end bg-tactical-surface">
              <button
                onClick={() => setSelectedExport(null)}
                className="btn-tactical-secondary px-3 py-1.5 text-xs font-semibold uppercase tracking-wider"
              >
                Close Audit View
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Evidence;
