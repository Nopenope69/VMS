import React, { useState, useEffect, useRef } from 'react';
import { Compass, Square, Trash2, Save, ArrowRight, Info, AlertCircle, CheckCircle2, Briefcase, Navigation } from 'lucide-react';
import api from '../services/api';
import Modal from './ui/Modal';
import Button from './ui/Button';
import Input from './ui/Input';

interface Point2D {
  x: number;
  y: number;
}

type RuleType = 'TRIPWIRE' | 'LOITERING' | 'UNATTENDED_OBJECT' | 'WRONG_WAY';

/** A rule as the backend stores it (coordinates normalised to the camera image, 0..1). */
interface SpatialRule {
  id: string;
  name: string;
  type: RuleType;
  cameraId: string;
  direction?: 'A_TO_B' | 'B_TO_A' | 'BIDIRECTIONAL';
  lineCoordinatesJson?: [Point2D, Point2D] | null;
  polygonCoordinatesJson?: Point2D[] | null;
  dwellThresholdSeconds?: number | null;
  paramsJson?: { objectClasses?: string[] } | null;
  cooldownSeconds: number;
}

interface TripwireModalProps {
  isOpen: boolean;
  onClose: () => void;
  cameraId?: string;
  cameraName?: string;
}

const CANVAS_W = 640;
const CANVAS_H = 360;
const VEHICLE_CLASSES = ['car', 'motorcycle', 'bus', 'truck', 'bicycle'];
const ALL_CLASSES = ['person', ...VEHICLE_CLASSES];

const TYPES: Array<{ type: RuleType; label: string; icon: React.ElementType; help: string }> = [
  { type: 'TRIPWIRE', label: 'Tripwire line', icon: ArrowRight, help: 'Click 2 points for the line. Alerts when a tracked object crosses it in the chosen direction.' },
  { type: 'LOITERING', label: 'Loitering zone', icon: Square, help: 'Click 3 or more points for the zone. Alerts when someone stays inside without leaving for the set time.' },
  {
    type: 'UNATTENDED_OBJECT',
    label: 'Unattended bag',
    icon: Briefcase,
    help: 'Click 3 or more points for the zone. Alerts when a backpack, handbag or suitcase lies still in it with nobody near it for the set time.',
  },
  {
    type: 'WRONG_WAY',
    label: 'Wrong way',
    icon: Navigation,
    help: 'Click 3 or more points for the zone, then switch to "Arrow" and click 2 points for the allowed direction. Alerts when something inside moves against the arrow.',
  },
];

const toNorm = (p: Point2D): Point2D => ({ x: +(p.x / CANVAS_W).toFixed(4), y: +(p.y / CANVAS_H).toFixed(4) });

