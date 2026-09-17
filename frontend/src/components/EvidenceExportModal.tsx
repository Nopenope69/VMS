import React, { useState } from 'react';
import { FileCheck, Download, AlertCircle, Video } from 'lucide-react';
import api from '../services/api';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';

interface EvidenceExportModalProps {
  cameraId: string;
  cameraName: string;
  defaultStartTime: Date;
  defaultEndTime: Date;
  onClose: () => void;
  onSuccess: (filename: string) => void;
}

export const EvidenceExportModal: React.FC<EvidenceExportModalProps> = ({
  cameraId,
  cameraName,
  defaultStartTime,
  defaultEndTime,
  onClose,
  onSuccess,
}) => {
  const [startTime, setStartTime] = useState(defaultStartTime.toISOString().slice(0, 19));
  const [endTime, setEndTime] = useState(defaultEndTime.toISOString().slice(0, 19));
  const [exportMode, setExportMode] = useState<'STREAM_COPY' | 'FRAME_ACCURATE'>('STREAM_COPY');

  // Statutory Signatories
  const [partAPartyName, setPartAPartyName] = useState('');
  const [partAPartyDesignation, setPartAPartyDesignation] = useState('Security Operations Head');
  const [partBExpertName, setPartBExpertName] = useState('');
  const [partBExpertDesignation, setPartBExpertDesignation] = useState('Digital Evidence Examiner');
  const [partBExpertOrganization, setPartBExpertOrganization] = useState('');
  const [partBSigningMode, setPartBSigningMode] = useState<'IN_APP_DESIGNATED' | 'EXTERNAL_PHYSICAL'>('IN_APP_DESIGNATED');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const res = await api.post('/evidence/export', {
        cameraId,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date(endTime).toISOString(),
        exportMode,
        partAPartyName,
        partAPartyDesignation,
        partBExpertName,
        partBExpertDesignation,
        partBExpertOrganization,
        partBSigningMode,
      });

      onSuccess(res.data.filename);
      onClose();
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to generate evidence package');
    } finally {
      setLoading(false);
    }
  };

  /* Modal ARIA dialog semantics: role="dialog" aria-modal="true" handles e.key === 'Escape' */
  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title="Statutory Evidence Export — BSA 2023 Sec. 63"
      description={`Export verifiable digital evidence for ${cameraName} [${cameraId.slice(0, 8)}]`}
      size="lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="p-3 bg-status-alarm/10 border border-status-alarm/30 rounded text-status-alarm text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="legal-disclaimer">
          <p>
            Section 63 BSA statutory export: packages are sealed with SHA-256 Merkle root digests and signed by appliance hardware key.
          </p>
        </div>

        {/* Source Camera Info */}
        <div className="flex items-center justify-between p-2.5 bg-vms-panel rounded border border-vms-border text-xs">
          <div className="flex items-center gap-2">
            <Video className="w-4 h-4 text-vms-accent" />
            <span className="text-vms-muted">Target Stream:</span>
            <span className="font-semibold text-vms-text font-mono">{cameraName}</span>
          </div>
          <Badge variant="legal" size="sm">
            Ed25519 Signed
          </Badge>
        </div>

        {/* Time Window */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="bg-vms-panel p-3 rounded border border-vms-border">
            <label className="block text-[11px] font-medium text-vms-muted uppercase tracking-wider mb-1.5">
              Start Interval
            </label>
            <input
              type="datetime-local"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              required
              className="w-full bg-vms-bg border border-vms-border rounded px-2.5 py-1.5 text-xs text-vms-text focus:outline-none focus:border-vms-accent font-mono"
            />
          </div>
          <div className="bg-vms-panel p-3 rounded border border-vms-border">
            <label className="block text-[11px] font-medium text-vms-muted uppercase tracking-wider mb-1.5">
              End Interval
            </label>
            <input
              type="datetime-local"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              required
              className="w-full bg-vms-bg border border-vms-border rounded px-2.5 py-1.5 text-xs text-vms-text focus:outline-none focus:border-vms-accent font-mono"
            />
          </div>
        </div>

        {/* Export Mode */}
        <div className="bg-vms-panel p-3 rounded border border-vms-border">
          <label className="block text-[11px] font-medium text-vms-muted uppercase tracking-wider mb-2">
            Bitstream & Container Mode
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label
              className={`flex items-start gap-2.5 p-2.5 rounded border cursor-pointer transition-all ${
                exportMode === 'STREAM_COPY'
                  ? 'bg-vms-surface border-vms-accent text-vms-text shadow-xs'
                  : 'bg-vms-bg border-vms-border text-vms-muted hover:border-vms-border/80'
              }`}
            >
              <input
                type="radio"
                name="exportMode"
                checked={exportMode === 'STREAM_COPY'}
                onChange={() => setExportMode('STREAM_COPY')}
                className="mt-0.5 text-vms-accent focus:ring-0"
              />
              <div>
                <div className="text-xs font-semibold">Stream Copy (Lossless)</div>
                <div className="text-[11px] text-vms-muted mt-0.5 leading-normal">
                  Preserves exact fMP4 bitstream; keyframe aligned.
                </div>
              </div>
            </label>

            <label
              className={`flex items-start gap-2.5 p-2.5 rounded border cursor-pointer transition-all ${
                exportMode === 'FRAME_ACCURATE'
                  ? 'bg-vms-surface border-vms-accent text-vms-text shadow-xs'
                  : 'bg-vms-bg border-vms-border text-vms-muted hover:border-vms-border/80'
              }`}
            >
              <input
                type="radio"
                name="exportMode"
                checked={exportMode === 'FRAME_ACCURATE'}
                onChange={() => setExportMode('FRAME_ACCURATE')}
                className="mt-0.5 text-vms-accent focus:ring-0"
              />
              <div>
                <div className="text-xs font-semibold">Frame Accurate (Re-encode)</div>
                <div className="text-[11px] text-vms-muted mt-0.5 leading-normal">
                  Exact boundary cut via libx264; updates SHA-256 root.
                </div>
              </div>
            </label>
          </div>
        </div>

        {/* Statutory Signatories: Section 63 BSA */}
        <div className="border border-vms-border bg-vms-panel p-3.5 rounded space-y-3">
          <div className="flex items-center gap-2 border-b border-vms-border pb-2">
            <FileCheck className="w-4 h-4 text-vms-accent" />
            <h4 className="text-xs font-bold text-vms-text uppercase tracking-wider">
              Statutory Signatories (BSA Section 63 Schedule)
            </h4>
          </div>

          {/* Part A */}
          <div className="bg-vms-bg p-3 rounded border border-vms-border space-y-2">
            <div className="text-[11px] font-semibold text-vms-accent uppercase tracking-wider">
              Part A: Party In-Charge / System Operator
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input
                type="text"
                placeholder="Custodian Full Name"
                value={partAPartyName}
                onChange={(e) => setPartAPartyName(e.target.value)}
                className="bg-vms-surface border border-vms-border rounded px-2.5 py-1.5 text-xs text-vms-text focus:outline-none focus:border-vms-accent"
              />
              <input
                type="text"
                placeholder="Designation (e.g., Security Operations Head)"
                value={partAPartyDesignation}
                onChange={(e) => setPartAPartyDesignation(e.target.value)}
                className="bg-vms-surface border border-vms-border rounded px-2.5 py-1.5 text-xs text-vms-text focus:outline-none focus:border-vms-accent"
              />
            </div>
          </div>

          {/* Part B */}
          <div className="bg-vms-bg p-3 rounded border border-vms-border space-y-2">
            <div className="text-[11px] font-semibold text-status-legal uppercase tracking-wider">
              Part B: Technical Expert / Forensic Examiner
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input
                type="text"
                placeholder="Forensic Expert Name"
                value={partBExpertName}
                onChange={(e) => setPartBExpertName(e.target.value)}
                className="bg-vms-surface border border-vms-border rounded px-2.5 py-1.5 text-xs text-vms-text focus:outline-none focus:border-vms-accent"
              />
              <input
                type="text"
                placeholder="Expert Designation"
                value={partBExpertDesignation}
                onChange={(e) => setPartBExpertDesignation(e.target.value)}
                className="bg-vms-surface border border-vms-border rounded px-2.5 py-1.5 text-xs text-vms-text focus:outline-none focus:border-vms-accent"
              />
            </div>
            <input
              type="text"
              placeholder="Laboratory / Institution Name"
              value={partBExpertOrganization}
              onChange={(e) => setPartBExpertOrganization(e.target.value)}
              className="w-full bg-vms-surface border border-vms-border rounded px-2.5 py-1.5 text-xs text-vms-text focus:outline-none focus:border-vms-accent"
            />
            <div>
              <label className="block text-[11px] text-vms-muted uppercase mb-1">Part B Execution Mode:</label>
              <select
                value={partBSigningMode}
                onChange={(e: any) => setPartBSigningMode(e.target.value)}
                className="w-full bg-vms-surface border border-vms-border rounded px-2.5 py-1.5 text-xs text-vms-text focus:outline-none focus:border-vms-accent"
              >
                <option value="IN_APP_DESIGNATED">In-App Designated Signatory Record (Ed25519 Embedded)</option>
                <option value="EXTERNAL_PHYSICAL">External Physical Signature on Printed Affidavit</option>
              </select>
            </div>
          </div>
        </div>

        {/* Legal Disclaimer */}
        <div className="p-3 bg-vms-panel/50 border border-vms-border rounded text-[11px] text-vms-muted leading-relaxed">
          <span className="font-semibold text-vms-text">Forensic Integrity Disclosure:</span> VigilOne VMS generates an immutable archive containing the raw fMP4 media stream, SHA-256 hash digests, Ed25519 appliance digital signature, and statutory Part A & Part B certificates pursuant to Section 63 of the Bharatiya Sakshya Adhiniyam, 2023.
        </div>

        {/* Footer Actions */}
        <div className="flex justify-end gap-2 pt-2 border-t border-vms-border">
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            isLoading={loading}
            icon={<Download className="w-3.5 h-3.5" />}
          >
            {loading ? 'Assembling & Signing...' : 'Seal & Generate Package'}
          </Button>
        </div>
      </form>
    </Modal>
  );
};

export default EvidenceExportModal;
