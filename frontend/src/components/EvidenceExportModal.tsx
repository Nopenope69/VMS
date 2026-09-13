import React, { useState } from 'react';
import { Shield, FileCheck, Download, AlertCircle } from 'lucide-react';
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
    <div className="fixed inset-0 bg-black/85 flex items-center justify-center p-4 z-50 backdrop-blur-none font-mono">
      <div className="bg-[#0D1117] border border-[#30363D] rounded-none w-full max-w-2xl overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#21262D] bg-[#161B22]">
          <div className="flex items-center space-x-2.5">
            <Shield className="w-4 h-4 text-[#E3B341]" />
            <div>
              <h3 className="font-bold text-xs text-[#C9D1D9] uppercase tracking-wider">
                [ STATUTORY EVIDENCE EXPORT // BSA 2023 SEC. 63 ]
              </h3>
              <p className="text-[10px] text-[#8B949E]">TARGET_FEED: {cameraName} [{cameraId.slice(0, 8)}]</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-[#8B949E] hover:text-[#C9D1D9] text-xs px-2 py-1 border border-[#30363D] hover:bg-[#21262D] transition-colors"
          >
            [ ESC / X ]
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-3 max-h-[80vh] overflow-y-auto text-xs text-[#C9D1D9]">
          {error && (
            <div className="p-2.5 bg-[#080B10] border border-[#F85149] text-[#F85149] text-xs flex items-center space-x-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Time Window */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="bg-[#161B22] p-2.5 border border-[#21262D]">
              <label className="block text-[10px] uppercase text-[#8B949E] tracking-wider mb-1">
                START_INTERVAL (UTC / LOCAL):
              </label>
              <input
                type="datetime-local"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                required
                className="w-full bg-[#080B10] border border-[#30363D] px-2.5 py-1.5 text-xs text-[#C9D1D9] focus:outline-none focus:border-[#E3B341]"
              />
            </div>
            <div className="bg-[#161B22] p-2.5 border border-[#21262D]">
              <label className="block text-[10px] uppercase text-[#8B949E] tracking-wider mb-1">
                END_INTERVAL (UTC / LOCAL):
              </label>
              <input
                type="datetime-local"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                required
                className="w-full bg-[#080B10] border border-[#30363D] px-2.5 py-1.5 text-xs text-[#C9D1D9] focus:outline-none focus:border-[#E3B341]"
              />
            </div>
          </div>

          {/* Export Mode */}
          <div className="bg-[#161B22] p-2.5 border border-[#21262D]">
            <label className="block text-[10px] uppercase text-[#8B949E] tracking-wider mb-2">
              CONTAINER_BITSTREAM_MODE:
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <label
                className={`flex items-start space-x-2.5 p-2 border cursor-pointer transition-colors ${
                  exportMode === 'STREAM_COPY'
                    ? 'bg-[#080B10] border-[#E3B341] text-[#E3B341]'
                    : 'bg-[#080B10] border-[#21262D] text-[#8B949E] hover:border-[#30363D]'
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
                  <div className="text-[11px] font-bold">[ STREAM_COPY ] LOSSLESS</div>
                  <div className="text-[10px] text-[#8B949E] mt-0.5">
                    Preserves exact incoming fMP4 bitstream; keyframe aligned.
                  </div>
                </div>
              </label>

              <label
                className={`flex items-start space-x-2.5 p-2 border cursor-pointer transition-colors ${
                  exportMode === 'FRAME_ACCURATE'
                    ? 'bg-[#080B10] border-[#E3B341] text-[#E3B341]'
                    : 'bg-[#080B10] border-[#21262D] text-[#8B949E] hover:border-[#30363D]'
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
                  <div className="text-[11px] font-bold">[ FRAME_ACCURATE ] RE-ENCODE</div>
                  <div className="text-[10px] text-[#8B949E] mt-0.5">
                    Exact frame cut via libx264; updates SHA-256 Merkle root.
                  </div>
                </div>
              </label>
            </div>
          </div>

          {/* Statutory Signatories: Section 63 BSA */}
          <div className="border border-[#21262D] bg-[#161B22] p-3 space-y-3">
            <div className="flex items-center space-x-2 border-b border-[#21262D] pb-1.5">
              <FileCheck className="w-4 h-4 text-[#58A6FF]" />
              <h4 className="text-xs font-bold text-[#C9D1D9] uppercase tracking-wider">
                STATUTORY SIGNATORIES (SCHEDULE BHARATIYA SAKSHYA ADHINIYAM)
              </h4>
            </div>

            {/* Part A */}
            <div className="bg-[#080B10] p-2.5 border border-[#21262D] space-y-2">
              <div className="text-[10px] font-bold text-[#58A6FF] uppercase tracking-wider">
                PART A: PARTY IN-CHARGE / SYSTEM OPERATOR
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input
                  type="text"
                  placeholder="Custodian Full Name"
                  value={partAPartyName}
                  onChange={(e) => setPartAPartyName(e.target.value)}
                  className="bg-[#161B22] border border-[#30363D] px-2.5 py-1 text-xs text-[#C9D1D9] focus:outline-none focus:border-[#58A6FF]"
                />
                <input
                  type="text"
                  placeholder="Designation (e.g., Security Operations Head)"
                  value={partAPartyDesignation}
                  onChange={(e) => setPartAPartyDesignation(e.target.value)}
                  className="bg-[#161B22] border border-[#30363D] px-2.5 py-1 text-xs text-[#C9D1D9] focus:outline-none focus:border-[#58A6FF]"
                />
              </div>
            </div>

            {/* Part B */}
            <div className="bg-[#080B10] p-2.5 border border-[#21262D] space-y-2">
              <div className="text-[10px] font-bold text-[#E3B341] uppercase tracking-wider">
                PART B: TECHNICAL EXPERT / FORENSIC EXAMINER
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input
                  type="text"
                  placeholder="Forensic Expert Name"
                  value={partBExpertName}
                  onChange={(e) => setPartBExpertName(e.target.value)}
                  className="bg-[#161B22] border border-[#30363D] px-2.5 py-1 text-xs text-[#C9D1D9] focus:outline-none focus:border-[#E3B341]"
                />
                <input
                  type="text"
                  placeholder="Expert Designation"
                  value={partBExpertDesignation}
                  onChange={(e) => setPartBExpertDesignation(e.target.value)}
                  className="bg-[#161B22] border border-[#30363D] px-2.5 py-1 text-xs text-[#C9D1D9] focus:outline-none focus:border-[#E3B341]"
                />
              </div>
              <input
                type="text"
                placeholder="Laboratory / Institution Name"
                value={partBExpertOrganization}
                onChange={(e) => setPartBExpertOrganization(e.target.value)}
                className="w-full bg-[#161B22] border border-[#30363D] px-2.5 py-1 text-xs text-[#C9D1D9] focus:outline-none focus:border-[#E3B341]"
              />
              <div>
                <label className="block text-[10px] text-[#8B949E] uppercase mb-1">PART_B_EXECUTION_MODE:</label>
                <select
                  value={partBSigningMode}
                  onChange={(e: any) => setPartBSigningMode(e.target.value)}
                  className="w-full bg-[#161B22] border border-[#30363D] px-2 py-1 text-xs text-[#C9D1D9] focus:outline-none focus:border-[#E3B341]"
                >
                  <option value="IN_APP_DESIGNATED">IN-APP DESIGNATED SIGNATORY RECORD (ED25519 EMBEDDED)</option>
                  <option value="EXTERNAL_PHYSICAL">EXTERNAL PHYSICAL SIGNATURE ON PRINTED AFFIDAVIT</option>
                </select>
              </div>
            </div>
          </div>

          {/* Legal Notice */}
          <div className="p-2.5 bg-[#080B10] border border-[#30363D] text-[10px] text-[#8B949E] leading-relaxed">
            <span className="text-[#C9D1D9] font-bold">[ FORENSIC INTEGRITY DISCLOSURE ]</span> VigilOne VMS generates a byte-verified archive containing the raw fMP4 media stream, SHA-256 hash digests, Ed25519 appliance digital signature, and statutory Part A & Part B certificates pursuant to Section 63 of the Bharatiya Sakshya Adhiniyam, 2023.
          </div>

          {/* Footer Buttons */}
          <div className="flex justify-end space-x-2 pt-2 border-t border-[#21262D]">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-[#8B949E] hover:text-[#C9D1D9] hover:bg-[#161B22] border border-[#30363D] transition-colors"
            >
              [ CANCEL ]
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex items-center space-x-1.5 px-4 py-1.5 text-xs font-bold uppercase tracking-wider bg-[#E3B341] text-[#080B10] hover:bg-[#F2CC60] transition-colors disabled:opacity-50"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{loading ? '[ ASSEMBLING & SIGNING... ]' : '[ SEAL & GENERATE PACKAGE ]'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default EvidenceExportModal;
