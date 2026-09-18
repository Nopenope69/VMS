import React, { useState, useEffect, useRef } from 'react';
import {
  ChevronRight,
  X,
  AlertTriangle,
  ShieldAlert,
  Volume2,
  VolumeX,
  BellOff,
  RotateCcw,
} from 'lucide-react';
import api from '../services/api';
import Button from './ui/Button';

interface AlarmBannerProps {
  onNavigateToAlarms?: () => void;
}

function playTacticalChime(isCritical: boolean) {
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const now = ctx.currentTime;
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();

    osc1.type = 'sine';
    if (isCritical) {
      osc1.frequency.setValueAtTime(880, now);
      osc1.frequency.setValueAtTime(659.25, now + 0.12);
    } else {
      osc1.frequency.setValueAtTime(587.33, now);
      osc1.frequency.setValueAtTime(880, now + 0.1);
    }

    gain1.gain.setValueAtTime(0.001, now);
    gain1.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
    gain1.gain.exponentialRampToValueAtTime(0.0001, now + (isCritical ? 0.35 : 0.25));

    osc1.connect(gain1);
    gain1.connect(ctx.destination);

    osc1.start(now);
    osc1.stop(now + (isCritical ? 0.36 : 0.26));
  } catch {
    // AudioContext blocked or unavailable in headless environments
  }
}

export const AlarmBanner: React.FC<AlarmBannerProps> = ({ onNavigateToAlarms }) => {
  const [activeAlarms, setActiveAlarms] = useState<any[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [snoozedUntil, setSnoozedUntil] = useState<number>(0);
  const [pendingAckId, setPendingAckId] = useState<string | null>(null);
  const [undoSecondsLeft, setUndoSecondsLeft] = useState<number>(0);

  const seenAlarmIdsRef = useRef<Set<string>>(new Set());
  const ackTimerRef = useRef<any>(null);
  const ackCountdownRef = useRef<any>(null);

  const fetchActiveAlarms = async () => {
    try {
      const res = await api.get('/alarms', { params: { state: 'ACTIVE' } });
      const fetched: any[] = res.data.alarms || [];
      setActiveAlarms(fetched);

      // Check for new alarms and trigger chime
      if (fetched.length > 0) {
        const hasNewAlarms = fetched.some((a) => !seenAlarmIdsRef.current.has(a.id));
        if (hasNewAlarms) {
          fetched.forEach((a) => seenAlarmIdsRef.current.add(a.id));
          const isSnoozed = Date.now() < snoozedUntil;
          if (!isMuted && !isSnoozed) {
            const hasCritical = fetched.some((a) => a.severity === 'CRITICAL');
            playTacticalChime(hasCritical);
          }
        }
      }
    } catch {
      // Ignore background poll errors
    }
  };

  useEffect(() => {
    fetchActiveAlarms();
    const timer = setInterval(fetchActiveAlarms, 10000);
    return () => {
      clearInterval(timer);
      if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
      if (ackCountdownRef.current) clearInterval(ackCountdownRef.current);
    };
  }, [isMuted, snoozedUntil]);

  if (dismissed || activeAlarms.length === 0) return null;

  // Filter out pending acknowledged alarm from visible head
  const visibleAlarms = activeAlarms.filter((a) => a.id !== pendingAckId);
  if (visibleAlarms.length === 0 && !pendingAckId) return null;

  const topAlarm = visibleAlarms[0] || activeAlarms[0];
  const isCritical = visibleAlarms.some((a) => a.severity === 'CRITICAL');
  const isSnoozed = Date.now() < snoozedUntil;

  const handleQuickAcknowledge = (alarmId: string) => {
    setPendingAckId(alarmId);
    setUndoSecondsLeft(5);

    if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
    if (ackCountdownRef.current) clearInterval(ackCountdownRef.current);

    ackCountdownRef.current = setInterval(() => {
      setUndoSecondsLeft((prev) => {
        if (prev <= 1) {
          clearInterval(ackCountdownRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    ackTimerRef.current = setTimeout(async () => {
      try {
        await api.post(`/alarms/${alarmId}/acknowledge`);
        fetchActiveAlarms();
      } catch (err) {
        console.error('Failed to acknowledge alarm:', err);
      } finally {
        setPendingAckId(null);
      }
    }, 5000);
  };

  const handleCancelAcknowledge = () => {
    if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
    if (ackCountdownRef.current) clearInterval(ackCountdownRef.current);
    setPendingAckId(null);
    setUndoSecondsLeft(0);
  };

  const handleSnooze = () => {
    setSnoozedUntil(Date.now() + 5 * 60 * 1000); // Snooze for 5 minutes
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
        {/* Inline Undo Toast */}
        {pendingAckId ? (
          <div className="flex items-center space-x-1.5 bg-vms-elevated border border-amber-500/50 px-2 py-0.5 rounded text-[11px] font-mono text-amber-300 animate-in fade-in">
            <span>Acknowledging in {undoSecondsLeft}s</span>
            <button
              onClick={handleCancelAcknowledge}
              title="Cancel acknowledgement and keep alarm active"
              className="flex items-center space-x-1 font-bold text-amber-400 hover:text-white px-1 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 transition-colors"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Undo</span>
            </button>
          </div>
        ) : (
          <Button
            variant="secondary"
            size="xs"
            onClick={() => handleQuickAcknowledge(topAlarm.id)}
            className="text-[11px]"
          >
            Acknowledge
          </Button>
        )}

        {/* Tactical Audio Mute & Snooze Controls */}
        <div className="flex items-center space-x-0.5 border-l border-vms-border/60 pl-1.5">
          <button
            onClick={() => setIsMuted(!isMuted)}
            title={isMuted ? 'Unmute alarm chime' : 'Mute alarm chime'}
            aria-label={isMuted ? 'Unmute alarm chime' : 'Mute alarm chime'}
            className={`p-1 rounded transition-colors ${
              isMuted
                ? 'text-rose-400 bg-rose-500/10'
                : 'text-vms-muted hover:text-vms-text hover:bg-vms-surface'
            }`}
          >
            {isMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
          </button>

          <button
            onClick={handleSnooze}
            title={isSnoozed ? 'Chime Snoozed (5m)' : 'Snooze chime for 5 minutes'}
            aria-label="Snooze alarm chime"
            className={`p-1 rounded transition-colors ${
              isSnoozed
                ? 'text-amber-400 bg-amber-500/10'
                : 'text-vms-muted hover:text-vms-text hover:bg-vms-surface'
            }`}
          >
            <BellOff className="w-3.5 h-3.5" />
          </button>
        </div>

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

