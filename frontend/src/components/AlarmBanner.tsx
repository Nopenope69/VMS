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
      className={`px-4 py-1.5 border-b flex items-center justify-between text-xs font-mono transition-colors ${
        isCritical
          ? 'bg-[#F85149]/15 border-[#F85149] text-[#F85149]'
          : 'bg-[#E3B341]/10 border-[#E3B341] text-[#E3B341]'
      }`}
    >
      <div className="flex items-center space-x-2.5">
        <span className="flex h-2 w-2 relative">
          <span
            className={`animate-ping absolute inline-flex h-full w-full rounded-none opacity-75 ${
              isCritical ? 'bg-[#F85149]' : 'bg-[#E3B341]'
            }`}
          />
          <span
            className={`relative inline-flex rounded-none h-2 w-2 ${
              isCritical ? 'bg-[#F85149]' : 'bg-[#E3B341]'
            }`}
          />
        </span>

        <span className="font-bold uppercase tracking-wider text-[11px]">
          [ {activeAlarms.length} ACTIVE ALARM{activeAlarms.length > 1 ? 'S' : ''} ]:
        </span>

        <span className="font-semibold text-[#E6EDF3] truncate max-w-md text-[11px]">
          {topAlarm.title} — {topAlarm.description || 'Action required'}
        </span>
      </div>

      <div className="flex items-center space-x-2">
        <button
          onClick={() => handleQuickAcknowledge(topAlarm.id)}
          className="flex items-center space-x-1 px-2 py-0.5 rounded-none bg-[#0D1117] hover:bg-[#161B22] border border-[#30363D] text-[10px] text-[#E6EDF3] font-bold uppercase tracking-wider transition-colors"
        >
          <CheckCircle2 className="w-3 h-3 text-[#3FB950]" />
          <span>[ ACKNOWLEDGE TOP ]</span>
        </button>

        {onNavigateToAlarms && (
          <button
            onClick={onNavigateToAlarms}
            className="flex items-center space-x-0.5 text-[#58A6FF] hover:text-[#79C0FF] text-[10px] uppercase font-bold tracking-wider"
          >
            <span>[ ALARMS CONSOLE ]</span>
            <ChevronRight className="w-3 h-3" />
          </button>
        )}

        <button
          onClick={() => setDismissed(true)}
          className="p-1 text-[#8B949E] hover:text-[#E6EDF3] transition-colors"
          title="Dismiss Banner"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};

export default AlarmBanner;
