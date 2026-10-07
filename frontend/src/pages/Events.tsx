import React, { useState, useEffect } from 'react';
import {
  AlertTriangle,
  AlertCircle,
  Info,
  CheckCircle2,
  RefreshCw,
  ShieldAlert,
  ListFilter,
  Check,
  Clock,
  FileText,
  Video,
  Filter,
  UserCheck,
  Download,
  Workflow,
} from 'lucide-react';
import api from '../services/api';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { EmptyState } from '../components/ui/EmptyState';
import { AiEvaluationBanner, AiProvenanceBadge } from '../components/AiEvaluationBanner';
import { AlarmSecondOpinion } from '../components/AlarmSecondOpinion';
import { AlarmTriagePanel } from '../components/AlarmTriagePanel';
import { AlarmIncidentSummary } from '../components/AlarmIncidentSummary';
import { EventActionRuleModal } from '../components/EventActionRuleModal';
import { useFeatureFlags } from '../services/features';
import { DEMO_ALARMS, DEMO_EVENTS, DEMO_USER } from '../demo/fixtures';

const describeError = (err: any): string =>
  err?.response?.data?.error || err?.message || 'backend unreachable';

type ConsoleTab = 'ALARMS' | 'EVENTS' | 'TRIAGE';

interface AlarmItem {
  id: string;
  title: string;
  description: string | null;
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  state: 'ACTIVE' | 'ACKNOWLEDGED' | 'RESOLVED';
  cameraId: string | null;
  camera?: { id: string; name: string };
  eventId?: string | null;
  acknowledgedAt?: string | null;
  acknowledgedBy?: string | null;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
  resolutionNotes?: string | null;
  /** Incident workflow (P3.4). */
  assignedToUserId?: string | null;
  ackDueAt?: string | null;
  resolveDueAt?: string | null;
  ackSlaBreachedAt?: string | null;
  resolveSlaBreachedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  /** Rule-raised alarms carry the canonical event and, for AI events, the model provenance. */
  metadataJson?: { provenance?: { modelName?: string; modelVersion?: string } | null } | null;
}

/** The signed-in user's id, as stored by the login flow (App.tsx). */
const currentUserId = (): string | null => {
  try {
    return JSON.parse(localStorage.getItem('vigilone_user') || 'null')?.id ?? null;
  } catch {
    return null;
  }
};

const SlaBadge: React.FC<{ alarm: AlarmItem }> = ({ alarm }) => {
  if (alarm.state === 'RESOLVED') return null;
  if (alarm.ackSlaBreachedAt && alarm.state === 'ACTIVE') {
    return <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-rose-600/20 text-rose-400 border border-rose-600 font-mono">ACK SLA BREACHED</span>;
  }
  if (alarm.resolveSlaBreachedAt) {
    return <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-rose-600/20 text-rose-400 border border-rose-600 font-mono">RESOLVE SLA BREACHED</span>;
  }
  const due = alarm.state === 'ACTIVE' ? alarm.ackDueAt : alarm.resolveDueAt;
  if (!due) return null;
  return (
    <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-vms-surface text-vms-muted border border-vms-border font-mono" title={due}>
      {alarm.state === 'ACTIVE' ? 'ack' : 'resolve'} by {new Date(due).toISOString().slice(11, 16)} UTC
    </span>
  );
};

