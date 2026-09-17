import React, { useEffect, useRef, useState } from 'react';

export interface TimelineSegment {
  id: string;
  startTime: string; // ISO
  endTime: string;   // ISO
  status: string;
}

interface TimelineScrubberProps {
  currentDate: Date; // 00:00:00 of chosen date
  currentTime: Date; // current scrubber position
  segments: TimelineSegment[];
  onSeek: (time: Date) => void;
  selectionRange?: { start: Date; end: Date } | null;
}

type ZoomLevel = '24H' | '6H' | '1H' | '15M';

export const TimelineScrubber: React.FC<TimelineScrubberProps> = ({
  currentDate,
  currentTime,
  segments,
  onSeek,
  selectionRange,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [zoom, setZoom] = useState<ZoomLevel>('24H');

  // Compute active window start and end depending on zoom level
  const dayStart = new Date(currentDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(currentDate);
  dayEnd.setHours(23, 59, 59, 999);

  let viewStart = dayStart.getTime();
  let viewEnd = dayEnd.getTime();

  if (zoom === '6H') {
    const center = currentTime.getTime();
    const half = 3 * 3600 * 1000;
    viewStart = Math.max(dayStart.getTime(), center - half);
    viewEnd = Math.min(dayEnd.getTime(), viewStart + 6 * 3600 * 1000);
    if (viewEnd - viewStart < 6 * 3600 * 1000) {
      viewStart = Math.max(dayStart.getTime(), viewEnd - 6 * 3600 * 1000);
    }
  } else if (zoom === '1H') {
    const center = currentTime.getTime();
    const half = 0.5 * 3600 * 1000;
    viewStart = Math.max(dayStart.getTime(), center - half);
    viewEnd = Math.min(dayEnd.getTime(), viewStart + 3600 * 1000);
    if (viewEnd - viewStart < 3600 * 1000) {
      viewStart = Math.max(dayStart.getTime(), viewEnd - 3600 * 1000);
    }
  } else if (zoom === '15M') {
    const center = currentTime.getTime();
    const half = 7.5 * 60 * 1000;
    viewStart = Math.max(dayStart.getTime(), center - half);
    viewEnd = Math.min(dayEnd.getTime(), viewStart + 15 * 60 * 1000);
    if (viewEnd - viewStart < 15 * 60 * 1000) {
      viewStart = Math.max(dayStart.getTime(), viewEnd - 15 * 60 * 1000);
    }
  }

  const viewTotalMs = viewEnd - viewStart;

  const timeToX = (time: Date, width: number) => {
    const elapsed = time.getTime() - viewStart;
    return Math.max(0, Math.min(width, (elapsed / viewTotalMs) * width));
  };

  const xToTime = (x: number, width: number) => {
    const ratio = Math.max(0, Math.min(1, x / width));
    return new Date(viewStart + ratio * viewTotalMs);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    // Canvas background
    ctx.fillStyle = '#080B11';
    ctx.fillRect(0, 0, width, height);

    // Track trough
    ctx.fillStyle = '#0E131F';
    ctx.fillRect(0, 22, width, height - 22);

    // Baseline divider
    ctx.strokeStyle = '#1E293B';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 22);
    ctx.lineTo(width, 22);
    ctx.stroke();

    // Draw recorded segments
    for (const seg of segments) {
      const segStart = new Date(seg.startTime).getTime();
      const segEnd = new Date(seg.endTime).getTime();

      if (segEnd < viewStart || segStart > viewEnd) continue;

      const xStart = Math.max(0, ((segStart - viewStart) / viewTotalMs) * width);
      const xEnd = Math.min(width, ((segEnd - viewStart) / viewTotalMs) * width);
      const segWidth = Math.max(2, xEnd - xStart);

      // Emerald block
      ctx.fillStyle = 'rgba(16, 185, 129, 0.45)';
      ctx.fillRect(xStart, 23, segWidth, height - 23);

      ctx.fillStyle = '#10B981';
      ctx.fillRect(xStart, 22, segWidth, 2);
    }

    // Selection range overlay
    if (selectionRange) {
      const selStart = timeToX(selectionRange.start, width);
      const selEnd = timeToX(selectionRange.end, width);
      const selWidth = Math.max(4, selEnd - selStart);

      ctx.fillStyle = 'rgba(245, 158, 11, 0.2)';
      ctx.fillRect(selStart, 0, selWidth, height);
      ctx.strokeStyle = '#F59E0B';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(selStart, 0, selWidth, height);
    }

    // Ticks & Timecode Labels
    ctx.strokeStyle = '#1E293B';
    ctx.fillStyle = '#64748B';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.lineWidth = 1;

    let tickIntervalMs = 3600 * 1000;
    let labelIntervalMs = 2 * 3600 * 1000;

    if (zoom === '6H') {
      tickIntervalMs = 30 * 60 * 1000;
      labelIntervalMs = 60 * 60 * 1000;
    } else if (zoom === '1H') {
      tickIntervalMs = 5 * 60 * 1000;
      labelIntervalMs = 10 * 60 * 1000;
    } else if (zoom === '15M') {
      tickIntervalMs = 60 * 1000;
      labelIntervalMs = 3 * 60 * 1000;
    }

    const firstTickTime = Math.ceil(viewStart / tickIntervalMs) * tickIntervalMs;

    for (let t = firstTickTime; t <= viewEnd; t += tickIntervalMs) {
      const x = ((t - viewStart) / viewTotalMs) * width;
      const isMajor = t % labelIntervalMs === 0;

      ctx.beginPath();
      ctx.moveTo(x, isMajor ? 6 : 14);
      ctx.lineTo(x, 22);
      ctx.strokeStyle = isMajor ? '#334155' : '#1E293B';
      ctx.stroke();

      if (isMajor) {
        const d = new Date(t);
        const timeStr = d.toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: zoom === '15M' ? '2-digit' : undefined,
          hour12: false,
        });
        const textWidth = ctx.measureText(timeStr).width;
        const textX = Math.min(width - textWidth - 4, Math.max(4, x - textWidth / 2));
        ctx.fillStyle = '#94A3B8';
        ctx.fillText(timeStr, textX, 15);
      }
    }

    // Playhead line & needle
    const playheadTime = currentTime.getTime();
    if (playheadTime >= viewStart && playheadTime <= viewEnd) {
      const playheadX = ((playheadTime - viewStart) / viewTotalMs) * width;

      // Needle core
      ctx.strokeStyle = '#F59E0B';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, height);
      ctx.stroke();

      // Top indicator arrow
      ctx.fillStyle = '#F59E0B';
      ctx.beginPath();
      ctx.moveTo(playheadX - 5, 0);
      ctx.lineTo(playheadX + 5, 0);
      ctx.lineTo(playheadX, 7);
      ctx.closePath();
      ctx.fill();
    }
  }, [currentDate, currentTime, segments, selectionRange, zoom, viewStart, viewEnd]);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    setIsDragging(true);
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const newTime = xToTime(x, rect.width);
    onSeek(newTime);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDragging) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const newTime = xToTime(x, rect.width);
    onSeek(newTime);
  };

  const handlePointerUp = () => {
    setIsDragging(false);
  };

  const pad = (n: number) => n.toString().padStart(2, '0');
  const padMs = (n: number) => n.toString().padStart(3, '0');
  const formattedTimecode = `${pad(currentTime.getHours())}:${pad(currentTime.getMinutes())}:${pad(
    currentTime.getSeconds()
  )}.${padMs(currentTime.getMilliseconds())}`;

  return (
    <div
      ref={containerRef}
      className="w-full bg-vms-surface border border-vms-border rounded p-2.5 select-none font-mono"
    >
      {/* Telemetry Strip & Controls */}
      <div className="flex flex-wrap justify-between items-center mb-2 gap-2 border-b border-vms-border pb-2 text-xs">
        <div className="flex items-center space-x-3">
          <div className="flex items-center space-x-1.5">
            <span className="text-[10px] text-vms-dim tracking-wider uppercase font-mono">SEEK:</span>
            <span className="text-amber-400 font-bold tracking-tight text-xs bg-vms-panel px-2 py-0.5 rounded border border-vms-border font-mono">
              {formattedTimecode}
            </span>
          </div>

          <div className="hidden sm:flex items-center space-x-1.5 text-[10px] text-vms-muted font-mono">
            <span className="text-vms-dim">RANGE:</span>
            <span>
              {new Date(viewStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })} –{' '}
              {new Date(viewEnd).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
            </span>
          </div>

          <div className="hidden md:flex items-center space-x-1.5 text-[10px] font-mono">
            <span className="text-vms-dim">RECORDINGS:</span>
            <span className="text-emerald-400 font-semibold">
              {segments.length} {segments.length === 1 ? 'block' : 'blocks'}
            </span>
          </div>
        </div>

        {/* Zoom Presets & Legend */}
        <div className="flex items-center space-x-3">
          <div className="flex items-center rounded border border-vms-border bg-vms-panel p-0.5">
            {(['24H', '6H', '1H', '15M'] as ZoomLevel[]).map((lvl) => (
              <button
                key={lvl}
                onClick={() => setZoom(lvl)}
                className={`px-2 py-0.5 text-[10px] uppercase font-mono font-medium rounded transition-colors ${
                  zoom === lvl
                    ? 'bg-amber-500 text-slate-950 font-bold'
                    : 'text-vms-muted hover:text-vms-text hover:bg-vms-hover'
                }`}
              >
                {lvl}
              </button>
            ))}
          </div>

          <div className="hidden lg:flex items-center space-x-2.5 text-[10px] font-mono text-vms-dim">
            <div className="flex items-center space-x-1">
              <span className="w-2 h-2 rounded-sm bg-emerald-500" />
              <span>Footage</span>
            </div>
            <div className="flex items-center space-x-1">
              <span className="w-2 h-2 rounded-sm bg-vms-panel border border-vms-border" />
              <span>Gap / Void</span>
            </div>
          </div>
        </div>
      </div>

      {/* Scrub Canvas */}
      <div className="relative w-full h-14 cursor-crosshair bg-vms-bg border border-vms-border rounded overflow-hidden">
        <canvas
          ref={canvasRef}
          width={1200}
          height={56}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          className="w-full h-full block"
        />
      </div>
    </div>
  );
};

export default TimelineScrubber;
