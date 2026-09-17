import React, { useState, useEffect } from 'react';
import {
  Compass,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ZoomIn,
  ZoomOut,
  Square,
  Play,
  Bookmark,
  Trash2,
  ShieldAlert,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react';
import api from '../services/api';
import Modal from './ui/Modal';
import Button from './ui/Button';
import Input from './ui/Input';

interface Preset {
  id: string;
  name: string;
  presetToken: string;
}

interface Tour {
  id: string;
  name: string;
  state: 'STOPPED' | 'RUNNING' | 'PAUSED' | 'MANUAL_OVERRIDE';
  stepsJson: Array<{ presetToken: string; presetName?: string; dwellSeconds: number }>;
}

interface PtzControlModalProps {
  camera: { id: string; name: string; hasPtz: boolean };
  onClose: () => void;
}

export const PtzControlModal: React.FC<PtzControlModalProps> = ({ camera, onClose }) => {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [tours, setTours] = useState<Tour[]>([]);
  const [newPresetName, setNewPresetName] = useState('');
  const [tourName, setTourName] = useState('');
  const [tourSteps, setTourSteps] = useState<Array<{ presetToken: string; presetName?: string; dwellSeconds: number }>>([]);
  const [dwellTime, setDwellTime] = useState(10);
  const [selectedPresetForTour, setSelectedPresetForTour] = useState('');
  const [savingPreset, setSavingPreset] = useState(false);
  const [activeTab, setActiveTab] = useState<'CONTROLS' | 'PRESETS' | 'TOURS'>('CONTROLS');
  const [arbiterNotice, setArbiterNotice] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<{ type: 'error' | 'success'; text: string } | null>(null);
  const [presetToDelete, setPresetToDelete] = useState<string | null>(null);

  const fetchData = async () => {
    try {
      const [resPresets, resTours] = await Promise.all([
        api.get(`/cameras/${camera.id}/ptz/presets`),
        api.get(`/cameras/${camera.id}/ptz/tours`),
      ]);
      setPresets(resPresets.data.presets || []);
      setTours(resTours.data.tours || []);
      if (resPresets.data.presets?.length > 0 && !selectedPresetForTour) {
        setSelectedPresetForTour(resPresets.data.presets[0].presetToken);
      }
    } catch (err: any) {
      console.error('Failed to load PTZ data:', err);
    }
  };

  useEffect(() => {
    fetchData();
  }, [camera.id]);

  const handlePtz = async (action: 'move' | 'stop', x = 0, y = 0, zoom = 0) => {
    try {
      setArbiterNotice(null);
      await api.post(`/cameras/${camera.id}/ptz`, { action, x, y, zoom });
    } catch (err: any) {
      if (err.response?.status === 409) {
        setArbiterNotice('Camera is locked by another operator lease.');
      } else {
        console.error('PTZ call failed:', err);
      }
    }
  };

  const handleSavePreset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPresetName.trim()) return;
    setSavingPreset(true);
    setStatusNotice(null);
    try {
      await api.post(`/cameras/${camera.id}/ptz/presets`, { name: newPresetName });
      setNewPresetName('');
      setStatusNotice({ type: 'success', text: `Preset '${newPresetName}' saved successfully.` });
      fetchData();
    } catch (err: any) {
      setStatusNotice({ type: 'error', text: `Failed to save preset: ${err.response?.data?.error || err.message}` });
    } finally {
      setSavingPreset(false);
    }
  };

  const handleGotoPreset = async (presetId: string) => {
    try {
      setArbiterNotice(null);
      setStatusNotice(null);
      await api.post(`/cameras/${camera.id}/ptz/presets/${presetId}/goto`);
    } catch (err: any) {
      if (err.response?.status === 409) {
        setArbiterNotice('Camera is locked by another operator.');
      } else {
        setStatusNotice({ type: 'error', text: `Goto failed: ${err.message}` });
      }
    }
  };

  const handleDeletePreset = async (presetId: string) => {
    try {
      setStatusNotice(null);
      await api.delete(`/cameras/${camera.id}/ptz/presets/${presetId}`);
      setPresetToDelete(null);
      setStatusNotice({ type: 'success', text: 'Preset deleted.' });
      fetchData();
    } catch (err: any) {
      setStatusNotice({ type: 'error', text: `Delete error: ${err.message}` });
    }
  };

  const handleAddTourStep = () => {
    if (!selectedPresetForTour) return;
    const p = presets.find((pr) => pr.presetToken === selectedPresetForTour);
    setTourSteps((prev) => [
      ...prev,
      { presetToken: selectedPresetForTour, presetName: p?.name, dwellSeconds: dwellTime },
    ]);
  };

  const handleCreateTour = async () => {
    if (!tourName.trim() || tourSteps.length === 0) {
      setStatusNotice({ type: 'error', text: 'Please provide tour name and at least 1 preset step' });
      return;
    }
    try {
      setStatusNotice(null);
      await api.post(`/cameras/${camera.id}/ptz/tours`, {
        name: tourName,
        steps: tourSteps,
      });
      setTourName('');
      setTourSteps([]);
      setStatusNotice({ type: 'success', text: `Patrol tour '${tourName}' created.` });
      fetchData();
    } catch (err: any) {
      setStatusNotice({ type: 'error', text: `Failed to create tour: ${err.message}` });
    }
  };

  const handleStartTour = async (tourId: string) => {
    try {
      setStatusNotice(null);
      await api.post(`/cameras/${camera.id}/ptz/tours/${tourId}/start`);
      fetchData();
    } catch (err: any) {
      setStatusNotice({ type: 'error', text: `Start tour error: ${err.message}` });
    }
  };

  const handleStopTour = async (tourId: string) => {
    try {
      setStatusNotice(null);
      await api.post(`/cameras/${camera.id}/ptz/tours/${tourId}/stop`);
      fetchData();
    } catch (err: any) {
      setStatusNotice({ type: 'error', text: `Stop tour error: ${err.message}` });
    }
  };

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={`PTZ Arbiter & Guard Tours — ${camera.name}`}
      subtitle="Proportional mechanical positioning, guard sweeps, and operator arbitration"
      icon={<Compass className="w-4 h-4 text-vms-accent" />}
      size="2xl"
      footer={
        <Button variant="secondary" size="sm" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="space-y-4">
        {/* Arbiter Lock Notice */}
        {arbiterNotice && (
          <div className="px-3.5 py-2 bg-rose-950/70 border border-rose-800 rounded text-xs font-mono text-rose-300 flex items-center space-x-2">
            <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{arbiterNotice}</span>
          </div>
        )}

        {/* Status Notice */}
        {statusNotice && (
          <div
            className={`px-3.5 py-2 rounded text-xs font-mono flex items-center justify-between ${
              statusNotice.type === 'error'
                ? 'bg-rose-950/70 border border-rose-800 text-rose-300'
                : 'bg-emerald-950/70 border border-emerald-800 text-emerald-300'
            }`}
          >
            <div className="flex items-center space-x-2">
              {statusNotice.type === 'error' ? (
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
              ) : (
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              )}
              <span>{statusNotice.text}</span>
            </div>
            <button
              type="button"
              onClick={() => setStatusNotice(null)}
              className="text-vms-muted hover:text-vms-text ml-2"
            >
              ×
            </button>
          </div>
        )}

        {/* Tab Selector */}
        <div className="flex border-b border-vms-border bg-vms-panel px-2 pt-1.5 rounded-t">
          <button
            type="button"
            onClick={() => setActiveTab('CONTROLS')}
            className={`px-3.5 py-1.5 text-xs font-mono font-medium border-b-2 transition-colors ${
              activeTab === 'CONTROLS'
                ? 'border-vms-accent text-vms-accent font-bold'
                : 'border-transparent text-vms-muted hover:text-vms-text'
            }`}
          >
            Virtual Joystick
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('PRESETS')}
            className={`px-3.5 py-1.5 text-xs font-mono font-medium border-b-2 transition-colors ${
              activeTab === 'PRESETS'
                ? 'border-vms-accent text-vms-accent font-bold'
                : 'border-transparent text-vms-muted hover:text-vms-text'
            }`}
          >
            Presets ({presets.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('TOURS')}
            className={`px-3.5 py-1.5 text-xs font-mono font-medium border-b-2 transition-colors ${
              activeTab === 'TOURS'
                ? 'border-vms-accent text-vms-accent font-bold'
                : 'border-transparent text-vms-muted hover:text-vms-text'
            }`}
          >
            Guard Tours ({tours.length})
          </button>
        </div>

        {/* Tab 1: Virtual Joystick & Direct D-Pad */}
        {activeTab === 'CONTROLS' && (
          <div className="p-6 flex flex-col items-center justify-center space-y-5 bg-vms-panel/50 rounded border border-vms-border">
            <div className="text-[11px] font-mono text-vms-muted text-center max-w-sm">
              Press and hold directional buttons to move camera optics. Manual movement preempts active patrol sweeps.
            </div>

            {/* D-Pad */}
            <div className="grid grid-cols-3 gap-2 w-48 h-48">
              <div />
              <button
                type="button"
                onMouseDown={() => handlePtz('move', 0, 1)}
                onMouseUp={() => handlePtz('stop')}
                title="Pan/Tilt Up"
                className="bg-vms-surface hover:bg-vms-accent hover:text-vms-text border border-vms-border rounded flex items-center justify-center text-vms-text active:scale-95 transition-all shadow"
              >
                <ArrowUp className="w-6 h-6" />
              </button>
              <div />

              <button
                type="button"
                onMouseDown={() => handlePtz('move', -1, 0)}
                onMouseUp={() => handlePtz('stop')}
                title="Pan Left"
                className="bg-vms-surface hover:bg-vms-accent hover:text-vms-text border border-vms-border rounded flex items-center justify-center text-vms-text active:scale-95 transition-all shadow"
              >
                <ArrowLeft className="w-6 h-6" />
              </button>
              <button
                type="button"
                onClick={() => handlePtz('stop')}
                title="Emergency Halt"
                className="bg-vms-panel hover:bg-rose-600 hover:text-white border border-vms-border rounded flex items-center justify-center text-vms-muted active:scale-95 transition-all"
              >
                <Square className="w-5 h-5" />
              </button>
              <button
                type="button"
                onMouseDown={() => handlePtz('move', 1, 0)}
                onMouseUp={() => handlePtz('stop')}
                title="Pan Right"
                className="bg-vms-surface hover:bg-vms-accent hover:text-vms-text border border-vms-border rounded flex items-center justify-center text-vms-text active:scale-95 transition-all shadow"
              >
                <ArrowRight className="w-6 h-6" />
              </button>

              <div />
              <button
                type="button"
                onMouseDown={() => handlePtz('move', 0, -1)}
                onMouseUp={() => handlePtz('stop')}
                title="Pan/Tilt Down"
                className="bg-vms-surface hover:bg-vms-accent hover:text-vms-text border border-vms-border rounded flex items-center justify-center text-vms-text active:scale-95 transition-all shadow"
              >
                <ArrowDown className="w-6 h-6" />
              </button>
              <div />
            </div>

            {/* Zoom Controls */}
            <div className="flex space-x-3">
              <button
                type="button"
                onMouseDown={() => handlePtz('move', 0, 0, 1)}
                onMouseUp={() => handlePtz('stop')}
                className="flex items-center space-x-1.5 px-4 py-2 rounded bg-vms-surface hover:bg-vms-accent hover:text-vms-text border border-vms-border text-vms-text font-mono text-xs transition-colors"
              >
                <ZoomIn className="w-4 h-4" />
                <span>Zoom In</span>
              </button>
              <button
                type="button"
                onMouseDown={() => handlePtz('move', 0, 0, -1)}
                onMouseUp={() => handlePtz('stop')}
                className="flex items-center space-x-1.5 px-4 py-2 rounded bg-vms-surface hover:bg-vms-accent hover:text-vms-text border border-vms-border text-vms-text font-mono text-xs transition-colors"
              >
                <ZoomOut className="w-4 h-4" />
                <span>Zoom Out</span>
              </button>
            </div>
          </div>
        )}

        {/* Tab 2: Presets */}
        {activeTab === 'PRESETS' && (
          <div className="space-y-4">
            {/* Save Current Position */}
            <form onSubmit={handleSavePreset} className="flex space-x-2 bg-vms-panel p-3 rounded border border-vms-border">
              <Input
                placeholder="e.g. North Gate Gatehouse"
                value={newPresetName}
                onChange={(e) => setNewPresetName(e.target.value)}
                className="flex-1"
              />
              <Button
                type="submit"
                variant="primary"
                size="sm"
                icon={Bookmark}
                isLoading={savingPreset}
                disabled={!newPresetName.trim()}
              >
                Save Current Position
              </Button>
            </form>

            {/* Presets List */}
            <div className="space-y-2">
              <div className="text-[11px] font-mono text-vms-muted uppercase tracking-wider">
                Saved Positions ({presets.length})
              </div>

              {presets.length === 0 ? (
                <div className="text-center p-6 border border-dashed border-vms-border rounded text-vms-dim text-xs font-mono">
                  No presets configured yet. Aim camera using joystick and save position above.
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {presets.map((p) => (
                    <div
                      key={p.id}
                      className="p-2.5 bg-vms-surface rounded border border-vms-border flex items-center justify-between"
                    >
                      <div>
                        <div className="text-xs font-semibold text-vms-text font-mono">{p.name}</div>
                        <div className="text-[10px] font-mono text-vms-dim">{p.presetToken}</div>
                      </div>

                      <div className="flex items-center space-x-1">
                        <Button
                          type="button"
                          variant="secondary"
                          size="xs"
                          onClick={() => handleGotoPreset(p.id)}
                        >
                          Goto
                        </Button>
                        {presetToDelete === p.id ? (
                          <div className="flex items-center space-x-1">
                            <button
                              type="button"
                              onClick={() => handleDeletePreset(p.id)}
                              className="px-1.5 py-0.5 rounded bg-rose-600 text-white text-[10px] font-mono"
                            >
                              Confirm
                            </button>
                            <button
                              type="button"
                              onClick={() => setPresetToDelete(null)}
                              className="px-1 py-0.5 text-vms-muted text-[10px]"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setPresetToDelete(p.id)}
                            title="Delete Preset"
                            className="p-1 text-vms-dim hover:text-rose-400 transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tab 3: Guard Tours */}
        {activeTab === 'TOURS' && (
          <div className="space-y-4">
            {/* New Tour Builder */}
            <div className="p-3 bg-vms-panel rounded border border-vms-border space-y-3">
              <h4 className="text-xs font-semibold text-vms-text uppercase tracking-wider font-mono">
                Create Automated Patrol Tour
              </h4>

              <div>
                <label className="block text-[11px] font-mono text-vms-muted mb-1 uppercase tracking-wider">
                  Tour Name
                </label>
                <Input
                  placeholder="e.g. 24/7 Perimeter Patrol"
                  value={tourName}
                  onChange={(e) => setTourName(e.target.value)}
                  className="w-full"
                />
              </div>

              <div className="grid grid-cols-3 gap-2 items-end">
                <div className="col-span-2">
                  <label className="block text-[11px] font-mono text-vms-muted mb-1 uppercase tracking-wider">
                    Select Preset
                  </label>
                  <select
                    value={selectedPresetForTour}
                    onChange={(e) => setSelectedPresetForTour(e.target.value)}
                    className="w-full bg-vms-surface border border-vms-border rounded px-2.5 py-1 text-xs text-vms-text font-mono focus:outline-none focus:border-vms-accent"
                  >
                    {presets.map((p) => (
                      <option key={p.id} value={p.presetToken}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-mono text-vms-muted mb-1 uppercase tracking-wider">
                    Dwell: {dwellTime}s
                  </label>
                  <input
                    type="range"
                    min={5}
                    max={60}
                    value={dwellTime}
                    onChange={(e) => setDwellTime(Number(e.target.value))}
                    className="w-full accent-[#C05800]"
                  />
                </div>
              </div>

              <Button
                type="button"
                variant="secondary"
                size="xs"
                onClick={handleAddTourStep}
                disabled={presets.length === 0}
              >
                + Add Preset to Sequence ({tourSteps.length} steps)
              </Button>

              {tourSteps.length > 0 && (
                <div className="p-2 bg-vms-surface rounded border border-vms-border text-xs font-mono text-vms-text space-y-1">
                  <div className="text-[10px] text-vms-muted uppercase tracking-wider">Sequence:</div>
                  <div className="flex flex-wrap gap-1">
                    {tourSteps.map((s, idx) => (
                      <span key={idx} className="px-2 py-0.5 bg-vms-panel rounded border border-vms-border text-[11px]">
                        {idx + 1}. {s.presetName || s.presetToken} ({s.dwellSeconds}s)
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex justify-end pt-1">
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={handleCreateTour}
                  disabled={!tourName || tourSteps.length === 0}
                >
                  Save Guard Tour
                </Button>
              </div>
            </div>

            {/* Tours List */}
            <div className="space-y-2">
              <div className="text-[11px] font-mono text-vms-muted uppercase tracking-wider">
                Configured Patrol Tours ({tours.length})
              </div>

              {tours.length === 0 ? (
                <div className="text-center p-4 border border-dashed border-vms-border rounded text-vms-dim text-xs font-mono">
                  No guard patrol tours defined. Create tour sequence above.
                </div>
              ) : (
                tours.map((t) => (
                  <div
                    key={t.id}
                    className="p-3 bg-vms-surface rounded border border-vms-border flex items-center justify-between"
                  >
                    <div>
                      <div className="flex items-center space-x-2">
                        <span className="text-xs font-semibold text-vms-text font-mono">{t.name}</span>
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-bold ${
                            t.state === 'RUNNING'
                              ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-800'
                              : 'bg-vms-panel text-vms-dim'
                          }`}
                        >
                          {t.state}
                        </span>
                      </div>
                      <div className="text-[10px] font-mono text-vms-dim mt-0.5">
                        {t.stepsJson.length} presets in loop
                      </div>
                    </div>

                    <div className="flex items-center space-x-1.5">
                      {t.state === 'RUNNING' ? (
                        <Button
                          type="button"
                          variant="danger"
                          size="xs"
                          icon={Square}
                          onClick={() => handleStopTour(t.id)}
                        >
                          Stop
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          variant="primary"
                          size="xs"
                          icon={Play}
                          onClick={() => handleStartTour(t.id)}
                        >
                          Start Patrol
                        </Button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
};

export default PtzControlModal;
