import React, { useState, useEffect } from 'react';
import { Calendar, Save, Clock, Briefcase, Zap, X } from 'lucide-react';
import api from '../services/api';

const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] as const;
type DayOfWeek = typeof DAYS[number];
type Mode = 'CONTINUOUS' | 'MOTION' | 'OFF';

interface ScheduleMatrixModalProps {
  camera: { id: string; name: string };
  onClose: () => void;
}

export const ScheduleMatrixModal: React.FC<ScheduleMatrixModalProps> = ({ camera, onClose }) => {
  const [matrix, setMatrix] = useState<Record<DayOfWeek, Mode[]>>({
    MONDAY: Array(24).fill('CONTINUOUS'),
    TUESDAY: Array(24).fill('CONTINUOUS'),
    WEDNESDAY: Array(24).fill('CONTINUOUS'),
    THURSDAY: Array(24).fill('CONTINUOUS'),
    FRIDAY: Array(24).fill('CONTINUOUS'),
    SATURDAY: Array(24).fill('CONTINUOUS'),
    SUNDAY: Array(24).fill('CONTINUOUS'),
  });
  const [selectedBrush, setSelectedBrush] = useState<Mode>('CONTINUOUS');
  const [recordingMode, setRecordingMode] = useState<string>('SCHEDULED');
  const [timezone, setTimezone] = useState<string>('Asia/Kolkata');
  const [isMouseDown, setIsMouseDown] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    api.get(`/cameras/${camera.id}/schedule`).then((res) => {
      if (res.data?.schedule?.weeklyMatrixJson) {
        setMatrix(res.data.schedule.weeklyMatrixJson);
      }
      if (res.data?.timezone) {
        setTimezone(res.data.timezone);
      }
      if (res.data?.recordingMode) {
        setRecordingMode(res.data.recordingMode);
      }
    }).catch((err) => console.error('Failed loading schedule:', err));
  }, [camera.id]);

  const paintCell = (day: DayOfWeek, hour: number) => {
    setMatrix((prev) => {
      const dayArr = [...prev[day]];
      dayArr[hour] = selectedBrush;
      return { ...prev, [day]: dayArr };
    });
  };

  const handleCellClick = (day: DayOfWeek, hour: number) => {
    paintCell(day, hour);
  };

  const handleCellMouseEnter = (day: DayOfWeek, hour: number) => {
    if (isMouseDown) {
      paintCell(day, hour);
    }
  };

  // Bulk presets
  const applyAll = (mode: Mode) => {
    setMatrix({
      MONDAY: Array(24).fill(mode),
      TUESDAY: Array(24).fill(mode),
      WEDNESDAY: Array(24).fill(mode),
      THURSDAY: Array(24).fill(mode),
      FRIDAY: Array(24).fill(mode),
      SATURDAY: Array(24).fill(mode),
      SUNDAY: Array(24).fill(mode),
    });
  };

  const applyBusinessHours = () => {
    const newMatrix = { ...matrix };
    for (const d of DAYS) {
      if (d === 'SATURDAY' || d === 'SUNDAY') {
        newMatrix[d] = Array(24).fill('MOTION');
      } else {
        newMatrix[d] = Array(24).fill('MOTION');
        for (let h = 8; h <= 18; h++) {
          newMatrix[d][h] = 'CONTINUOUS';
        }
      }
    }
    setMatrix(newMatrix);
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage('');
    try {
      await api.put(`/cameras/${camera.id}/schedule`, {
        weeklyMatrix: matrix,
        recordingMode,
      });
      setMessage('Schedule saved and applied successfully.');
      setTimeout(() => onClose(), 1200);
    } catch (err: any) {
      setMessage(`Save error: ${err.response?.data?.error || err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const getCellColor = (mode: Mode) => {
    switch (mode) {
      case 'CONTINUOUS':
        return 'bg-emerald-600 hover:bg-emerald-500 text-white';
      case 'MOTION':
        return 'bg-amber-600 hover:bg-amber-500 text-white';
      case 'OFF':
      default:
        return 'bg-graphite-800 hover:bg-graphite-700 text-slate-500';
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50 backdrop-blur-sm select-none"
      onMouseUp={() => setIsMouseDown(false)}
    >
      <div className="bg-graphite-850 border border-graphite-700 rounded-md w-full max-w-4xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-graphite-700 flex justify-between items-center bg-graphite-800">
          <div className="flex items-center space-x-2">
            <Calendar className="w-4 h-4 text-cctv-amber" />
            <h3 className="text-sm font-semibold text-slate-100 uppercase tracking-wider">
              7x24 Recording Schedule — {camera.name}
            </h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Toolbar */}
        <div className="p-4 border-b border-graphite-700 flex flex-wrap items-center justify-between gap-3 bg-graphite-900/60">
          <div className="flex items-center space-x-3">
            <div className="flex items-center space-x-1.5">
              <span className="text-xs font-mono text-slate-300">Active Mode:</span>
              <select
                value={recordingMode}
                onChange={(e) => setRecordingMode(e.target.value)}
                className="bg-graphite-800 border border-graphite-700 text-slate-200 text-xs rounded px-2 py-1 font-mono focus:border-cctv-amber focus:outline-none"
              >
                <option value="SCHEDULED">SCHEDULED (Follows 7x24 Matrix)</option>
                <option value="CONTINUOUS">CONTINUOUS (24/7 Always)</option>
                <option value="MOTION">MOTION (Scene Change Only)</option>
                <option value="OFF">OFF (Live Only)</option>
              </select>
            </div>

            <div className="text-[11px] font-mono px-2 py-0.5 rounded bg-graphite-800 border border-graphite-700 text-slate-400 flex items-center space-x-1">
              <Clock className="w-3 h-3 text-cctv-teal" />
              <span>Facility Timezone: </span>
              <span className="text-cctv-amber font-semibold">{timezone}</span>
            </div>
          </div>

          {/* Brush Selector */}
          <div className="flex items-center space-x-1 bg-graphite-850 p-1 rounded border border-graphite-700">
            <span className="text-[10px] font-mono text-slate-400 uppercase tracking-wider mr-1">Brush:</span>
            <button
              onClick={() => setSelectedBrush('CONTINUOUS')}
              className={`px-2.5 py-1 rounded text-xs font-mono font-medium transition ${
                selectedBrush === 'CONTINUOUS'
                  ? 'bg-emerald-600 text-white shadow'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              CONTINUOUS
            </button>
            <button
              onClick={() => setSelectedBrush('MOTION')}
              className={`px-2.5 py-1 rounded text-xs font-mono font-medium transition ${
                selectedBrush === 'MOTION'
                  ? 'bg-amber-600 text-white shadow'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              MOTION
            </button>
            <button
              onClick={() => setSelectedBrush('OFF')}
              className={`px-2.5 py-1 rounded text-xs font-mono font-medium transition ${
                selectedBrush === 'OFF'
                  ? 'bg-graphite-700 text-white shadow'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              OFF
            </button>
          </div>
        </div>

        {/* Bulk Presets Bar */}
        <div className="px-4 py-2 bg-graphite-850 border-b border-graphite-700/60 flex items-center justify-between text-xs text-slate-400">
          <div className="flex items-center space-x-2">
            <span className="text-[10px] font-mono uppercase text-slate-400">Presets:</span>
            <button
              onClick={() => applyAll('CONTINUOUS')}
              className="px-2 py-0.5 rounded bg-graphite-800 hover:bg-graphite-700 text-slate-300 font-mono text-[11px] border border-graphite-700"
            >
              All 24/7 Continuous
            </button>
            <button
              onClick={applyBusinessHours}
              className="px-2 py-0.5 rounded bg-graphite-800 hover:bg-graphite-700 text-slate-300 font-mono text-[11px] border border-graphite-700 flex items-center space-x-1"
            >
              <Briefcase className="w-3 h-3 text-cctv-teal" />
              <span>Business Hours (8am-6pm)</span>
            </button>
            <button
              onClick={() => applyAll('MOTION')}
              className="px-2 py-0.5 rounded bg-graphite-800 hover:bg-graphite-700 text-slate-300 font-mono text-[11px] border border-graphite-700 flex items-center space-x-1"
            >
              <Zap className="w-3 h-3 text-cctv-amber" />
              <span>All Motion</span>
            </button>
            <button
              onClick={() => applyAll('OFF')}
              className="px-2 py-0.5 rounded bg-graphite-800 hover:bg-graphite-700 text-slate-300 font-mono text-[11px] border border-graphite-700"
            >
              Clear All
            </button>
          </div>
          <span className="text-[10px] font-mono text-slate-400">Click & drag to paint hours</span>
        </div>

        {/* 7x24 Matrix Grid Canvas */}
        <div
          className="p-4 overflow-x-auto flex-1 bg-graphite-900"
          onMouseDown={() => setIsMouseDown(true)}
        >
          <div className="min-w-[700px]">
            {/* Hour Headers (00 - 23) */}
            <div className="grid grid-cols-[80px_repeat(24,1fr)] gap-0.5 mb-1 text-[10px] font-mono text-slate-400 text-center">
              <div>DAY</div>
              {Array.from({ length: 24 }).map((_, h) => (
                <div key={h} className="truncate">
                  {h.toString().padStart(2, '0')}
                </div>
              ))}
            </div>

            {/* Matrix Rows */}
            {DAYS.map((day) => (
              <div key={day} className="grid grid-cols-[80px_repeat(24,1fr)] gap-0.5 mb-1">
                <div className="text-[11px] font-mono text-slate-300 flex items-center font-semibold uppercase pr-2">
                  {day.slice(0, 3)}
                </div>
                {matrix[day].map((mode, hour) => (
                  <div
                    key={hour}
                    onMouseDown={() => handleCellClick(day, hour)}
                    onMouseEnter={() => handleCellMouseEnter(day, hour)}
                    title={`${day} ${hour.toString().padStart(2, '0')}:00 - ${mode}`}
                    className={`h-7 rounded-xs cursor-pointer border border-black/20 transition-all ${getCellColor(
                      mode
                    )}`}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-graphite-700 flex justify-between items-center bg-graphite-800">
          <span className="text-xs font-mono text-cctv-amber">{message}</span>
          <div className="flex items-center space-x-2">
            <button
              onClick={onClose}
              className="px-4 py-1.5 rounded text-xs text-slate-300 hover:bg-graphite-700 font-mono"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center space-x-1.5 px-4 py-1.5 rounded text-xs font-semibold bg-cctv-amber text-graphite-900 hover:bg-amber-400 disabled:opacity-50 font-mono shadow-md"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{saving ? 'Applying...' : 'Save Schedule'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ScheduleMatrixModal;