export const TripwireModal: React.FC<TripwireModalProps> = ({ isOpen, onClose, cameraId = '', cameraName = '' }) => {
  const [rules, setRules] = useState<SpatialRule[]>([]);
  const [ruleType, setRuleType] = useState<RuleType>('TRIPWIRE');
  const [ruleName, setRuleName] = useState('');
  const [direction, setDirection] = useState<'A_TO_B' | 'B_TO_A' | 'BIDIRECTIONAL'>('A_TO_B');
  const [dwellSeconds, setDwellSeconds] = useState(15);
  const [unattendedSeconds, setUnattendedSeconds] = useState(60);
  const [cooldownSeconds, setCooldownSeconds] = useState(10);
  const [wrongWayClasses, setWrongWayClasses] = useState<string[]>(VEHICLE_CLASSES);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const [ruleToDelete, setRuleToDelete] = useState<string | null>(null);

  // Drawing state, in canvas pixels; converted to 0..1 when saved.
  const [linePoints, setLinePoints] = useState<Point2D[]>([]);
  const [polygonPoints, setPolygonPoints] = useState<Point2D[]>([]);
  /** WRONG_WAY draws a zone and an arrow; this says which one the clicks go to. */
  const [drawing, setDrawing] = useState<'zone' | 'arrow'>('zone');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const needsLine = ruleType === 'TRIPWIRE' || (ruleType === 'WRONG_WAY' && drawing === 'arrow');

  const fetchRules = async () => {
    try {
      const res = await api.get(`/spatial-rules/${cameraId}`);
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

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
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

    if (ruleType !== 'TRIPWIRE' && polygonPoints.length > 0) {
      ctx.strokeStyle = '#38BDF8';
      ctx.fillStyle = 'rgba(56, 189, 248, 0.2)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(polygonPoints[0].x, polygonPoints[0].y);
      for (let i = 1; i < polygonPoints.length; i++) ctx.lineTo(polygonPoints[i].x, polygonPoints[i].y);
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

    if ((ruleType === 'TRIPWIRE' || ruleType === 'WRONG_WAY') && linePoints.length > 0) {
      ctx.strokeStyle = ruleType === 'WRONG_WAY' ? '#10B981' : '#C05800';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(linePoints[0].x, linePoints[0].y);
      for (let i = 1; i < linePoints.length; i++) ctx.lineTo(linePoints[i].x, linePoints[i].y);
      ctx.stroke();
      if (ruleType === 'WRONG_WAY' && linePoints.length === 2) {
        // Arrow head on the allowed direction.
        const [a, b] = linePoints;
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        ctx.fillStyle = '#10B981';
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x - 14 * Math.cos(ang - 0.4), b.y - 14 * Math.sin(ang - 0.4));
        ctx.lineTo(b.x - 14 * Math.cos(ang + 0.4), b.y - 14 * Math.sin(ang + 0.4));
        ctx.closePath();
        ctx.fill();
      }
      linePoints.forEach((p, idx) => {
        ctx.fillStyle = idx === 0 ? '#10B981' : '#EF4444';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6, 0, 2 * Math.PI);
        ctx.fill();
        if (ruleType === 'TRIPWIRE') {
          ctx.fillStyle = '#FDFBD4';
          ctx.font = '11px monospace';
          ctx.fillText(idx === 0 ? 'Point A' : 'Point B', p.x + 8, p.y - 8);
        }
      });
    }
  }, [linePoints, polygonPoints, ruleType]);

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.round((e.clientX - rect.left) * (canvas.width / rect.width));
    const y = Math.round((e.clientY - rect.top) * (canvas.height / rect.height));
    if (needsLine) setLinePoints(linePoints.length >= 2 ? [{ x, y }] : [...linePoints, { x, y }]);
    else setPolygonPoints([...polygonPoints, { x, y }]);
  };

  const selectType = (t: RuleType) => {
    setRuleType(t);
    setLinePoints([]);
    setPolygonPoints([]);
    setDrawing('zone');
    setCooldownSeconds(t === 'UNATTENDED_OBJECT' ? 300 : t === 'LOITERING' ? 30 : 10);
  };

  const handleSaveRule = async () => {
    setErrorNotice(null);
    setSuccessNotice(null);
    if (!ruleName.trim()) return setErrorNotice('Please provide a rule name');
    if (ruleType === 'TRIPWIRE' && linePoints.length < 2) return setErrorNotice('Click two points to draw the tripwire');
    if (ruleType !== 'TRIPWIRE' && polygonPoints.length < 3) return setErrorNotice('Click at least 3 points to draw the zone');
    if (ruleType === 'WRONG_WAY' && linePoints.length < 2) return setErrorNotice('Switch to "Arrow" and click two points for the allowed direction');
    if (ruleType === 'WRONG_WAY' && wrongWayClasses.length === 0) return setErrorNotice('Pick at least one kind of object to watch');

    const base = { name: ruleName.trim(), type: ruleType, cameraId, cooldownSeconds };
    const zone = polygonPoints.map(toNorm);
    const line = linePoints.map(toNorm);
    const body =
      ruleType === 'TRIPWIRE'
        ? { ...base, direction, lineCoordinates: line }
        : ruleType === 'LOITERING'
          ? { ...base, polygonCoordinates: zone, dwellThresholdSeconds: dwellSeconds }
          : ruleType === 'UNATTENDED_OBJECT'
            ? { ...base, polygonCoordinates: zone, dwellThresholdSeconds: unattendedSeconds }
            : { ...base, polygonCoordinates: zone, lineCoordinates: line, params: { objectClasses: wrongWayClasses } };
    try {
      await api.post('/spatial-rules', body);
      setRuleName('');
      setLinePoints([]);
      setPolygonPoints([]);
      setDrawing('zone');
      setSuccessNotice('Rule saved.');
      fetchRules();
    } catch (err: any) {
      const d = err.response?.data;
      setErrorNotice(d?.details?.join('; ') || d?.error || 'Failed to create spatial rule');
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

  const describe = (r: SpatialRule) => {
    if (r.type === 'TRIPWIRE') return r.direction || 'BIDIRECTIONAL';
    if (r.type === 'LOITERING') return `${r.dwellThresholdSeconds}s in zone`;
    if (r.type === 'UNATTENDED_OBJECT') return `bag left ${r.dwellThresholdSeconds}s`;
    return `against arrow: ${(r.paramsJson?.objectClasses || ['any']).join(', ')}`;
  };

  if (!isOpen) return null;
  const help = TYPES.find((t) => t.type === ruleType)!.help;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Spatial rules: tripwire, loitering, unattended bag, wrong way"
      subtitle={`Camera: ${cameraName}`}
      icon={<Compass className="w-4 h-4 text-vms-accent" />}
      size="4xl"
      footer={
        <Button variant="secondary" size="sm" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="space-y-4">
        {errorNotice && (
          <div role="alert" className="p-3 bg-rose-950/70 border border-rose-800 rounded text-xs font-mono text-rose-300 flex items-center justify-between">
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
          <div role="status" className="p-3 bg-emerald-950/70 border border-emerald-800 rounded text-xs font-mono text-emerald-300 flex items-center justify-between">
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
          <div className="lg:col-span-2 space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center flex-wrap gap-2">
                {TYPES.map(({ type, label, icon: Icon }) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => selectType(type)}
                    aria-pressed={ruleType === type}
                    className={`px-3 py-1.5 rounded text-xs font-semibold font-mono flex items-center space-x-1.5 transition-colors ${
                      ruleType === type ? 'bg-vms-accent text-vms-text font-bold' : 'bg-vms-panel text-vms-muted hover:bg-vms-hover'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => {
                  setLinePoints([]);
                  setPolygonPoints([]);
                  setDrawing('zone');
                }}
                className="text-[11px] font-mono text-vms-muted hover:text-rose-400 transition-colors"
              >
                Clear drawing
              </button>
            </div>

            {ruleType === 'WRONG_WAY' && (
              <div className="flex items-center gap-2 text-[11px] font-mono">
                <span className="text-vms-muted">Drawing:</span>
                {(['zone', 'arrow'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={drawing === m}
                    onClick={() => setDrawing(m)}
                    className={`px-2 py-1 rounded ${drawing === m ? 'bg-sky-500/20 text-sky-300 border border-sky-400' : 'bg-vms-panel text-vms-muted'}`}
                  >
                    {m === 'zone' ? `Zone (${polygonPoints.length} points)` : `Arrow (${linePoints.length}/2)`}
                  </button>
                ))}
              </div>
            )}

            <div className="relative aspect-video bg-[#0D0804] border border-vms-border rounded overflow-hidden flex items-center justify-center">
              <canvas
                ref={canvasRef}
                width={CANVAS_W}
                height={CANVAS_H}
                onClick={handleCanvasClick}
                data-testid="rule-canvas"
                className="w-full h-full cursor-crosshair"
              />
            </div>

            <div className="p-3 bg-vms-panel border border-vms-border rounded text-xs text-vms-muted flex items-start space-x-2">
              <Info className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
              <div className="text-[11px] leading-relaxed">{help}</div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="p-3.5 bg-vms-panel border border-vms-border rounded space-y-3">
              <h3 className="font-bold text-xs uppercase tracking-wider text-vms-accent font-mono">Rule settings</h3>
              <div>
                <label htmlFor="rule-name" className="block text-[11px] text-vms-muted mb-1 font-mono uppercase tracking-wider">
                  Rule name
                </label>
                <Input id="rule-name" placeholder="e.g. Platform 1 entrance" value={ruleName} onChange={(e) => setRuleName(e.target.value)} className="w-full" />
              </div>

              {ruleType === 'TRIPWIRE' && (
                <div>
                  <label htmlFor="rule-direction" className="block text-[11px] text-vms-muted mb-1 font-mono uppercase tracking-wider">
                    Crossing direction
                  </label>
                  <select
                    id="rule-direction"
                    value={direction}
                    onChange={(e) => setDirection(e.target.value as any)}
                    className="w-full bg-vms-surface border border-vms-border rounded p-2 text-xs text-vms-text font-mono focus:outline-none focus:border-vms-accent"
                  >
                    <option value="A_TO_B">A → B</option>
                    <option value="B_TO_A">B → A</option>
                    <option value="BIDIRECTIONAL">Both ways</option>
                  </select>
                </div>
              )}

              {ruleType === 'LOITERING' && (
                <div>
                  <label htmlFor="rule-dwell" className="block text-[11px] text-vms-muted mb-1 font-mono uppercase tracking-wider">
                    Time in zone (seconds)
                  </label>
                  <Input id="rule-dwell" type="number" min="3" max="600" value={dwellSeconds} onChange={(e) => setDwellSeconds(Number(e.target.value))} className="w-full" />
                </div>
              )}

              {ruleType === 'UNATTENDED_OBJECT' && (
                <div>
                  <label htmlFor="rule-unattended" className="block text-[11px] text-vms-muted mb-1 font-mono uppercase tracking-wider">
                    Left with nobody near (seconds)
                  </label>
                  <Input
                    id="rule-unattended"
                    type="number"
                    min="10"
                    max="3600"
                    value={unattendedSeconds}
                    onChange={(e) => setUnattendedSeconds(Number(e.target.value))}
                    className="w-full"
                  />
                </div>
              )}

              {ruleType === 'WRONG_WAY' && (
                <fieldset>
                  <legend className="block text-[11px] text-vms-muted mb-1 font-mono uppercase tracking-wider">Watch</legend>
                  <div className="flex flex-wrap gap-2">
                    {ALL_CLASSES.map((c) => (
                      <label key={c} className="flex items-center gap-1 text-[11px] font-mono text-vms-text">
                        <input
                          type="checkbox"
                          checked={wrongWayClasses.includes(c)}
                          onChange={(e) => setWrongWayClasses(e.target.checked ? [...wrongWayClasses, c] : wrongWayClasses.filter((x) => x !== c))}
                        />
                        {c}
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}

              <div>
                <label htmlFor="rule-cooldown" className="block text-[11px] text-vms-muted mb-1 font-mono uppercase tracking-wider">
                  Cooldown between alerts (seconds)
                </label>
                <Input id="rule-cooldown" type="number" min="1" max="86400" value={cooldownSeconds} onChange={(e) => setCooldownSeconds(Number(e.target.value))} className="w-full" />
              </div>

              <Button type="button" variant="primary" size="sm" icon={Save} onClick={handleSaveRule} className="w-full">
                Save rule
              </Button>
            </div>

            <div className="space-y-2">
              <div className="text-xs font-semibold text-vms-muted font-mono uppercase tracking-wider">Rules on this camera ({rules.length})</div>
              {rules.length === 0 ? (
                <div className="p-3 bg-vms-panel rounded border border-vms-border text-center text-vms-dim font-mono text-[11px]">No spatial rules on this camera.</div>
              ) : (
                rules.map((r) => (
                  <div key={r.id} data-testid="spatial-rule" className="p-2.5 bg-vms-surface border border-vms-border rounded flex items-center justify-between text-xs">
                    <div>
                      <div className="font-semibold text-vms-text font-mono">{r.name}</div>
                      <div className="text-[10px] font-mono text-vms-dim">
                        {r.type} • {describe(r)}
                      </div>
                    </div>
                    {ruleToDelete === r.id ? (
                      <div className="flex items-center space-x-1">
                        <button type="button" onClick={() => handleDeleteRule(r.id)} className="px-1.5 py-0.5 rounded bg-rose-600 text-white text-[10px] font-mono">
                          Confirm
                        </button>
                        <button type="button" onClick={() => setRuleToDelete(null)} className="px-1 py-0.5 text-vms-muted text-[10px]">
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Delete ${r.name}`}
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
