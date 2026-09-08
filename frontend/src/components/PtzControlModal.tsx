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
  X,
  ShieldAlert,
} from 'lucide-react';
import api from '../services/api';

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
    } catch (err) {
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
    try {
      await api.post(`/cameras/${camera.id}/ptz/presets`, { name: newPresetName });
      setNewPresetName('');
      fetchData();
    } catch (err: any) {
      alert(`Failed to save preset: ${err.response?.data?.error || err.message}`);
    } finally {
      setSavingPreset(false);
    }
  };

  const handleGotoPreset = async (presetId: string) => {
    try {
      setArbiterNotice(null);
      await api.post(`/cameras/${camera.id}/ptz/presets/${presetId}/goto`);
    } catch (err: any) {
      if (err.response?.status === 409) {
        setArbiterNotice('Camera is locked by another operator.');
      } else {
        alert(`Goto failed: ${err.message}`);
      }
    }
  };

  const handleDeletePreset = async (presetId: string) => {
    if (!confirm('Delete preset?')) return;
    try {
      await api.delete(`/cameras/${camera.id}/ptz/presets/${presetId}`);
      fetchData();
    } catch (err: any) {
      alert(`Delete error: ${err.message}`);
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
      alert('Please provide tour name and at least 1 preset step');
      return;
    }
    try {
      await api.post(`/cameras/${camera.id}/ptz/tours`, {
        name: tourName,
        steps: tourSteps,
      });
      setTourName('');
      setTourSteps([]);
      fetchData();
    } catch (err: any) {
      alert(`Failed to create tour: ${err.message}`);
    }
  };

  const handleStartTour = async (tourId: string) => {
    try {
      await api.post(`/cameras/${camera.id}/ptz/tours/${tourId}/start`);
      fetchData();
    } catch (err: any) {
      alert(`Start tour error: ${err.message}`);
    }
  };

  const handleStopTour = async (tourId: string) => {
    try {
      await api.post(`/cameras/${camera.id}/ptz/tours/${tourId}/stop`);
      fetchData();
    } catch (err: any) {
      alert(`Stop tour error: ${err.message}`);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50 backdrop-blur-sm select-none">
      <div className="bg-graphite-850 border border-graphite-700 rounded-md w-full max-w-2xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-graphite-700 flex justify-between items-center bg-graphite-800">
          <div className="flex items-center space-x-2">
            <Compass className="w-4 h-4 text-cctv-amber" />
            <h3 className="text-sm font-semibold text-slate-100 uppercase tracking-wider">
              PTZ Arbiter & Guard Tours — {camera.name}
            </h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Arbiter Lock Notice */}
        {arbiterNotice && (
          <div className="px-4 py-2 bg-red-950/80 border-b border-red-800 text-xs font-mono text-red-300 flex items-center space-x-2">
            <ShieldAlert className="w-4 h-4 text-red-400" />
            <span>{arbiterNotice}</span>
          </div>
        )}

        {/* Tab Selector */}
        <div className="flex border-b border-graphite-700 bg-graphite-900 px-4 pt-2">
          <button
            onClick={() => setActiveTab('CONTROLS')}
            className={`px-4 py-2 text-xs font-mono font-medium border-b-2 transition ${
              activeTab === 'CONTROLS'
                ? 'border-cctv-amber text-cctv-amber font-bold'
                : 'border-transparent text-slate-400 hover:text-white'
            }`}
          >
            Virtual Joystick
          </button>
          <button
            onClick={() => setActiveTab('PRESETS')}
            className={`px-4 py-2 text-xs font-mono font-medium border-b-2 transition ${
              activeTab === 'PRESETS'
                ? 'border-cctv-amber text-cctv-amber font-bold'
                : 'border-transparent text-slate-400 hover:text-white'
            }`}
          >
            Presets ({presets.length})
          </button>
          <button
            onClick={() => setActiveTab('TOURS')}
            className={`px-4 py-2 text-xs font-mono font-medium border-b-2 transition ${
              activeTab === 'TOURS'
                ? 'border-cctv-amber text-cctv-amber font-bold'
                : 'border-transparent text-slate-400 hover:text-white'
            }`}
          >
            Guard Tours ({tours.length})
          </button>
        </div>

        {/* Tab 1: Virtual Joystick & Direct D-Pad */}
        {activeTab === 'CONTROLS' && (
          <div className="p-6 flex flex-col items-center justify-center space-y-6 bg-graphite-900">
            <div className="text-[11px] font-mono text-slate-400 text-center">
              Press and hold to move. Manual movement immediately preempts running guard tours.
            </div>

            {/* D-Pad */}
            <div className="grid grid-cols-3 gap-2 w-48 h-48">
              <div />
              <button
                onMouseDown={() => handlePtz('move', 0, 1)}
                onMouseUp={() => handlePtz('stop')}
                className="bg-graphite-800 hover:bg-cctv-amber hover:text-graphite-900 border border-graphite-700 rounded-md flex items-center justify-center text-slate-200 active:scale-95 transition shadow"
              >
                <ArrowUp className="w-6 h-6" />
              </button>
              <div />

              <button
                onMouseDown={() => handlePtz('move', -1, 0)}
                onMouseUp={() => handlePtz('stop')}
                className="bg-graphite-800 hover:bg-cctv-amber hover:text-graphite-900 border border-graphite-700 rounded-md flex items-center justify-center text-slate-200 active:scale-95 transition shadow"
              >
                <ArrowLeft className="w-6 h-6" />
              </button>
              <button
                onClick={() => handlePtz('stop')}
                className="bg-graphite-850 hover:bg-red-600 hover:text-white border border-graphite-700 rounded-md flex items-center justify-center text-slate-400 active:scale-95 transition"
              >
                <Square className="w-5 h-5" />
              </button>
              <button
                onMouseDown={() => handlePtz('move', 1, 0)}
                onMouseUp={() => handlePtz('stop')}
                className="bg-graphite-800 hover:bg-cctv-amber hover:text-graphite-900 border border-graphite-700 rounded-md flex items-center justify-center text-slate-200 active:scale-95 transition shadow"
              >
                <ArrowRight className="w-6 h-6" />
              </button>

              <div />
              <button
                onMouseDown={() => handlePtz('move', 0, -1)}
                onMouseUp={() => handlePtz('stop')}
                className="bg-graphite-800 hover:bg-cctv-amber hover:text-graphite-900 border border-graphite-700 rounded-md flex items-center justify-center text-slate-200 active:scale-95 transition shadow"
              >
                <ArrowDown className="w-6 h-6" />
              </button>
              <div />
            </div>

            {/* Zoom Controls */}
            <div className="flex space-x-3">
              <button
                onMouseDown={() => handlePtz('move', 0, 0, 1)}
                onMouseUp={() => handlePtz('stop')}
                className="flex items-center space-x-1.5 px-4 py-2 rounded bg-graphite-800 hover:bg-cctv-teal hover:text-graphite-900 border border-graphite-700 text-slate-200 font-mono text-xs transition"
              >
                <ZoomIn className="w-4 h-4" />
                <span>Zoom In</span>
              </button>
              <button
                onMouseDown={() => handlePtz('move', 0, 0, -1)}
                onMouseUp={() => handlePtz('stop')}
                className="flex items-center space-x-1.5 px-4 py-2 rounded bg-graphite-800 hover:bg-cctv-teal hover:text-graphite-900 border border-graphite-700 text-slate-200 font-mono text-xs transition"
              >
                <ZoomOut className="w-4 h-4" />
                <span>Zoom Out</span>
              </button>
            </div>
          </div>
        )}

        {/* Tab 2: Presets */}
        {activeTab === 'PRESETS' && (
          <div className="p-4 space-y-4 bg-graphite-850 overflow-y-auto">
            {/* Save Current Position */}
            <form onSubmit={handleSavePreset} className="flex space-x-2 bg-graphite-900 p-3 rounded border border-graphite-700">
              <input
                type="text"
                placeholder="e.g. North Gate Gatehouse"
                value={newPresetName}
                onChange={(e) => setNewPresetName(e.target.value)}
                className="flex-1 bg-graphite-850 border border-graphite-700 rounded px-3 py-1.5 text-xs text-slate-200 font-mono focus:outline-none focus:border-cctv-amber"
              />
              <button
                type="submit"
                disabled={savingPreset || !newPresetName.trim()}
                className="flex items-center space-x-1.5 px-3 py-1.5 rounded text-xs font-semibold bg-cctv-amber text-graphite-900 hover:bg-amber-400 disabled:opacity-50 font-mono"
              >
                <Bookmark className="w-3.5 h-3.5" />
                <span>{savingPreset ? 'Saving...' : 'Save Current Position'}</span>
              </button>
            </form>

            {/* Presets List */}
            <div className="space-y-2">
              <div className="text-[11px] font-mono text-slate-400 uppercase tracking-wider">
                Saved Positions ({presets.length})
              </div>

              {presets.length === 0 ? (
                <div className="text-center p-6 border border-dashed border-graphite-700 rounded text-slate-500 text-xs font-mono">
                  No presets configured yet. Aim camera and save positions above.
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {presets.map((p) => (
                    <div
                      key={p.id}
                      className="p-2.5 bg-graphite-900 rounded border border-graphite-700 flex items-center justify-between"
                    >
                      <div>
                        <div className="text-xs font-semibold text-white font-mono">{p.name}</div>
                        <div className="text-[10px] font-mono text-slate-500">{p.presetToken}</div>
                      </div>

                      <div className="flex items-center space-x-1">
                        <button
                          onClick={() => handleGotoPreset(p.id)}
                          className="px-2.5 py-1 rounded bg-cctv-teal/20 text-cctv-teal hover:bg-cctv-teal/30 font-mono text-xs font-semibold border border-cctv-teal/40 transition"
                        >
                          Goto
                        </button>
                        <button
                          onClick={() => handleDeletePreset(p.id)}
                          className="p-1 text-slate-500 hover:text-red-400"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
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
          <div className="p-4 space-y-4 bg-graphite-850 overflow-y-auto">
            {/* New Tour Builder */}
            <div className="p-3 bg-graphite-900 rounded border border-graphite-700 space-y-3">
              <h4 className="text-xs font-semibold text-slate-200 uppercase tracking-wider">
                Create Automated Patrol Tour
              </h4>

              <div>
                <label className="block text-[11px] font-mono text-slate-400 mb-1">Tour Name</label>
                <input
                  type="text"
                  placeholder="e.g. 24/7 Perimeter Patrol"
                  value={tourName}
                  onChange={(e) => setTourName(e.target.value)}
                  className="w-full bg-graphite-850 border border-graphite-700 rounded px-3 py-1 text-xs text-slate-200 font-mono focus:outline-none focus:border-cctv-amber"
                />
              </div>

              <div className="grid grid-cols-3 gap-2 items-end">
                <div className="col-span-2">
                  <label className="block text-[11px] font-mono text-slate-400 mb-1">Select Preset</label>
                  <select
                    value={selectedPresetForTour}
                    onChange={(e) => setSelectedPresetForTour(e.target.value)}
                    className="w-full bg-graphite-850 border border-graphite-700 rounded px-2.5 py-1 text-xs text-slate-200 font-mono focus:outline-none focus:border-cctv-amber"
                  >
                    {presets.map((p) => (
                      <option key={p.id} value={p.presetToken}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-mono text-slate-400 mb-1">Dwell: {dwellTime}s</label>
                  <input
                    type="range"
                    min={5}
                    max={60}
                    value={dwellTime}
                    onChange={(e) => setDwellTime(Number(e.target.value))}
                    className="w-full accent-cctv-amber"
                  />
                </div>
              </div>

              <button
                type="button"
                onClick={handleAddTourStep}
                disabled={presets.length === 0}
                className="px-3 py-1 rounded bg-graphite-800 hover:bg-graphite-700 text-slate-200 font-mono text-xs border border-graphite-700"
              >
                + Add Preset to Sequence ({tourSteps.length} steps)
              </button>

              {tourSteps.length > 0 && (
                <div className="p-2 bg-graphite-850 rounded border border-graphite-700 text-xs font-mono text-slate-300 space-y-1">
                  <div className="text-[10px] text-slate-400 uppercase">Sequence:</div>
                  <div className="flex flex-wrap gap-1">
                    {tourSteps.map((s, idx) => (
                      <span key={idx} className="px-2 py-0.5 bg-graphite-900 rounded border border-graphite-700">
                        {idx + 1}. {s.presetName || s.presetToken} ({s.dwellSeconds}s)
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex justify-end">
                <button
                  onClick={handleCreateTour}
                  disabled={!tourName || tourSteps.length === 0}
                  className="px-4 py-1.5 rounded text-xs font-semibold bg-cctv-amber text-graphite-900 hover:bg-amber-400 disabled:opacity-50 font-mono shadow"
                >
                  Save Guard Tour
                </button>
              </div>
            </div>

            {/* Tours List */}
            <div className="space-y-2">
              <div className="text-[11px] font-mono text-slate-400 uppercase tracking-wider">
                Configured Patrol Tours ({tours.length})
              </div>

              {tours.map((t) => (
                <div
                  key={t.id}
                  className="p-3 bg-graphite-900 rounded border border-graphite-700 flex items-center justify-between"
                >
                  <div>
                    <div className="flex items-center space-x-2">
                      <span className="text-xs font-semibold text-white font-mono">{t.name}</span>
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-bold ${
                          t.state === 'RUNNING'
                            ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                            : 'bg-graphite-800 text-slate-400'
                        }`}
                      >
                        {t.state}
                      </span>
                    </div>
                    <div className="text-[10px] font-mono text-slate-500 mt-0.5">
                      {t.stepsJson.length} presets in loop
                    </div>
                  </div>

                  <div className="flex items-center space-x-1.5">
                    {t.state === 'RUNNING' ? (
                      <button
                        onClick={() => handleStopTour(t.id)}
                        className="flex items-center space-x-1 px-3 py-1 rounded bg-red-950 text-red-400 border border-red-800 font-mono text-xs font-semibold hover:bg-red-900 transition"
                      >
                        <Square className="w-3.5 h-3.5" />
                        <span>Stop</span>
                      </button>
                    ) : (
                      <button
                        onClick={() => handleStartTour(t.id)}
                        className="flex items-center space-x-1 px-3 py-1 rounded bg-emerald-950 text-emerald-400 border border-emerald-800 font-mono text-xs font-semibold hover:bg-emerald-900 transition"
                      >
                        <Play className="w-3.5 h-3.5" />
                        <span>Start Patrol</span>
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="px-5 py-3 border-t border-graphite-700 flex justify-end bg-graphite-800">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded text-xs font-semibold bg-graphite-700 text-white hover:bg-graphite-600 font-mono"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default PtzControlModal;
