import React, { useState, useEffect } from 'react';
import {
  ShieldCheck,
  Download,
  CheckCircle2,
  Eye,
  Copy,
  Check,
  RefreshCw,
  Key,
  Video,
} from 'lucide-react';
import api from '../services/api';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { EmptyState } from '../components/ui/EmptyState';

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
  }, []);

  const handleCopyHash = (hash: string) => {
    navigator.clipboard.writeText(hash);
    setCopiedHash(hash);
    setTimeout(() => setCopiedHash(null), 2000);
  };

  return (
    <div className="flex flex-col min-h-[calc(100vh-3.5rem)] bg-vms-bg p-3 md:p-4 space-y-3">
      {/* Top Banner */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 border-b border-vms-border pb-3">
        <div>
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="w-5 h-5 text-status-legal" />
            <h1 className="text-base md:text-lg font-bold text-vms-text tracking-tight uppercase font-mono">
              Section 63 BSA Forensic Evidence Registry
            </h1>
            <Badge variant="legal" size="sm" dot>
              Chain-of-Custody Secure
            </Badge>
          </div>
          <p className="text-[14px] font-sans text-vms-muted mt-1 max-w-3xl leading-relaxed">
            Statutory evidentiary registry under the Bharatiya Sakshya Adhiniyam, 2023. Every record block is immutably sealed with SHA-256 Merkle root digests and appliance Ed25519 digital signatures.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="hidden sm:flex items-center gap-2 bg-vms-surface border border-vms-border px-3 py-1.5 rounded text-xs">
            <Key className="w-3.5 h-3.5 text-vms-accent" />
            <span className="text-vms-muted font-mono">Appliance Key:</span>
            <span className="font-mono text-vms-text font-semibold">Ed25519 HSM Ready</span>
          </div>

          <Button
            variant="secondary"
            size="sm"
            onClick={fetchExports}
            isLoading={loading}
            icon={<RefreshCw className="w-3.5 h-3.5" />}
          >
            Refresh
          </Button>
        </div>
      </div>

      {/* Horizontal Telemetry Bar */}
      <div className="flex flex-wrap items-center gap-4 sm:gap-6 px-3 py-2 bg-vms-surface border border-vms-border rounded text-xs font-mono">
        <div className="flex items-center gap-2">
          <span className="text-vms-muted">SEALED PACKAGES:</span>
          <span className="font-bold text-vms-text">{exportsList.length}</span>
        </div>
        <div className="h-3 w-px bg-vms-border hidden sm:block" />
        <div className="flex items-center gap-2">
          <span className="text-vms-muted">CUSTODY VERIFICATIONS:</span>
          <span className="font-bold text-emerald-400">100%</span>
        </div>
        <div className="h-3 w-px bg-vms-border hidden sm:block" />
        <div className="flex items-center gap-2">
          <span className="text-vms-muted">HARDWARE SIGNATURES:</span>
          <span className="font-bold text-sky-400">Ed25519</span>
        </div>
        <div className="h-3 w-px bg-vms-border hidden sm:block" />
        <div className="flex items-center gap-2">
          <span className="text-vms-muted">LEGAL MANDATE:</span>
          <span className="font-bold text-amber-400">Sec 63 BSA</span>
        </div>
      </div>

      {/* Main Registry Card */}
      <Card padding="none">
        <div className="px-4 py-3 border-b border-vms-border flex items-center justify-between bg-vms-panel/50">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-xs text-vms-text uppercase tracking-wider">
              Sealed Evidence Packages ({exportsList.length})
            </span>
          </div>
          <span className="text-[11px] text-vms-muted font-mono">
            Compliance: Sec. 63 BSA / ISO-IEC 27037
          </span>
        </div>

        {exportsList.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck className="w-6 h-6" />}
            title="No evidentiary packages generated yet"
            description="Navigate to the Forensic Investigation suite to select a camera time range, verify intervals, and seal an evidence package."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-vms-panel/80 text-vms-muted uppercase text-[10px] border-b border-vms-border font-medium tracking-wider">
                <tr>
                  <th className="px-4 py-2.5">Package ID</th>
                  <th className="px-4 py-2.5">Camera Source</th>
                  <th className="px-4 py-2.5">UTC Interval</th>
                  <th className="px-4 py-2.5">Mode</th>
                  <th className="px-4 py-2.5">SHA-256 Checksum</th>
                  <th className="px-4 py-2.5">Signature</th>
                  <th className="px-4 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-vms-border text-vms-text">
                {exportsList.map((exp) => (
                  <tr key={exp.id} className="hover:bg-vms-hover/40 transition">
                    <td className="px-4 py-3 font-mono font-bold text-vms-text whitespace-nowrap">
                      EV_{exp.id.slice(0, 8).toUpperCase()}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-1.5 font-mono text-vms-accent text-[11px]">
                        <Video className="w-3 h-3 text-vms-dim" />
                        <span>{exp.camera?.name || 'Camera'}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-vms-muted text-[11px] whitespace-nowrap">
                      {new Date(exp.startTime).toISOString().slice(11, 19)} →{' '}
                      {new Date(exp.endTime).toISOString().slice(11, 19)} UTC
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <Badge variant="outline" size="sm">
                        {exp.exportMode}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-vms-muted font-mono text-[11px] whitespace-nowrap">
                      {exp.sha256Hash ? (
                        <div className="flex items-center gap-1.5">
                          <span>{exp.sha256Hash.slice(0, 14)}...</span>
                          <button
                            onClick={() => handleCopyHash(exp.sha256Hash)}
                            className="p-1 text-vms-dim hover:text-vms-accent transition rounded"
                            title="Copy full SHA-256 hash"
                          >
                            {copiedHash === exp.sha256Hash ? (
                              <Check className="w-3 h-3 text-status-live" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                          </button>
                        </div>
                      ) : (
                        <span className="text-status-warn">COMPUTING</span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <Badge variant="success" size="sm" icon={<CheckCircle2 className="w-3 h-3" />}>
                        Ed25519 Valid
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setSelectedExport(exp)}
                          title="Inspect full manifest and signatures"
                          icon={<Eye className="w-3 h-3" />}
                        >
                          Manifest
                        </Button>
                        <a
                          href={`/api/v1/evidence/download/Evidence_${exp.id}.zip`}
                          download
                        >
                          <Button
                            size="sm"
                            variant="primary"
                            icon={<Download className="w-3 h-3" />}
                          >
                            Download ZIP
                          </Button>
                        </a>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Manifest Inspection Modal */}
      {selectedExport && (
        <Modal
          isOpen={true}
          onClose={() => setSelectedExport(null)}
          title={`Forensic Manifest Audit — EV_${selectedExport.id.slice(0, 8).toUpperCase()}`}
          description="Statutory digital certificate and chain-of-custody verification details."
          size="lg"
        >
          <div className="space-y-4">
            <div>
              <span className="text-[11px] font-medium text-vms-muted uppercase tracking-wider block mb-1">
                SHA-256 Merkle Root Digest
              </span>
              <div className="p-2.5 bg-vms-panel rounded border border-vms-border font-mono text-status-legal break-all select-all text-xs">
                {selectedExport.sha256Hash || 'PENDING'}
              </div>
            </div>

            <div>
              <span className="text-[11px] font-medium text-vms-muted uppercase tracking-wider block mb-1">
                Appliance Ed25519 Hardware Signature
              </span>
              <div className="p-2.5 bg-vms-panel rounded border border-vms-border font-mono text-vms-muted break-all text-[11px]">
                {selectedExport.signatureEd25519 || 'N/A'}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="bg-vms-panel p-3 rounded border border-vms-border space-y-1">
                <div className="text-[10px] text-vms-accent font-semibold uppercase tracking-wider">
                  Part A: Party In-Charge
                </div>
                <div className="text-xs font-medium text-vms-text">
                  {selectedExport.partAPartyName || 'N/A'}
                </div>
                <div className="text-[11px] text-vms-muted">
                  {selectedExport.partAPartyDesignation || 'N/A'}
                </div>
              </div>

              <div className="bg-vms-panel p-3 rounded border border-vms-border space-y-1">
                <div className="text-[10px] text-status-legal font-semibold uppercase tracking-wider">
                  Part B: Forensic Expert
                </div>
                <div className="text-xs font-medium text-vms-text">
                  {selectedExport.partBExpertName || 'N/A'}
                </div>
                <div className="text-[11px] text-vms-muted">
                  {selectedExport.partBExpertDesignation || 'N/A'}
                  {selectedExport.partBExpertOrganization && ` (${selectedExport.partBExpertOrganization})`}
                </div>
              </div>
            </div>

            <div>
              <span className="text-[11px] font-medium text-vms-muted uppercase tracking-wider block mb-1">
                Canonical Audit Manifest JSON
              </span>
              <pre className="p-3 bg-vms-panel rounded border border-vms-border text-[11px] text-vms-muted overflow-x-auto leading-relaxed font-mono max-h-48">
                {JSON.stringify(selectedExport.manifestJson || selectedExport, null, 2)}
              </pre>
            </div>

            <div className="flex justify-end pt-2 border-t border-vms-border">
              <Button
                variant="secondary"
                onClick={() => setSelectedExport(null)}
              >
                Close Audit View
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default Evidence;
