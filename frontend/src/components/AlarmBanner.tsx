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
      role="alert"
      className={`px-4 py-1.5 border-b flex items-center justify-between text-xs font-mono transition-colors ${
        isCritical
          ? 'bg-phosphor-red/15 border-phosphor-red text-phosphor-red'
          : 'bg-phosphor-amber/10 border-phosphor-amber text-phosphor-amber'
      }`}
    >
      <div className="flex items-center space-x-2.5">
        <span className="flex h-2 w-2 relative" aria-hidden="true">
          <span
            className={`animate-ping absolute inline-flex h-full w-full rounded-none opacity-75 ${
              isCritical ? 'bg-phosphor-red' : 'bg-phosphor-amber'
            }`}
          />
          <span
            className={`relative inline-flex rounded-none h-2 w-2 ${
              isCritical ? 'bg-phosphor-red' : 'bg-phosphor-amber'
            }`}
          />
        </span>

        <span className="font-bold uppercase tracking-wider text-[11px]">
          [ {activeAlarms.length} ACTIVE ALARM{activeAlarms.length > 1 ? 'S' : ''} ]:
        </span>

        <span className="truncate max-w-md text-xs">
          <strong className="font-mono text-tactical-bright">{topAlarm.title}</strong>
          <span className="font-sans text-tactical-text ml-1.5">— {topAlarm.description || 'Action required'}</span>
        </span>
      </div>

      <div className="flex items-center space-x-2.5">
        <button
          onClick={() => handleQuickAcknowledge(topAlarm.id)}
          className="btn-tactical-secondary !text-[10px] !py-0.5 !px-2"
        >
          <CheckCircle2 className="w-3 h-3 text-phosphor-green" />
          <span>Acknowledge Top</span>
        </button>

        {onNavigateToAlarms && (
          <button
            onClick={onNavigateToAlarms}
            className="flex items-center space-x-1 text-phosphor-cyan hover:text-phosphor-cyan-glow text-[11px] font-mono uppercase tracking-wider font-semibold focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-phosphor-cyan"
          >
            <span>Alarms Console</span>
            <ChevronRight className="w-3 h-3" />
          </button>
        )}

        <button
          onClick={() => setDismissed(true)}
          className="p-1 text-tactical-muted hover:text-tactical-bright transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-phosphor-cyan"
          title="Dismiss Banner"
          aria-label="Dismiss Banner"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};

export default AlarmBanner;
