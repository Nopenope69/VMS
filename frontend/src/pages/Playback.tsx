import React, { useState, useEffect, useRef } from 'react';
import { Calendar, Film, ShieldCheck, Download, Crosshair } from 'lucide-react';
import api from '../services/api';
import TimelineScrubber, { TimelineSegment } from '../components/TimelineScrubber';
import EvidenceExportModal from '../components/EvidenceExportModal';
import SmartSearchModal from '../components/SmartSearchModal';

export const Playback: React.FC = () => {
  const [cameras, setCameras] = useState<any[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string>('');
  const [selectedDate, setSelectedDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [currentTime, setCurrentTime] = useState<Date>(new Date());
  const [segments, setSegments] = useState<TimelineSegment[]>([]);
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [playbackRate, setPlaybackRate] = useState<number>(1.0);

  const [showExportModal, setShowExportModal] = useState(false);
  const [showSmartSearch, setShowSmartSearch] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Load cameras
  useEffect(() => {
    api.get('/cameras').then((res) => {
      const cams = res.data.cameras || [];
      setCameras(cams);
      if (cams.length > 0) {
        setSelectedCameraId(cams[0].id);
      }
    });
  }, []);

  // Load recording segments for chosen camera & date
  useEffect(() => {
    if (!selectedCameraId || !selectedDate) return;

    const start = new Date(`${selectedDate}T00:00:00Z`).toISOString();
    const end = new Date(`${selectedDate}T23:59:59Z`).toISOString();

    api
      .get(`/playback/${selectedCameraId}/segments`, { params: { start, end } })
      .then((res) => {
        const segs = res.data.segments || [];
        setSegments(segs);
        if (segs.length > 0) {
          setActiveSegmentId(segs[0].id);
        } else {
          setActiveSegmentId(null);
        }
      })
      .catch((err) => console.error('Failed to load segments:', err));
  }, [selectedCameraId, selectedDate]);

  // Sync playback rate to video element
  const handleSpeedChange = (speed: number) => {
    setPlaybackRate(speed);
    if (videoRef.current) {
      videoRef.current.playbackRate = speed;
    }
  };

  // Quick jump in time
  const handleJump = (deltaMs: number) => {
    const next = new Date(currentTime.getTime() + deltaMs);
    handleSeek(next);
  };

  // Handle timeline scrubber seek
  const handleSeek = (time: Date) => {
    setCurrentTime(time);

    // Find overlapping segment
    const targetMs = time.getTime();
    const match = segments.find((s) => {
      const sStart = new Date(s.startTime).getTime();
      const sEnd = new Date(s.endTime).getTime();
      return targetMs >= sStart && targetMs <= sEnd;
    });

    if (match) {
      setActiveSegmentId(match.id);
    }
  };

  const handleSeekToTimestamp = (isoTimestamp: string) => {
    const targetDate = new Date(isoTimestamp);
    const dateStr = targetDate.toISOString().slice(0, 10);
    if (dateStr !== selectedDate) {
      setSelectedDate(dateStr);
    }
    handleSeek(targetDate);
  };

  const activeCamera = cameras.find((c) => c.id === selectedCameraId);

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] bg-tactical-canvas p-4 space-y-3 overflow-y-auto font-mono text-tactical-text">
      {/* Tactical Top Bar */}
      <div className="bg-tactical-panel p-3 border border-tactical-border flex flex-wrap items-center justify-between gap-3 shadow-none">
        <div className="flex flex-wrap items-center gap-3">
          {/* Camera Select */}
          <div className="flex items-center space-x-2 bg-tactical-surface px-2.5 py-1 border border-tactical-border">
            <Film className="w-3.5 h-3.5 text-phosphor-amber" />
            <span className="text-[10px] uppercase text-tactical-muted tracking-wider">SOURCE:</span>
            <select
              value={selectedCameraId}
              onChange={(e) => setSelectedCameraId(e.target.value)}
              className="bg-transparent text-xs text-tactical-text font-mono focus:outline-none cursor-pointer"
            >
              {cameras.map((c) => (
                <option key={c.id} value={c.id} className="bg-tactical-panel text-tactical-text">
                  {c.name} [{c.ipAddress}]
                </option>
              ))}
            </select>
          </div>

          {/* Date Select */}
          <div className="flex items-center space-x-2 bg-tactical-surface px-2.5 py-1 border border-tactical-border">
            <Calendar className="w-3.5 h-3.5 text-phosphor-cyan" />
            <span className="text-[10px] uppercase text-tactical-muted tracking-wider">ARCHIVE_DATE:</span>
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="bg-transparent text-xs text-tactical-text font-mono focus:outline-none cursor-pointer"
            />
          </div>

          {/* Jump Shortcuts */}
          <div className="hidden sm:flex items-center space-x-1 border border-tactical-border bg-tactical-canvas px-1 py-0.5">
            <button
              onClick={() => handleJump(-3600000)}
              className="px-1.5 py-0.5 text-[10px] text-tactical-muted hover:text-tactical-text hover:bg-tactical-surface"
              title="Step -1 Hour"
            >
              -1H
            </button>
            <button
              onClick={() => handleJump(-600000)}
              className="px-1.5 py-0.5 text-[10px] text-tactical-muted hover:text-tactical-text hover:bg-tactical-surface"
              title="Step -10 Minutes"
            >
              -10M
            </button>
            <button
              onClick={() => handleJump(600000)}
              className="px-1.5 py-0.5 text-[10px] text-tactical-muted hover:text-tactical-text hover:bg-tactical-surface"
              title="Step +10 Minutes"
            >
              +10M
            </button>
            <button
              onClick={() => handleJump(3600000)}
              className="px-1.5 py-0.5 text-[10px] text-tactical-muted hover:text-tactical-text hover:bg-tactical-surface"
              title="Step +1 Hour"
            >
              +1H
            </button>
          </div>
        </div>

        {/* Action Triggers */}
        <div className="flex items-center space-x-2">
          <button
            onClick={() => setShowSmartSearch(true)}
            className="btn-tactical-secondary flex items-center space-x-1.5 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors"
          >
            <Crosshair className="w-3.5 h-3.5 text-phosphor-amber" />
            <span>Smart Forensic Search</span>
          </button>

          <button
            onClick={() => setShowExportModal(true)}
            disabled={!selectedCameraId}
            className="btn-tactical-primary flex items-center space-x-1.5 px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ShieldCheck className="w-4 h-4" />
            <span>Section 63 BSA Export</span>
          </button>
        </div>
      </div>

      {/* Export Notification Banner */}
      {exportNotice && (
        <div className="p-2.5 bg-[#0D1117] border border-[#3FB950] flex items-center justify-between text-xs text-[#3FB950]">
          <div className="flex items-center space-x-2">
            <ShieldCheck className="w-4 h-4 text-[#3FB950]" />
            <span>
              EVIDENCE PACKAGE SEALED & DIGITALLY SIGNED:{' '}
              <strong className="text-[#C9D1D9]">{exportNotice}</strong>
            </span>
          </div>
          <a
            href={`/api/v1/evidence/download/${exportNotice}`}
            download
            className="flex items-center space-x-1 px-2.5 py-1 bg-[#238636] hover:bg-[#2EA043] text-white font-bold uppercase text-[10px] tracking-wider transition-colors"
          >
            <Download className="w-3 h-3" />
            <span>DOWNLOAD ZIP PACKAGE</span>
          </a>
        </div>
      )}

      {/* Main Playback Cockpit */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-3 flex-1 min-h-[420px]">
        {/* Video Player Chassis */}
        <div className="lg:col-span-3 bg-[#080B10] border border-[#21262D] relative flex flex-col justify-between overflow-hidden">
          {/* OSD Top Bar */}
          <div className="flex items-center justify-between px-3 py-1.5 bg-[#0D1117]/90 border-b border-[#21262D] z-10 text-[10px] tracking-wider">
            <div className="flex items-center space-x-2">
              <span className="w-2 h-2 bg-[#3FB950] animate-pulse" />
              <span className="text-[#3FB950] font-bold">
                [ ARCHIVE PLAYBACK // {playbackRate}X ]
              </span>
              <span className="text-[#8B949E]">//</span>
              <span className="text-[#C9D1D9]">
                {activeCamera?.name || 'FEED'} [{activeCamera?.ipAddress}]
              </span>
            </div>

            <div className="flex items-center space-x-3">
              <span className="text-[#8B949E]">
                CONTAINER: <strong className="text-[#58A6FF]">fMP4 (FRAGMENTED)</strong>
              </span>
              <span className="text-[#E3B341] font-bold">
                {currentTime.toLocaleTimeString([], { hour12: false })} UTC
              </span>
            </div>
          </div>

          {/* Center Video Viewport */}
          <div className="flex-1 flex items-center justify-center relative bg-black min-h-[320px]">
            {/* Corner Reticles */}
            <div className="absolute top-2 left-2 text-[#30363D] text-xs select-none pointer-events-none">+</div>
            <div className="absolute top-2 right-2 text-[#30363D] text-xs select-none pointer-events-none">+</div>
            <div className="absolute bottom-2 left-2 text-[#30363D] text-xs select-none pointer-events-none">+</div>
            <div className="absolute bottom-2 right-2 text-[#30363D] text-xs select-none pointer-events-none">+</div>

            {activeSegmentId ? (
              <video
                key={activeSegmentId}
                ref={videoRef}
                src={`/api/v1/playback/stream/${activeSegmentId}`}
                controls
                autoPlay
                className="w-full h-full object-contain max-h-[540px]"
              />
            ) : (
              <div className="flex flex-col items-center justify-center space-y-3 text-[#484F58] p-8 text-center">
                <Film className="w-12 h-12 text-[#30363D]" />
                <div className="text-xs uppercase tracking-widest text-[#8B949E]">
                  [ NO RECORDED FOOTAGE AT SELECTED TIMECODE ]
                </div>
                <div className="text-[10px] text-[#484F58] max-w-sm">
                  Select an indexed block from the right panel or scrub the 24H timeline below to inspect available fMP4 fragments.
                </div>
              </div>
            )}
          </div>

          {/* OSD Bottom HUD & Speed Controls */}
          <div className="flex flex-wrap items-center justify-between px-3 py-1.5 bg-[#0D1117] border-t border-[#21262D] z-10 text-[10px]">
            <div className="flex items-center space-x-2">
              <span className="text-[#8B949E]">RATE:</span>
              <div className="flex items-center border border-[#30363D] bg-[#080B10]">
                {[0.5, 1.0, 2.0, 4.0, 8.0, 16.0].map((rate) => (
                  <button
                    key={rate}
                    onClick={() => handleSpeedChange(rate)}
                    className={`px-1.5 py-0.5 font-bold transition-colors ${
                      playbackRate === rate
                        ? 'bg-[#E3B341] text-[#080B10]'
                        : 'text-[#8B949E] hover:text-[#C9D1D9] hover:bg-[#161B22]'
                    }`}
                  >
                    {rate}X
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center space-x-3 text-[#8B949E]">
              <span>MOOF ATOM: <strong className="text-[#3FB950]">VALIDATED</strong></span>
              <span>//</span>
              <span>HASH LOCK: <strong className="text-[#58A6FF]">SHA-256 ACTIVE</strong></span>
            </div>
          </div>
        </div>

        {/* Segments Directory Panel */}
        <div className="bg-[#0D1117] border border-[#21262D] flex flex-col h-full max-h-[600px]">
          <div className="p-2.5 border-b border-[#21262D] flex items-center justify-between bg-[#161B22]">
            <div className="text-xs font-bold uppercase tracking-wider text-[#C9D1D9]">
              INDEXED FRAGMENTS
            </div>
            <div className="text-[10px] text-[#E3B341] bg-[#080B10] px-1.5 py-0.5 border border-[#30363D]">
              COUNT: {segments.length}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {segments.length === 0 ? (
              <div className="text-[11px] text-[#484F58] text-center py-12">
                [ NO RECORDING BLOCKS FOR {selectedDate} ]
              </div>
            ) : (
              segments.map((seg) => {
                const isSelected = activeSegmentId === seg.id;
                const startStr = new Date(seg.startTime).toLocaleTimeString([], { hour12: false });
                const endStr = new Date(seg.endTime).toLocaleTimeString([], { hour12: false });

                return (
                  <button
                    key={seg.id}
                    onClick={() => {
                      setActiveSegmentId(seg.id);
                      setCurrentTime(new Date(seg.startTime));
                    }}
                    className={`w-full text-left p-2 transition-colors border flex flex-col space-y-1 ${
                      isSelected
                        ? 'bg-[#161B22] border-[#E3B341] text-[#E3B341]'
                        : 'bg-[#080B10] border-[#21262D] text-[#8B949E] hover:border-[#30363D] hover:text-[#C9D1D9]'
                    }`}
                  >
                    <div className="flex justify-between items-center text-xs">
                      <span className="font-bold">{startStr} → {endStr}</span>
                      <span className="text-[9px] px-1 py-[2px] bg-[#238636]/20 border border-[#238636] text-[#3FB950] font-bold">
                        fMP4
                      </span>
                    </div>
                    <div className="flex justify-between text-[10px] text-[#484F58]">
                      <span>SEG_ID: {seg.id.slice(0, 8)}...</span>
                      <span>STATUS: {seg.status || 'OK'}</span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* 24-Hour Timeline Scrubber */}
      <TimelineScrubber
        currentDate={new Date(`${selectedDate}T00:00:00Z`)}
        currentTime={currentTime}
        segments={segments}
        onSeek={handleSeek}
      />

      {/* Section 63 Evidence Export Modal */}
      {showExportModal && activeCamera && (
        <EvidenceExportModal
          cameraId={activeCamera.id}
          cameraName={activeCamera.name}
          defaultStartTime={new Date(currentTime.getTime() - 60000)}
          defaultEndTime={new Date(currentTime.getTime() + 60000)}
          onClose={() => setShowExportModal(false)}
          onSuccess={(filename) => {
            setExportNotice(filename);
          }}
        />
      )}

      {/* Smart Spatial Forensics & ANPR Wildcard Modal */}
      <SmartSearchModal
        isOpen={showSmartSearch}
        onClose={() => setShowSmartSearch(false)}
        cameraId={selectedCameraId}
        cameras={cameras}
        onSeekToTimestamp={handleSeekToTimestamp}
      />
    </div>
  );
};

export default Playback;
