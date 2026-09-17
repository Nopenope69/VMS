import React, { useState, useEffect } from 'react';
import { ChevronRight, X, AlertTriangle, ShieldAlert } from 'lucide-react';
import api from '../services/api';
import Button from './ui/Button';

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
    const timer = setInterval(fetchActiveAlarms, 10000);
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
      className={`px-3.5 py-1.5 border-b flex items-center justify-between text-xs select-none transition-colors shrink-0 ${
        isCritical
          ? 'bg-rose-500/10 border-rose-500/40 text-rose-300'
          : 'bg-amber-500/10 border-amber-500/30 text-amber-300'
      }`}
    >
      <div className="flex items-center space-x-2.5 truncate mr-2">
        <span className="flex h-2 w-2 relative shrink-0">
          <span
            className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
              isCritical ? 'bg-rose-400' : 'bg-amber-400'
            }`}
          />
          <span
            className={`relative inline-flex rounded-full h-2 w-2 ${
              isCritical ? 'bg-rose-500' : 'bg-amber-500'
            }`}
          />
        </span>

        {isCritical ? (
          <ShieldAlert className="w-3.5 h-3.5 text-rose-400 shrink-0" />
        ) : (
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
        )}

        <span className="font-mono font-bold text-[11px] uppercase tracking-wider shrink-0">
          {activeAlarms.length} Active {activeAlarms.length === 1 ? 'Alarm' : 'Alarms'}
        </span>

        <span className="truncate text-xs font-sans text-vms-text">
          <strong className="font-semibold text-white">{topAlarm.title}</strong>
          {topAlarm.description && (
            <span className="text-vms-muted ml-1.5 hidden sm:inline">— {topAlarm.description}</span>
          )}
        </span>
      </div>

      <div className="flex items-center space-x-2 shrink-0">
        <Button
          variant="secondary"
          size="xs"
          onClick={() => handleQuickAcknowledge(topAlarm.id)}
          className="text-[11px]"
        >
          Acknowledge
        </Button>

        {onNavigateToAlarms && (
          <Button
            variant="ghost"
            size="xs"
            onClick={onNavigateToAlarms}
            icon={ChevronRight}
            iconPosition="right"
            className="text-[11px] text-sky-400 hover:text-sky-300"
          >
            Review All
          </Button>
        )}

        <button
          onClick={() => setDismissed(true)}
          className="p-1 text-vms-muted hover:text-vms-text rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-400"
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
