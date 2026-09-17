import React, { useState } from 'react';
import { LayoutGrid, Save, Lock, Users } from 'lucide-react';
import api from '../services/api';
import Modal from './ui/Modal';
import Button from './ui/Button';
import Input from './ui/Input';

interface SaveLayoutModalProps {
  currentGridType: string;
  cameraSlots: Array<{ slotIndex: number; cameraId: string | null }>;
  onClose: () => void;
  onSaved: () => void;
}

export const SaveLayoutModal: React.FC<SaveLayoutModalProps> = ({
  currentGridType,
  cameraSlots,
  onClose,
  onSaved,
}) => {
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<'PRIVATE' | 'TENANT_SHARED'>('PRIVATE');
  const [isDefault, setIsDefault] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const mapGridTypeToPrisma = (type: string) => {
    switch (type) {
      case '1x1':
        return 'GRID_1X1';
      case '2x2':
        return 'GRID_2X2';
      case '3x3':
        return 'GRID_3X3';
      case '1+5':
        return 'GRID_1_PLUS_5';
      case '4x4':
        return 'GRID_4X4';
      default:
        return 'GRID_2X2';
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError('');

    try {
      await api.post('/layouts', {
        name,
        gridType: mapGridTypeToPrisma(currentGridType),
        visibility,
        slotsJson: cameraSlots,
        isDefault,
      });

      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to save layout');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title="Save Current Layout View"
      icon={<LayoutGrid className="w-4 h-4 text-vms-accent" />}
      size="md"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={Save}
            onClick={handleSave}
            isLoading={saving}
            disabled={!name.trim()}
          >
            Save Layout
          </Button>
        </>
      }
    >
      <form onSubmit={handleSave} className="space-y-4">
        {error && (
          <div className="p-2.5 bg-rose-950/60 border border-rose-800/80 rounded text-xs text-rose-300 font-mono">
            {error}
          </div>
        )}

        <div>
          <label className="block text-xs font-mono text-vms-muted mb-1 uppercase tracking-wider">
            Layout Name
          </label>
          <Input
            required
            placeholder="e.g. Warehouse Quad Patrol"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full"
            autoFocus
          />
        </div>

        <div className="p-3 bg-vms-panel rounded border border-vms-border text-xs font-mono text-vms-muted">
          Grid Type:{' '}
          <span className="text-vms-accent font-semibold uppercase">{currentGridType}</span> •{' '}
          {cameraSlots.length} camera assignments captured
        </div>

        <div>
          <label className="block text-xs font-mono text-vms-muted mb-1.5 uppercase tracking-wider">
            Visibility Boundary
          </label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setVisibility('PRIVATE')}
              className={`flex items-center space-x-2 p-2.5 rounded border text-left font-mono text-xs transition-colors ${
                visibility === 'PRIVATE'
                  ? 'bg-vms-accent/20 border-vms-accent text-vms-text font-bold'
                  : 'bg-vms-panel border-vms-border text-vms-muted hover:bg-vms-hover'
              }`}
            >
              <Lock className="w-3.5 h-3.5 text-vms-accent shrink-0" />
              <span>Private (You Only)</span>
            </button>

            <button
              type="button"
              onClick={() => setVisibility('TENANT_SHARED')}
              className={`flex items-center space-x-2 p-2.5 rounded border text-left font-mono text-xs transition-colors ${
                visibility === 'TENANT_SHARED'
                  ? 'bg-sky-500/20 border-sky-400 text-vms-text font-bold'
                  : 'bg-vms-panel border-vms-border text-vms-muted hover:bg-vms-hover'
              }`}
            >
              <Users className="w-3.5 h-3.5 text-sky-400 shrink-0" />
              <span>Shared with Facility</span>
            </button>
          </div>
        </div>

        <label className="flex items-center space-x-2 cursor-pointer pt-1 select-none">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
            className="accent-[#C05800] rounded"
          />
          <span className="text-xs font-mono text-vms-muted">
            Set as default layout for my session
          </span>
        </label>
      </form>
    </Modal>
  );
};

export default SaveLayoutModal;
