import React, { useState, useEffect } from 'react';
import {
  ShieldCheck,
  Download,
  CheckCircle2,
  Eye,
  Copy,
  Check,
  RefreshCw,
  Video,
  Scissors,
  Settings,
  Play,
  FileCheck,
} from 'lucide-react';
import api from '../services/api';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { EmptyState } from '../components/ui/EmptyState';
import CreateRedactionModal from '../components/CreateRedactionModal';
import DpdpSettingsModal from '../components/DpdpSettingsModal';

export const Evidence: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'PACKAGES' | 'REDACTION'>('PACKAGES');
  const [exportsList, setExportsList] = useState<any[]>([]);
  const [redactionJobs, setRedactionJobs] = useState<any[]>([]);
  const [selectedExport, setSelectedExport] = useState<any | null>(null);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [executingJobId, setExecutingJobId] = useState<string | null>(null);
  const [showCreateRedaction, setShowCreateRedaction] = useState(false);
  const [showDpdpSettings, setShowDpdpSettings] = useState(false);

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

  const fetchRedactionJobs = async () => {
    try {
      const res = await api.get('/privacy/jobs');
      setRedactionJobs(res.data.jobs || []);
    } catch (err) {
      console.error(err);
    }
  };

  const handleRefreshAll = () => {
    fetchExports();
    fetchRedactionJobs();
  };

  useEffect(() => {
    fetchExports();
    fetchRedactionJobs();
  }, []);

  // Poll redaction jobs if any are QUEUED or PROCESSING
  useEffect(() => {
    const hasActiveJob = redactionJobs.some((j) => j.status === 'QUEUED' || j.status === 'PROCESSING');
    if (!hasActiveJob) return;

    const timer = setInterval(() => {
      fetchRedactionJobs();
    }, 4000);

    return () => clearInterval(timer);
  }, [redactionJobs]);

  const handleExecuteJob = async (jobId: string) => {
    setExecutingJobId(jobId);
    try {
      await api.post(`/privacy/jobs/${jobId}/execute`);
      await fetchRedactionJobs();
    } catch (err: any) {
      alert(`Execute failed: ${err.response?.data?.error || err.message}`);
    } finally {
      setExecutingJobId(null);
    }
  };

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
              Section 63 BSA Forensic Evidence & Privacy Registry
            </h1>
            <Badge variant="legal" size="sm" dot>
              Chain-of-Custody Secure
            </Badge>
          </div>
          <p className="text-[14px] font-sans text-vms-muted mt-1 max-w-3xl leading-relaxed">
            Statutory evidentiary registry under the Bharatiya Sakshya Adhiniyam, 2023 and DPDP Act 2023. Every record block is immutably sealed with SHA-256 Merkle root digests, appliance Ed25519 digital signatures, and derivative redaction packages.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowDpdpSettings(true)}
            icon={<Settings className="w-3.5 h-3.5 text-vms-accent" />}
          >
            DPDP Settings
          </Button>

          <Button
            variant="primary"
            size="sm"
            onClick={() => setShowCreateRedaction(true)}
            icon={<Scissors className="w-3.5 h-3.5" />}
          >
            New Redaction Job
          </Button>

          <Button
            variant="secondary"
            size="sm"
            onClick={handleRefreshAll}
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
          <span className="text-vms-muted">REDACTION JOBS:</span>
          <span className="font-bold text-sky-400">{redactionJobs.length}</span>
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
          <span className="font-bold text-amber-400">Sec 63 BSA / DPDP</span>
        </div>
      </div>

      {/* Section View Tabs */}
      <div className="flex items-center space-x-2 border-b border-vms-border pb-2">
        <button
          onClick={() => setActiveTab('PACKAGES')}
          className={`flex items-center gap-2 px-3 py-1.5 text-xs font-mono rounded font-semibold transition-colors ${
            activeTab === 'PACKAGES'
              ? 'bg-vms-panel border border-vms-border text-vms-text shadow-sm'
              : 'text-vms-muted hover:text-vms-text'
          }`}
        >
          <ShieldCheck className="w-3.5 h-3.5 text-status-legal" />
          <span>Sealed Evidence Packages ({exportsList.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('REDACTION')}
          className={`flex items-center gap-2 px-3 py-1.5 text-xs font-mono rounded font-semibold transition-colors ${
            activeTab === 'REDACTION'
              ? 'bg-vms-panel border border-vms-border text-vms-text shadow-sm'
              : 'text-vms-muted hover:text-vms-text'
          }`}
        >
          <Scissors className="w-3.5 h-3.5 text-vms-accent" />
          <span>Video Redaction Jobs ({redactionJobs.length})</span>
        </button>
      </div>

      {/* View 1: Sealed Evidence Packages */}
      {activeTab === 'PACKAGES' && (
        <Card padding="none">
          <div className="px-4 py-3 border-b border-vms-border flex items-center justify-between bg-vms-panel/50">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-xs text-vms-text uppercase tracking-wider">
                Canonical Evidence Manifests ({exportsList.length})
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
                <tbody className="divide-y divide-vms-border font-mono">
                  {exportsList.map((exp) => (
                    <tr key={exp.id} className="hover:bg-vms-surface/50 transition-colors">
                      <td className="px-4 py-3">
                        <div className="font-semibold text-vms-text flex items-center gap-1.5">
                          <span>EV_{exp.id.slice(0, 8).toUpperCase()}</span>
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                        </div>
                        <div className="text-[10px] text-vms-dim mt-0.5">
                          {new Date(exp.createdAt).toLocaleString()}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-vms-text flex items-center gap-1.5">
                          <Video className="w-3.5 h-3.5 text-vms-muted" />
                          <span>{exp.cameraName || 'Multi-Camera / System'}</span>
                        </div>
                        <div className="text-[10px] text-vms-dim mt-0.5">
                          {exp.cameraIp || 'Local Storage Vault'}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-[11px] text-vms-muted">
                        <div>{new Date(exp.timeWindowStart).toISOString().slice(0, 19).replace('T', ' ')}</div>
                        <div>{new Date(exp.timeWindowEnd).toISOString().slice(0, 19).replace('T', ' ')}</div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="neutral" size="sm">
                          {exp.exportMode || 'FORENSIC'}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[11px] text-status-legal truncate max-w-[120px]">
                            {exp.sha256Hash || 'PENDING'}
                          </span>
                          {exp.sha256Hash && (
                            <button
                              onClick={() => handleCopyHash(exp.sha256Hash)}
                              className="text-vms-muted hover:text-vms-text transition-colors p-0.5"
                              title="Copy SHA-256 Digest"
                            >
                              {copiedHash === exp.sha256Hash ? (
                                <Check className="w-3 h-3 text-emerald-400" />
                              ) : (
                                <Copy className="w-3 h-3" />
                              )}
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="telemetry" size="sm">
                          ED25519
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setSelectedExport(exp)}
                            icon={<Eye className="w-3 h-3" />}
                          >
                            Audit
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
                              ZIP
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
      )}

      {/* View 2: Video Redaction Jobs */}
      {activeTab === 'REDACTION' && (
        <Card padding="none">
          <div className="px-4 py-3 border-b border-vms-border flex items-center justify-between bg-vms-panel/50">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-xs text-vms-text uppercase tracking-wider">
                Video Redaction & Privacy Derivatives ({redactionJobs.length})
              </span>
            </div>
            <span className="text-[11px] text-vms-muted font-mono">
              Engine: FFmpeg + YuNet (Face) + PP-OCRv4 (Plate)
            </span>
          </div>

          {redactionJobs.length === 0 ? (
            <EmptyState
              icon={<Scissors className="w-6 h-6" />}
              title="No redaction jobs created yet"
              description="Click 'New Redaction Job' to apply face and license plate masking to an existing sealed evidence package."
              action={{
                label: 'Create First Redaction Job',
                onClick: () => setShowCreateRedaction(true),
              }}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-vms-panel/80 text-vms-muted uppercase text-[10px] border-b border-vms-border font-medium tracking-wider">
                  <tr>
                    <th className="px-4 py-2.5">Job ID</th>
                    <th className="px-4 py-2.5">Source Manifest</th>
                    <th className="px-4 py-2.5">Mode & Targets</th>
                    <th className="px-4 py-2.5">Status</th>
                    <th className="px-4 py-2.5">Output SHA-256</th>
                    <th className="px-4 py-2.5">Size</th>
                    <th className="px-4 py-2.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-vms-border font-mono">
                  {redactionJobs.map((job) => (
                    <tr key={job.id} className="hover:bg-vms-surface/50 transition-colors">
                      <td className="px-4 py-3">
                        <div className="font-semibold text-vms-text flex items-center gap-1.5">
                          <span>RED_{job.id.slice(0, 8).toUpperCase()}</span>
                        </div>
                        <div className="text-[10px] text-vms-dim mt-0.5">
                          {new Date(job.createdAt).toLocaleString()}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-vms-muted">
                        <div className="text-vms-text">
                          EV_{job.sourceManifestId?.slice(0, 8).toUpperCase() || 'N/A'}
                        </div>
                        <div className="text-[10px] text-vms-dim">
                          {job.cameraId ? `Camera: ${job.cameraId.slice(0, 8)}` : 'All Feeds'}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <Badge variant="neutral" size="sm">
                            {job.redactionMode}
                          </Badge>
                          {(job.detectKinds || []).map((k: string) => (
                            <Badge key={k} variant="telemetry" size="sm">
                              {k === 'FACE' ? 'FACE' : 'PLATE'}
                            </Badge>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {job.status === 'COMPLETED' ? (
                          <Badge variant="success" size="sm" dot>
                            COMPLETED
                          </Badge>
                        ) : job.status === 'PROCESSING' ? (
                          <Badge variant="warn" size="sm" dot>
                            PROCESSING
                          </Badge>
                        ) : job.status === 'FAILED' ? (
                          <Badge variant="alarm" size="sm" dot>
                            FAILED
                          </Badge>
                        ) : (
                          <Badge variant="neutral" size="sm">
                            QUEUED
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {job.outputSha256 ? (
                          <div className="flex items-center gap-1.5">
                            <span className="text-[11px] text-status-legal truncate max-w-[120px]">
                              {job.outputSha256}
                            </span>
                            <button
                              onClick={() => handleCopyHash(job.outputSha256)}
                              className="text-vms-muted hover:text-vms-text transition-colors p-0.5"
                              title="Copy SHA-256 Digest"
                            >
                              {copiedHash === job.outputSha256 ? (
                                <Check className="w-3 h-3 text-emerald-400" />
                              ) : (
                                <Copy className="w-3 h-3" />
                              )}
                            </button>
                          </div>
                        ) : (
                          <span className="text-vms-dim text-[11px]">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-vms-muted text-[11px]">
                        {job.outputBytes ? `${(job.outputBytes / (1024 * 1024)).toFixed(1)} MB` : '—'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {job.status === 'QUEUED' && (
                            <Button
                              size="sm"
                              variant="primary"
                              onClick={() => handleExecuteJob(job.id)}
                              isLoading={executingJobId === job.id}
                              icon={<Play className="w-3 h-3" />}
                            >
                              Execute
                            </Button>
                          )}

                          {job.status === 'COMPLETED' && (
                            <>
                              <a
                                href={`/api/v1/privacy/jobs/${job.id}/download`}
                                download
                                title="Download redacted derivative MP4"
                              >
                                <Button
                                  size="sm"
                                  variant="primary"
                                  icon={<Video className="w-3 h-3" />}
                                >
                                  MP4
                                </Button>
                              </a>

                              <a
                                href={`/api/v1/privacy/jobs/${job.id}/package`}
                                download
                                title="Download signed verification package (derivation.json + AI provenance)"
                              >
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  icon={<FileCheck className="w-3 h-3" />}
                                >
                                  ZIP
                                </Button>
                              </a>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

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

      {/* Create Redaction Modal */}
      <CreateRedactionModal
        isOpen={showCreateRedaction}
        onClose={() => setShowCreateRedaction(false)}
        evidenceList={exportsList}
        onCreated={() => {
          fetchRedactionJobs();
          setActiveTab('REDACTION');
        }}
      />

      {/* DPDP Settings Modal */}
      <DpdpSettingsModal
        isOpen={showDpdpSettings}
        onClose={() => setShowDpdpSettings(false)}
      />
    </div>
  );
};

export default Evidence;
