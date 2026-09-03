import React, { useState } from 'react';
import { Shield, FileCheck, X, Download, AlertCircle } from 'lucide-react';
import api from '../services/api';

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

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50 backdrop-blur-sm">
      <div className="bg-graphite-850 border border-graphite-700 rounded-md w-full max-w-2xl overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-graphite-700 bg-graphite-800">
          <div className="flex items-center space-x-2.5">
            <Shield className="w-5 h-5 text-cctv-amber" />
            <div>
              <h3 className="font-semibold text-sm text-slate-100 uppercase tracking-wider">
                Generate Section 63 BSA Evidence Package
              </h3>
              <p className="text-[11px] text-slate-400 font-mono">Camera: {cameraName}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded text-slate-400 hover:text-white transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 max-h-[80vh] overflow-y-auto">
          {error && (
            <div className="p-3 bg-red-900/30 border border-red-500/50 rounded flex items-center space-x-2 text-xs text-red-200">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Time Window */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-mono text-slate-300 mb-1">Start Time (UTC / Local)</label>
              <input
                type="datetime-local"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                required
                className="w-full bg-graphite-900 border border-graphite-700 rounded px-3 py-1.5 text-xs text-slate-200 font-mono focus:outline-none focus:border-cctv-amber"
              />
            </div>
            <div>
              <label className="block text-xs font-mono text-slate-300 mb-1">End Time (UTC / Local)</label>
              <input
                type="datetime-local"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                required
                className="w-full bg-graphite-900 border border-graphite-700 rounded px-3 py-1.5 text-xs text-slate-200 font-mono focus:outline-none focus:border-cctv-amber"
              />
            </div>
          </div>

          {/* Export Mode */}
          <div>
            <label className="block text-xs font-mono text-slate-300 mb-1">Video Export Mode</label>
            <div className="grid grid-cols-2 gap-3">
              <label
                className={`flex items-start space-x-2 p-2.5 rounded border cursor-pointer transition ${
                  exportMode === 'STREAM_COPY'
                    ? 'bg-cctv-amber/10 border-cctv-amber/60 text-slate-100'
                    : 'bg-graphite-900 border-graphite-700 text-slate-400'
                }`}
              >
                <input
                  type="radio"
                  name="exportMode"
                  checked={exportMode === 'STREAM_COPY'}
                  onChange={() => setExportMode('STREAM_COPY')}
                  className="mt-0.5"
                />
                <div>
                  <div className="text-xs font-semibold">STREAM_COPY (Lossless)</div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    Fast, preserves original bitstream, keyframe-aligned cuts.
                  </div>
                </div>
              </label>

              <label
                className={`flex items-start space-x-2 p-2.5 rounded border cursor-pointer transition ${
                  exportMode === 'FRAME_ACCURATE'
                    ? 'bg-cctv-amber/10 border-cctv-amber/60 text-slate-100'
                    : 'bg-graphite-900 border-graphite-700 text-slate-400'
                }`}
              >
                <input
                  type="radio"
                  name="exportMode"
                  checked={exportMode === 'FRAME_ACCURATE'}
                  onChange={() => setExportMode('FRAME_ACCURATE')}
                  className="mt-0.5"
                />
                <div>
                  <div className="text-xs font-semibold">FRAME_ACCURATE</div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    Exact frame-level cut via libx264 re-encoding.
                  </div>
                </div>
              </label>
            </div>
          </div>

          {/* Statutory Details: Section 63 BSA */}
          <div className="border-t border-graphite-700 pt-3 space-y-3">
            <div className="flex items-center space-x-2">
              <FileCheck className="w-4 h-4 text-cctv-teal" />
              <h4 className="text-xs font-semibold text-slate-200 uppercase tracking-wider">
                Statutory Signatories (Section 63 BSA 2023)
              </h4>
            </div>

            {/* Part A */}
            <div className="bg-graphite-900/60 p-3 rounded border border-graphite-700 space-y-2">
              <div className="text-[11px] font-semibold text-cctv-teal font-mono">
                Schedule Part A: Party In-Charge
              </div>
              <div className="grid grid-cols-2 gap-3">
                <input
                  type="text"
                  placeholder="Signatory Name (Party in charge)"
                  value={partAPartyName}
                  onChange={(e) => setPartAPartyName(e.target.value)}
                  className="bg-graphite-850 border border-graphite-700 rounded px-2.5 py-1 text-xs text-slate-200 focus:outline-none focus:border-cctv-teal"
                />
                <input
                  type="text"
                  placeholder="Designation"
                  value={partAPartyDesignation}
                  onChange={(e) => setPartAPartyDesignation(e.target.value)}
                  className="bg-graphite-850 border border-graphite-700 rounded px-2.5 py-1 text-xs text-slate-200 focus:outline-none focus:border-cctv-teal"
                />
              </div>
            </div>

            {/* Part B */}
            <div className="bg-graphite-900/60 p-3 rounded border border-graphite-700 space-y-2">
              <div className="text-[11px] font-semibold text-cctv-amber font-mono">
                Schedule Part B: Technical Expert / Custodian
              </div>
              <div className="grid grid-cols-2 gap-3">
                <input
                  type="text"
                  placeholder="Expert / Custodian Name"
                  value={partBExpertName}
                  onChange={(e) => setPartBExpertName(e.target.value)}
                  className="bg-graphite-850 border border-graphite-700 rounded px-2.5 py-1 text-xs text-slate-200 focus:outline-none focus:border-cctv-amber"
                />
                <input
                  type="text"
                  placeholder="Expert Designation"
                  value={partBExpertDesignation}
                  onChange={(e) => setPartBExpertDesignation(e.target.value)}
                  className="bg-graphite-850 border border-graphite-700 rounded px-2.5 py-1 text-xs text-slate-200 focus:outline-none focus:border-cctv-amber"
                />
              </div>
              <input
                type="text"
                placeholder="Laboratory / Organization Name"
                value={partBExpertOrganization}
                onChange={(e) => setPartBExpertOrganization(e.target.value)}
                className="w-full bg-graphite-850 border border-graphite-700 rounded px-2.5 py-1 text-xs text-slate-200 focus:outline-none focus:border-cctv-amber"
              />
              <div>
                <label className="block text-[10px] text-slate-400 font-mono mb-0.5">Part B Execution Mode</label>
                <select
                  value={partBSigningMode}
                  onChange={(e: any) => setPartBSigningMode(e.target.value)}
                  className="w-full bg-graphite-850 border border-graphite-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-cctv-amber"
                >
                  <option value="IN_APP_DESIGNATED">In-App Designated Signatory Record</option>
                  <option value="EXTERNAL_PHYSICAL">External Physical Signature on Printed PDF</option>
                </select>
              </div>
            </div>
          </div>

          {/* Legal Notice */}
          <div className="p-3 bg-graphite-800 rounded border border-graphite-700 text-[11px] text-slate-400">
            <span className="font-semibold text-slate-300">Notice:</span> VigilOne generates a cryptographically hashed (SHA-256) and Ed25519-signed electronic evidence package along with pre-populated Part A and Part B certificate forms. Statutory certificates must be physically or digitally executed by the designated custodian and expert in accordance with prevailing judicial guidelines.
          </div>

          {/* Footer Buttons */}
          <div className="flex justify-end space-x-2 pt-2 border-t border-graphite-700">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-1.5 rounded text-xs font-medium text-slate-300 hover:bg-graphite-700 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex items-center space-x-1.5 px-4 py-1.5 rounded text-xs font-semibold bg-cctv-amber text-graphite-900 hover:bg-amber-400 transition disabled:opacity-50"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{loading ? 'Assembling Package...' : 'Generate Evidence Zip'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default EvidenceExportModal;