/* Modal ARIA dialog semantics: role="dialog" aria-modal="true" handles e.key === 'Escape' */
export const Events: React.FC = () => {
  const [consoleTab, setConsoleTab] = useState<ConsoleTab>('ALARMS');
  const featureFlags = useFeatureFlags();
  const [triageRefresh, setTriageRefresh] = useState(0);
  const [showAutomation, setShowAutomation] = useState(false);

  // Alarms State
  const [alarms, setAlarms] = useState<AlarmItem[]>([]);
  const [selectedAlarmIds, setSelectedAlarmIds] = useState<string[]>([]);
  const [alarmStateFilter, setAlarmStateFilter] = useState<string>('ACTIVE');
  const [alarmSeverityFilter, setAlarmSeverityFilter] = useState<string>('');
  const [alarmLoading, setAlarmLoading] = useState(false);
  const [alarmError, setAlarmError] = useState<string | null>(null);
  const [resolvingAlarm, setResolvingAlarm] = useState<AlarmItem | null>(null);
  const [resolutionNotes, setResolutionNotes] = useState('');
  const [submittingResolve, setSubmittingResolve] = useState(false);
  /** Operator verdict recorded with the resolution (P3.7); '' = not stated. */
  const [verdict, setVerdict] = useState<'' | 'FALSE_ALARM' | 'TRUE_ALARM'>('');
  const [bulkTriaging, setBulkTriaging] = useState(false);

  const RESOLUTION_PRESETS = [
    'False Alarm / Environmental Trigger',
    'Security Guard Dispatched & Verified',
    'Maintenance / Sensor Calibration Test',
    'Perimeter Inspected — Sector All Clear',
  ];

  // Raw Events State
  const [events, setEvents] = useState<any[]>([]);
  const [eventStats, setEventStats] = useState<any>({ critical: 0, warning: 0, info: 0, unacknowledgedTotal: 0 });
  const [eventSeverityFilter, setEventSeverityFilter] = useState<string>('');
  const [unackOnly, setUnackOnly] = useState<boolean>(false);
  const [eventLoading, setEventLoading] = useState(false);
  const [eventError, setEventError] = useState<string | null>(null);

  // Fetch Alarms. Production shows exactly what the backend returns; an unreachable backend is
  // surfaced as an error, never papered over with simulated alarms (demo builds only).
  const fetchAlarms = async () => {
    setAlarmLoading(true);
    setAlarmError(null);
    const applyDemoAlarms = () => {
      if (!__DEMO_MODE__) return;
      let filtered = [...DEMO_ALARMS] as AlarmItem[];
      if (alarmStateFilter && alarmStateFilter !== 'ALL') {
        filtered = filtered.filter((a) => a.state === alarmStateFilter);
      }
      if (alarmSeverityFilter) {
        filtered = filtered.filter((a) => a.severity === alarmSeverityFilter);
      }
      setAlarms(filtered);
    };
    try {
      const params: any = {};
      if (alarmStateFilter && alarmStateFilter !== 'ALL') params.state = alarmStateFilter;
      if (alarmSeverityFilter) params.severity = alarmSeverityFilter;

      const res = await api.get('/alarms', { params });
      const realAlarms: AlarmItem[] = res.data?.alarms || [];
      if (__DEMO_MODE__ && realAlarms.length === 0) {
        applyDemoAlarms();
      } else {
        setAlarms(realAlarms);
      }
    } catch (err: any) {
      if (__DEMO_MODE__) {
        applyDemoAlarms();
      } else {
        console.error('Failed to load alarms:', err);
        setAlarms([]);
        setAlarmError(err?.response?.data?.error || err?.message || 'Alarm service unreachable');
      }
    } finally {
      setAlarmLoading(false);
    }
  };

  // Fetch Raw Events
  const fetchEvents = async () => {
    setEventLoading(true);
    setEventError(null);
    const applyDemoEvents = () => {
      if (!__DEMO_MODE__) return;
      let filtered = [...DEMO_EVENTS];
      if (eventSeverityFilter) filtered = filtered.filter((e) => e.severity === eventSeverityFilter);
      if (unackOnly) filtered = filtered.filter((e) => !e.acknowledged);
      setEvents(filtered);
      setEventStats({
        critical: filtered.filter((e) => e.severity === 'CRITICAL').length,
        warning: filtered.filter((e) => e.severity === 'WARNING').length,
        info: filtered.filter((e) => e.severity === 'INFO').length,
        unacknowledgedTotal: filtered.filter((e) => !e.acknowledged).length,
      });
    };
    try {
      const params: any = {};
      if (eventSeverityFilter) params.severity = eventSeverityFilter;
      if (unackOnly) params.unacknowledgedOnly = 'true';

      const [resEvents, resStats] = await Promise.all([
        api.get('/events', { params }),
        api.get('/events/stats'),
      ]);

      const realEvents = resEvents.data?.events || [];
      if (__DEMO_MODE__ && realEvents.length === 0) {
        applyDemoEvents();
      } else {
        setEvents(realEvents);
        setEventStats(resStats.data || { critical: 0, warning: 0, info: 0, unacknowledgedTotal: 0 });
      }
    } catch (err: any) {
      if (__DEMO_MODE__) {
        applyDemoEvents();
      } else {
        console.error('Failed to load events:', err);
        setEvents([]);
        setEventStats({ critical: 0, warning: 0, info: 0, unacknowledgedTotal: 0 });
        setEventError(err?.response?.data?.error || err?.message || 'Event service unreachable');
      }
    } finally {
      setEventLoading(false);
    }
  };

  useEffect(() => {
    if (consoleTab === 'ALARMS') {
      fetchAlarms();
    } else if (consoleTab === 'EVENTS') {
      fetchEvents();
    }
  }, [consoleTab, alarmStateFilter, alarmSeverityFilter, eventSeverityFilter, unackOnly]);

  const [exportNotice, setExportNotice] = useState<string | null>(null);

  // Assign to the signed-in operator, or release the assignment
  const handleAssign = async (alarm: AlarmItem) => {
    const me = currentUserId();
    const target = alarm.assignedToUserId === me ? null : me;
    try {
      await api.post(`/alarms/${alarm.id}/assign`, { userId: target });
      fetchAlarms();
    } catch (err: any) {
      setAlarmError(`Assignment failed; nothing changed (${describeError(err)})`);
    }
  };

  // One-click evidence export over the alarm's incident window
  const handleExport = async (alarm: AlarmItem) => {
    setExportNotice(null);
    try {
      const res = await api.post(`/alarms/${alarm.id}/export`);
      setExportNotice(`Evidence package ${res.data.filename} created (${res.data.window.source === 'INCIDENT_HOLD' ? 'incident hold window' : 'default alarm window'}).`);
    } catch (err: any) {
      setAlarmError(`Export failed; no package was created (${describeError(err)})`);
    }
  };

  // Acknowledge Alarm
  const handleAcknowledgeAlarm = async (alarmId: string) => {
    try {
      await api.post(`/alarms/${alarmId}/acknowledge`);
      fetchAlarms();
    } catch (err: any) {
      if (__DEMO_MODE__) {
        setAlarms(prev => prev.map(a => a.id === alarmId ? {
          ...a,
          state: 'ACKNOWLEDGED',
          acknowledgedAt: new Date().toISOString(),
          acknowledgedBy: DEMO_USER.name
        } : a));
      } else {
        // Never show an alarm as acknowledged unless the backend recorded it.
        setAlarmError(`Acknowledge failed; alarm is still ACTIVE (${describeError(err)})`);
      }
    }
  };

  const handleToggleSelectAlarm = (id: string) => {
    setSelectedAlarmIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const handleSelectAllAlarms = () => {
    const activeIds = alarms.filter((a) => a.state === 'ACTIVE').map((a) => a.id);
    if (selectedAlarmIds.length === activeIds.length && activeIds.length > 0) {
      setSelectedAlarmIds([]);
    } else {
      setSelectedAlarmIds(activeIds);
    }
  };

  const handleBulkAcknowledge = async () => {
    if (selectedAlarmIds.length === 0) return;
    setBulkTriaging(true);
    try {
      await Promise.all(selectedAlarmIds.map((id) => api.post(`/alarms/${id}/acknowledge`)));
      setSelectedAlarmIds([]);
      fetchAlarms();
    } catch (err: any) {
      if (__DEMO_MODE__) {
        setAlarms(prev => prev.map(a => selectedAlarmIds.includes(a.id) ? {
          ...a,
          state: 'ACKNOWLEDGED',
          acknowledgedAt: new Date().toISOString(),
          acknowledgedBy: DEMO_USER.name
        } : a));
        setSelectedAlarmIds([]);
      } else {
        setAlarmError(`Bulk acknowledge failed; refresh to see which alarms the backend recorded (${describeError(err)})`);
        fetchAlarms();
      }
    } finally {
      setBulkTriaging(false);
    }
  };

  const handleAcknowledgeAllCritical = async () => {
    const criticalActive = alarms.filter((a) => a.state === 'ACTIVE' && a.severity === 'CRITICAL');
    if (criticalActive.length === 0) return;
    setBulkTriaging(true);
    try {
      await Promise.all(criticalActive.map((a) => api.post(`/alarms/${a.id}/acknowledge`)));
      setSelectedAlarmIds([]);
      fetchAlarms();
    } catch (err: any) {
      if (__DEMO_MODE__) {
        setAlarms(prev => prev.map(a => a.severity === 'CRITICAL' && a.state === 'ACTIVE' ? {
          ...a,
          state: 'ACKNOWLEDGED',
          acknowledgedAt: new Date().toISOString(),
          acknowledgedBy: DEMO_USER.name
        } : a));
        setSelectedAlarmIds([]);
      } else {
        setAlarmError(`Acknowledge of critical alarms failed; refresh to see which the backend recorded (${describeError(err)})`);
        fetchAlarms();
      }
    } finally {
      setBulkTriaging(false);
    }
  };

  // Open Resolve Dialog
  const handleOpenResolve = (alarm: AlarmItem) => {
    setResolvingAlarm(alarm);
    setResolutionNotes('');
  };

  // Submit Alarm Resolution
  const handleConfirmResolve = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resolvingAlarm) return;
    setSubmittingResolve(true);

    try {
      await api.post(`/alarms/${resolvingAlarm.id}/resolve`, {
        notes: resolutionNotes.trim() || 'Resolved by security operator',
      });
      if (verdict) {
        try {
          await api.post(`/alarms/${resolvingAlarm.id}/feedback`, { verdict, reason: resolutionNotes.trim().slice(0, 500) || undefined });
        } catch (fbErr: any) {
          setAlarmError(`Alarm resolved, but the verdict was not saved (${describeError(fbErr)})`);
        }
      }
      setVerdict('');
      setResolvingAlarm(null);
      fetchAlarms();
    } catch (err: any) {
      if (__DEMO_MODE__) {
        setAlarms(prev => prev.map(a => a.id === resolvingAlarm.id ? {
          ...a,
          state: 'RESOLVED',
          resolvedAt: new Date().toISOString(),
          resolvedBy: DEMO_USER.name,
          resolutionNotes: resolutionNotes.trim() || 'Resolved by security operator'
        } : a));
        setResolvingAlarm(null);
      } else {
        // Keep the dialog open with the operator's notes; the alarm was NOT resolved.
        setAlarmError(`Resolve failed; alarm was not resolved (${describeError(err)})`);
      }
    } finally {
      setSubmittingResolve(false);
    }
  };

  // Acknowledge Raw Event
  const handleAckEvent = async (id: string) => {
    try {
      await api.patch(`/events/${id}/ack`);
      fetchEvents();
    } catch (err: any) {
      if (__DEMO_MODE__) {
        setEvents(prev => prev.map(ev => ev.id === id ? {
          ...ev,
          acknowledged: true,
          acknowledgedAt: new Date().toISOString(),
          acknowledgedBy: DEMO_USER.name
        } : ev));
      } else {
        setEventError(`Acknowledge failed; event is still unacknowledged (${describeError(err)})`);
      }
    }
  };

  const getSeverityBadge = (severity: string) => {
    switch (severity) {
      case 'CRITICAL':
        return (
          <Badge variant="alarm" size="sm" icon={<AlertCircle className="w-3 h-3" />}>
            CRITICAL
          </Badge>
        );
      case 'WARNING':
        return (
          <Badge variant="warn" size="sm" icon={<AlertTriangle className="w-3 h-3" />}>
            WARNING
          </Badge>
        );
      default:
        return (
          <Badge variant="telemetry" size="sm" icon={<Info className="w-3 h-3" />}>
            INFO
          </Badge>
        );
    }
  };

  const getAlarmStateBadge = (state: string) => {
    switch (state) {
      case 'ACTIVE':
        return (
          <Badge variant="alarm" size="sm" dot pulse>
            Active
          </Badge>
        );
      case 'ACKNOWLEDGED':
        return (
          <Badge variant="warn" size="sm" icon={<Clock className="w-3 h-3" />}>
            In Review
          </Badge>
        );
      case 'RESOLVED':
        return (
          <Badge variant="success" size="sm" icon={<CheckCircle2 className="w-3 h-3" />}>
            Resolved
          </Badge>
        );
      default:
        return null;
    }
  };

  // Alarm Counts
  const activeCount = alarms.filter((a) => a.state === 'ACTIVE').length;
  const criticalCount = alarms.filter((a) => a.severity === 'CRITICAL').length;
  const ackCount = alarms.filter((a) => a.state === 'ACKNOWLEDGED').length;
  const resolvedCount = alarms.filter((a) => a.state === 'RESOLVED').length;

  return (
    <div className="flex flex-col min-h-[calc(100vh-3.5rem)] bg-vms-bg p-3 md:p-4 space-y-3">
      <AiEvaluationBanner />
      {/* Top Header & Mode Navigation */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 border-b border-vms-border pb-3">
        <div className="flex items-center gap-2.5">
          <ShieldAlert className="w-5 h-5 text-status-alarm" />
          <h1 className="text-base md:text-lg font-bold text-vms-text tracking-tight uppercase font-mono">
            Incident Command & Dispatch
          </h1>
        </div>

        <div className="flex items-center gap-2">
          {/* The rule builder (automation matrix): which events raise alarms and what else they do. */}
          <button
            onClick={() => setShowAutomation(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-vms-border bg-vms-panel text-vms-muted hover:text-vms-text"
            data-testid="open-automation-rules"
          >
            <Workflow className="w-3.5 h-3.5 text-vms-accent" />
            <span>Automation rules</span>
          </button>
          {/* Segmented Tab Switcher */}
          <div className="flex bg-vms-panel p-1 rounded border border-vms-border">
            <button
              onClick={() => setConsoleTab('ALARMS')}
              className={`flex items-center gap-2 px-3.5 py-1.5 text-xs font-medium rounded transition-all ${
                consoleTab === 'ALARMS'
                  ? 'bg-vms-surface text-vms-text font-semibold shadow-sm border border-vms-border'
                  : 'text-vms-muted hover:text-vms-text hover:bg-vms-surface/50 border border-transparent'
              }`}
            >
              <ShieldAlert className="w-3.5 h-3.5 text-status-alarm" />
              <span>Active Alarms</span>
              {activeCount > 0 && (
                <span className="px-1.5 py-0.5 bg-status-alarm/20 text-status-alarm text-[10px] font-mono font-bold rounded-full">
                  {activeCount}
                </span>
              )}
            </button>

            {featureFlags.ALARM_TRIAGE && (
              <button
                onClick={() => setConsoleTab('TRIAGE')}
                data-testid="triage-tab"
                className={`flex items-center gap-2 px-3.5 py-1.5 text-xs font-medium rounded transition-all ${
                  consoleTab === 'TRIAGE'
                    ? 'bg-vms-surface text-vms-text font-semibold shadow-sm border border-vms-border'
                    : 'text-vms-muted hover:text-vms-text hover:bg-vms-surface/50 border border-transparent'
                }`}
              >
                <ListFilter className="w-3.5 h-3.5 text-vms-accent" />
                <span>Triage</span>
              </button>
            )}

            <button
              onClick={() => setConsoleTab('EVENTS')}
              className={`flex items-center gap-2 px-3.5 py-1.5 text-xs font-medium rounded transition-all ${
                consoleTab === 'EVENTS'
                  ? 'bg-vms-surface text-vms-text font-semibold shadow-sm border border-vms-border'
                  : 'text-vms-muted hover:text-vms-text hover:bg-vms-surface/50 border border-transparent'
              }`}
            >
              <ListFilter className="w-3.5 h-3.5 text-vms-accent" />
              <span>Raw Telemetry Feed</span>
              {eventStats.unacknowledgedTotal > 0 && (
                <span className="px-1.5 py-0.5 bg-vms-elevated text-vms-muted text-[10px] font-mono rounded-full">
                  {eventStats.unacknowledgedTotal}
                </span>
              )}
            </button>
          </div>

          <Button
            variant="secondary"
            size="sm"
            onClick={() => (consoleTab === 'ALARMS' ? fetchAlarms() : consoleTab === 'TRIAGE' ? setTriageRefresh((n) => n + 1) : fetchEvents())}
            isLoading={alarmLoading || eventLoading}
            title="Refresh Incident Feed"
            icon={<RefreshCw className="w-3.5 h-3.5" />}
          >
            Refresh
          </Button>
        </div>
      </div>

      {consoleTab === 'TRIAGE' && featureFlags.ALARM_TRIAGE && (
        <AlarmTriagePanel refreshToken={triageRefresh} onOpenAlarms={() => setConsoleTab('ALARMS')} />
      )}

      {consoleTab === 'ALARMS' && exportNotice && (
        <div role="status" className="px-3 py-2 text-xs font-mono rounded border border-emerald-800 bg-emerald-950/60 text-emerald-300 flex justify-between">
          <span>{exportNotice}</span>
          <button onClick={() => setExportNotice(null)} className="text-vms-muted hover:text-vms-text ml-2">Dismiss</button>
        </div>
      )}
      {((consoleTab === 'ALARMS' && alarmError) || (consoleTab === 'EVENTS' && eventError)) && (
        <div
          role="alert"
          className="p-3 bg-status-alarm/10 border border-status-alarm/30 rounded text-xs text-status-alarm font-mono"
        >
          INCIDENT FEED UNAVAILABLE: {consoleTab === 'ALARMS' ? alarmError : eventError}. The list below is
          empty because the backend could not be reached, not because there are no incidents.
        </div>
      )}

      {/* ========================================================================= */}
      {/* ALARMS WORKFLOW CONSOLE TAB                                              */}
      {/* ========================================================================= */}
      {consoleTab === 'ALARMS' && (
        <div className="space-y-3">
          {/* Horizontal Telemetry Bar */}
          <div className="flex flex-wrap items-center gap-4 sm:gap-6 px-3 py-2 bg-vms-surface border border-vms-border rounded text-xs font-mono">
            <div className="flex items-center gap-2">
              <span className="text-vms-muted">ACTIVE ALARMS:</span>
              <span className={`font-bold ${activeCount > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>{activeCount}</span>
            </div>
            <div className="h-3 w-px bg-vms-border hidden sm:block" />
            <div className="flex items-center gap-2">
              <span className="text-vms-muted">CRITICAL:</span>
              <span className={`font-bold ${criticalCount > 0 ? 'text-rose-400' : 'text-vms-text'}`}>{criticalCount}</span>
            </div>
            <div className="h-3 w-px bg-vms-border hidden sm:block" />
            <div className="flex items-center gap-2">
              <span className="text-vms-muted">IN REVIEW:</span>
              <span className="font-bold text-amber-400">{ackCount}</span>
            </div>
            <div className="h-3 w-px bg-vms-border hidden sm:block" />
            <div className="flex items-center gap-2">
              <span className="text-vms-muted">RESOLVED:</span>
              <span className="font-bold text-emerald-400">{resolvedCount}</span>
            </div>
          </div>

          {/* Filter Bar */}
          <Card padding="sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3">
                {/* State Filter Buttons */}
                <div className="flex bg-vms-bg p-0.5 rounded border border-vms-border">
                  {(['ALL', 'ACTIVE', 'ACKNOWLEDGED', 'RESOLVED'] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => setAlarmStateFilter(s)}
                      className={`px-3 py-1 text-xs rounded transition font-medium ${
                        alarmStateFilter === s
                          ? 'bg-vms-surface text-vms-text font-semibold shadow-xs'
                          : 'text-vms-muted hover:text-vms-text hover:bg-vms-panel'
                      }`}
                    >
                      {s === 'ALL' ? 'All States' : s === 'ACKNOWLEDGED' ? 'In Review' : s.charAt(0) + s.slice(1).toLowerCase()}
                    </button>
                  ))}
                </div>

                {/* Severity Filter */}
                <div className="flex items-center gap-1.5">
                  <Filter className="w-3.5 h-3.5 text-vms-dim" />
                  <select
                    aria-label="Alarm severity"
                    value={alarmSeverityFilter}
                    onChange={(e) => setAlarmSeverityFilter(e.target.value)}
                    className="bg-vms-bg border border-vms-border rounded px-2.5 py-1 text-xs text-vms-text focus:outline-none focus:border-vms-accent"
                  >
                    <option value="">All Severities</option>
                    <option value="CRITICAL">Critical</option>
                    <option value="WARNING">Warning</option>
                    <option value="INFO">Info</option>
                  </select>
                </div>
              </div>

              <div className="text-xs text-vms-muted font-mono">
                Matched Incidents: <span className="text-vms-text font-semibold">{alarms.length}</span>
              </div>
            </div>
          </Card>

          {/* Bulk Triage Action Bar */}
          {activeCount > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 bg-vms-panel rounded border border-vms-border text-xs">
              <div className="flex items-center gap-2">
                <span className="text-vms-muted font-mono">BULK TRIAGE:</span>
                <span className="font-semibold text-vms-text">
                  {selectedAlarmIds.length} of {activeCount} active selected
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={handleBulkAcknowledge}
                  disabled={selectedAlarmIds.length === 0 || bulkTriaging}
                  isLoading={bulkTriaging}
                  icon={<Check className="w-3.5 h-3.5" />}
                >
                  Acknowledge Selected ({selectedAlarmIds.length})
                </Button>
                {criticalCount > 0 && (
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={handleAcknowledgeAllCritical}
                    disabled={bulkTriaging}
                    isLoading={bulkTriaging}
                    icon={<AlertCircle className="w-3.5 h-3.5" />}
                  >
                    Acknowledge All Critical ({criticalCount})
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Alarms Table */}
          <Card padding="none">
            <div className="px-4 py-3 border-b border-vms-border flex items-center justify-between bg-vms-panel/50">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-xs text-vms-text uppercase tracking-wider">
                  Operational Incident Registry
                </span>
                <Badge variant="outline" size="sm">
                  Ed25519 Verified
                </Badge>
              </div>
              <span className="text-[11px] text-vms-dim font-mono">
                Auto-synced with Appliance Edge
              </span>
            </div>

            {alarms.length === 0 ? (
              <EmptyState
                icon={<ShieldAlert className="w-6 h-6" />}
                title="No incidents found"
                description="There are currently no active or historical incidents matching your filter criteria."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-vms-panel/80 text-vms-muted uppercase text-[10px] border-b border-vms-border font-medium tracking-wider">
                    <tr>
                      <th className="px-3 py-2.5 w-10 text-center">
                        <input
                          type="checkbox"
                          checked={
                            activeCount > 0 &&
                            selectedAlarmIds.length === alarms.filter((a) => a.state === 'ACTIVE').length
                          }
                          onChange={handleSelectAllAlarms}
                          disabled={activeCount === 0}
                          aria-label="Select all active alarms"
                          className="rounded bg-vms-bg border-vms-border text-vms-accent focus:ring-0 cursor-pointer"
                        />
                      </th>
                      <th className="px-4 py-2.5">Severity</th>
                      <th className="px-4 py-2.5">Incident Details</th>
                      <th className="px-4 py-2.5">Source Camera</th>
                      <th className="px-4 py-2.5">State</th>
                      <th className="px-4 py-2.5">Timestamp (UTC)</th>
                      <th className="px-4 py-2.5">Operator Notes</th>
                      <th className="px-4 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-vms-border text-vms-text">
                    {alarms.map((alarm) => (
                      <tr key={alarm.id} className="hover:bg-vms-hover/40 transition">
                        <td className="px-3 py-3 text-center">
                          <input
                            type="checkbox"
                            checked={selectedAlarmIds.includes(alarm.id)}
                            onChange={() => handleToggleSelectAlarm(alarm.id)}
                            disabled={alarm.state !== 'ACTIVE'}
                            aria-label={`Select alarm ${alarm.title}`}
                            className="rounded bg-vms-bg border-vms-border text-vms-accent focus:ring-0 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                          />
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          {getSeverityBadge(alarm.severity)}
                        </td>
                        <td className="px-4 py-3 max-w-sm">
                          <div className="font-semibold text-vms-text text-xs">
                            {alarm.title}
                            <AiProvenanceBadge provenance={alarm.metadataJson?.provenance} />
                            <SlaBadge alarm={alarm} />
                          </div>
                          {alarm.assignedToUserId && (
                            <div className="text-[10px] text-vms-muted font-mono mt-0.5">
                              assigned{alarm.assignedToUserId === currentUserId() ? ' to you' : ''}
                            </div>
                          )}
                          {alarm.description && (
                            <div className="text-[11px] text-vms-muted mt-0.5 line-clamp-1">
                              {alarm.description}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <div className="flex items-center gap-1.5 text-vms-accent font-mono text-[11px]">
                            <Video className="w-3 h-3 text-vms-dim" />
                            <span>{alarm.camera?.name || 'Facility Appliance'}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          {getAlarmStateBadge(alarm.state)}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap font-mono text-[11px] text-vms-muted">
                          {new Date(alarm.createdAt).toISOString().replace('T', ' ').slice(0, 19)}
                        </td>
                        <td className="px-4 py-3 text-vms-muted text-[11px] max-w-xs">
                          {alarm.state === 'RESOLVED' ? (
                            <div className="truncate text-status-live font-medium" title={alarm.resolutionNotes || ''}>
                              {alarm.resolutionNotes || 'Resolved'}
                            </div>
                          ) : alarm.state === 'ACKNOWLEDGED' ? (
                            <div className="text-status-warn">
                              Acked ({alarm.acknowledgedBy || 'Operator'})
                            </div>
                          ) : (
                            <span className="text-vms-dim">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          <div className="flex items-center justify-end gap-1.5">
                            {alarm.state !== 'RESOLVED' && !__DEMO_MODE__ && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleAssign(alarm)}
                                title={alarm.assignedToUserId === currentUserId() ? 'Release assignment' : 'Assign to me'}
                                icon={<UserCheck className="w-3 h-3" />}
                              >
                                {alarm.assignedToUserId === currentUserId() ? 'Unassign' : 'Take'}
                              </Button>
                            )}
                            {alarm.cameraId && !__DEMO_MODE__ && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleExport(alarm)}
                                title="Export signed evidence package for this alarm"
                                icon={<Download className="w-3 h-3" />}
                              >
                                Export
                              </Button>
                            )}
                            {alarm.state === 'ACTIVE' && (
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => handleAcknowledgeAlarm(alarm.id)}
                                title="Acknowledge alarm"
                                icon={<Check className="w-3 h-3" />}
                              >
                                Acknowledge
                              </Button>
                            )}

                            {(alarm.state === 'ACTIVE' || alarm.state === 'ACKNOWLEDGED') && (
                              <Button
                                size="sm"
                                variant="primary"
                                onClick={() => handleOpenResolve(alarm)}
                                title="Resolve alarm with incident notes"
                                icon={<CheckCircle2 className="w-3 h-3" />}
                              >
                                Resolve
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}

      {/* ========================================================================= */}
      {/* RAW SURVEILLANCE EVENTS TAB                                               */}
      {/* ========================================================================= */}
      {consoleTab === 'EVENTS' && (
        <div className="space-y-3">
          {/* Horizontal Telemetry Bar */}
          <div className="flex flex-wrap items-center gap-4 sm:gap-6 px-3 py-2 bg-vms-surface border border-vms-border rounded text-xs font-mono">
            <div className="flex items-center gap-2">
              <span className="text-vms-muted">UNACK TELEMETRY:</span>
              <span className={`font-bold ${(eventStats.unacknowledgedTotal || 0) > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
                {eventStats.unacknowledgedTotal || 0}
              </span>
            </div>
            <div className="h-3 w-px bg-vms-border hidden sm:block" />
            <div className="flex items-center gap-2">
              <span className="text-vms-muted">CRITICAL:</span>
              <span className={`font-bold ${(eventStats.critical || 0) > 0 ? 'text-rose-400' : 'text-vms-text'}`}>
                {eventStats.critical || 0}
              </span>
            </div>
            <div className="h-3 w-px bg-vms-border hidden sm:block" />
            <div className="flex items-center gap-2">
              <span className="text-vms-muted">WARNING:</span>
              <span className={`font-bold ${(eventStats.warning || 0) > 0 ? 'text-amber-400' : 'text-vms-text'}`}>
                {eventStats.warning || 0}
              </span>
            </div>
            <div className="h-3 w-px bg-vms-border hidden sm:block" />
            <div className="flex items-center gap-2">
              <span className="text-vms-muted">INFO:</span>
              <span className="font-bold text-vms-text">{eventStats.info || 0}</span>
            </div>
          </div>

          {/* Filter Bar */}
          <Card padding="sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <select
                  value={eventSeverityFilter}
                  onChange={(e) => setEventSeverityFilter(e.target.value)}
                  className="bg-vms-bg border border-vms-border rounded px-2.5 py-1 text-xs text-vms-text focus:outline-none focus:border-vms-accent"
                >
                  <option value="">All Severities</option>
                  <option value="CRITICAL">Critical</option>
                  <option value="WARNING">Warning</option>
                  <option value="INFO">Info</option>
                </select>

                <label className="flex items-center gap-2 text-xs text-vms-text cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={unackOnly}
                    onChange={(e) => setUnackOnly(e.target.checked)}
                    className="rounded bg-vms-bg border-vms-border text-vms-accent focus:ring-0"
                  />
                  <span>Unacknowledged Only</span>
                </label>
              </div>

              <div className="text-xs text-vms-muted font-mono">
                Total Events: <span className="text-vms-text font-semibold">{events.length}</span>
              </div>
            </div>
          </Card>

          {/* Events Table */}
          <Card padding="none">
            <div className="px-4 py-3 border-b border-vms-border flex items-center justify-between bg-vms-panel/50">
              <span className="font-semibold text-xs text-vms-text uppercase tracking-wider">
                Raw Surveillance Telemetry Feed
              </span>
              <span className="text-[11px] text-vms-dim font-mono">
                Live Sensor Event Bus
              </span>
            </div>

            {events.length === 0 ? (
              <EmptyState
                icon={<ListFilter className="w-6 h-6" />}
                title="No telemetry events"
                description="No events captured matching current criteria."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-vms-panel/80 text-vms-muted uppercase text-[10px] border-b border-vms-border font-medium tracking-wider">
                    <tr>
                      <th className="px-4 py-2.5">Severity</th>
                      <th className="px-4 py-2.5">Title / Type</th>
                      <th className="px-4 py-2.5">Camera Source</th>
                      <th className="px-4 py-2.5">Activity Metrics</th>
                      <th className="px-4 py-2.5">Timestamp (UTC)</th>
                      <th className="px-4 py-2.5">Status</th>
                      <th className="px-4 py-2.5 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-vms-border text-vms-text">
                    {events.map((evt) => (
                      <tr key={evt.id} className="hover:bg-vms-hover/40 transition">
                        <td className="px-4 py-3 whitespace-nowrap">
                          {getSeverityBadge(evt.severity)}
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-semibold text-vms-text text-xs">{evt.title}</div>
                          <div className="text-[10px] text-vms-muted font-mono uppercase mt-0.5">{evt.type}</div>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap font-mono text-[11px] text-vms-accent">
                          {evt.camera?.name || 'Facility System'}
                        </td>
                        <td className="px-4 py-3 text-vms-muted text-[11px] font-mono">
                          {evt.type === 'MOTION' ? (
                            <span>
                              {evt.motionSpikes} spikes // {evt.durationSeconds}s duration
                            </span>
                          ) : (
                            <span className="text-vms-dim">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap font-mono text-[11px] text-vms-muted">
                          {new Date(evt.startTime).toISOString().replace('T', ' ').slice(0, 19)}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          {evt.acknowledged ? (
                            <Badge variant="success" size="sm" icon={<CheckCircle2 className="w-3 h-3" />}>
                              Ack: {evt.acknowledgedBy || 'Operator'}
                            </Badge>
                          ) : (
                            <Badge variant="alarm" size="sm" dot>
                              Unack
                            </Badge>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          {!evt.acknowledged && (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => handleAckEvent(evt.id)}
                            >
                              Acknowledge
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}

      {/* Resolve Alarm Modal Dialog */}
      {resolvingAlarm && (
        <Modal
          isOpen={true}
          onClose={() => setResolvingAlarm(null)}
          title="Resolve Alarm Incident"
          description="Record verifiable root cause notes and certify resolution."
          size="md"
        >
          <form onSubmit={handleConfirmResolve} className="space-y-4">
            <div className="p-3 bg-vms-panel rounded border border-vms-border space-y-1">
              <div className="text-[10px] text-vms-muted uppercase tracking-wider font-mono">
                Incident Identifier
              </div>
              <div className="font-semibold text-vms-text text-sm">
                {resolvingAlarm.title}
              </div>
              <div className="text-xs text-vms-muted flex items-center gap-1.5 mt-1 font-mono">
                <span>Source:</span>
                <span className="text-vms-accent">{resolvingAlarm.camera?.name || 'Facility Appliance'}</span>
              </div>
            </div>

            {!__DEMO_MODE__ && <AlarmSecondOpinion alarmId={resolvingAlarm.id} />}
            {!__DEMO_MODE__ && featureFlags.INCIDENT_SUMMARY && <AlarmIncidentSummary alarmId={resolvingAlarm.id} />}

            <div>
              <label className="block text-xs font-medium text-vms-text mb-1.5 flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5 text-vms-muted" />
                <span>Operator Resolution Attestation</span>
              </label>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {RESOLUTION_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => {
                      setResolutionNotes(preset);
                      if (preset.startsWith('False Alarm')) setVerdict('FALSE_ALARM');
                    }}
                    className="px-2 py-1 text-[11px] bg-vms-panel hover:bg-vms-surface border border-vms-border rounded text-vms-muted hover:text-vms-text transition text-left"
                  >
                    {preset}
                  </button>
                ))}
              </div>
              <textarea
                aria-label="Resolution notes"
                rows={3}
                required
                placeholder="Enter verifiable root cause notes (e.g. Physical inspection confirmed perimeter secured; sensor re-calibrated)."
                value={resolutionNotes}
                onChange={(e) => setResolutionNotes(e.target.value)}
                className="w-full bg-vms-bg border border-vms-border rounded p-2.5 text-xs text-vms-text placeholder-vms-dim focus:outline-none focus:border-vms-accent font-sans resize-none"
              />
              <label className="flex items-center gap-2 mt-2 text-xs text-vms-muted">
                Verdict
                <select
                  aria-label="Verdict"
                  value={verdict}
                  onChange={(e) => setVerdict(e.target.value as typeof verdict)}
                  className="bg-vms-bg border border-vms-border rounded px-2 py-1 text-xs text-vms-text font-mono"
                >
                  <option value="">not stated</option>
                  <option value="TRUE_ALARM">true alarm</option>
                  <option value="FALSE_ALARM">false alarm</option>
                </select>
                <span className="text-vms-dim">feeds false-alarm statistics per rule and model</span>
              </label>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-vms-border">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setResolvingAlarm(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                isLoading={submittingResolve}
                disabled={!resolutionNotes.trim()}
                icon={<CheckCircle2 className="w-3.5 h-3.5" />}
              >
                Confirm Resolution
              </Button>
            </div>
          </form>
        </Modal>
      )}

      <EventActionRuleModal isOpen={showAutomation} onClose={() => setShowAutomation(false)} />
    </div>
  );
};

export default Events;
