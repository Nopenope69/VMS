import React, { useEffect, useMemo, useState } from 'react';
import { Search, X, Users, Car, ArrowLeft, Check, Ban, Play, ShieldCheck, Route, Map as MapIcon, Siren, Image as ImageIcon } from 'lucide-react';
import JourneyMap from './JourneyMap';
import Button from '../ui/Button';
import {
  Candidate,
  Filters,
  Purpose,
  TrackRecord,
  allowedPurposes,
  candidates as fetchCandidates,
  cropImageUrl,
  decide,
  JourneyMapData,
  journey as fetchJourney,
  journeyFloorplan,
  openJourneyIncident,
  listTracks,
  refusalText,
  sealJourney,
  searchTracks,
} from '../../services/investigationApi';

/**
 * The investigation workspace (North Star Bucket 4), a side panel of the Investigation page:
 *
 *   find (words, a photo or filters) -> open a person or vehicle (playback jumps there) -> follow it to other
 *   cameras (confirm or reject each suggestion) -> its journey (play it, see it on the floor plan, seal it as one
 *   evidence package, open an incident from it).
 *
 * People and plates need a declared purpose, chosen at the top and sent with every request that needs it. Every
 * refusal from the backend is shown as it is, never hidden.
 */
interface Props {
  cameras: Array<{ id: string; name: string }>;
  semanticSearch: boolean;
  canSealEvidence: boolean;
  canOpenIncident: boolean;
  onSearch: () => void;
  onOpenTrack: (t: TrackRecord) => void;
  onPlayJourney: (steps: TrackRecord[]) => void;
  onSealed: (manifestId: string, steps: number) => void;
  onIncident: (alarmId: string, holds: number) => void;
  onClose: () => void;
}

interface Result {
  track: TrackRecord;
  score?: number;
  matchedCropId?: string;
  matchedCrops?: number;
}

const CLASSES = ['person', 'car', 'motorcycle', 'bus', 'truck', 'bicycle', 'backpack', 'handbag', 'suitcase'];
const COLOURS = ['black', 'white', 'grey', 'red', 'orange', 'brown', 'yellow', 'green', 'blue', 'purple', 'pink'];
const DIRECTIONS = ['UP', 'UP_RIGHT', 'RIGHT', 'DOWN_RIGHT', 'DOWN', 'DOWN_LEFT', 'LEFT', 'UP_LEFT', 'STATIONARY'];

/** A datetime-local value in the browser's own time zone (toISOString would be UTC and read as local). */
const localInput = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const day = (iso: string) => new Date(iso).toLocaleDateString();
const terms = (s: string) => s.split(',').map((t) => t.trim()).filter(Boolean);
const gapText = (g: number) => (g < 0 ? 'at the same time' : g < 90 ? `${Math.round(g)} s apart` : `${Math.round(g / 60)} min apart`);

