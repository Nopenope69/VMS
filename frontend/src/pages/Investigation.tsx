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
  Clock,
} from 'lucide-react';
import api from '../services/api';
import EvidenceExportModal from '../components/EvidenceExportModal';
import EvidenceReviewModal from '../components/EvidenceReviewModal';

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
  const [gridLayout, setGridLayout] = useState<'1x1' | '2x2' | '1+5' | '3x3'>('2x2');

  // Master UTC Investigation Timeline
  const [masterUtc, setMasterUtc] = useState<Date>(new Date(Date.now() - 3600000));
  const [playbackRate, setPlaybackRate] = useState<number>(1.0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [cameraStates, setCameraStates] = useState<Record<string, CameraPlaybackTile>>({});
  const [coverageBlocks, setCoverageBlocks] = useState<Record<string, any[]>>({});

  // Modals
  const [showExportModal, setShowExportModal] = useState(false);
  const [showReviewModal, setShowReviewModal] = useState(false);
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

    // Fetch coverage for selected cameras for current 24-hour window
    const windowStart = new Date(masterUtc.getTime() - 12 * 3600000).toISOString();
    const windowEnd = new Date(masterUtc.getTime() + 12 * 3600000).toISOString();

    selectedCameraIds.forEach((camId) => {
      api
        .get(`/playback/${camId}/coverage`, { params: { start: windowStart, end: windowEnd } })
        .then((res) => {
          setCoverageBlocks((prev) => ({ ...prev, [camId]: res.data.blocks || [] }));
        })
        .catch(() => {});
    });
  }, [selectedCameraIds]);

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

  // Playback timer advances monotonic clock delta
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
        // Call backend seek periodically to keep per-camera PTS updated
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
  };

  const gridClass =
    gridLayout === '1x1'
      ? 'grid-cols-1'
      : gridLayout === '2x2'
      ? 'grid-cols-2'
      : gridLayout === '1+5'
      ? 'grid-cols-3'
      : 'grid-cols-3';

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] bg-[#080B10] text-slate-100 overflow-hidden select-none font-sans">
      {/* Top Tactical Bar: Layout Presets & Evidentiary Actions */}
      <div className="h-12 border-b border-[#21262D] px-4 flex items-center justify-between bg-[#0D1117] z-10">
        <div className="flex items-center gap-3">
          <Film className="w-4 h-4 text-[#E3B341]" />
          <h1 className="text-xs font-mono font-bold uppercase tracking-wider text-slate-200 flex items-center gap-2">
            <span>MULTI-STREAM INVESTIGATION MATRIX</span>
            <span className="text-slate-600 font-normal">//</span>
            <span className="text-[#58A6FF] font-normal">SYNCHRONIZED FORENSIC CLOCK</span>
          </h1>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded-none bg-[#3FB950]/10 text-[#3FB950] border border-[#3FB950]/30 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 bg-[#3FB950] animate-pulse" />
            <span>UTC_LOCK: MONOTONIC</span>
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Matrix Presets */}
          <div className="flex items-center bg-tactical-canvas border border-tactical-border p-0.5">
            {(['1x1', '2x2', '1+5', '3x3'] as const).map((l) => (
              <button
                key={l}
                onClick={() => setGridLayout(l)}
                className={`px-2.5 py-1 text-[11px] font-mono uppercase tracking-wider transition ${
                  gridLayout === l
                    ? 'bg-phosphor-amber text-tactical-canvas font-bold'
                    : 'text-tactical-muted hover:text-white hover:bg-tactical-surface'
                }`}
              >
                {l.toUpperCase()}
              </button>
            ))}
          </div>

          <button
            onClick={() => setShowExportModal(true)}
            className="btn-tactical-primary flex items-center gap-1.5 px-3 py-1.5 font-mono font-bold text-xs uppercase tracking-wider transition shadow-sm"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export BSA 63 Evidence</span>
          </button>

          <button
            onClick={() => {
              setActiveManifestId(undefined);
              setShowReviewModal(true);
            }}
            className="btn-tactical-secondary flex items-center gap-1.5 px-3 py-1.5 font-mono text-xs uppercase tracking-wider transition"
          >
            <ShieldCheck className="w-3.5 h-3.5 text-phosphor-cyan" />
            <span>Audit Custody</span>
          </button>
        </div>
      </div>

      {notice && (
        <div className="bg-[#161B22] border-b border-[#3FB950]/40 px-4 py-2 text-[#3FB950] text-xs font-mono flex items-center justify-between">
          <span className="flex items-center gap-2">
            <span className="w-2 h-2 bg-[#3FB950]" />
            <span>{notice}</span>
          </span>
          <button onClick={() => setNotice(null)} className="text-[#3FB950] hover:text-white">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Main Grid Canvas */}
      <div className="flex-1 bg-[#080B10] p-2 overflow-hidden tactical-grid">
        <div className={`grid ${gridClass} gap-2 h-full w-full`}>
          {selectedCameraIds.map((camId, idx) => {
            const cam = cameras.find((c) => c.id === camId);
            const state = cameraStates[camId];
            const isReady = state?.status === 'READY';

            return (
              <div
                key={camId}
                className="relative bg-[#0D1117] border border-[#21262D] rounded-none flex flex-col justify-between overflow-hidden group select-none shadow-lg"
              >
                {/* Optical Corner Reticles */}
                <span className="absolute -top-1 -left-1 text-[9px] font-mono text-[#30363D] select-none leading-none z-20">+</span>
                <span className="absolute -top-1 -right-1 text-[9px] font-mono text-[#30363D] select-none leading-none z-20">+</span>
                <span className="absolute -bottom-1 -left-1 text-[9px] font-mono text-[#30363D] select-none leading-none z-20">+</span>
                <span className="absolute -bottom-1 -right-1 text-[9px] font-mono text-[#30363D] select-none leading-none z-20">+</span>

                {/* Tile Header OSD */}
                <div className="absolute top-0 inset-x-0 p-2 bg-[#0D1117]/90 border-b border-[#21262D] z-10 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono text-slate-500 font-bold">
                      #{String(idx + 1).padStart(2, '0')}
                    </span>
                    <span
                      className={`w-1.5 h-1.5 ${
                        isReady ? 'bg-[#3FB950]' : 'bg-[#E3B341] animate-pulse'
                      }`}
                    />
                    <span className="font-mono text-xs font-semibold text-white tracking-wider truncate max-w-[180px]">
                      {cam?.name || camId}
                    </span>
                    <span className="text-[10px] font-mono text-slate-500 uppercase">
                      [{cam?.streamPath ? 'RTSP' : 'DIRECT'}]
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-[9px] font-mono px-1.5 py-[2px] bg-tactical-canvas border border-tactical-border text-tactical-muted">
                      {isReady ? 'PTS_LOCKED' : 'GAP_HOLD'}
                    </span>
                    <button
                      onClick={() => removeCameraFromGrid(camId)}
                      className="text-tactical-muted hover:text-phosphor-red p-0.5 rounded-none transition"
                      title="Unassign stream from slot"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Video / Gap Display with CRT effect */}
                <div className="flex-1 flex items-center justify-center bg-[#080B10] relative crt-scanlines">
                  {isReady ? (
                    <div className="flex flex-col items-center justify-center space-y-2 text-slate-400 z-10">
                      <Film className="w-10 h-10 text-slate-700 animate-pulse" />
                      <div className="font-mono text-[11px] text-slate-300 tracking-wider">
                        PTS: <span className="text-[#58A6FF]">{state.currentPts || '1726278000'}</span>
                      </div>
                      <div className="text-[10px] font-mono text-[#3FB950] bg-[#3FB950]/10 px-2 py-0.5 border border-[#3FB950]/30 tracking-widest uppercase">
                        [ MASTER_UTC_SYNC // LOCK ]
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center space-y-2 p-4 text-center z-10">
                      <AlertCircle className="w-8 h-8 text-[#E3B341]/80" />
                      <div className="font-mono text-xs font-semibold text-[#E3B341] uppercase tracking-wider">
                        [ NO SEGMENT AT TIMECODE ]
                      </div>
                      <p className="text-[10px] text-slate-500 font-mono max-w-[220px] leading-relaxed">
                        Holding previous decoded keyframe. Awaiting continuous sequence alignment.
                      </p>
                    </div>
                  )}
                </div>

                {/* Tile Telemetry Footer */}
                <div className="p-1.5 bg-[#0D1117] border-t border-[#21262D] font-mono text-[10px] text-slate-400 flex items-center justify-between z-10">
                  <span className="text-slate-500">
                    CODEC: <span className="text-slate-300">{state?.codec?.toUpperCase() || 'H.264'}</span> /{' '}
                    <span className="text-slate-300">{state?.fps || 25} FPS</span>
                  </span>
                  <span className="text-[#58A6FF] tracking-wider">
                    {masterUtc.toISOString().slice(11, 23)} UTC
                  </span>
                </div>
              </div>
            );
          })}

          {selectedCameraIds.length === 0 && (
            <div className="col-span-full h-full flex flex-col items-center justify-center text-slate-500 font-mono text-xs space-y-3 bg-[#0D1117] border border-dashed border-[#21262D]">
              <Film className="w-12 h-12 text-slate-700" />
              <span className="uppercase tracking-widest">[ NO CHANNELS ASSIGNED TO INVESTIGATION MATRIX ]</span>
              <div className="flex flex-wrap gap-2 justify-center max-w-lg">
                {cameras.slice(0, 6).map((c) => (
                  <button
                    key={c.id}
                    onClick={() => addCameraToGrid(c.id)}
                    className="btn-tactical-secondary px-2.5 py-1 text-[11px] font-mono uppercase transition"
                  >
                    + Assign {c.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bottom Timeline & Variable Transport Shuttle */}
      <div className="border-t border-[#21262D] bg-[#0D1117] p-3 flex flex-col justify-between space-y-2 select-none">
        {/* Coverage Tracks Readout */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
            <span className="tracking-wider uppercase flex items-center gap-2">
              <Clock className="w-3.5 h-3.5 text-[#E3B341]" />
              <span>RECORDING CONTINUITY TRACKS</span>
            </span>
            <span className="text-[#E3B341] font-bold font-mono tracking-wider">
              {masterUtc.toISOString()} UTC
            </span>
          </div>

          <div className="h-10 bg-[#080B10] border border-[#21262D] relative overflow-hidden flex flex-col justify-center px-1">
            {/* Multi-track coverage bar */}
            {selectedCameraIds.map((camId) => {
              const blocks = coverageBlocks[camId] || [];
              return (
                <div key={camId} className="h-1.5 w-full bg-[#161B22] my-0.5 overflow-hidden flex rounded-none">
                  {blocks.length > 0 ? (
                    blocks.map((b, idx) => (
                      <div
                        key={idx}
                        className={`h-full ${b.type === 'RECORDING' ? 'bg-[#3FB950]' : 'bg-[#F85149]/60'}`}
                        style={{ width: `${Math.max(2, (b.durationMs / (24 * 3600000)) * 100)}%` }}
                      />
                    ))
                  ) : (
                    <div className="h-full bg-[#3FB950]/60 w-full" />
                  )}
                </div>
              );
            })}

            {/* Authoritative Master UTC Playhead Needle */}
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-[#E3B341] z-10 shadow-[0_0_8px_#E3B341]"
              style={{ left: '50%' }}
            />
          </div>
        </div>

        {/* Transport & Variable Shuttle Controls */}
        <div className="flex items-center justify-between pt-1">
          {/* Speed Shuttles */}
          <div className="flex items-center gap-1 font-mono text-[10px]">
            {[-16, -8, -4, -2, -1, 1, 2, 4, 8, 16].map((rate) => (
              <button
                key={rate}
                onClick={() => handleRateChange(rate)}
                className={`px-2 py-0.5 border rounded-none transition ${
                  playbackRate === rate && isPlaying
                    ? 'bg-[#E3B341] text-[#080B10] border-[#E3B341] font-bold'
                    : 'bg-[#161B22] text-slate-400 border-[#21262D] hover:text-white hover:bg-[#21262D]'
                }`}
              >
                {rate > 0 ? `+${rate}X` : `${rate}X`}
              </button>
            ))}
          </div>

          {/* Primary Transport Controls */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => handleStep('BACKWARD')}
              title="Step Frame Backward"
              className="p-2 bg-[#161B22] hover:bg-[#21262D] text-slate-200 border border-[#21262D] rounded-none transition"
            >
              <StepBack className="w-4 h-4" />
            </button>

            <button
              onClick={togglePlay}
              className={`px-4 py-2 text-[#080B10] font-mono font-bold text-xs uppercase tracking-wider transition rounded-none shadow-md flex items-center gap-1.5 ${
                isPlaying ? 'bg-[#E3B341] hover:bg-amber-400' : 'bg-[#3FB950] hover:bg-emerald-400'
              }`}
            >
              {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
              <span>{isPlaying ? 'PAUSE' : 'PLAY'}</span>
            </button>

            <button
              onClick={() => handleStep('FORWARD')}
              title="Step Frame Forward"
              className="p-2 bg-[#161B22] hover:bg-[#21262D] text-slate-200 border border-[#21262D] rounded-none transition"
            >
              <StepForward className="w-4 h-4" />
            </button>
          </div>

          {/* Time Delta Fast Seeks */}
          <div className="flex items-center gap-1 text-xs font-mono">
            {[-60, -10, 10, 60].map((deltaSec) => (
              <button
                key={deltaSec}
                onClick={() => handleSeek(new Date(masterUtc.getTime() + deltaSec * 1000))}
                className="px-2 py-1 bg-[#161B22] hover:bg-[#21262D] text-slate-300 border border-[#21262D] rounded-none text-[11px]"
              >
                {deltaSec > 0 ? `+${deltaSec}S` : `${deltaSec}S`}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Modals */}
      {showExportModal && selectedCameraIds.length > 0 && (
        <EvidenceExportModal
          cameraId={selectedCameraIds[0]}
          cameraName={cameras.find((c) => c.id === selectedCameraIds[0])?.name || selectedCameraIds[0]}
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
    </div>
  );
};

export default Investigation;
