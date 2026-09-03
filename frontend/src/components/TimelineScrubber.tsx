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

export const TimelineScrubber: React.FC<TimelineScrubberProps> = ({
  currentDate,
  currentTime,
  segments,
  onSeek,
  selectionRange,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const dayStart = new Date(currentDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(currentDate);
  dayEnd.setHours(23, 59, 59, 999);
  const dayTotalMs = dayEnd.getTime() - dayStart.getTime();

  const timeToX = (time: Date, width: number) => {
    const elapsed = time.getTime() - dayStart.getTime();
    return Math.max(0, Math.min(width, (elapsed / dayTotalMs) * width));
  };

  const xToTime = (x: number, width: number) => {
    const ratio = Math.max(0, Math.min(1, x / width));
    return new Date(dayStart.getTime() + ratio * dayTotalMs);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    // Background
    ctx.fillStyle = '#121418';
    ctx.fillRect(0, 0, width, height);

    // Track background
    ctx.fillStyle = '#1e2229';
    ctx.fillRect(0, 20, width, height - 20);

    // Draw recording segments (Green = Continuous)
    ctx.fillStyle = '#10b981';
    for (const seg of segments) {
      const segStart = new Date(seg.startTime);
      const segEnd = new Date(seg.endTime);

      if (segEnd < dayStart || segStart > dayEnd) continue;

      const xStart = timeToX(segStart, width);
      const xEnd = timeToX(segEnd, width);
      const segWidth = Math.max(2, xEnd - xStart);

      ctx.fillRect(xStart, 20, segWidth, height - 20);
    }

    // Draw selection range overlay if active
    if (selectionRange) {
      const selStart = timeToX(selectionRange.start, width);
      const selEnd = timeToX(selectionRange.end, width);
      ctx.fillStyle = 'rgba(245, 158, 11, 0.3)';
      ctx.fillRect(selStart, 0, Math.max(4, selEnd - selStart), height);
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2;
      ctx.strokeRect(selStart, 0, Math.max(4, selEnd - selStart), height);
    }

    // Hour ticks and labels
    ctx.strokeStyle = '#384152';
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.lineWidth = 1;

    for (let hour = 0; hour <= 24; hour++) {
      const x = (hour / 24) * width;

      // Major tick
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 20);
      ctx.stroke();

      // Text label every 2 hours
      if (hour % 2 === 0) {
        const text = `${hour.toString().padStart(2, '0')}:00`;
        const textWidth = ctx.measureText(text).width;
        const textX = Math.min(width - textWidth, Math.max(2, x - textWidth / 2));
        ctx.fillText(text, textX, 14);
      }
    }

    // Current playhead scrubber (amber/white line)
    const playheadX = timeToX(currentTime, width);
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();

    // Playhead arrow indicator
    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.moveTo(playheadX - 5, 0);
    ctx.lineTo(playheadX + 5, 0);
    ctx.lineTo(playheadX, 8);
    ctx.closePath();
    ctx.fill();
  }, [currentDate, currentTime, segments, selectionRange]);

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

  return (
    <div className="w-full bg-graphite-850 p-3 rounded border border-graphite-700 select-none">
      <div className="flex justify-between items-center mb-2 text-xs font-mono">
        <div className="flex items-center space-x-3">
          <span className="text-slate-400">Position:</span>
          <span className="text-cctv-amber font-semibold">{currentTime.toLocaleTimeString()}</span>
        </div>

        <div className="flex items-center space-x-4 text-[11px]">
          <div className="flex items-center space-x-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-[#10b981]" />
            <span className="text-slate-300">Continuous Recording</span>
          </div>
          <div className="flex items-center space-x-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-[#1e2229] border border-graphite-600" />
            <span className="text-slate-400">No Data / Gap</span>
          </div>
        </div>
      </div>

      <div className="relative w-full h-16 cursor-crosshair">
        <canvas
          ref={canvasRef}
          width={1200}
          height={64}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          className="w-full h-full rounded bg-graphite-900"
        />
      </div>
    </div>
  );
};

export default TimelineScrubber;
