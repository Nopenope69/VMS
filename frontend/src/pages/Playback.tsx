import React, { useState, useEffect } from 'react';
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

  const [showExportModal, setShowExportModal] = useState(false);
  const [showSmartSearch, setShowSmartSearch] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

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

  // Handle timeline scrubber click
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
    <div className="flex flex-col h-[calc(100vh-3.5rem)] bg-graphite-900 p-4 space-y-4 overflow-y-auto">
      {/* Control Bar */}
      <div className="bg-graphite-850 p-3 rounded border border-graphite-700 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center space-x-3">
          {/* Camera Picker */}
          <div className="flex items-center space-x-2">
            <Film className="w-4 h-4 text-cctv-amber" />
            <select
              value={selectedCameraId}
              onChange={(e) => setSelectedCameraId(e.target.value)}
              className="bg-graphite-900 border border-graphite-700 rounded px-2.5 py-1 text-xs text-slate-200 font-mono focus:outline-none focus:border-cctv-amber"
            >
              {cameras.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.ipAddress})
                </option>
              ))}
            </select>
          </div>

          {/* Date Picker */}
          <div className="flex items-center space-x-2">
            <Calendar className="w-4 h-4 text-cctv-teal" />
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="bg-graphite-900 border border-graphite-700 rounded px-2.5 py-1 text-xs text-slate-200 font-mono focus:outline-none focus:border-cctv-teal"
            />
          </div>
        </div>

        {/* Forensic Search & Section 63 Evidence Export Buttons */}
        <div className="flex items-center space-x-2">
          <button
            onClick={() => setShowSmartSearch(true)}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded text-xs font-semibold bg-graphite-800 border border-graphite-700 hover:border-cctv-amber text-slate-200 transition"
          >
            <Crosshair className="w-4 h-4 text-cctv-amber" />
            <span>Smart Forensic & ANPR Search</span>
          </button>

          <button
            onClick={() => setShowExportModal(true)}
            disabled={!selectedCameraId}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded text-xs font-semibold bg-cctv-amber text-graphite-900 hover:bg-amber-400 transition disabled:opacity-50"
          >
            <ShieldCheck className="w-4 h-4" />
            <span>Generate Section 63 Evidence Package</span>
          </button>
        </div>
      </div>

      {exportNotice && (
        <div className="p-3 bg-cctv-teal/20 border border-cctv-teal/60 rounded flex items-center justify-between text-xs text-teal-100">
          <div className="flex items-center space-x-2">
            <ShieldCheck className="w-4 h-4 text-cctv-teal" />
            <span>Evidence package generated: <strong>{exportNotice}</strong></span>
          </div>
          <a
            href={`/api/v1/evidence/download/${exportNotice}`}
            download
            className="flex items-center space-x-1 px-2 py-0.5 rounded bg-cctv-teal text-graphite-900 font-semibold"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Download Zip</span>
          </a>
        </div>
      )}

      {/* Main Playback Screen */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 flex-1 min-h-[350px]">
        {/* Video Player */}
        <div className="lg:col-span-3 bg-black border border-graphite-700 rounded flex items-center justify-center relative overflow-hidden aspect-video max-h-[500px]">
          {activeSegmentId ? (
            <video
              key={activeSegmentId}
              src={`/api/v1/playback/stream/${activeSegmentId}`}
              controls
              autoPlay
              className="w-full h-full object-contain"
            />
          ) : (
            <div className="flex flex-col items-center space-y-2 text-slate-500">
              <Film className="w-10 h-10" />
              <div className="text-xs font-mono">No recorded footage selected or available for this interval</div>
            </div>
          )}
        </div>

        {/* Segments List for Day */}
        <div className="bg-graphite-850 border border-graphite-700 rounded p-3 flex flex-col h-full max-h-[500px]">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-300 pb-2 border-b border-graphite-700">
            Indexed Segments ({segments.length})
          </div>

          <div className="flex-1 overflow-y-auto space-y-1.5 mt-2 pr-1">
            {segments.length === 0 ? (
              <div className="text-[11px] text-slate-500 font-mono text-center py-6">
                No segments recorded for {selectedDate}
              </div>
            ) : (
              segments.map((seg) => {
                const isSelected = activeSegmentId === seg.id;
                const startStr = new Date(seg.startTime).toLocaleTimeString();
                const endStr = new Date(seg.endTime).toLocaleTimeString();

                return (
                  <button
                    key={seg.id}
                    onClick={() => {
                      setActiveSegmentId(seg.id);
                      setCurrentTime(new Date(seg.startTime));
                    }}
                    className={`w-full text-left p-2 rounded text-xs font-mono transition flex justify-between items-center ${
                      isSelected
                        ? 'bg-cctv-amber/20 border border-cctv-amber/60 text-cctv-amber font-semibold'
                        : 'bg-graphite-900 border border-graphite-800 text-slate-300 hover:bg-graphite-800'
                    }`}
                  >
                    <span>{startStr} - {endStr}</span>
                    <span className="text-[10px] px-1 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800">
                      fMP4
                    </span>
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
