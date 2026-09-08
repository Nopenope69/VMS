import React, { useState } from 'react';
import { LayoutGrid, Save, X, Lock, Users } from 'lucide-react';
import api from '../services/api';

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
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50 backdrop-blur-sm select-none">
      <div className="bg-graphite-850 border border-graphite-700 rounded-md w-full max-w-md overflow-hidden shadow-2xl">
        <div className="px-5 py-3.5 border-b border-graphite-700 flex justify-between items-center bg-graphite-800">
          <div className="flex items-center space-x-2">
            <LayoutGrid className="w-4 h-4 text-cctv-amber" />
            <h3 className="text-sm font-semibold text-slate-100 uppercase tracking-wider">
              Save Current Layout View
            </h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSave} className="p-5 space-y-4 bg-graphite-900">
          {error && (
            <div className="p-2.5 bg-red-950 border border-red-800 rounded text-xs text-red-300 font-mono">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-mono text-slate-300 mb-1">Layout Name</label>
            <input
              type="text"
              required
              placeholder="e.g. Warehouse Quad Patrol"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-graphite-850 border border-graphite-700 rounded px-3 py-1.5 text-xs text-slate-200 font-mono focus:outline-none focus:border-cctv-amber"
            />
          </div>

          <div className="p-3 bg-graphite-850 rounded border border-graphite-700 text-xs font-mono text-slate-400">
            Grid Type: <span className="text-cctv-amber font-semibold uppercase">{currentGridType}</span> • {cameraSlots.length} camera assignments captured
          </div>

          <div>
            <label className="block text-xs font-mono text-slate-300 mb-1.5">Visibility Boundary</label>
            <div className="grid grid-cols-2 gap-2">
              <label
                className={`flex items-center space-x-2 p-2.5 rounded border cursor-pointer font-mono text-xs transition ${
                  visibility === 'PRIVATE'
                    ? 'bg-cctv-amber/20 border-cctv-amber text-white'
                    : 'bg-graphite-850 border-graphite-700 text-slate-400'
                }`}
              >
                <input
                  type="radio"
                  name="visibility"
                  value="PRIVATE"
                  checked={visibility === 'PRIVATE'}
                  onChange={() => setVisibility('PRIVATE')}
                  className="hidden"
                />
                <Lock className="w-3.5 h-3.5" />
                <span>Private (You Only)</span>
              </label>

              <label
                className={`flex items-center space-x-2 p-2.5 rounded border cursor-pointer font-mono text-xs transition ${
                  visibility === 'TENANT_SHARED'
                    ? 'bg-cctv-teal/20 border-cctv-teal text-white'
                    : 'bg-graphite-850 border-graphite-700 text-slate-400'
                }`}
              >
                <input
                  type="radio"
                  name="visibility"
                  value="TENANT_SHARED"
                  checked={visibility === 'TENANT_SHARED'}
                  onChange={() => setVisibility('TENANT_SHARED')}
                  className="hidden"
                />
                <Users className="w-3.5 h-3.5" />
                <span>Shared with Facility</span>
              </label>
            </div>
          </div>

          <label className="flex items-center space-x-2 cursor-pointer pt-1">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="accent-cctv-amber rounded"
            />
            <span className="text-xs font-mono text-slate-300">Set as default layout for my session</span>
          </label>

          <div className="flex justify-end space-x-2 pt-3 border-t border-graphite-700">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-1.5 rounded text-xs text-slate-300 hover:bg-graphite-800 font-mono"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !name.trim()}
              className="flex items-center space-x-1.5 px-4 py-1.5 rounded text-xs font-semibold bg-cctv-amber text-graphite-900 hover:bg-amber-400 disabled:opacity-50 font-mono shadow"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{saving ? 'Saving...' : 'Save Layout'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default SaveLayoutModal;
