import React, { useState, useEffect } from 'react';
import { CheckCircle2, ChevronRight, X } from 'lucide-react';
import api from '../services/api';

interface AlarmBannerProps {
  onNavigateToAlarms?: () => void;
}

export const AlarmBanner: React.FC<AlarmBannerProps> = ({ onNavigateToAlarms }) => {
  const [activeAlarms, setActiveAlarms] = useState<any[]>([]);
  const [dismissed, setDismissed] = useState(false);

  const fetchActiveAlarms = async () => {
    try {
      const res = await api.get('/alarms', { params: { state: 'ACTIVE' } });
      setActiveAlarms(res.data.alarms || []);
    } catch {
      // Ignore background poll errors
    }
  };

  useEffect(() => {
    fetchActiveAlarms();
    const timer = setInterval(fetchActiveAlarms, 15000); // 15s poll
    return () => clearInterval(timer);
  }, []);

  if (dismissed || activeAlarms.length === 0) return null;

  const topAlarm = activeAlarms[0];
  const isCritical = activeAlarms.some((a) => a.severity === 'CRITICAL');

  const handleQuickAcknowledge = async (alarmId: string) => {
    try {
      await api.post(`/alarms/${alarmId}/acknowledge`);
      fetchActiveAlarms();
    } catch (err) {
      console.error('Failed to acknowledge alarm:', err);
    }
  };

  return (
    <div
      className={`px-4 py-2 border-b flex items-center justify-between text-xs font-mono transition-colors shadow-md ${
        isCritical
          ? 'bg-red-950/90 border-red-800 text-red-200'
          : 'bg-amber-950/90 border-amber-800 text-amber-200'
      }`}
    >
      <div className="flex items-center space-x-2.5">
        <span className="flex h-2.5 w-2.5 relative">
          <span
            className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
              isCritical ? 'bg-red-400' : 'bg-amber-400'
            }`}
          />
          <span
            className={`relative inline-flex rounded-full h-2.5 w-2.5 ${
              isCritical ? 'bg-red-500' : 'bg-amber-500'
            }`}
          />
        </span>

        <span className="font-bold uppercase tracking-wider">
          {activeAlarms.length} Active Alarm{activeAlarms.length > 1 ? 's' : ''}:
        </span>

        <span className="font-semibold text-white truncate max-w-md">
          {topAlarm.title} — {topAlarm.description || 'Action required'}
        </span>
      </div>

      <div className="flex items-center space-x-2">
        <button
          onClick={() => handleQuickAcknowledge(topAlarm.id)}
          className="flex items-center space-x-1 px-2.5 py-0.5 rounded bg-black/40 hover:bg-black/60 border border-white/20 text-[11px] text-white font-semibold transition"
        >
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
          <span>Acknowledge Top</span>
        </button>

        {onNavigateToAlarms && (
          <button
            onClick={onNavigateToAlarms}
            className="flex items-center space-x-0.5 text-cctv-amber hover:underline text-[11px]"
          >
            <span>Alarms Console</span>
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        )}

        <button
          onClick={() => setDismissed(true)}
          className="p-1 text-slate-400 hover:text-white"
          title="Dismiss Banner"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};

export default AlarmBanner;
