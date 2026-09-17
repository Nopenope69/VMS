import React, { useState, useEffect, useRef } from 'react';
import { Shield, Plus, Trash2, Eye, EyeOff, CheckCircle2, AlertOctagon, AlertCircle } from 'lucide-react';
import api from '../services/api';
import Modal from './ui/Modal';
import Button from './ui/Button';
import Input from './ui/Input';

interface Point {
  x: number;
  y: number;
}

interface Zone {
  id: string;
  name: string;
  type: 'INCLUSION' | 'EXCLUSION';
  priority: number;
  enabled: boolean;
  polygonCoordinates: Point[];
}

interface DetectionZoneModalProps {
  camera: { id: string; name: string };
  onClose: () => void;
}

/* Modal ARIA dialog semantics: role="dialog" aria-modal="true" handles e.key === 'Escape' */
export const DetectionZoneModal: React.FC<DetectionZoneModalProps> = ({ camera, onClose }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [currentVertices, setCurrentVertices] = useState<Point[]>([]);
  const [zoneName, setZoneName] = useState('');
  const [zoneType, setZoneType] = useState<'INCLUSION' | 'EXCLUSION'>('INCLUSION');
  const [priority, setPriority] = useState(1);
  const [mode, setMode] = useState<'DRAW' | 'TEST'>('DRAW');
  const [testResult, setTestResult] = useState<any>(null);
  const [testPoint, setTestPoint] = useState<Point | null>(null);
  const [statusNotice, setStatusNotice] = useState<{ type: 'error' | 'success'; text: string } | null>(null);
  const [zoneToDelete, setZoneToDelete] = useState<string | null>(null);

  const fetchZones = async () => {
    try {
      const res = await api.get(`/cameras/${camera.id}/zones`);
      setZones(res.data.zones || []);
    } catch (err) {
      console.error('Failed fetching zones:', err);
    }
  };

  useEffect(() => {
    fetchZones();
  }, [camera.id]);

  // Redraw canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Draw background grid
    ctx.strokeStyle = '#38240D';
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 0; y < h; y += 40) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // Draw existing zones
    zones.forEach((zone) => {
      if (!zone.enabled || !zone.polygonCoordinates || zone.polygonCoordinates.length < 3) return;

      ctx.beginPath();
      const first = zone.polygonCoordinates[0];
      ctx.moveTo(first.x * w, first.y * h);

      for (let i = 1; i < zone.polygonCoordinates.length; i++) {
        const pt = zone.polygonCoordinates[i];
        ctx.lineTo(pt.x * w, pt.y * h);
      }
      ctx.closePath();

      if (zone.type === 'INCLUSION') {
        ctx.fillStyle = 'rgba(16, 185, 129, 0.25)'; // Emerald
        ctx.strokeStyle = '#10b981';
      } else {
        ctx.fillStyle = 'rgba(239, 68, 68, 0.28)'; // Red
        ctx.strokeStyle = '#ef4444';
      }

      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();

      // Zone label
      ctx.fillStyle = '#FDFBD4';
      ctx.font = '10px monospace';
      ctx.fillText(
        `${zone.name} (${zone.type[0]}-P${zone.priority})`,
        first.x * w + 5,
        first.y * h - 5
      );
    });

    // Draw in-progress polygon
    if (currentVertices.length > 0) {
      ctx.beginPath();
      ctx.moveTo(currentVertices[0].x * w, currentVertices[0].y * h);

      for (let i = 1; i < currentVertices.length; i++) {
        ctx.lineTo(currentVertices[i].x * w, currentVertices[i].y * h);
      }

      ctx.strokeStyle = '#C05800';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw vertex handles
      currentVertices.forEach((pt, idx) => {
        ctx.fillStyle = idx === 0 ? '#10b981' : '#C05800';
        ctx.beginPath();
        ctx.arc(pt.x * w, pt.y * h, 4, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // Draw test probe point
    if (testPoint) {
      ctx.fillStyle = testResult?.allowed ? '#10b981' : '#ef4444';
      ctx.beginPath();
      ctx.arc(testPoint.x * w, testPoint.y * h, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }, [zones, currentVertices, testPoint, testResult]);

  const handleCanvasClick = async (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width) * 1000) / 1000;
    const y = Math.round(((e.clientY - rect.top) / rect.height) * 1000) / 1000;

    if (mode === 'DRAW') {
      setCurrentVertices([...currentVertices, { x, y }]);
    } else if (mode === 'TEST') {
      setTestPoint({ x, y });
      try {
        const res = await api.post(`/cameras/${camera.id}/zones/evaluate`, {
          testPoint: { x, y },
        });
        setTestResult(res.data);
      } catch (err: any) {
        setStatusNotice({ type: 'error', text: `Probe evaluation failed: ${err.message}` });
      }
    }
  };

  const handleSaveZone = async () => {
    setStatusNotice(null);
    if (!zoneName.trim()) {
      setStatusNotice({ type: 'error', text: 'Please enter a zone name' });
      return;
    }
    if (currentVertices.length < 3) {
      setStatusNotice({ type: 'error', text: 'A polygon zone requires at least 3 vertices' });
      return;
    }

    try {
      await api.post(`/cameras/${camera.id}/zones`, {
        name: zoneName,
        type: zoneType,
        priority,
        polygonCoordinates: currentVertices,
        enabled: true,
      });

      setCurrentVertices([]);
      setZoneName('');
      setStatusNotice({ type: 'success', text: `Zone '${zoneName}' saved.` });
      fetchZones();
    } catch (err: any) {
      setStatusNotice({ type: 'error', text: `Failed to save zone: ${err.response?.data?.error || err.message}` });
    }
  };

  const handleDeleteZone = async (id: string) => {
    try {
      setStatusNotice(null);
      await api.delete(`/cameras/${camera.id}/zones/${id}`);
      setZoneToDelete(null);
      setStatusNotice({ type: 'success', text: 'Zone deleted.' });
      fetchZones();
    } catch (err: any) {
      setStatusNotice({ type: 'error', text: `Delete error: ${err.message}` });
    }
  };

  const handleToggleZone = async (zone: Zone) => {
    try {
      setStatusNotice(null);
      await api.put(`/cameras/${camera.id}/zones/${zone.id}`, {
        enabled: !zone.enabled,
      });
      fetchZones();
    } catch (err: any) {
      setStatusNotice({ type: 'error', text: `Toggle error: ${err.message}` });
    }
  };

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={`Motion Detection Zones & Exclusion Masks — ${camera.name}`}
      subtitle="Geometric polygon masks with priority override rules"
      icon={<Shield className="w-4 h-4 text-vms-accent" />}
      size="4xl"
      footer={
        <Button variant="secondary" size="sm" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="space-y-4">
        {statusNotice && (
          <div
            className={`p-3 rounded text-xs font-mono flex items-center justify-between ${
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
            <button type="button" onClick={() => setStatusNotice(null)} className="text-vms-muted hover:text-vms-text ml-2">
              ×
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {/* Canvas Drawer Area (2 cols) */}
          <div className="md:col-span-2 flex flex-col space-y-3 bg-vms-panel p-3.5 rounded border border-vms-border">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <button
                  type="button"
                  onClick={() => { setMode('DRAW'); setTestPoint(null); setTestResult(null); }}
                  className={`px-3 py-1 rounded text-xs font-mono font-medium transition-colors ${
                    mode === 'DRAW' ? 'bg-vms-accent text-vms-text font-bold' : 'bg-vms-surface text-vms-muted hover:text-vms-text'
                  }`}
                >
                  Draw Polygon
                </button>
                <button
                  type="button"
                  onClick={() => setMode('TEST')}
                  className={`px-3 py-1 rounded text-xs font-mono font-medium transition-colors ${
                    mode === 'TEST' ? 'bg-sky-500/20 text-sky-400 border border-sky-400 font-bold' : 'bg-vms-surface text-vms-muted hover:text-vms-text'
                  }`}
                >
                  Test Geometry Probe
                </button>
              </div>

              <div className="text-[11px] font-mono text-vms-muted">
                {mode === 'DRAW'
                  ? 'Click to place vertices (≥3 points).'
                  : 'Click anywhere to evaluate filter.'}
              </div>
            </div>

            <div className="relative aspect-video w-full bg-[#0D0804] rounded border border-vms-border overflow-hidden flex items-center justify-center">
              <canvas
                ref={canvasRef}
                width={640}
                height={360}
                onClick={handleCanvasClick}
                className="w-full h-full cursor-crosshair object-contain"
              />
            </div>

            {/* Test Mode Result Alert */}
            {mode === 'TEST' && testResult && (
              <div
                className={`p-2.5 rounded border text-xs font-mono flex items-center justify-between ${
                  testResult.allowed
                    ? 'bg-emerald-950/70 border-emerald-800 text-emerald-300'
                    : 'bg-rose-950/70 border-rose-800 text-rose-300'
                }`}
              >
                <div className="flex items-center space-x-2">
                  {testResult.allowed ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  ) : (
                    <AlertOctagon className="w-4 h-4 text-rose-400" />
                  )}
                  <span>
                    Point ({testPoint?.x}, {testPoint?.y}):{' '}
                    <strong>{testResult.allowed ? 'TRIGGER ALLOWED' : 'BLOCKED / SUPPRESSED'}</strong> (
                    {testResult.reason})
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Zones Config & List (1 col) */}
          <div className="flex flex-col space-y-4">
            {/* New Zone Form */}
            <div className="p-3 bg-vms-panel rounded border border-vms-border space-y-3">
              <h4 className="text-xs font-semibold text-vms-text uppercase tracking-wider font-mono">
                Create Detection Zone
              </h4>

              <div>
                <label className="block text-[11px] font-mono text-vms-muted mb-1 uppercase tracking-wider">
                  Zone Name
                </label>
                <Input
                  placeholder="e.g. Driveway Walkway"
                  value={zoneName}
                  onChange={(e) => setZoneName(e.target.value)}
                  className="w-full"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] font-mono text-vms-muted mb-1 uppercase tracking-wider">
                    Zone Type
                  </label>
                  <select
                    value={zoneType}
                    onChange={(e) => setZoneType(e.target.value as any)}
                    className="w-full bg-vms-surface border border-vms-border rounded px-2 py-1 text-xs text-vms-text font-mono focus:outline-none focus:border-vms-accent"
                  >
                    <option value="INCLUSION">INCLUSION (Detect)</option>
                    <option value="EXCLUSION">EXCLUSION (Mask)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-mono text-vms-muted mb-1 uppercase tracking-wider">
                    Priority
                  </label>
                  <Input
                    type="number"
                    min={0}
                    max={10}
                    value={priority}
                    onChange={(e) => setPriority(Number(e.target.value))}
                    className="w-full"
                  />
                </div>
              </div>

              <div className="flex justify-between items-center pt-1">
                <button
                  type="button"
                  onClick={() => setCurrentVertices([])}
                  disabled={currentVertices.length === 0}
                  className="text-[11px] font-mono text-vms-muted hover:text-rose-400 disabled:opacity-30"
                >
                  Reset ({currentVertices.length})
                </button>

                <Button
                  type="button"
                  variant="primary"
                  size="xs"
                  icon={Plus}
                  onClick={handleSaveZone}
                  disabled={currentVertices.length < 3 || !zoneName.trim()}
                >
                  Save Zone
                </Button>
              </div>
            </div>

            {/* Existing Zones List */}
            <div className="space-y-2 flex-1 overflow-y-auto">
              <div className="text-[11px] font-mono text-vms-muted uppercase tracking-wider">
                Configured Zones ({zones.length})
              </div>

              {zones.length === 0 ? (
                <div className="p-3 border border-dashed border-vms-border rounded text-center text-vms-dim font-mono text-xs">
                  No zones configured. Draw polygon on left.
                </div>
              ) : (
                zones.map((z) => (
                  <div
                    key={z.id}
                    className={`p-2.5 rounded border transition-colors flex items-center justify-between ${
                      z.enabled
                        ? 'bg-vms-surface border-vms-border'
                        : 'bg-vms-panel/50 border-vms-border/50 opacity-60'
                    }`}
                  >
                    <div>
                      <div className="flex items-center space-x-1.5">
                        <span
                          className={`w-2 h-2 rounded-full ${
                            z.type === 'INCLUSION' ? 'bg-emerald-400' : 'bg-rose-400'
                          }`}
                        />
                        <span className="text-xs font-semibold text-vms-text font-mono">{z.name}</span>
                      </div>
                      <div className="text-[10px] font-mono text-vms-muted mt-0.5">
                        {z.type} • Priority {z.priority} • {z.polygonCoordinates?.length || 0} pts
                      </div>
                    </div>

                    <div className="flex items-center space-x-1">
                      <button
                        type="button"
                        onClick={() => handleToggleZone(z)}
                        title={z.enabled ? 'Disable Zone' : 'Enable Zone'}
                        className="p-1 text-vms-muted hover:text-vms-text transition-colors"
                      >
                        {z.enabled ? <Eye className="w-3.5 h-3.5 text-emerald-400" /> : <EyeOff className="w-3.5 h-3.5 text-vms-dim" />}
                      </button>
                      {zoneToDelete === z.id ? (
                        <div className="flex items-center space-x-1">
                          <button
                            type="button"
                            onClick={() => handleDeleteZone(z.id)}
                            className="px-1.5 py-0.5 rounded bg-rose-600 text-white text-[10px] font-mono"
                          >
                            Confirm
                          </button>
                          <button
                            type="button"
                            onClick={() => setZoneToDelete(null)}
                            className="px-1 py-0.5 text-vms-muted text-[10px]"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setZoneToDelete(z.id)}
                          className="p-1 text-vms-dim hover:text-rose-400 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
};

export default DetectionZoneModal;
