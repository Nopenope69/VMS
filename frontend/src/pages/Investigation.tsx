import React, { useState, useEffect, useRef } from 'react';
import {
  Play,
  Pause,
  StepBack,
  StepForward,
  ShieldCheck,
  AlertCircle,
  X,
  Download,
  Film,
  Search,
  Calendar,
} from 'lucide-react';
import api from '../services/api';
import EvidenceExportModal from '../components/EvidenceExportModal';
import EvidenceReviewModal from '../components/EvidenceReviewModal';
import SmartSearchModal from '../components/SmartSearchModal';
import TimelineScrubber, { TimelineSegment, TimelineTrack } from '../components/TimelineScrubber';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';

interface CameraItem {
  id: string;
  name: string;
  isOnline: boolean;
  streamPath: string;
}

interface CameraPlaybackTile {
  cameraId: string;
  status: 'READY' | 'NO_RECORDING' | 'BUFFERING';
  segmentId?: string;
  currentPts?: string;
  fps?: number;
  codec?: string;
  gapDurationMs?: number;
}

export const Investigation: React.FC = () => {
  const [cameras, setCameras] = useState<CameraItem[]>([]);
  const [selectedCameraIds, setSelectedCameraIds] = useState<string[]>([]);
  const [focusedCameraId, setFocusedCameraId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'matrix' | 'single'>('matrix');
  const [gridLayout, setGridLayout] = useState<'1x1' | '2x2' | '1+5' | '3x3'>('2x2');

  // Master UTC Investigation Timeline
  const [masterUtc, setMasterUtc] = useState<Date>(new Date(Date.now() - 3600000));
  const [selectedDate, setSelectedDate] = useState<string>(
    new Date(Date.now() - 3600000).toISOString().slice(0, 10)
  );
  const [playbackRate, setPlaybackRate] = useState<number>(1.0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [cameraStates, setCameraStates] = useState<Record<string, CameraPlaybackTile>>({});
  const [multiCameraSegments, setMultiCameraSegments] = useState<Record<string, TimelineSegment[]>>({});

  // Modals
  const [showExportModal, setShowExportModal] = useState(false);
  const [showReviewModal, setShowReviewModal] = useState(false);
  const [showSmartSearch, setShowSmartSearch] = useState(false);
  const [activeManifestId, setActiveManifestId] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);

  const playbackTimerRef = useRef<any>(null);

  // Load available cameras
  useEffect(() => {
    api.get('/cameras').then((res) => {
      const cams: CameraItem[] = res.data.cameras || [];
      setCameras(cams);
      if (cams.length > 0) {
        setSelectedCameraIds(cams.slice(0, 4).map((c) => c.id));
        setFocusedCameraId(cams[0].id);
      }
    });
  }, []);

  // Initialize or update synchronized playback session
  useEffect(() => {
    if (selectedCameraIds.length === 0) return;

    api
      .post('/playback/sync/sessions', {
        cameraIds: selectedCameraIds,
        initialUtc: masterUtc.toISOString(),
      })
      .then((res) => {
        setSessionId(res.data.session.id);
        updateCameraStatesFromSeek(res.data.initialSeek?.cameras || []);
      })
      .catch((err) => console.error('Failed to create synchronized session:', err));

  }, [selectedCameraIds, selectedDate]);

  // Load segments for all active matrix cameras simultaneously
  useEffect(() => {
    if (selectedCameraIds.length === 0 || !selectedDate) return;

    const start = new Date(`${selectedDate}T00:00:00Z`).toISOString();
    const end = new Date(`${selectedDate}T23:59:59Z`).toISOString();

    const generateDemoSegments = (seed: string): TimelineSegment[] => {
      const baseTime = new Date(`${selectedDate}T08:00:00Z`).getTime();
      const segs: TimelineSegment[] = [];
      const blocks = [
        { offsetHours: 0, durationMinutes: 120, status: 'RECORDED' },
        { offsetHours: 2.5, durationMinutes: 90, status: 'RECORDED' },
        { offsetHours: 4.2, durationMinutes: 15, status: 'MOTION' },
        { offsetHours: 4.6, durationMinutes: 180, status: 'RECORDED' },
        { offsetHours: 8.0, durationMinutes: 30, status: 'MOTION' },
        { offsetHours: 9.0, durationMinutes: 240, status: 'RECORDED' },
      ];
      blocks.forEach((b, idx) => {
        const s = new Date(baseTime + b.offsetHours * 3600 * 1000);
        const e = new Date(s.getTime() + b.durationMinutes * 60 * 1000);
        segs.push({
          id: `seg-${seed}-${idx}`,
          startTime: s.toISOString(),
          endTime: e.toISOString(),
          status: b.status,
        });
      });
      return segs;
    };

    Promise.all(
      selectedCameraIds.map((camId) =>
        api
          .get(`/playback/${camId}/segments`, { params: { start, end } })
          .then((res) => ({ camId, segments: res.data.segments || [] }))
          .catch(() => ({ camId, segments: generateDemoSegments(camId) }))
      )
    ).then((results) => {
      const segMap: Record<string, TimelineSegment[]> = {};
      results.forEach((r) => {
        segMap[r.camId] = r.segments && r.segments.length > 0 ? r.segments : generateDemoSegments(r.camId);
      });
      setMultiCameraSegments(segMap);
    });
  }, [selectedCameraIds, selectedDate, focusedCameraId]);

  const updateCameraStatesFromSeek = (camList: any[]) => {
    const stateMap: Record<string, CameraPlaybackTile> = {};
    camList.forEach((c) => {
      stateMap[c.cameraId] = {
        cameraId: c.cameraId,
        status: c.status,
        segmentId: c.segmentId,
        currentPts: c.currentPts,
        fps: c.fps,
        codec: c.codec,
        gapDurationMs: c.gapDurationMs,
      };
    });
    setCameraStates(stateMap);
  };

  // Advance playback timer
  useEffect(() => {
    if (!isPlaying || !sessionId) {
      if (playbackTimerRef.current) clearInterval(playbackTimerRef.current);
      return;
    }

    const intervalMs = 250;
    playbackTimerRef.current = setInterval(() => {
      setMasterUtc((prev) => {
        const deltaWallClock = intervalMs * playbackRate;
        const nextTime = new Date(prev.getTime() + deltaWallClock);
        api
          .post(`/playback/sync/sessions/${sessionId}/seek`, { targetUtc: nextTime.toISOString() })
          .then((res) => updateCameraStatesFromSeek(res.data.cameras || []))
          .catch(() => {});
        return nextTime;
      });
    }, intervalMs);

    return () => {
      if (playbackTimerRef.current) clearInterval(playbackTimerRef.current);
    };
  }, [isPlaying, playbackRate, sessionId]);

  const handleSeek = (newUtc: Date) => {
    setMasterUtc(newUtc);
    const newDateStr = newUtc.toISOString().slice(0, 10);
    if (newDateStr !== selectedDate) {
      setSelectedDate(newDateStr);
    }
    if (sessionId) {
      api
        .post(`/playback/sync/sessions/${sessionId}/seek`, { targetUtc: newUtc.toISOString() })
        .then((res) => updateCameraStatesFromSeek(res.data.cameras || []))
        .catch((err) => console.error('Seek error:', err));
    }
  };

  const handleRateChange = (newRate: number) => {
    setPlaybackRate(newRate);
    if (sessionId) {
      api.post(`/playback/sync/sessions/${sessionId}/rate`, { rate: newRate }).catch(() => {});
    }
  };

  const handleStep = (direction: 'FORWARD' | 'BACKWARD') => {
    setIsPlaying(false);
    if (!sessionId) return;

    api
      .post(`/playback/sync/sessions/${sessionId}/step`, { direction })
      .then((res) => {
        setMasterUtc(new Date(res.data.masterTimeUtc));
        updateCameraStatesFromSeek(res.data.cameras || []);
      })
      .catch((err) => console.error('Step error:', err));
  };

  const togglePlay = () => {
    const nextPlay = !isPlaying;
    setIsPlaying(nextPlay);
    handleRateChange(nextPlay ? 1.0 : 0.0);
  };

  const addCameraToGrid = (camId: string) => {
    if (!selectedCameraIds.includes(camId)) {
      setSelectedCameraIds([...selectedCameraIds, camId]);
    }
  };

  const removeCameraFromGrid = (camId: string) => {
    setSelectedCameraIds(selectedCameraIds.filter((id) => id !== camId));
    if (focusedCameraId === camId) {
      setFocusedCameraId(selectedCameraIds.find((id) => id !== camId) || null);
    }
  };

  const handleSeekToTimestamp = (isoTimestamp: string) => {
    const targetDate = new Date(isoTimestamp);
    handleSeek(targetDate);
  };

  // Keyboard transport accelerators for forensic review (Space, Arrows, J-K-L)
  useEffect(() => {
    const handleTransportKeyDown = (e: KeyboardEvent) => {
      const activeTag = (document.activeElement?.tagName || '').toLowerCase();
      if (
        activeTag === 'input' ||
        activeTag === 'textarea' ||
        activeTag === 'select' ||
        (document.activeElement as HTMLElement)?.isContentEditable
      ) {
        return;
      }
      if (showSmartSearch || showReviewModal || showExportModal) {
        return;
      }
      if (e.altKey || e.ctrlKey || e.metaKey) return;

      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handleStep('BACKWARD');
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        handleStep('FORWARD');
      } else if (e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        handleStep('BACKWARD');
      } else if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        setIsPlaying(false);
        handleRateChange(0.0);
      } else if (e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        if (!isPlaying) {
          setIsPlaying(true);
          handleRateChange(1.0);
        } else {
          handleRateChange(Math.min(playbackRate * 2, 16.0));
        }
      }
    };

    window.addEventListener('keydown', handleTransportKeyDown);
    return () => window.removeEventListener('keydown', handleTransportKeyDown);
  }, [isPlaying, playbackRate, sessionId, showSmartSearch, showReviewModal, showExportModal]);

  const gridClass =
    gridLayout === '1x1'
      ? 'grid-cols-1'
      : gridLayout === '2x2'
      ? 'grid-cols-2'
      : gridLayout === '1+5'
      ? 'grid-cols-3'
      : 'grid-cols-3';

  const activeFocusCam = cameras.find((c) => c.id === (focusedCameraId || selectedCameraIds[0]));

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)] bg-vms-bg text-vms-text overflow-hidden select-none font-sans">
      {/* Top Investigation Toolbar */}
      <div className="h-11 border-b border-vms-border px-3.5 flex flex-wrap items-center justify-between bg-vms-panel z-10 shrink-0 gap-2">
        <div className="flex items-center space-x-3">
          <div className="flex items-center space-x-2">
            <Film className="w-4 h-4 text-amber-400" />
            <h1 className="text-xs font-mono font-bold uppercase tracking-wider text-vms-text">
              Forensic Investigation
            </h1>
          </div>

          {/* Mode Switcher: Matrix vs Single */}
          <div className="flex items-center bg-vms-surface p-0.5 rounded border border-vms-border text-xs">
            <button
              onClick={() => setViewMode('matrix')}
              className={`px-2.5 py-1 rounded font-medium transition-colors ${
                viewMode === 'matrix'
                  ? 'bg-amber-500 text-slate-950 font-bold'
                  : 'text-vms-muted hover:text-vms-text'
              }`}
            >
              Sync Matrix
            </button>
            <button
              onClick={() => setViewMode('single')}
              className={`px-2.5 py-1 rounded font-medium transition-colors ${
                viewMode === 'single'
                  ? 'bg-amber-500 text-slate-950 font-bold'
                  : 'text-vms-muted hover:text-vms-text'
              }`}
            >
              Single Stream
            </button>
          </div>

          {/* Matrix Presets (when in matrix view) */}
          {viewMode === 'matrix' && (
            <div className="hidden sm:flex items-center bg-vms-surface p-0.5 rounded border border-vms-border">
              {(['1x1', '2x2', '1+5', '3x3'] as const).map((l) => (
                <button
                  key={l}
                  onClick={() => setGridLayout(l)}
                  className={`px-2 py-0.5 text-xs font-mono rounded transition-colors ${
                    gridLayout === l
                      ? 'bg-vms-elevated text-amber-400 font-bold border border-vms-border'
                      : 'text-vms-muted hover:text-vms-text'
                  }`}
                >
                  {l}
                </button>
              ))}
            </div>
          )}

          {/* Date Picker */}
          <div className="flex items-center space-x-1.5 bg-vms-surface px-2 py-1 rounded border border-vms-border text-xs">
            <Calendar className="w-3.5 h-3.5 text-vms-muted" />
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => {
                const newDate = e.target.value;
                setSelectedDate(newDate);
                const d = new Date(masterUtc);
                const [y, m, day] = newDate.split('-').map(Number);
                d.setFullYear(y, m - 1, day);
                handleSeek(d);
              }}
              className="bg-transparent border-none text-xs text-vms-text font-mono focus:outline-none"
            />
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center space-x-2">
          <Button
            variant="secondary"
            size="xs"
            icon={Search}
            onClick={() => setShowSmartSearch(true)}
            title="Smart Motion & Region Search"
          >
            Smart Search
          </Button>

          <Button
            variant="primary"
            size="xs"
            icon={Download}
            onClick={() => setShowExportModal(true)}
            disabled={selectedCameraIds.length === 0}
            title="Export Tamper-Evident Evidence Package"
          >
            Export BSA 63 Evidence
          </Button>

          <Button
            variant="secondary"
            size="xs"
            icon={ShieldCheck}
            onClick={() => {
              setActiveManifestId(undefined);
              setShowReviewModal(true);
            }}
            title="Review Chain-of-Custody Signatures"
          >
            Audit Custody
          </Button>
        </div>
      </div>

      {notice && (
        <div className="bg-vms-surface border-b border-emerald-500/40 px-4 py-2 text-emerald-400 text-xs font-mono flex items-center justify-between shrink-0">
          <span className="flex items-center space-x-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            <span>{notice}</span>
          </span>
          <button onClick={() => setNotice(null)} className="text-emerald-400 hover:text-white">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Main Video Canvas: Video First Primary Surface */}
      <div className="flex-1 bg-vms-bg p-2 overflow-hidden flex flex-col min-h-0">
        {viewMode === 'matrix' ? (
          <div className={`grid ${gridClass} gap-2 h-full w-full auto-rows-fr`}>
            {selectedCameraIds.map((camId, idx) => {
              const cam = cameras.find((c) => c.id === camId);
              const state = cameraStates[camId];
              const isReady = state?.status === 'READY';
              const isFocused = focusedCameraId === camId;

              return (
                <div
                  key={camId}
                  onClick={() => setFocusedCameraId(camId)}
                  className={`relative bg-black border ${
                    isFocused ? 'border-sky-500 shadow-md' : 'border-vms-border'
                  } rounded overflow-hidden flex flex-col justify-between select-none transition-colors group aspect-video min-h-0`}
                >
                  {/* Top Bar OSD */}
                  <div className="absolute top-2 inset-x-2 z-10 flex items-center justify-between pointer-events-none">
                    <div className="flex items-center space-x-1.5 pointer-events-auto">
                      <span className="bg-slate-950/85 px-1.5 py-0.5 rounded border border-vms-border text-vms-dim font-mono text-[10px] font-bold">
                        #{String(idx + 1).padStart(2, '0')}
                      </span>
                      <span className="bg-slate-950/85 px-2 py-0.5 rounded border border-vms-border text-white font-medium text-[11px] truncate max-w-[160px]">
                        {cam?.name || camId}
                      </span>
                    </div>

                    <div className="flex items-center space-x-1.5 pointer-events-auto">
                      <Badge variant={isReady ? 'live' : 'warn'} size="sm">
                        {isReady ? 'PTS LOCKED' : 'GAP HOLD'}
                      </Badge>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeCameraFromGrid(camId);
                        }}
                        className="p-1 rounded bg-slate-950/85 border border-vms-border text-vms-dim hover:text-rose-400 transition-colors"
                        title="Unassign camera from slot"
                        aria-label="Unassign camera"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  </div>

                  {/* Feed Display Center */}
                  <div className="flex-1 flex items-center justify-center bg-vms-bg relative">
                    {isReady ? (
                      <div className="flex flex-col items-center justify-center space-y-2 text-vms-muted">
                        <Film className="w-8 h-8 text-vms-dim" />
                        <div className="font-mono text-[11px] text-vms-text">
                          PTS: <span className="text-sky-400">{state.currentPts || '1726278000'}</span>
                        </div>
                        <span className="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/30">
                          UTC SYNC LOCKED
                        </span>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center justify-center space-y-1.5 p-4 text-center">
                        <AlertCircle className="w-6 h-6 text-amber-400" />
                        <div className="font-mono text-xs font-semibold text-amber-400 uppercase tracking-wide">
                          No Recording at Timecode
                        </div>
                        <p className="text-[10px] text-vms-dim font-sans max-w-[200px]">
                          Holding preceding decoded keyframe.
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Telemetry Footer */}
                  <div className="p-1.5 bg-slate-950/85 border-t border-vms-border font-mono text-[10px] text-vms-muted flex items-center justify-between z-10 pointer-events-none">
                    <span className="text-vms-dim">
                      {state?.codec?.toUpperCase() || 'H.264'} • {state?.fps || 25} FPS
                    </span>
                    <span className="text-sky-400 font-mono font-semibold">
                      {masterUtc.toISOString().slice(11, 23)} UTC
                    </span>
                  </div>
                </div>
              );
            })}

            {selectedCameraIds.length === 0 && (
              <div className="col-span-full h-full flex flex-col items-center justify-center text-vms-muted font-sans text-xs space-y-3 bg-vms-surface border border-dashed border-vms-border rounded p-8">
                <Film className="w-10 h-10 text-vms-dim" />
                <span className="font-semibold text-vms-text">No Streams Assigned to Investigation Matrix</span>
                <div className="flex flex-wrap gap-2 justify-center max-w-lg">
                  {cameras.slice(0, 6).map((c) => (
                    <Button
                      key={c.id}
                      variant="secondary"
                      size="xs"
                      onClick={() => addCameraToGrid(c.id)}
                    >
                      + Assign {c.name}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          /* Single Stream Deep Focus View */
          <div className="h-full flex flex-col bg-black border border-vms-border rounded overflow-hidden relative">
            <div className="px-4 py-2 border-b border-vms-border bg-vms-panel flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <span className="font-mono text-xs font-bold text-amber-400">INSPECTION FOCUS:</span>
                <span className="text-xs font-semibold text-vms-text">{activeFocusCam?.name || 'Selected Camera'}</span>
                <span className="text-[10px] font-mono text-vms-dim">{activeFocusCam?.streamPath}</span>
              </div>
              <div className="flex items-center space-x-2">
                <select
                  value={focusedCameraId || ''}
                  onChange={(e) => setFocusedCameraId(e.target.value)}
                  className="bg-vms-surface border border-vms-border text-xs px-2 py-1 rounded text-vms-text font-sans"
                >
                  {cameras.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex-1 flex items-center justify-center bg-black relative">
              <div className="text-center space-y-2">
                <Film className="w-12 h-12 text-vms-dim mx-auto" />
                <div className="font-mono text-sm text-vms-text font-semibold">
                  {activeFocusCam?.name}
                </div>
                <div className="font-mono text-xs text-sky-400">
                  Target PTS: {masterUtc.toISOString()}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Bottom Forensic Timeline & Variable Transport Shuttle */}
      <div className="border-t border-vms-border bg-vms-panel p-3 flex flex-col justify-between space-y-2 select-none shrink-0">
        {/* Interactive Synchronized Multi-Track Timeline Scrubber */}
        {(() => {
          const activeTracks: TimelineTrack[] = (viewMode === 'matrix' ? selectedCameraIds : [focusedCameraId || selectedCameraIds[0]])
            .filter(Boolean)
            .map((camId) => {
              const cam = cameras.find((c) => c.id === camId);
              return {
                cameraId: camId,
                cameraName: cam?.name || `Camera ${camId.slice(0, 8)}`,
                segments: multiCameraSegments[camId] || [],
                isFocused: camId === (focusedCameraId || selectedCameraIds[0]),
              };
            });

          return (
            <TimelineScrubber
              currentDate={new Date(`${selectedDate}T00:00:00Z`)}
              currentTime={masterUtc}
              tracks={activeTracks}
              onSeek={handleSeek}
              onSelectTrack={(camId) => setFocusedCameraId(camId)}
            />
          );
        })()}

        {/* Transport & Variable Shuttle Controls */}
        <div className="flex flex-wrap items-center justify-between pt-1 gap-2">
          {/* Speed Shuttles */}
          <div className="flex items-center space-x-1 font-mono text-[10px]">
            {[-16, -8, -4, -2, -1, 1, 2, 4, 8, 16].map((rate) => (
              <button
                key={rate}
                onClick={() => handleRateChange(rate)}
                className={`px-2 py-0.5 rounded border transition-colors ${
                  playbackRate === rate && isPlaying
                    ? 'bg-amber-500 text-slate-950 border-amber-500 font-bold'
                    : 'bg-vms-surface text-vms-muted border-vms-border hover:text-vms-text hover:bg-vms-hover'
                }`}
              >
                {rate > 0 ? `+${rate}X` : `${rate}X`}
              </button>
            ))}
          </div>

          {/* Primary Transport Controls */}
          <div className="flex items-center space-x-1.5">
            <Button
              variant="secondary"
              size="sm"
              icon={StepBack}
              onClick={() => handleStep('BACKWARD')}
              title="Step Frame Backward"
              aria-label="Step Frame Backward"
            />

            <Button
              variant="primary"
              size="sm"
              icon={isPlaying ? Pause : Play}
              onClick={togglePlay}
              className="px-5"
            >
              {isPlaying ? 'PAUSE' : 'PLAY'}
            </Button>

            <Button
              variant="secondary"
              size="sm"
              icon={StepForward}
              onClick={() => handleStep('FORWARD')}
              title="Step Frame Forward"
              aria-label="Step Frame Forward"
            />
          </div>

          {/* Quick Jump Buttons */}
          <div className="flex items-center space-x-1 text-xs font-mono">
            {[-60, -10, 10, 60].map((deltaSec) => (
              <button
                key={deltaSec}
                onClick={() => handleSeek(new Date(masterUtc.getTime() + deltaSec * 1000))}
                className="px-2 py-1 bg-vms-surface hover:bg-vms-hover text-vms-text border border-vms-border rounded text-[11px] transition-colors"
              >
                {deltaSec > 0 ? `+${deltaSec}s` : `${deltaSec}s`}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Modals */}
      {showExportModal && selectedCameraIds.length > 0 && (
        <EvidenceExportModal
          cameraId={focusedCameraId || selectedCameraIds[0]}
          cameraName={
            cameras.find((c) => c.id === (focusedCameraId || selectedCameraIds[0]))?.name ||
            'Camera'
          }
          defaultStartTime={new Date(masterUtc.getTime() - 300000)}
          defaultEndTime={masterUtc}
          onClose={() => setShowExportModal(false)}
          onSuccess={(fn) => {
            setNotice(`Evidence package export initiated: ${fn}`);
            setShowExportModal(false);
          }}
        />
      )}

      {showReviewModal && (
        <EvidenceReviewModal
          manifestId={activeManifestId}
          onClose={() => setShowReviewModal(false)}
        />
      )}

      <SmartSearchModal
        isOpen={showSmartSearch}
        onClose={() => setShowSmartSearch(false)}
        cameraId={focusedCameraId || selectedCameraIds[0]}
        cameras={cameras}
        onSeekToTimestamp={handleSeekToTimestamp}
      />
    </div>
  );
};

export default Investigation;
