import React, { useState, useEffect, useRef } from 'react';
import { Shield, Plus, Trash2, X, Eye, EyeOff, CheckCircle2, AlertOctagon } from 'lucide-react';
import api from '../services/api';

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
    ctx.strokeStyle = '#222a32';
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

      // Label zone
      const center = zone.polygonCoordinates[0];
      ctx.fillStyle = '#ffffff';
      ctx.font = '10px monospace';
      ctx.fillText(`${zone.name} (${zone.type})`, center.x * w + 5, center.y * h + 15);
    });

    // Draw active drawing in progress
    if (currentVertices.length > 0) {
      ctx.beginPath();
      ctx.moveTo(currentVertices[0].x * w, currentVertices[0].y * h);
      for (let i = 1; i < currentVertices.length; i++) {
        ctx.lineTo(currentVertices[i].x * w, currentVertices[i].y * h);
      }

      ctx.strokeStyle = zoneType === 'INCLUSION' ? '#34d399' : '#f87171';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw vertex handles
      currentVertices.forEach((v, idx) => {
        ctx.fillStyle = idx === 0 ? '#f59e0b' : '#ffffff';
        ctx.beginPath();
        ctx.arc(v.x * w, v.y * h, 4, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // Draw test point if testing
    if (testPoint) {
      ctx.fillStyle = testResult?.allowed ? '#10b981' : '#ef4444';
      ctx.beginPath();
      ctx.arc(testPoint.x * w, testPoint.y * h, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }, [zones, currentVertices, zoneType, testPoint, testResult]);

  const handleCanvasClick = async (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;

    const normalizedPoint = {
      x: Math.round(x * 1000) / 1000,
      y: Math.round(y * 1000) / 1000,
    };

    if (mode === 'TEST') {
      setTestPoint(normalizedPoint);
      try {
        const res = await api.post(`/cameras/${camera.id}/zones/test`, { point: normalizedPoint });
        setTestResult(res.data.evaluation);
      } catch (err) {
        console.error('Test error:', err);
      }
      return;
    }

    // DRAW mode
    if (currentVertices.length >= 3) {
      // If clicking near first vertex, auto-close
      const first = currentVertices[0];
      const dist = Math.hypot(first.x - normalizedPoint.x, first.y - normalizedPoint.y);
      if (dist < 0.04) {
        return; // Clicked near start
      }
    }

    setCurrentVertices((prev) => [...prev, normalizedPoint]);
  };

  const handleSaveZone = async () => {
    if (!zoneName.trim()) {
      alert('Please enter a zone name');
      return;
    }
    if (currentVertices.length < 3) {
      alert('A polygon zone requires at least 3 vertices');
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
      fetchZones();
    } catch (err: any) {
      alert(`Failed to save zone: ${err.response?.data?.error || err.message}`);
    }
  };

  const handleDeleteZone = async (id: string) => {
    if (!confirm('Delete this detection zone?')) return;
    try {
      await api.delete(`/cameras/${camera.id}/zones/${id}`);
      fetchZones();
    } catch (err: any) {
      alert(`Delete error: ${err.message}`);
    }
  };

  const handleToggleZone = async (zone: Zone) => {
    try {
      await api.put(`/cameras/${camera.id}/zones/${zone.id}`, {
        enabled: !zone.enabled,
      });
      fetchZones();
    } catch (err: any) {
      alert(`Toggle error: ${err.message}`);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50 backdrop-blur-sm select-none">
      <div className="bg-graphite-850 border border-graphite-700 rounded-md w-full max-w-5xl overflow-hidden shadow-2xl flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-graphite-700 flex justify-between items-center bg-graphite-800">
          <div className="flex items-center space-x-2">
            <Shield className="w-4 h-4 text-cctv-teal" />
            <h3 className="text-sm font-semibold text-slate-100 uppercase tracking-wider">
              Motion Detection Zones & Exclusion Masks — {camera.name}
            </h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 grid grid-cols-1 md:grid-cols-3 overflow-hidden">
          {/* Canvas Drawer Area (2 cols) */}
          <div className="md:col-span-2 p-4 flex flex-col bg-graphite-900 border-r border-graphite-700">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center space-x-2">
                <button
                  onClick={() => { setMode('DRAW'); setTestPoint(null); setTestResult(null); }}
                  className={`px-3 py-1 rounded text-xs font-mono font-medium transition ${
                    mode === 'DRAW' ? 'bg-cctv-amber text-graphite-900 font-bold' : 'bg-graphite-800 text-slate-300'
                  }`}
                >
                  Draw Polygon
                </button>
                <button
                  onClick={() => setMode('TEST')}
                  className={`px-3 py-1 rounded text-xs font-mono font-medium transition ${
                    mode === 'TEST' ? 'bg-cctv-teal text-graphite-900 font-bold' : 'bg-graphite-800 text-slate-300'
                  }`}
                >
                  Test Geometry Probe
                </button>
              </div>

              <div className="text-[11px] font-mono text-slate-400">
                {mode === 'DRAW'
                  ? 'Click to place vertices. Need at least 3 points.'
                  : 'Click anywhere on canvas to evaluate motion filter.'}
              </div>
            </div>

            <div className="relative aspect-video w-full bg-black rounded border border-graphite-700 overflow-hidden flex items-center justify-center">
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
                className={`mt-2 p-2.5 rounded border text-xs font-mono flex items-center justify-between ${
                  testResult.allowed
                    ? 'bg-emerald-950/70 border-emerald-800 text-emerald-300'
                    : 'bg-red-950/70 border-red-800 text-red-300'
                }`}
              >
                <div className="flex items-center space-x-2">
                  {testResult.allowed ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  ) : (
                    <AlertOctagon className="w-4 h-4 text-red-400" />
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
          <div className="p-4 flex flex-col bg-graphite-850 overflow-y-auto space-y-4">
            {/* New Zone Form */}
            <div className="p-3 bg-graphite-900 rounded border border-graphite-700 space-y-3">
              <h4 className="text-xs font-semibold text-slate-200 uppercase tracking-wider">
                Create Detection Zone
              </h4>

              <div>
                <label className="block text-[11px] font-mono text-slate-400 mb-1">Zone Name</label>
                <input
                  type="text"
                  placeholder="e.g. Driveway Walkway"
                  value={zoneName}
                  onChange={(e) => setZoneName(e.target.value)}
                  className="w-full bg-graphite-850 border border-graphite-700 rounded px-2.5 py-1 text-xs text-slate-200 font-mono focus:outline-none focus:border-cctv-amber"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] font-mono text-slate-400 mb-1">Zone Type</label>
                  <select
                    value={zoneType}
                    onChange={(e) => setZoneType(e.target.value as any)}
                    className="w-full bg-graphite-850 border border-graphite-700 rounded px-2 py-1 text-xs text-slate-200 font-mono focus:outline-none focus:border-cctv-amber"
                  >
                    <option value="INCLUSION">INCLUSION (Detect)</option>
                    <option value="EXCLUSION">EXCLUSION (Ignore Mask)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-mono text-slate-400 mb-1">Priority</label>
                  <input
                    type="number"
                    min={0}
                    max={10}
                    value={priority}
                    onChange={(e) => setPriority(Number(e.target.value))}
                    className="w-full bg-graphite-850 border border-graphite-700 rounded px-2 py-1 text-xs text-slate-200 font-mono focus:outline-none focus:border-cctv-amber"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between pt-1">
                <span className="text-[10px] font-mono text-slate-400">
                  Vertices: {currentVertices.length}
                </span>
                <div className="flex items-center space-x-1.5">
                  <button
                    onClick={() => setCurrentVertices([])}
                    disabled={currentVertices.length === 0}
                    className="px-2 py-1 rounded text-[11px] text-slate-400 hover:text-white disabled:opacity-40 font-mono"
                  >
                    Clear Points
                  </button>
                  <button
                    onClick={handleSaveZone}
                    disabled={currentVertices.length < 3}
                    className="flex items-center space-x-1 px-3 py-1 rounded text-xs font-semibold bg-cctv-amber text-graphite-900 hover:bg-amber-400 disabled:opacity-50 font-mono shadow"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Save Zone</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Configured Zones List */}
            <div className="space-y-2 flex-1">
              <h4 className="text-xs font-semibold text-slate-200 uppercase tracking-wider">
                Configured Zones ({zones.length})
              </h4>

              {zones.length === 0 ? (
                <div className="text-center p-6 border border-dashed border-graphite-700 rounded text-slate-500 text-xs font-mono">
                  No zones configured. Motion evaluates across entire camera frame.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {zones.map((z) => (
                    <div
                      key={z.id}
                      className="p-2 bg-graphite-900 rounded border border-graphite-700 flex items-center justify-between"
                    >
                      <div className="flex items-center space-x-2">
                        <span
                          className={`w-2 h-2 rounded-full ${
                            z.type === 'INCLUSION' ? 'bg-emerald-400' : 'bg-red-400'
                          }`}
                        />
                        <div>
                          <div className="text-xs font-semibold text-white font-mono">{z.name}</div>
                          <div className="text-[10px] font-mono text-slate-400">
                            {z.type} • Priority: {z.priority} • {z.polygonCoordinates.length} pts
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center space-x-1">
                        <button
                          onClick={() => handleToggleZone(z)}
                          title={z.enabled ? 'Disable Zone' : 'Enable Zone'}
                          className="p-1 text-slate-400 hover:text-white"
                        >
                          {z.enabled ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5 text-slate-600" />}
                        </button>
                        <button
                          onClick={() => handleDeleteZone(z.id)}
                          title="Delete Zone"
                          className="p-1 text-slate-400 hover:text-red-400"
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
        </div>

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

export default DetectionZoneModal;
