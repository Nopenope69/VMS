import React, { useState, useEffect } from 'react';
import { Calendar, Save, Clock, Briefcase, Zap } from 'lucide-react';
import api from '../services/api';
import Modal from './ui/Modal';
import Button from './ui/Button';

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
    api
      .get(`/cameras/${camera.id}/schedule`)
      .then((res) => {
        if (res.data?.schedule?.weeklyMatrixJson) {
          setMatrix(res.data.schedule.weeklyMatrixJson);
        }
        if (res.data?.timezone) {
          setTimezone(res.data.timezone);
        }
        if (res.data?.recordingMode) {
          setRecordingMode(res.data.recordingMode);
        }
      })
      .catch((err) => console.error('Failed loading schedule:', err));
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
        return 'bg-vms-surface hover:bg-vms-hover text-vms-dim';
    }
  };

  return (
    <div onMouseUp={() => setIsMouseDown(false)}>
      <Modal
        isOpen={true}
        onClose={onClose}
        title={`7x24 Recording Schedule — ${camera.name}`}
        subtitle="Matrix scheduled recording policies with brush editor"
        icon={<Calendar className="w-4 h-4 text-vms-accent" />}
        size="4xl"
        footer={
          <div className="flex justify-between items-center w-full">
            <span className="text-xs font-mono text-vms-accent">{message}</span>
            <div className="flex items-center space-x-2">
              <Button variant="secondary" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={Save}
                onClick={handleSave}
                isLoading={saving}
                disabled={saving}
              >
                Save Schedule
              </Button>
            </div>
          </div>
        }
      >
        <div className="space-y-3">
          {/* Toolbar */}
          <div className="p-3 border border-vms-border rounded flex flex-wrap items-center justify-between gap-3 bg-vms-panel">
            <div className="flex items-center space-x-3">
              <div className="flex items-center space-x-1.5">
                <span className="text-xs font-mono text-vms-muted uppercase tracking-wider text-[10px]">Active Mode:</span>
                <select
                  value={recordingMode}
                  onChange={(e) => setRecordingMode(e.target.value)}
                  className="bg-vms-surface border border-vms-border text-vms-text text-xs rounded px-2 py-1 font-mono focus:border-vms-accent focus:outline-none"
                >
                  <option value="SCHEDULED">SCHEDULED (Follows 7x24 Matrix)</option>
                  <option value="CONTINUOUS">CONTINUOUS (24/7 Always)</option>
                  <option value="MOTION">MOTION (Scene Change Only)</option>
                  <option value="OFF">OFF (Live Only)</option>
                </select>
              </div>

              <div className="text-[11px] font-mono px-2 py-0.5 rounded bg-vms-surface border border-vms-border text-vms-muted flex items-center space-x-1">
                <Clock className="w-3 h-3 text-sky-400" />
                <span>Facility Timezone: </span>
                <span className="text-vms-accent font-semibold">{timezone}</span>
              </div>
            </div>

            {/* Brush Selector */}
            <div className="flex items-center space-x-1 bg-vms-surface p-1 rounded border border-vms-border">
              <span className="text-[10px] font-mono text-vms-muted uppercase tracking-wider mr-1">Brush:</span>
              <button
                type="button"
                onClick={() => setSelectedBrush('CONTINUOUS')}
                className={`px-2.5 py-1 rounded text-xs font-mono font-medium transition-colors ${
                  selectedBrush === 'CONTINUOUS'
                    ? 'bg-emerald-600 text-white shadow'
                    : 'text-vms-muted hover:text-vms-text'
                }`}
              >
                CONTINUOUS
              </button>
              <button
                type="button"
                onClick={() => setSelectedBrush('MOTION')}
                className={`px-2.5 py-1 rounded text-xs font-mono font-medium transition-colors ${
                  selectedBrush === 'MOTION'
                    ? 'bg-amber-600 text-white shadow'
                    : 'text-vms-muted hover:text-vms-text'
                }`}
              >
                MOTION
              </button>
              <button
                type="button"
                onClick={() => setSelectedBrush('OFF')}
                className={`px-2.5 py-1 rounded text-xs font-mono font-medium transition-colors ${
                  selectedBrush === 'OFF'
                    ? 'bg-vms-panel text-white shadow'
                    : 'text-vms-muted hover:text-vms-text'
                }`}
              >
                OFF
              </button>
            </div>
          </div>

          {/* Bulk Presets Bar */}
          <div className="px-3 py-2 bg-vms-panel border border-vms-border rounded flex items-center justify-between text-xs text-vms-muted">
            <div className="flex items-center space-x-2">
              <span className="text-[10px] font-mono uppercase text-vms-dim">Presets:</span>
              <button
                type="button"
                onClick={() => applyAll('CONTINUOUS')}
                className="px-2 py-0.5 rounded bg-vms-surface hover:bg-vms-hover text-vms-text font-mono text-[11px] border border-vms-border"
              >
                All 24/7 Continuous
              </button>
              <button
                type="button"
                onClick={applyBusinessHours}
                className="px-2 py-0.5 rounded bg-vms-surface hover:bg-vms-hover text-vms-text font-mono text-[11px] border border-vms-border flex items-center space-x-1"
              >
                <Briefcase className="w-3 h-3 text-sky-400" />
                <span>Business Hours (8am-6pm)</span>
              </button>
              <button
                type="button"
                onClick={() => applyAll('MOTION')}
                className="px-2 py-0.5 rounded bg-vms-surface hover:bg-vms-hover text-vms-text font-mono text-[11px] border border-vms-border flex items-center space-x-1"
              >
                <Zap className="w-3 h-3 text-vms-accent" />
                <span>All Motion</span>
              </button>
              <button
                type="button"
                onClick={() => applyAll('OFF')}
                className="px-2 py-0.5 rounded bg-vms-surface hover:bg-vms-hover text-vms-text font-mono text-[11px] border border-vms-border"
              >
                Clear All
              </button>
            </div>
            <span className="text-[10px] font-mono text-vms-dim">Click & drag to paint hours</span>
          </div>

          {/* 7x24 Matrix Grid Canvas */}
          <div
            className="p-4 overflow-x-auto bg-[#0D0804] rounded border border-vms-border"
            onMouseDown={() => setIsMouseDown(true)}
          >
            <div className="min-w-[700px]">
              {/* Hour Headers (00 - 23) */}
              <div className="grid grid-cols-[80px_repeat(24,1fr)] gap-0.5 mb-1 text-[10px] font-mono text-vms-dim text-center">
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
                  <div className="text-[11px] font-mono text-vms-text flex items-center font-semibold uppercase pr-2">
                    {day.slice(0, 3)}
                  </div>
                  {matrix[day].map((mode, hour) => (
                    <div
                      key={hour}
                      onMouseDown={() => handleCellClick(day, hour)}
                      onMouseEnter={() => handleCellMouseEnter(day, hour)}
                      title={`${day} ${hour.toString().padStart(2, '0')}:00 - ${mode}`}
                      className={`h-7 rounded-xs cursor-pointer border border-black/30 transition-colors ${getCellColor(
                        mode
                      )}`}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default ScheduleMatrixModal;
