import React, { useState } from 'react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { Sparkles, AlertCircle } from 'lucide-react';
import api from '../services/api';

interface CreateRedactionModalProps {
  isOpen: boolean;
  onClose: () => void;
  evidenceList: Array<{ id: string; title?: string; sha256Hash?: string }>;
  onCreated: (jobId: string) => void;
}

export const CreateRedactionModal: React.FC<CreateRedactionModalProps> = ({
  isOpen,
  onClose,
  evidenceList,
  onCreated,
}) => {
  const [sourceManifestId, setSourceManifestId] = useState(evidenceList[0]?.id || '');
  const [redactionMode, setRedactionMode] = useState<'BLUR' | 'SOLID_BLACK'>('BLUR');
  const [detectFace, setDetectFace] = useState(true);
  const [detectPlate, setDetectPlate] = useState(true);
  const [sampleFps, setSampleFps] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sourceManifestId) {
      setError('Please select a source evidence manifest.');
      return;
    }

    const detectKinds: Array<'FACE' | 'LICENSE_PLATE'> = [];
    if (detectFace) detectKinds.push('FACE');
    if (detectPlate) detectKinds.push('LICENSE_PLATE');

    if (detectKinds.length === 0) {
      setError('Select at least one detection target (Faces or License Plates).');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await api.post('/privacy/jobs', {
        sourceManifestId,
        redactionMode,
        detectKinds,
        sampleFps,
      });
      onCreated(res.data.id);
      onClose();
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to create redaction job');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Create Privacy Redaction Job"
      description="Apply AI-guided neural face and license plate masking to generate a Section 63 BSA derivative package."
      size="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="p-3 bg-red-950/40 border border-red-500/50 rounded flex items-center gap-2 text-xs text-red-200">
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div>
          <label className="block text-xs font-mono uppercase tracking-wider text-vms-muted mb-1.5">
            Source Evidence Manifest
          </label>
          <select
            value={sourceManifestId}
            onChange={(e) => setSourceManifestId(e.target.value)}
            className="w-full bg-vms-panel border border-vms-border rounded px-3 py-2 text-xs text-vms-text font-mono focus:border-vms-accent focus:outline-none"
            required
          >
            {evidenceList.length === 0 ? (
              <option value="" disabled>No sealed evidence packages found</option>
            ) : (
              evidenceList.map((exp) => (
                <option key={exp.id} value={exp.id}>
                  EV_{exp.id.slice(0, 8).toUpperCase()} {exp.title ? `— ${exp.title}` : ''}
                </option>
              ))
            )}
          </select>
        </div>

        <div>
          <label className="block text-xs font-mono uppercase tracking-wider text-vms-muted mb-1.5">
            Redaction Mode
          </label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setRedactionMode('BLUR')}
              className={`px-3 py-2 text-xs rounded border text-left font-mono transition-colors ${
                redactionMode === 'BLUR'
                  ? 'border-vms-accent bg-vms-accent/20 text-vms-text font-bold'
                  : 'border-vms-border bg-vms-panel text-vms-muted hover:text-vms-text'
              }`}
            >
              <div className="font-semibold">GaussianBlur</div>
              <div className="text-[10px] text-vms-dim mt-0.5">Natural visual blurring</div>
            </button>
            <button
              type="button"
              onClick={() => setRedactionMode('SOLID_BLACK')}
              className={`px-3 py-2 text-xs rounded border text-left font-mono transition-colors ${
                redactionMode === 'SOLID_BLACK'
                  ? 'border-vms-accent bg-vms-accent/20 text-vms-text font-bold'
                  : 'border-vms-border bg-vms-panel text-vms-muted hover:text-vms-text'
              }`}
            >
              <div className="font-semibold">Solid Black</div>
              <div className="text-[10px] text-vms-dim mt-0.5">Opaque blackout box</div>
            </button>
          </div>
        </div>

        <div>
          <label className="block text-xs font-mono uppercase tracking-wider text-vms-muted mb-1.5">
            Target Detect Kinds
          </label>
          <div className="space-y-2 bg-vms-panel p-3 rounded border border-vms-border">
            <label className="flex items-center gap-2 text-xs text-vms-text cursor-pointer">
              <input
                type="checkbox"
                checked={detectFace}
                onChange={(e) => setDetectFace(e.target.checked)}
                className="rounded border-vms-border text-vms-accent focus:ring-0 bg-vms-bg"
              />
              <span className="font-medium">Human Faces (YuNet Detector)</span>
            </label>
            <label className="flex items-center gap-2 text-xs text-vms-text cursor-pointer">
              <input
                type="checkbox"
                checked={detectPlate}
                onChange={(e) => setDetectPlate(e.target.checked)}
                className="rounded border-vms-border text-vms-accent focus:ring-0 bg-vms-bg"
              />
              <span className="font-medium">License Plates (PP-OCRv4 Text DB)</span>
            </label>
          </div>
        </div>

        <div>
          <label className="block text-xs font-mono uppercase tracking-wider text-vms-muted mb-1.5">
            Detection Sample Rate (FPS)
          </label>
          <input
            type="number"
            min={0.5}
            max={5}
            step={0.5}
            value={sampleFps}
            onChange={(e) => setSampleFps(parseFloat(e.target.value) || 1)}
            className="w-full bg-vms-panel border border-vms-border rounded px-3 py-2 text-xs text-vms-text font-mono focus:border-vms-accent focus:outline-none"
          />
          <span className="text-[10px] text-vms-dim block mt-1">
            Recommended: 1 FPS for balanced speed and accuracy across standard CCTV clips.
          </span>
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t border-vms-border">
          <Button variant="secondary" type="button" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            isLoading={loading}
            icon={<Sparkles className="w-3.5 h-3.5" />}
          >
            Enqueue Redaction Job
          </Button>
        </div>
      </form>
    </Modal>
  );
};
export default CreateRedactionModal;
