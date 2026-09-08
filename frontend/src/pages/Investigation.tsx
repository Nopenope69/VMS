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
    <div className="flex flex-col h-[calc(100vh-3.5rem)] bg-graphite-900 text-slate-100 overflow-hidden select-none font-sans">
      {/* Top Bar: Layout Selector & Evidence Actions */}
      <div className="h-12 border-b border-slate-800 px-4 flex items-center justify-between bg-graphite-900 z-10">
        <div className="flex items-center gap-3">
          <Film className="w-5 h-5 text-amber-400" />
          <h1 className="text-sm font-semibold uppercase tracking-wider text-slate-200">
            Multi-Camera Synchronized Investigation Console
          </h1>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            UTC INVESTIGATION CLOCK
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Layout buttons */}
          <div className="flex items-center bg-slate-800 rounded p-0.5 border border-slate-700 text-xs">
            {(['1x1', '2x2', '1+5', '3x3'] as const).map((l) => (
              <button
                key={l}
                onClick={() => setGridLayout(l)}
                className={`px-2 py-0.5 rounded font-mono transition ${
                  gridLayout === l ? 'bg-amber-500 text-graphite-900 font-bold' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {l}
              </button>
            ))}
          </div>

          <button
            onClick={() => setShowExportModal(true)}
            className="flex items-center gap-1.5 px-3 py-1 bg-amber-500 hover:bg-amber-400 text-graphite-900 rounded font-semibold text-xs transition shadow"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export Evidence Manifest</span>
          </button>

          <button
            onClick={() => {
              setActiveManifestId(undefined);
              setShowReviewModal(true);
            }}
            className="flex items-center gap-1.5 px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded font-mono text-xs transition"
          >
            <ShieldCheck className="w-3.5 h-3.5 text-cyan-400" />
            <span>Audit Custody</span>
          </button>
        </div>
      </div>

      {notice && (
        <div className="bg-emerald-950/60 border-b border-emerald-800/80 px-4 py-2 text-emerald-300 text-xs font-mono flex items-center justify-between">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} className="text-emerald-400 hover:text-emerald-200">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Main Grid View */}
      <div className="flex-1 bg-black p-2 overflow-hidden">
        <div className={`grid ${gridClass} gap-2 h-full w-full`}>
          {selectedCameraIds.map((camId) => {
            const cam = cameras.find((c) => c.id === camId);
            const state = cameraStates[camId];
            const isReady = state?.status === 'READY';

            return (
              <div
                key={camId}
                className="relative bg-graphite-800 border border-slate-800 rounded flex flex-col justify-between overflow-hidden shadow group"
              >
                {/* Tile Header */}
                <div className="absolute top-0 inset-x-0 p-2 bg-gradient-to-b from-black/80 to-transparent z-10 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        isReady ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]' : 'bg-amber-400 animate-pulse'
                      }`}
                    />
                    <span className="font-mono text-xs font-semibold text-slate-200 truncate max-w-[160px]">
                      {cam?.name || camId}
                    </span>
                  </div>
                  <button
                    onClick={() => removeCameraFromGrid(camId)}
                    className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-rose-400 p-0.5 rounded transition"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Video / Gap Display */}
                <div className="flex-1 flex items-center justify-center bg-graphite-900 relative">
                  {isReady ? (
                    <div className="flex flex-col items-center justify-center space-y-2 text-slate-400">
                      <Film className="w-10 h-10 text-slate-600 animate-pulse" />
                      <div className="font-mono text-[11px] text-slate-300">
                        DECODING AT PTS: {state.currentPts || '0'}
                      </div>
                      <div className="text-[10px] font-mono text-emerald-400 bg-emerald-950/40 px-2 py-0.5 rounded border border-emerald-800/40">
                        SYNCHRONIZED WITH MASTER UTC
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center space-y-2 p-4 text-center">
                      <AlertCircle className="w-8 h-8 text-amber-500/80" />
                      <div className="font-mono text-xs font-semibold text-amber-400">
                        NO RECORDING AT THIS TIMESTAMP
                      </div>
                      <p className="text-[10px] text-slate-500 font-mono max-w-[200px]">
                        Holding last decoded frame until master clock reaches next segment.
                      </p>
                    </div>
                  )}
                </div>

                {/* Tile Telemetry Footer */}
                <div className="p-1.5 bg-black/80 border-t border-slate-800 font-mono text-[10px] text-slate-400 flex items-center justify-between">
                  <span>{state?.codec?.toUpperCase() || 'H264'} / {state?.fps || 25} FPS</span>
                  <span className="text-cyan-400">{masterUtc.toISOString().slice(11, 23)} UTC</span>
                </div>
              </div>
            );
          })}

          {selectedCameraIds.length === 0 && (
            <div className="col-span-full h-full flex flex-col items-center justify-center text-slate-500 font-mono text-xs space-y-3">
              <Film className="w-12 h-12 text-slate-700" />
              <span>No cameras selected for synchronized investigation</span>
              <div className="flex gap-2">
                {cameras.slice(0, 4).map((c) => (
                  <button
                    key={c.id}
                    onClick={() => addCameraToGrid(c.id)}
                    className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded border border-slate-700 text-[11px]"
                  >
                    + {c.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bottom Timeline & Shuttle Controller */}
      <div className="h-44 border-t border-slate-800 bg-graphite-800 p-3 flex flex-col justify-between space-y-2">
        {/* Coverage Bars */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
            <span>RECORDING COVERAGE TRACKS</span>
            <span className="text-amber-400 font-bold">{masterUtc.toISOString()} UTC</span>
          </div>

          <div className="h-10 bg-graphite-900 border border-slate-700 rounded relative overflow-hidden flex flex-col justify-center px-1">
            {/* Multi-track coverage bar */}
            {selectedCameraIds.map((camId) => {
              const blocks = coverageBlocks[camId] || [];
              return (
                <div key={camId} className="h-1.5 w-full bg-slate-800 rounded my-0.5 overflow-hidden flex">
                  {blocks.length > 0 ? (
                    blocks.map((b, idx) => (
                      <div
                        key={idx}
                        className={`h-full ${b.type === 'RECORDING' ? 'bg-emerald-500/80' : 'bg-rose-500/40'}`}
                        style={{ width: `${Math.max(2, (b.durationMs / (24 * 3600000)) * 100)}%` }}
                      />
                    ))
                  ) : (
                    <div className="h-full bg-emerald-500/60 w-full" />
                  )}
                </div>
              );
            })}

            {/* Authoritative Master UTC Playhead Line */}
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-amber-400 z-10 shadow-[0_0_8px_#f59e0b]"
              style={{ left: '50%' }}
            />
          </div>
        </div>

        {/* Transport & Variable Shuttle Controls */}
        <div className="flex items-center justify-between pt-1">
          {/* Speed Shuttles */}
          <div className="flex items-center gap-1 font-mono text-[11px]">
            {[-16, -8, -4, -2, -1, 1, 2, 4, 8, 16].map((rate) => (
              <button
                key={rate}
                onClick={() => handleRateChange(rate)}
                className={`px-1.5 py-0.5 rounded border ${
                  playbackRate === rate && isPlaying
                    ? 'bg-amber-500 text-graphite-900 border-amber-400 font-bold'
                    : 'bg-slate-900 text-slate-400 border-slate-700 hover:text-slate-200'
                }`}
              >
                {rate > 0 ? `+${rate}x` : `${rate}x`}
              </button>
            ))}
          </div>

          {/* Primary Transport Controls */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleStep('BACKWARD')}
              title="Step Frame Backward"
              className="p-2 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 transition"
            >
              <StepBack className="w-4 h-4" />
            </button>

            <button
              onClick={togglePlay}
              className={`p-2.5 rounded text-graphite-900 font-bold transition shadow ${
                isPlaying ? 'bg-amber-400 hover:bg-amber-300' : 'bg-emerald-400 hover:bg-emerald-300'
              }`}
            >
              {isPlaying ? <Pause className="w-5 h-5 fill-current" /> : <Play className="w-5 h-5 fill-current" />}
            </button>

            <button
              onClick={() => handleStep('FORWARD')}
              title="Step Frame Forward"
              className="p-2 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 transition"
            >
              <StepForward className="w-4 h-4" />
            </button>
          </div>

          {/* Time Delta Fast Seeks */}
          <div className="flex items-center gap-1.5 text-xs font-mono">
            {[-60, -10, 10, 60].map((deltaSec) => (
              <button
                key={deltaSec}
                onClick={() => handleSeek(new Date(masterUtc.getTime() + deltaSec * 1000))}
                className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700"
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
          cameraId={selectedCameraIds[0]}
          cameraName={cameras.find((c) => c.id === selectedCameraIds[0])?.name || selectedCameraIds[0]}
          defaultStartTime={new Date(masterUtc.getTime() - 300000)}
          defaultEndTime={masterUtc}
          onClose={() => setShowExportModal(false)}
          onSuccess={(fn) => {
            setNotice(`Evidence export packaged: ${fn}`);
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
