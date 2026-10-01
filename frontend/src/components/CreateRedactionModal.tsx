import React, { useEffect, useState } from 'react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { Sparkles, AlertCircle } from 'lucide-react';
import api from '../services/api';

interface CreateRedactionModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Evidence exports as GET /evidence returns them; only those with a sealed manifest can be redacted. */
  evidenceList: Array<{ id: string; title?: string; camera?: { id: string; name: string } | null; manifest?: { id: string } | null }>;
  onCreated: (jobId: string) => void;
}

export const CreateRedactionModal: React.FC<CreateRedactionModalProps> = ({
  isOpen,
  onClose,
  evidenceList,
  onCreated,
}) => {
  // A redaction job is made from an evidence *manifest*, not from the export row that lists it.
  const sources = evidenceList.filter((e) => e.manifest?.id);
  const [sourceExportId, setSourceExportId] = useState(sources[0]?.id || '');
  // The modal is mounted before the evidence list loads: pick the first package once it arrives.
  useEffect(() => {
    if (!sources.some((e) => e.id === sourceExportId)) setSourceExportId(sources[0]?.id || '');
  }, [evidenceList]); // eslint-disable-line react-hooks/exhaustive-deps
  const [detectFace, setDetectFace] = useState(false);
  const [detectPlate, setDetectPlate] = useState(true);
  const [sampleFps, setSampleFps] = useState(4);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const source = sources.find((e) => e.id === sourceExportId);
    if (!source?.manifest?.id) {
      setError('Select a sealed evidence package.');
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
      // The backend's redaction modes name what is detected (FACE, LICENSE_PLATE); detectKinds adds the other.
      // Masking is always an opaque black box (maskPlanner.ts): there is no blur option.
      const res = await api.post('/privacy/jobs', {
        sourceManifestId: source.manifest.id,
        redactionMode: detectFace ? 'FACE' : 'LICENSE_PLATE',
        detectKinds,
        sampleFps,
        ...(source.camera?.id ? { cameraId: source.camera.id } : {}),
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
      description="Mask faces and license plates in a sealed evidence clip, producing a hashed derivative linked to the original."
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
            aria-label="Source evidence package"
            value={sourceExportId}
            onChange={(e) => setSourceExportId(e.target.value)}
            className="w-full bg-vms-panel border border-vms-border rounded px-3 py-2 text-xs text-vms-text font-mono focus:border-vms-accent focus:outline-none"
            required
          >
            {sources.length === 0 ? (
              <option value="" disabled>No sealed evidence packages found</option>
            ) : (
              sources.map((exp) => (
                <option key={exp.id} value={exp.id}>
                  EV_{exp.id.slice(0, 8).toUpperCase()} {exp.camera?.name ? `— ${exp.camera.name}` : ''} {exp.title ? `— ${exp.title}` : ''}
                </option>
              ))
            )}
          </select>
        </div>

        <div>
          <label className="block text-xs font-mono uppercase tracking-wider text-vms-muted mb-1.5">
            What to redact
          </label>
          <div className="space-y-2 bg-vms-panel p-3 rounded border border-vms-border">
            <label className="flex items-center gap-2 text-xs text-vms-text cursor-pointer">
              <input
                type="checkbox"
                checked={detectFace}
                onChange={(e) => setDetectFace(e.target.checked)}
                className="rounded border-vms-border text-vms-accent focus:ring-0 bg-vms-bg"
              />
              <span className="font-medium">Faces (needs face processing on in DPDP settings)</span>
            </label>
            <label className="flex items-center gap-2 text-xs text-vms-text cursor-pointer">
              <input
                type="checkbox"
                checked={detectPlate}
                onChange={(e) => setDetectPlate(e.target.checked)}
                className="rounded border-vms-border text-vms-accent focus:ring-0 bg-vms-bg"
              />
              <span className="font-medium">License plates</span>
            </label>
          </div>
        </div>

        <div>
          <label className="block text-xs font-mono uppercase tracking-wider text-vms-muted mb-1.5">
            Detection sample rate (frames per second)
          </label>
          <input
            type="number"
            min={0.5}
            max={10}
            step={0.5}
            value={sampleFps}
            aria-label="Detection sample rate"
            onChange={(e) => setSampleFps(parseFloat(e.target.value) || 4)}
            className="w-full bg-vms-panel border border-vms-border rounded px-3 py-2 text-xs text-vms-text font-mono focus:border-vms-accent focus:outline-none"
          />
          <span className="text-[10px] text-vms-dim block mt-1">
            0.5 to 10, default 4. A higher rate finds more regions and takes longer.
          </span>
        </div>

        <p className="text-[11px] text-vms-dim">
          Every detected region is covered with an opaque black box. The job is queued; start it from the jobs table.
        </p>

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