function CropThumb({ cropId, purpose, label }: { cropId: string | null | undefined; purpose: Purpose | null; label: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let revoked = false;
    let made: string | null = null;
    setUrl(null);
    setFailed(false);
    if (!cropId) return;
    cropImageUrl(cropId, purpose)
      .then((u) => {
        made = u;
        if (!revoked) setUrl(u);
      })
      .catch(() => !revoked && setFailed(true));
    return () => {
      revoked = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [cropId, purpose?.purpose, purpose?.reference]);
  return (
    <div className="w-12 h-14 shrink-0 rounded bg-vms-bg border border-vms-border flex items-center justify-center overflow-hidden">
      {url ? <img src={url} alt={label} className="w-full h-full object-cover" /> : <ImageIcon className={`w-4 h-4 ${failed ? 'text-rose-400' : 'text-vms-dim'}`} aria-label={failed ? 'picture not available' : 'no picture'} />}
    </div>
  );
}

/** The route across the picture (ground points, 0..1), first point hollow, last point filled. */
function PathSketch({ path }: { path: TrackRecord['path'] }) {
  if (!path || path.length === 0) return null;
  const pts = path.map((p) => `${(p.x * 160).toFixed(1)},${(p.y * 90).toFixed(1)}`).join(' ');
  const first = path[0];
  const last = path[path.length - 1];
  return (
    <svg viewBox="0 0 160 90" className="w-full h-auto bg-vms-bg border border-vms-border rounded" role="img" aria-label="Route across the camera picture">
      <polyline points={pts} fill="none" stroke="#38bdf8" strokeWidth="1.5" />
      <circle cx={first.x * 160} cy={first.y * 90} r="2.5" fill="none" stroke="#38bdf8" />
      <circle cx={last.x * 160} cy={last.y * 90} r="2.5" fill="#f59e0b" />
    </svg>
  );
}

export const FindPanel: React.FC<Props> = ({ cameras, semanticSearch, canSealEvidence, canOpenIncident, onSearch, onOpenTrack, onPlayJourney, onSealed, onIncident, onClose }) => {
  const camName = useMemo(() => new Map(cameras.map((c) => [c.id, c.name])), [cameras]);
  const name = (id: string) => camName.get(id) || `Camera ${id.slice(0, 6)}`;

  // Purpose, for people and plates.
  const [purposes, setPurposes] = useState<string[]>([]);
  const [needReference, setNeedReference] = useState<string[]>([]);
  const [purposeName, setPurposeName] = useState('');
  const [reference, setReference] = useState('');
  useEffect(() => {
    allowedPurposes()
      .then((r) => {
        setPurposes(r.allowed);
        setNeedReference(r.needReference);
      })
      .catch(() => setPurposes([]));
  }, []);
  const purpose: Purpose | null = purposeName ? { purpose: purposeName, reference: reference.trim() || undefined } : null;

  // Search form.
  const [text, setText] = useState('');
  const [andText, setAndText] = useState('');
  const [notText, setNotText] = useState('');
  const [photo, setPhoto] = useState<{ name: string; base64: string } | null>(null);
  const [camerasSel, setCamerasSel] = useState<string[]>([]);
  const [objectClass, setObjectClass] = useState('');
  const [includePersons, setIncludePersons] = useState(false);
  const [colour, setColour] = useState({ upper: '', lower: '', body: '' });
  const [direction, setDirection] = useState('');
  const [minDwell, setMinDwell] = useState('');
  const [hasPlate, setHasPlate] = useState('');
  const [from, setFrom] = useState(localInput(new Date(Date.now() - 24 * 3_600_000)));
  const [to, setTo] = useState(localInput(new Date()));

  const [results, setResults] = useState<Result[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track, follow and journey.
  const [view, setView] = useState<'search' | 'track' | 'journey'>('search');
  const [current, setCurrent] = useState<Result | null>(null);
  const [follow, setFollow] = useState<{ method: 'appearance' | 'plate'; adjacency?: string; outsideTravelTime?: number; readsWithoutTrack?: Array<{ cameraId: string; firstSeenAt: string }>; list: Candidate[] } | null>(null);
  const [steps, setSteps] = useState<TrackRecord[] | null>(null);
  const [legalHold, setLegalHold] = useState(true);
  const [map, setMap] = useState<JourneyMapData | null>(null);
  const [sealedId, setSealedId] = useState<string | null>(null);
  const [incident, setIncident] = useState<{ title: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; description: string; attach: boolean } | null>(null);
  const [incidentId, setIncidentId] = useState<string | null>(null);

  const isPersonQuery = includePersons || objectClass === 'person' || !!colour.upper || !!colour.lower;

  const filters = (): Filters => ({
    cameraIds: camerasSel.length ? camerasSel : undefined,
    from: from ? new Date(from).toISOString() : undefined,
    to: to ? new Date(to).toISOString() : undefined,
    objectClasses: objectClass ? [objectClass] : undefined,
    direction: direction || undefined,
    upperColour: colour.upper || undefined,
    lowerColour: colour.lower || undefined,
    bodyColour: colour.body || undefined,
    minDwellSeconds: minDwell ? Number(minDwell) : undefined,
    hasPlate: hasPlate === '' ? undefined : hasPlate === 'yes',
  });

  const run = async () => {
    setBusy(true);
    setError(null);
    onSearch();
    try {
      const described = text.trim() || photo;
      if (described) {
        const r = await searchTracks(
          { ...(photo ? { imageJpegBase64: photo.base64 } : { text: text.trim() }), and: terms(andText), not: terms(notText) },
          filters(),
          isPersonQuery,
          purpose
        );
        setResults(r.map((x) => ({ track: x.track, score: x.score, matchedCropId: x.matchedCropId, matchedCrops: x.matchedCrops })));
      } else {
        const r = await listTracks(filters(), isPersonQuery, purpose);
        setResults(r.map((t) => ({ track: t })));
      }
    } catch (err) {
      setResults(null);
      setError(refusalText(err, 'Search failed'));
    } finally {
      setBusy(false);
    }
  };

  const readPhoto = (file: File | undefined) => {
    if (!file) return setPhoto(null);
    if (file.type !== 'image/jpeg') {
      setError('The photo must be a JPEG.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setPhoto({ name: file.name, base64: String(reader.result).split(',')[1] || '' });
    reader.readAsDataURL(file);
  };

  const open = (r: Result) => {
    setCurrent(r);
    setFollow(null);
    setSteps(null);
    setError(null);
    setView('track');
    onOpenTrack(r.track);
  };

  const sensitive = (t: TrackRecord) => (t.objectClass === 'person' ? purpose : null);

  const loadFollow = async (method: 'appearance' | 'plate') => {
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetchCandidates(current.track.id, method, method === 'plate' ? purpose : sensitive(current.track));
      setFollow({ method, adjacency: r.adjacency, outsideTravelTime: r.outsideTravelTime, readsWithoutTrack: r.readsWithoutTrack, list: r.candidates });
    } catch (err) {
      setFollow(null);
      setError(refusalText(err, 'Could not load suggestions'));
    } finally {
      setBusy(false);
    }
  };

  const decideOn = async (c: Candidate, decision: 'CONFIRMED' | 'REJECTED') => {
    if (!current || !follow) return;
    setError(null);
    try {
      const method = follow.method === 'plate' ? 'PLATE' : 'APPEARANCE';
      await decide(current.track.id, { toTrackId: c.track.id, method, decision }, method === 'PLATE' ? purpose : sensitive(current.track));
      setFollow({ ...follow, list: decision === 'REJECTED' ? follow.list.filter((x) => x.track.id !== c.track.id) : follow.list.map((x) => (x.track.id === c.track.id ? { ...x, decision } : x)) });
    } catch (err) {
      setError(refusalText(err, 'Could not record the decision'));
    }
  };

  const loadJourney = async () => {
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      const j = await fetchJourney(current.track.id, sensitive(current.track));
      setSteps(j.steps);
      setMap(null);
      setSealedId(null);
      setIncident(null);
      setIncidentId(null);
      setView('journey');
    } catch (err) {
      setError(refusalText(err, 'Could not load the journey'));
    } finally {
      setBusy(false);
    }
  };

  const seal = async () => {
    if (!steps?.length || !current) return;
    setError(null);
    try {
      const m = await sealJourney(steps, legalHold, `Journey of ${current.track.objectClass} track ${current.track.id}: ${steps.length} sightings on ${new Set(steps.map((s) => s.cameraId)).size} cameras`);
      setSealedId(m.id);
      onSealed(m.id, steps.length);
    } catch (err) {
      setError(refusalText(err, 'Could not seal the evidence'));
    }
  };

  const showMap = async () => {
    if (!current) return;
    if (map) return setMap(null);
    setError(null);
    try {
      setMap(await journeyFloorplan(current.track.id, sensitive(current.track)));
    } catch (err) {
      setError(refusalText(err, 'Could not load the floor plan'));
    }
  };

  const startIncident = () => {
    if (!steps?.length || !current) return;
    const cams = new Set(steps.map((s) => s.cameraId)).size;
    setIncident({ title: `${current.track.objectClass} seen on ${cams} camera(s), ${time(steps[0].firstSeenAt)}`, severity: 'WARNING', description: '', attach: true });
  };

  const submitIncident = async () => {
    if (!incident || !current) return;
    setError(null);
    try {
      const out = await openJourneyIncident(
        current.track.id,
        {
          title: incident.title,
          severity: incident.severity,
          description: incident.description || undefined,
          evidenceManifestId: incident.attach && sealedId ? sealedId : undefined,
        },
        sensitive(current.track)
      );
      setIncident(null);
      setIncidentId(out.alarm.id);
      onIncident(out.alarm.id, out.holds);
    } catch (err) {
      setError(refusalText(err, 'Could not open the incident'));
    }
  };

  const describe = (t: TrackRecord) => {
    const c = t.colours;
    const colours = [c.upper && `${c.upper} top`, c.lower && `${c.lower} bottom`, c.body].filter(Boolean).join(', ');
    return `${t.objectClass}${colours ? ` (${colours})` : ''}`;
  };

  const sel = 'bg-vms-surface border border-vms-border rounded px-2 py-1 text-xs text-vms-text w-full';
  const lbl = 'text-[10px] uppercase tracking-wide text-vms-muted font-mono';

  return (
    <aside className="w-[380px] shrink-0 border-l border-vms-border bg-vms-panel flex flex-col min-h-0" aria-label="Find people and vehicles">
      <div className="h-10 px-3 border-b border-vms-border flex items-center justify-between shrink-0">
        <div className="flex items-center space-x-2">
          {view !== 'search' && (
            <button onClick={() => setView(view === 'journey' ? 'track' : 'search')} aria-label="Back" className="text-vms-muted hover:text-vms-text">
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          <span className="text-xs font-mono font-bold uppercase tracking-wider">{view === 'search' ? 'Find' : view === 'track' ? 'Person / vehicle' : 'Journey'}</span>
        </div>
        <button onClick={onClose} aria-label="Close find panel" className="text-vms-muted hover:text-vms-text">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="px-3 py-2 border-b border-vms-border space-y-1 shrink-0">
        <label className={lbl} htmlFor="find-purpose">Reason (needed for people and plates)</label>
        <div className="flex space-x-2">
          <select id="find-purpose" aria-label="Purpose" value={purposeName} onChange={(e) => setPurposeName(e.target.value)} className={sel}>
            <option value="">No reason given</option>
            {purposes.map((p) => (
              <option key={p} value={p}>
                {p.replace(/_/g, ' ').toLowerCase()}
              </option>
            ))}
          </select>
          {needReference.includes(purposeName) && <input aria-label="Purpose reference" placeholder="Case reference" value={reference} onChange={(e) => setReference(e.target.value)} className={sel} />}
        </div>
      </div>

      {error && (
        <div role="alert" className="mx-3 mt-2 text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded px-2 py-1.5 shrink-0">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3 min-h-0">
        {view === 'search' && (
          <>
            <div className="space-y-2">
              {semanticSearch && (
                <>
                  <input aria-label="Describe what you are looking for" placeholder='e.g. "white SUV", "man in a blue shirt"' value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} className={sel} disabled={!!photo} />
                  <div className="flex items-center space-x-2">
                    <label className="text-xs text-vms-muted cursor-pointer underline">
                      {photo ? `Photo: ${photo.name}` : 'or search by photo (JPEG)'}
                      <input type="file" accept="image/jpeg" aria-label="Photo" className="hidden" onChange={(e) => readPhoto(e.target.files?.[0])} />
                    </label>
                    {photo && (
                      <button className="text-xs text-rose-300" onClick={() => setPhoto(null)}>
                        remove
                      </button>
                    )}
                  </div>
                  <input aria-label="Must also look like" placeholder="also looks like (comma-separated)" value={andText} onChange={(e) => setAndText(e.target.value)} className={sel} />
                  <input aria-label="Must not look like" placeholder="does not look like (comma-separated)" value={notText} onChange={(e) => setNotText(e.target.value)} className={sel} />
                </>
              )}
              {!semanticSearch && <p className="text-xs text-vms-muted">Search by description needs semantic search; filters still work.</p>}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <span className={lbl}>From</span>
                <input type="datetime-local" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} className={sel} />
              </div>
              <div>
                <span className={lbl}>To</span>
                <input type="datetime-local" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} className={sel} />
              </div>
              <div>
                <span className={lbl}>Type</span>
                <select aria-label="Object type" value={objectClass} onChange={(e) => setObjectClass(e.target.value)} className={sel}>
                  <option value="">any</option>
                  {CLASSES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <span className={lbl}>Direction</span>
                <select aria-label="Direction" value={direction} onChange={(e) => setDirection(e.target.value)} className={sel}>
                  <option value="">any</option>
                  {DIRECTIONS.map((d) => (
                    <option key={d} value={d}>
                      {d.replace('_', ' ').toLowerCase()}
                    </option>
                  ))}
                </select>
              </div>
              {(['upper', 'lower', 'body'] as const).map((k) => (
                <div key={k}>
                  <span className={lbl}>{k === 'upper' ? 'Top colour' : k === 'lower' ? 'Bottom colour' : 'Vehicle colour'}</span>
                  <select aria-label={k === 'upper' ? 'Top colour' : k === 'lower' ? 'Bottom colour' : 'Vehicle colour'} value={colour[k]} onChange={(e) => setColour({ ...colour, [k]: e.target.value })} className={sel}>
                    <option value="">any</option>
                    {COLOURS.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
              <div>
                <span className={lbl}>Stayed at least (s)</span>
                <input aria-label="Minimum time on scene" inputMode="numeric" value={minDwell} onChange={(e) => setMinDwell(e.target.value.replace(/\D/g, ''))} className={sel} />
              </div>
              <div>
                <span className={lbl}>Plate read</span>
                <select aria-label="Plate read" value={hasPlate} onChange={(e) => setHasPlate(e.target.value)} className={sel}>
                  <option value="">either</option>
                  <option value="yes">yes</option>
                  <option value="no">no</option>
                </select>
              </div>
            </div>

            <div>
              <span className={lbl}>Cameras</span>
              <div className="flex flex-wrap gap-1 mt-1">
                {cameras.map((c) => (
                  <button
                    key={c.id}
                    aria-pressed={camerasSel.includes(c.id)}
                    onClick={() => setCamerasSel(camerasSel.includes(c.id) ? camerasSel.filter((x) => x !== c.id) : [...camerasSel, c.id])}
                    className={`px-2 py-0.5 rounded border text-[11px] ${camerasSel.includes(c.id) ? 'bg-amber-500 text-slate-950 border-amber-500' : 'border-vms-border text-vms-muted'}`}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            </div>

            <label className="flex items-center space-x-2 text-xs">
              <input type="checkbox" checked={includePersons} onChange={(e) => setIncludePersons(e.target.checked)} aria-label="Include people" />
              <Users className="w-3.5 h-3.5" />
              <span>Include people (needs a reason; audited)</span>
            </label>

            <Button variant="primary" size="sm" icon={Search} onClick={run} disabled={busy} className="w-full">
              Find
            </Button>

            {results && (
              <div className="space-y-1.5" aria-label="Results">
                <div className="text-[11px] text-vms-muted">{results.length === 0 ? 'Nothing found.' : `${results.length} found, ${results[0].score !== undefined ? 'best match first' : 'newest first'}`}</div>
                {results.map((r) => (
                  <button
                    key={r.track.id}
                    onClick={() => open(r)}
                    aria-label={`Open ${r.track.objectClass} on ${name(r.track.cameraId)} at ${time(r.track.firstSeenAt)}`}
                    className="w-full flex items-center space-x-2 p-1.5 rounded border border-vms-border hover:border-sky-500 text-left"
                  >
                    <CropThumb cropId={r.matchedCropId ?? r.track.bestCropId} purpose={sensitive(r.track)} label={describe(r.track)} />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold truncate">{describe(r.track)}</div>
                      <div className="text-[11px] text-vms-muted">
                        {name(r.track.cameraId)} · {day(r.track.firstSeenAt)} {time(r.track.firstSeenAt)} · {Math.round(r.track.dwellSeconds)} s
                      </div>
                      {r.score !== undefined && <div className="text-[10px] font-mono text-sky-400">match {r.score.toFixed(2)}{r.matchedCrops ? ` · ${r.matchedCrops} frames` : ''}</div>}
                    </div>
                    {r.track.objectClass === 'person' ? <Users className="w-3.5 h-3.5 text-vms-dim" /> : <Car className="w-3.5 h-3.5 text-vms-dim" />}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {view === 'track' && current && (
          <div className="space-y-3">
            <div className="flex space-x-2">
              <CropThumb cropId={current.matchedCropId ?? current.track.bestCropId} purpose={sensitive(current.track)} label={describe(current.track)} />
              <div className="text-xs space-y-0.5">
                <div className="font-semibold">{describe(current.track)}</div>
                <div className="text-vms-muted">{name(current.track.cameraId)}</div>
                <div className="text-vms-muted">
                  {day(current.track.firstSeenAt)} {time(current.track.firstSeenAt)} – {time(current.track.lastSeenAt)} ({Math.round(current.track.dwellSeconds)} s)
                </div>
                {current.track.direction && <div className="text-vms-muted">moving {current.track.direction.replace('_', ' ').toLowerCase()}</div>}
                {'linked' in (current.track.plate || {}) && (current.track.plate as any).linked && <div className="text-vms-muted">plate read</div>}
              </div>
            </div>
            <PathSketch path={current.track.path} />
            {current.track.zones.length > 0 && <div className="text-[11px] text-vms-muted">Zones: {current.track.zones.map((z) => z.name).join(', ')}</div>}

            <div className="flex flex-wrap gap-1.5">
              <Button size="xs" variant="secondary" icon={Play} onClick={() => onOpenTrack(current.track)}>
                Play
              </Button>
              {semanticSearch && (
                <Button size="xs" variant="secondary" icon={Users} onClick={() => loadFollow('appearance')} disabled={busy}>
                  Follow by appearance
                </Button>
              )}
              {current.track.objectClass !== 'person' && (current.track.plate as any)?.linked === true && (
                <Button size="xs" variant="secondary" icon={Car} onClick={() => loadFollow('plate')} disabled={busy}>
                  Follow by plate
                </Button>
              )}
              <Button size="xs" variant="primary" icon={Route} onClick={loadJourney} disabled={busy}>
                Show journey
              </Button>
            </div>

            {follow && (
              <div className="space-y-1.5" aria-label="Suggestions">
                <div className="text-[11px] text-vms-muted">
                  {follow.list.length === 0 ? 'No suggestions.' : `${follow.list.length} suggestion(s), best first. Confirm only what you have checked on the video.`}
                  {follow.adjacency === 'site-fallback' && ' No camera neighbours are set for this camera: suggestions come from the whole site.'}
                  {!!follow.outsideTravelTime && ` ${follow.outsideTravelTime} look-alike(s) left out: their timing does not fit the travel time.`}
                </div>
                {follow.list.map((c) => (
                  <div key={c.track.id} className="flex items-center space-x-2 p-1.5 rounded border border-vms-border" aria-label={`Suggestion on ${name(c.track.cameraId)}`}>
                    <CropThumb cropId={c.matchedCropId ?? c.track.bestCropId} purpose={sensitive(c.track)} label={describe(c.track)} />
                    <div className="flex-1 min-w-0 text-[11px]">
                      <div className="font-semibold text-xs">{name(c.track.cameraId)}</div>
                      <div className="text-vms-muted">
                        {time(c.track.firstSeenAt)} · {gapText(c.gapSeconds)}
                      </div>
                      <div className="font-mono text-sky-400">{follow.method === 'plate' ? 'same plate' : `match ${c.score.toFixed(2)}`}</div>
                    </div>
                    <div className="flex flex-col space-y-1">
                      <button className="text-[11px] text-sky-300" onClick={() => onOpenTrack(c.track)}>
                        View
                      </button>
                      {c.decision === 'CONFIRMED' ? (
                        <span className="text-[11px] text-emerald-400">Confirmed</span>
                      ) : (
                        <>
                          <button className="text-[11px] text-emerald-300 flex items-center" onClick={() => decideOn(c, 'CONFIRMED')}>
                            <Check className="w-3 h-3 mr-0.5" />
                            Confirm
                          </button>
                          <button className="text-[11px] text-rose-300 flex items-center" onClick={() => decideOn(c, 'REJECTED')}>
                            <Ban className="w-3 h-3 mr-0.5" />
                            Reject
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
                {!!follow.readsWithoutTrack?.length && (
                  <div className="text-[11px] text-vms-muted">
                    Also read (vehicle not detected): {follow.readsWithoutTrack.map((r) => `${name(r.cameraId)} ${time(r.firstSeenAt)}`).join(', ')}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {view === 'journey' && steps && (
          <div className="space-y-2">
            <div className="text-[11px] text-vms-muted">
              {steps.length} sighting(s) on {new Set(steps.map((s) => s.cameraId)).size} camera(s), linked by confirmed decisions.
            </div>
            <ol className="space-y-1" aria-label="Journey steps">
              {steps.map((s, i) => (
                <li key={s.id}>
                  <button onClick={() => onOpenTrack(s)} className="w-full text-left flex items-center space-x-2 p-1.5 rounded border border-vms-border hover:border-sky-500" aria-label={`Step ${i + 1}: ${name(s.cameraId)} at ${time(s.firstSeenAt)}`}>
                    <span className="font-mono text-[10px] text-amber-400 w-5">{i + 1}</span>
                    <span className="text-xs flex-1">{name(s.cameraId)}</span>
                    <span className="text-[11px] text-vms-muted">
                      {time(s.firstSeenAt)} – {time(s.lastSeenAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap gap-1.5">
              <Button size="xs" variant="secondary" icon={Play} onClick={() => onPlayJourney(steps)}>
                Play journey
              </Button>
              <Button size="xs" variant="secondary" icon={MapIcon} onClick={showMap}>
                {map ? 'Hide floor plan' : 'Show on floor plan'}
              </Button>
              {canSealEvidence && (
                <Button size="xs" variant="primary" icon={ShieldCheck} onClick={seal}>
                  Seal journey as evidence
                </Button>
              )}
              {canOpenIncident && !incident && !incidentId && (
                <Button size="xs" variant="secondary" icon={Siren} onClick={startIncident}>
                  Open incident
                </Button>
              )}
            </div>
            {map && <JourneyMap data={map} time={time} />}
            {incident && (
              <form
                className="space-y-1.5 p-2 border border-vms-border rounded"
                aria-label="New incident"
                onSubmit={(e) => {
                  e.preventDefault();
                  submitIncident();
                }}
              >
                <input className={sel} aria-label="Incident title" value={incident.title} maxLength={200} onChange={(e) => setIncident({ ...incident, title: e.target.value })} />
                <select className={sel} aria-label="Severity" value={incident.severity} onChange={(e) => setIncident({ ...incident, severity: e.target.value as 'INFO' | 'WARNING' | 'CRITICAL' })}>
                  <option value="INFO">Info</option>
                  <option value="WARNING">Warning</option>
                  <option value="CRITICAL">Critical</option>
                </select>
                <textarea className={sel} aria-label="Incident notes" rows={2} maxLength={2000} placeholder="Notes (optional)" value={incident.description} onChange={(e) => setIncident({ ...incident, description: e.target.value })} />
                {sealedId && (
                  <label className="flex items-center space-x-2 text-xs">
                    <input type="checkbox" checked={incident.attach} onChange={(e) => setIncident({ ...incident, attach: e.target.checked })} aria-label="Attach the sealed evidence package" />
                    <span>Attach the sealed evidence package</span>
                  </label>
                )}
                <div className="text-[10px] text-vms-dim">Footage on every camera of the journey is held, from a minute before the first sighting to two minutes after the last.</div>
                <div className="flex gap-1.5">
                  <Button size="xs" variant="primary" type="submit" disabled={!incident.title.trim()}>
                    Create incident
                  </Button>
                  <Button size="xs" variant="secondary" type="button" onClick={() => setIncident(null)}>
                    Cancel
                  </Button>
                </div>
              </form>
            )}
            {incidentId && <div className="text-[11px] text-emerald-400">Incident opened. It is on the Alarms page.</div>}
            {canSealEvidence && (
              <label className="flex items-center space-x-2 text-xs">
                <input type="checkbox" checked={legalHold} onChange={(e) => setLegalHold(e.target.checked)} aria-label="Legal hold" />
                <span>Legal hold (recordings kept until released)</span>
              </label>
            )}
          </div>
        )}
      </div>
    </aside>
  );
};

export default FindPanel;
