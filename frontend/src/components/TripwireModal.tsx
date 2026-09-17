import React, { useState, useEffect, useRef } from 'react';
import {
  Compass,
  Square,
  Trash2,
  Save,
  ArrowRight,
  Info,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react';
import api from '../services/api';
import Modal from './ui/Modal';
import Button from './ui/Button';
import Input from './ui/Input';

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
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const [ruleToDelete, setRuleToDelete] = useState<string | null>(null);

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
      setErrorNotice(null);
      setSuccessNotice(null);
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
    ctx.strokeStyle = '#38240D';
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
      ctx.strokeStyle = '#C05800'; // VMS safety accent
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(linePoints[0].x, linePoints[0].y);
      for (let i = 1; i < linePoints.length; i++) {
        ctx.lineTo(linePoints[i].x, linePoints[i].y);
      }
      ctx.stroke();

      linePoints.forEach((p, idx) => {
        ctx.fillStyle = idx === 0 ? '#10B981' : '#EF4444';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6, 0, 2 * Math.PI);
        ctx.fill();
        ctx.strokeStyle = '#FDFBD4';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = '#FDFBD4';
        ctx.font = '11px monospace';
        ctx.fillText(idx === 0 ? 'Point A' : 'Point B', p.x + 8, p.y - 8);
      });
    }

    // Draw active drawing: Loitering polygon
    if (ruleType === 'LOITERING' && polygonPoints.length > 0) {
      ctx.strokeStyle = '#38BDF8';
      ctx.fillStyle = 'rgba(56, 189, 248, 0.2)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(polygonPoints[0].x, polygonPoints[0].y);
      for (let i = 1; i < polygonPoints.length; i++) {
        ctx.lineTo(polygonPoints[i].x, polygonPoints[i].y);
      }
      if (polygonPoints.length >= 3) {
        ctx.closePath();
        ctx.fill();
      }
      ctx.stroke();

      polygonPoints.forEach((p) => {
        ctx.fillStyle = '#38BDF8';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, 2 * Math.PI);
        ctx.fill();
      });
    }
  }, [linePoints, polygonPoints, ruleType]);

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);

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
    setErrorNotice(null);
    setSuccessNotice(null);
    if (!ruleName.trim()) {
      setErrorNotice('Please provide a rule name');
      return;
    }

    try {
      if (ruleType === 'TRIPWIRE') {
        if (linePoints.length < 2) {
          setErrorNotice('Click two points on the canvas to define the tripwire boundary');
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
          setErrorNotice('Click at least 3 points on the canvas to form a loitering polygon');
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
      setSuccessNotice('Spatial rule deployed successfully.');
      fetchRules();
    } catch (err: any) {
      setErrorNotice(err.response?.data?.error || 'Failed to create spatial rule');
    }
  };

  const handleDeleteRule = async (id: string) => {
    try {
      setErrorNotice(null);
      await api.delete(`/spatial-rules/${id}`);
      setRuleToDelete(null);
      setSuccessNotice('Rule removed.');
      fetchRules();
    } catch (err: any) {
      setErrorNotice(err.response?.data?.error || 'Failed to delete spatial rule');
    }
  };

  if (!isOpen) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Spatial Analytics: Vector Tripwire & Continuous Loitering"
      subtitle={`Target: ${cameraName} (${cameraId}) • Hysteresis debounced & exit-reset invariant`}
      icon={<Compass className="w-4 h-4 text-vms-accent" />}
      size="4xl"
      footer={
        <Button variant="secondary" size="sm" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="space-y-4">
        {/* Notice Banners */}
        {errorNotice && (
          <div className="p-3 bg-rose-950/70 border border-rose-800 rounded text-xs font-mono text-rose-300 flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
              <span>{errorNotice}</span>
            </div>
            <button type="button" onClick={() => setErrorNotice(null)} className="text-vms-muted hover:text-vms-text">
              ×
            </button>
          </div>
        )}

        {successNotice && (
          <div className="p-3 bg-emerald-950/70 border border-emerald-800 rounded text-xs font-mono text-emerald-300 flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{successNotice}</span>
            </div>
            <button type="button" onClick={() => setSuccessNotice(null)} className="text-vms-muted hover:text-vms-text">
              ×
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
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
                  className={`px-3 py-1.5 rounded text-xs font-semibold font-mono flex items-center space-x-1.5 transition-colors ${
                    ruleType === 'TRIPWIRE'
                      ? 'bg-vms-accent text-vms-text font-bold'
                      : 'bg-vms-panel text-vms-muted hover:bg-vms-hover'
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
                  className={`px-3 py-1.5 rounded text-xs font-semibold font-mono flex items-center space-x-1.5 transition-colors ${
                    ruleType === 'LOITERING'
                      ? 'bg-sky-500/20 text-sky-400 border border-sky-400 font-bold'
                      : 'bg-vms-panel text-vms-muted hover:bg-vms-hover'
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
                className="text-[11px] font-mono text-vms-muted hover:text-rose-400 transition-colors"
              >
                Clear Canvas
              </button>
            </div>

            {/* Interactive Canvas */}
            <div className="relative aspect-video bg-[#0D0804] border border-vms-border rounded overflow-hidden flex items-center justify-center">
              <canvas
                ref={canvasRef}
                width={640}
                height={360}
                onClick={handleCanvasClick}
                className="w-full h-full cursor-crosshair"
              />
              <div className="absolute top-2 left-2 px-2 py-1 bg-vms-panel/90 backdrop-blur rounded font-mono text-[10px] text-vms-muted border border-vms-border">
                {ruleType === 'TRIPWIRE'
                  ? `Tripwire: Click 2 points to define line (${linePoints.length}/2)`
                  : `Loitering: Click points to draw polygon (${polygonPoints.length} points)`}
              </div>
            </div>

            {/* Invariant Note */}
            <div className="p-3 bg-vms-panel border border-vms-border rounded text-xs text-vms-muted flex items-start space-x-2">
              <Info className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
              <div className="text-[11px] leading-relaxed">
                <strong className="text-vms-text">Architectural Invariant:</strong> Directional tripwires use
                2D vector cross products with track-state hysteresis to eliminate false rapid triggers.
                Loitering requires continuous dwell inside polygon; any exit immediately resets dwell timer.
              </div>
            </div>
          </div>

          {/* Configuration Sidebar */}
          <div className="space-y-4">
            <div className="p-3.5 bg-vms-panel border border-vms-border rounded space-y-3">
              <h3 className="font-bold text-xs uppercase tracking-wider text-vms-accent font-mono">
                Configure Rule Parameters
              </h3>

              <div>
                <label className="block text-[11px] text-vms-muted mb-1 font-mono uppercase tracking-wider">
                  Rule Name
                </label>
                <Input
                  placeholder="e.g. Perimeter Fence North"
                  value={ruleName}
                  onChange={(e) => setRuleName(e.target.value)}
                  className="w-full"
                />
              </div>

              {ruleType === 'TRIPWIRE' ? (
                <div>
                  <label className="block text-[11px] text-vms-muted mb-1 font-mono uppercase tracking-wider">
                    Crossing Direction
                  </label>
                  <select
                    value={direction}
                    onChange={(e) => setDirection(e.target.value as any)}
                    className="w-full bg-vms-surface border border-vms-border rounded p-2 text-xs text-vms-text font-mono focus:outline-none focus:border-vms-accent"
                  >
                    <option value="A_TO_B">A → B (Side A to Side B)</option>
                    <option value="B_TO_A">B → A (Side B to Side A)</option>
                    <option value="BIDIRECTIONAL">BIDIRECTIONAL (Both ways)</option>
                  </select>
                </div>
              ) : (
                <div>
                  <label className="block text-[11px] text-vms-muted mb-1 font-mono uppercase tracking-wider">
                    Continuous Dwell Threshold (Seconds)
                  </label>
                  <Input
                    type="number"
                    min="3"
                    max="600"
                    value={dwellSeconds}
                    onChange={(e) => setDwellSeconds(Number(e.target.value))}
                    className="w-full"
                  />
                </div>
              )}

              <div>
                <label className="block text-[11px] text-vms-muted mb-1 font-mono uppercase tracking-wider">
                  Alert Hysteresis Cooldown (Seconds)
                </label>
                <Input
                  type="number"
                  min="1"
                  max="120"
                  value={cooldownSeconds}
                  onChange={(e) => setCooldownSeconds(Number(e.target.value))}
                  className="w-full"
                />
              </div>

              <Button
                type="button"
                variant="primary"
                size="sm"
                icon={Save}
                onClick={handleSaveRule}
                className="w-full"
              >
                Save Spatial Rule
              </Button>
            </div>

            {/* Configured Rules List */}
            <div className="space-y-2">
              <div className="text-xs font-semibold text-vms-muted font-mono uppercase tracking-wider">
                Existing Rules ({rules.length})
              </div>
              {rules.length === 0 ? (
                <div className="p-3 bg-vms-panel rounded border border-vms-border text-center text-vms-dim font-mono text-[11px]">
                  No spatial rules deployed for this camera.
                </div>
              ) : (
                rules.map((r) => (
                  <div
                    key={r.id}
                    className="p-2.5 bg-vms-surface border border-vms-border rounded flex items-center justify-between text-xs"
                  >
                    <div>
                      <div className="font-semibold text-vms-text font-mono">{r.name}</div>
                      <div className="text-[10px] font-mono text-vms-dim">
                        {r.type} • {r.type === 'TRIPWIRE' ? r.tripwireDirection : `${r.dwellThresholdSeconds}s dwell`}
                      </div>
                    </div>
                    {ruleToDelete === r.id ? (
                      <div className="flex items-center space-x-1">
                        <button
                          type="button"
                          onClick={() => handleDeleteRule(r.id)}
                          className="px-1.5 py-0.5 rounded bg-rose-600 text-white text-[10px] font-mono"
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          onClick={() => setRuleToDelete(null)}
                          className="px-1 py-0.5 text-vms-muted text-[10px]"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setRuleToDelete(r.id)}
                        className="p-1 rounded text-vms-dim hover:text-rose-400 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
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

export default TripwireModal;
