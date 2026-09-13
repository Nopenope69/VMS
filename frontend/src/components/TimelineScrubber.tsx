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

    // Substrate background
    ctx.fillStyle = '#080B10';
    ctx.fillRect(0, 0, width, height);

    // Track trough
    ctx.fillStyle = '#0D1117';
    ctx.fillRect(0, 24, width, height - 24);

    // Grid baseline
    ctx.strokeStyle = '#21262D';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 24);
    ctx.lineTo(width, 24);
    ctx.stroke();

    // Draw recorded footage segments
    for (const seg of segments) {
      const segStart = new Date(seg.startTime).getTime();
      const segEnd = new Date(seg.endTime).getTime();

      if (segEnd < viewStart || segStart > viewEnd) continue;

      const xStart = Math.max(0, ((segStart - viewStart) / viewTotalMs) * width);
      const xEnd = Math.min(width, ((segEnd - viewStart) / viewTotalMs) * width);
      const segWidth = Math.max(2, xEnd - xStart);

      // Phosphor green block with solid top border
      ctx.fillStyle = '#238636';
      ctx.fillRect(xStart, 25, segWidth, height - 25);

      ctx.fillStyle = '#3FB950';
      ctx.fillRect(xStart, 24, segWidth, 2);
    }

    // Draw selection range overlay if active
    if (selectionRange) {
      const selStart = timeToX(selectionRange.start, width);
      const selEnd = timeToX(selectionRange.end, width);
      const selWidth = Math.max(4, selEnd - selStart);

      ctx.fillStyle = 'rgba(227, 179, 65, 0.2)';
      ctx.fillRect(selStart, 0, selWidth, height);
      ctx.strokeStyle = '#E3B341';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(selStart, 0, selWidth, height);

      // Diagonal hazard hatching for selection
      ctx.strokeStyle = 'rgba(227, 179, 65, 0.4)';
      ctx.lineWidth = 1;
      for (let x = selStart - height; x < selStart + selWidth; x += 12) {
        ctx.beginPath();
        ctx.moveTo(Math.max(selStart, x), 0);
        ctx.lineTo(Math.min(selStart + selWidth, x + height), height);
        ctx.stroke();
      }
    }

    // Ticks & Timecode Labels
    ctx.strokeStyle = '#30363D';
    ctx.fillStyle = '#8B949E';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.lineWidth = 1;

    let tickIntervalMs = 3600 * 1000; // 1 hour for 24H
    let labelIntervalMs = 2 * 3600 * 1000; // every 2 hours

    if (zoom === '6H') {
      tickIntervalMs = 30 * 60 * 1000; // 30 mins
      labelIntervalMs = 60 * 60 * 1000; // 1 hour
    } else if (zoom === '1H') {
      tickIntervalMs = 5 * 60 * 1000; // 5 mins
      labelIntervalMs = 10 * 60 * 1000; // 10 mins
    } else if (zoom === '15M') {
      tickIntervalMs = 60 * 1000; // 1 min
      labelIntervalMs = 3 * 60 * 1000; // 3 mins
    }

    const firstTickTime = Math.ceil(viewStart / tickIntervalMs) * tickIntervalMs;

    for (let t = firstTickTime; t <= viewEnd; t += tickIntervalMs) {
      const x = ((t - viewStart) / viewTotalMs) * width;
      const isMajor = t % labelIntervalMs === 0;

      ctx.beginPath();
      ctx.moveTo(x, isMajor ? 6 : 14);
      ctx.lineTo(x, 24);
      ctx.strokeStyle = isMajor ? '#484F58' : '#21262D';
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
        ctx.fillStyle = '#C9D1D9';
        ctx.fillText(timeStr, textX, 16);
      }
    }

    // Playhead line & optical cursor needle
    const playheadTime = currentTime.getTime();
    if (playheadTime >= viewStart && playheadTime <= viewEnd) {
      const playheadX = ((playheadTime - viewStart) / viewTotalMs) * width;

      // Needle glowing core
      ctx.strokeStyle = '#E3B341';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, height);
      ctx.stroke();

      // Top arrow / reticle
      ctx.fillStyle = '#E3B341';
      ctx.beginPath();
      ctx.moveTo(playheadX - 5, 0);
      ctx.lineTo(playheadX + 5, 0);
      ctx.lineTo(playheadX, 8);
      ctx.closePath();
      ctx.fill();

      // Bottom arrow
      ctx.beginPath();
      ctx.moveTo(playheadX - 4, height);
      ctx.lineTo(playheadX + 4, height);
      ctx.lineTo(playheadX, height - 6);
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
      className="w-full bg-[#0D1117] border border-[#21262D] rounded-none p-2.5 select-none font-mono"
    >
      {/* Telemetry Strip & Controls */}
      <div className="flex flex-wrap justify-between items-center mb-2 gap-2 border-b border-[#21262D] pb-2 text-xs">
        <div className="flex items-center space-x-3">
          <div className="flex items-center space-x-1.5">
            <span className="text-[10px] text-[#8B949E] tracking-wider uppercase">CUE_TIMECODE:</span>
            <span className="text-[#E3B341] font-bold tracking-tight text-xs bg-[#161B22] px-2 py-0.5 border border-[#30363D]">
              {formattedTimecode}
            </span>
          </div>

          <div className="hidden sm:flex items-center space-x-1.5 text-[10px] text-[#8B949E]">
            <span>WINDOW:</span>
            <span className="text-[#C9D1D9]">
              {new Date(viewStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })} -{' '}
              {new Date(viewEnd).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
            </span>
          </div>

          <div className="hidden md:flex items-center space-x-1.5 text-[10px]">
            <span className="text-[#8B949E]">SECTOR_FOOTAGE:</span>
            <span className="text-[#3FB950] font-bold">
              [{segments.length} {segments.length === 1 ? 'SEGMENT' : 'SEGMENTS'}]
            </span>
          </div>
        </div>

        {/* Zoom Presets & Legend */}
        <div className="flex items-center space-x-4">
          <div className="flex items-center border border-[#30363D] bg-[#080B10]">
            {(['24H', '6H', '1H', '15M'] as ZoomLevel[]).map((lvl) => (
              <button
                key={lvl}
                onClick={() => setZoom(lvl)}
                className={`px-2 py-0.5 text-[10px] uppercase font-bold tracking-wide transition-colors ${
                  zoom === lvl
                    ? 'bg-[#E3B341] text-[#080B10]'
                    : 'text-[#8B949E] hover:text-[#C9D1D9] hover:bg-[#161B22]'
                }`}
              >
                {lvl}
              </button>
            ))}
          </div>

          <div className="hidden lg:flex items-center space-x-3 text-[10px]">
            <div className="flex items-center space-x-1">
              <span className="w-2 h-2 bg-[#3FB950] border border-[#238636]" />
              <span className="text-[#8B949E]">fMP4 RECORDBLOCK</span>
            </div>
            <div className="flex items-center space-x-1">
              <span className="w-2 h-2 bg-[#0D1117] border border-[#30363D]" />
              <span className="text-[#8B949E]">SIGNAL LOSS / VOID</span>
            </div>
          </div>
        </div>
      </div>

      {/* Crosshair Scrub Canvas */}
      <div className="relative w-full h-16 cursor-crosshair bg-[#080B10] border border-[#21262D]">
        <canvas
          ref={canvasRef}
          width={1200}
          height={64}
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
