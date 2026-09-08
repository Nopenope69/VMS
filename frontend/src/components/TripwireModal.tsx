import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Compass,
  Square,
  Trash2,
  Save,
  ArrowRight,
  Info,
} from 'lucide-react';
import api from '../services/api';

interface Point2D {
  x: number;
  y: number;
}

interface SpatialRule {
  id: string;
  name: string;
  type: 'TRIPWIRE' | 'LOITERING';
  cameraId: string;
  tripwireDirection?: 'A_TO_B' | 'B_TO_A' | 'BIDIRECTIONAL';
  lineCoordinates?: [Point2D, Point2D];
  polygonCoordinates?: Point2D[];
  dwellThresholdSeconds?: number;
  cooldownSeconds: number;
}

interface TripwireModalProps {
  isOpen: boolean;
  onClose: () => void;
  cameraId?: string;
  cameraName?: string;
}

export const TripwireModal: React.FC<TripwireModalProps> = ({
  isOpen,
  onClose,
  cameraId = 'cam_main_01',
  cameraName = 'Main Entrance Camera',
}) => {
  const [rules, setRules] = useState<SpatialRule[]>([]);
  const [ruleType, setRuleType] = useState<'TRIPWIRE' | 'LOITERING'>('TRIPWIRE');
  const [ruleName, setRuleName] = useState('');
  const [direction, setDirection] = useState<'A_TO_B' | 'B_TO_A' | 'BIDIRECTIONAL'>('A_TO_B');
  const [dwellSeconds, setDwellSeconds] = useState(15);
  const [cooldownSeconds, setCooldownSeconds] = useState(10);

  // Drawing state
  const [linePoints, setLinePoints] = useState<Point2D[]>([]);
  const [polygonPoints, setPolygonPoints] = useState<Point2D[]>([]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const fetchRules = async () => {
    try {
      const res = await api.get(`/spatial-rules?cameraId=${cameraId}`);
      setRules(res.data.rules || []);
    } catch (err) {
      console.error('Failed to fetch spatial rules', err);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchRules();
      setLinePoints([]);
      setPolygonPoints([]);
    }
  }, [isOpen, cameraId]);

  // Canvas drawing effect
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw grid lines
    ctx.strokeStyle = '#2d3748';
    ctx.lineWidth = 1;
    for (let x = 0; x < canvas.width; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y < canvas.height; y += 40) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }

    // Draw active drawing: Tripwire line
    if (ruleType === 'TRIPWIRE' && linePoints.length > 0) {
      ctx.strokeStyle = '#fbbf24'; // CCTV amber
      ctx.lineWidth = 3;
      ctx.fillStyle = '#fbbf24';

      // First point
      ctx.beginPath();
      ctx.arc(linePoints[0].x * canvas.width, linePoints[0].y * canvas.height, 6, 0, 2 * Math.PI);
      ctx.fill();

      // Second point and line
      if (linePoints.length > 1) {
        ctx.beginPath();
        ctx.moveTo(linePoints[0].x * canvas.width, linePoints[0].y * canvas.height);
        ctx.lineTo(linePoints[1].x * canvas.width, linePoints[1].y * canvas.height);
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(linePoints[1].x * canvas.width, linePoints[1].y * canvas.height, 6, 0, 2 * Math.PI);
        ctx.fill();

        // Direction arrow
        const midX = ((linePoints[0].x + linePoints[1].x) / 2) * canvas.width;
        const midY = ((linePoints[0].y + linePoints[1].y) / 2) * canvas.height;
        ctx.fillStyle = '#38bdf8';
        ctx.font = 'bold 12px monospace';
        ctx.fillText(`LINE CROSS: ${direction}`, midX + 10, midY - 10);
      }
    }

    // Draw active drawing: Loitering Polygon
    if (ruleType === 'LOITERING' && polygonPoints.length > 0) {
      ctx.strokeStyle = '#2dd4bf'; // CCTV teal
      ctx.fillStyle = 'rgba(45, 212, 191, 0.2)';
      ctx.lineWidth = 2;

      ctx.beginPath();
      polygonPoints.forEach((pt, idx) => {
        const px = pt.x * canvas.width;
        const py = pt.y * canvas.height;
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });

      if (polygonPoints.length > 2) {
        ctx.closePath();
        ctx.fill();
      }
      ctx.stroke();

      polygonPoints.forEach((pt) => {
        ctx.fillStyle = '#2dd4bf';
        ctx.beginPath();
        ctx.arc(pt.x * canvas.width, pt.y * canvas.height, 4, 0, 2 * Math.PI);
        ctx.fill();
      });
    }
  }, [linePoints, polygonPoints, ruleType, direction]);

  if (!isOpen) return null;

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / canvas.width;
    const y = (e.clientY - rect.top) / canvas.height;

    if (ruleType === 'TRIPWIRE') {
      if (linePoints.length >= 2) {
        setLinePoints([{ x, y }]);
      } else {
        setLinePoints([...linePoints, { x, y }]);
      }
    } else {
      setPolygonPoints([...polygonPoints, { x, y }]);
    }
  };

  const handleSaveRule = async () => {
    if (!ruleName.trim()) {
      alert('Please provide a rule name');
      return;
    }

    try {
      if (ruleType === 'TRIPWIRE') {
        if (linePoints.length < 2) {
          alert('Click two points on the canvas to define the tripwire boundary');
          return;
        }
        await api.post('/spatial-rules', {
          name: ruleName,
          type: 'TRIPWIRE',
          cameraId,
          tripwireDirection: direction,
          lineCoordinates: linePoints,
          cooldownSeconds,
        });
      } else {
        if (polygonPoints.length < 3) {
          alert('Click at least 3 points on the canvas to form a loitering polygon');
          return;
        }
        await api.post('/spatial-rules', {
          name: ruleName,
          type: 'LOITERING',
          cameraId,
          polygonCoordinates: polygonPoints,
          dwellThresholdSeconds: dwellSeconds,
          cooldownSeconds,
        });
      }

      setRuleName('');
      setLinePoints([]);
      setPolygonPoints([]);
      fetchRules();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to create spatial rule');
    }
  };

  const handleDeleteRule = async (id: string) => {
    try {
      await api.delete(`/spatial-rules/${id}`);
      fetchRules();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to delete spatial rule');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 font-sans text-slate-100">
      <div className="bg-graphite-900 border border-graphite-700 rounded-xl shadow-2xl w-full max-w-5xl max-h-[92vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-graphite-700 flex items-center justify-between bg-graphite-850">
          <div className="flex items-center space-x-2">
            <Compass className="w-5 h-5 text-cctv-amber" />
            <div>
              <h2 className="text-base font-bold tracking-wider uppercase text-slate-100">
                Spatial Analytics: Vector Tripwire & Continuous Loitering
              </h2>
              <p className="text-[11px] font-mono text-slate-400">
                Target: {cameraName} ({cameraId}) • Hysteresis debounced & exit-reset invariant
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-graphite-700 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Canvas Drawer */}
          <div className="lg:col-span-2 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <button
                  type="button"
                  onClick={() => {
                    setRuleType('TRIPWIRE');
                    setLinePoints([]);
                  }}
                  className={`px-3 py-1.5 rounded text-xs font-semibold flex items-center space-x-1.5 transition ${
                    ruleType === 'TRIPWIRE'
                      ? 'bg-cctv-amber text-graphite-900 font-bold'
                      : 'bg-graphite-800 text-slate-300 hover:bg-graphite-700'
                  }`}
                >
                  <ArrowRight className="w-3.5 h-3.5" />
                  <span>Directional Tripwire Line</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRuleType('LOITERING');
                    setPolygonPoints([]);
                  }}
                  className={`px-3 py-1.5 rounded text-xs font-semibold flex items-center space-x-1.5 transition ${
                    ruleType === 'LOITERING'
                      ? 'bg-cctv-teal text-graphite-900 font-bold'
                      : 'bg-graphite-800 text-slate-300 hover:bg-graphite-700'
                  }`}
                >
                  <Square className="w-3.5 h-3.5" />
                  <span>Continuous Loitering Polygon</span>
                </button>
              </div>

              <button
                type="button"
                onClick={() => {
                  setLinePoints([]);
                  setPolygonPoints([]);
                }}
                className="text-[11px] font-mono text-slate-400 hover:text-rose-400"
              >
                Clear Canvas
              </button>
            </div>

            {/* Interactive Canvas */}
            <div className="relative aspect-video bg-graphite-950 border border-graphite-750 rounded-lg overflow-hidden flex items-center justify-center">
              <canvas
                ref={canvasRef}
                width={640}
                height={360}
                onClick={handleCanvasClick}
                className="w-full h-full cursor-crosshair"
              />
              <div className="absolute top-2 left-2 px-2 py-1 bg-graphite-900/80 backdrop-blur rounded font-mono text-[10px] text-slate-400">
                {ruleType === 'TRIPWIRE'
                  ? `Tripwire: Click 2 points to define line (${linePoints.length}/2)`
                  : `Loitering: Click points to draw polygon (${polygonPoints.length} points)`}
              </div>
            </div>

            {/* Invariant Note */}
            <div className="p-3 bg-graphite-850 border border-graphite-750 rounded text-xs text-slate-400 flex items-start space-x-2">
              <Info className="w-4 h-4 text-cctv-teal shrink-0 mt-0.5" />
              <div className="text-[11px] leading-relaxed">
                <strong className="text-slate-200">Architectural Invariant:</strong> Directional tripwires
                use 2D vector cross products with track-state hysteresis to eliminate false rapid triggers.
                Loitering requires continuous dwell inside the polygon; any exit immediately resets the dwell timer.
              </div>
            </div>
          </div>

          {/* Configuration Sidebar */}
          <div className="space-y-4">
            <div className="p-4 bg-graphite-850 border border-graphite-700 rounded-lg space-y-3">
              <h3 className="font-bold text-xs uppercase tracking-wider text-cctv-amber">
                Configure Rule Parameters
              </h3>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Rule Name</label>
                <input
                  type="text"
                  placeholder="e.g. Perimeter Fence North"
                  value={ruleName}
                  onChange={(e) => setRuleName(e.target.value)}
                  className="w-full bg-graphite-900 border border-graphite-700 rounded p-2 text-xs text-slate-200"
                />
              </div>

              {ruleType === 'TRIPWIRE' ? (
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Crossing Direction</label>
                  <select
                    value={direction}
                    onChange={(e) => setDirection(e.target.value as any)}
                    className="w-full bg-graphite-900 border border-graphite-700 rounded p-2 text-xs text-slate-200 font-mono"
                  >
                    <option value="A_TO_B">A → B (Side A to Side B)</option>
                    <option value="B_TO_A">B → A (Side B to Side A)</option>
                    <option value="BIDIRECTIONAL">BIDIRECTIONAL (Both ways)</option>
                  </select>
                </div>
              ) : (
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">
                    Continuous Dwell Threshold (Seconds)
                  </label>
                  <input
                    type="number"
                    min="3"
                    max="600"
                    value={dwellSeconds}
                    onChange={(e) => setDwellSeconds(Number(e.target.value))}
                    className="w-full bg-graphite-900 border border-graphite-700 rounded p-2 text-xs text-slate-200 font-mono"
                  />
                </div>
              )}

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  Alert Hysteresis Cooldown (Seconds)
                </label>
                <input
                  type="number"
                  min="1"
                  max="120"
                  value={cooldownSeconds}
                  onChange={(e) => setCooldownSeconds(Number(e.target.value))}
                  className="w-full bg-graphite-900 border border-graphite-700 rounded p-2 text-xs text-slate-200 font-mono"
                />
              </div>

              <button
                type="button"
                onClick={handleSaveRule}
                className="w-full py-2 rounded bg-cctv-amber text-graphite-900 font-bold text-xs hover:bg-amber-400 transition flex items-center justify-center space-x-1.5"
              >
                <Save className="w-3.5 h-3.5" />
                <span>Save Spatial Rule</span>
              </button>
            </div>

            {/* Configured Rules List */}
            <div className="space-y-2">
              <div className="text-xs font-semibold text-slate-400">Existing Rules ({rules.length})</div>
              {rules.length === 0 ? (
                <div className="p-3 bg-graphite-850 rounded border border-graphite-750 text-center text-slate-500 font-mono text-[11px]">
                  No spatial rules deployed for this camera.
                </div>
              ) : (
                rules.map((r) => (
                  <div
                    key={r.id}
                    className="p-2.5 bg-graphite-850 border border-graphite-750 rounded flex items-center justify-between text-xs"
                  >
                    <div>
                      <div className="font-semibold text-slate-200">{r.name}</div>
                      <div className="text-[10px] font-mono text-slate-400">
                        {r.type} • {r.type === 'TRIPWIRE' ? r.tripwireDirection : `${r.dwellThresholdSeconds}s dwell`}
                      </div>
                    </div>
                    <button
                      onClick={() => handleDeleteRule(r.id)}
                      className="p-1 rounded text-slate-400 hover:text-rose-400"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TripwireModal;
