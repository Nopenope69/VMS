import React, { useState, useEffect } from 'react';
import {
  Bell,
  AlertTriangle,
  AlertCircle,
  Info,
  CheckCircle2,
  RefreshCw,
  ShieldAlert,
  ListFilter,
  Check,
  X,
  Clock,
  FileText,
} from 'lucide-react';
import api from '../services/api';

type ConsoleTab = 'ALARMS' | 'EVENTS';

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
  createdAt: string;
  updatedAt: string;
}

export const Events: React.FC = () => {
  const [consoleTab, setConsoleTab] = useState<ConsoleTab>('ALARMS');

  // Alarms State
  const [alarms, setAlarms] = useState<AlarmItem[]>([]);
  const [alarmStateFilter, setAlarmStateFilter] = useState<string>('ACTIVE');
  const [alarmSeverityFilter, setAlarmSeverityFilter] = useState<string>('');
  const [alarmLoading, setAlarmLoading] = useState(false);
  const [resolvingAlarm, setResolvingAlarm] = useState<AlarmItem | null>(null);
  const [resolutionNotes, setResolutionNotes] = useState('');
  const [submittingResolve, setSubmittingResolve] = useState(false);

  // Raw Events State
  const [events, setEvents] = useState<any[]>([]);
  const [eventStats, setEventStats] = useState<any>({ critical: 0, warning: 0, info: 0, unacknowledgedTotal: 0 });
  const [eventSeverityFilter, setEventSeverityFilter] = useState<string>('');
  const [unackOnly, setUnackOnly] = useState<boolean>(false);
  const [eventLoading, setEventLoading] = useState(false);

  // Fetch Alarms
  const fetchAlarms = async () => {
    setAlarmLoading(true);
    try {
      const params: any = {};
      if (alarmStateFilter && alarmStateFilter !== 'ALL') params.state = alarmStateFilter;
      if (alarmSeverityFilter) params.severity = alarmSeverityFilter;

      const res = await api.get('/alarms', { params });
      setAlarms(res.data.alarms || []);
    } catch (err) {
      console.error('Failed to load alarms:', err);
    } finally {
      setAlarmLoading(false);
    }
  };

  // Fetch Raw Events
  const fetchEvents = async () => {
    setEventLoading(true);
    try {
      const params: any = {};
      if (eventSeverityFilter) params.severity = eventSeverityFilter;
      if (unackOnly) params.unacknowledgedOnly = 'true';

      const [resEvents, resStats] = await Promise.all([
        api.get('/events', { params }),
        api.get('/events/stats'),
      ]);

      setEvents(resEvents.data.events || []);
      setEventStats(resStats.data || {});
    } catch (err) {
      console.error('Failed to load events:', err);
    } finally {
      setEventLoading(false);
    }
  };

  useEffect(() => {
    if (consoleTab === 'ALARMS') {
      fetchAlarms();
    } else {
      fetchEvents();
    }
  }, [consoleTab, alarmStateFilter, alarmSeverityFilter, eventSeverityFilter, unackOnly]);

  // Acknowledge Alarm
  const handleAcknowledgeAlarm = async (alarmId: string) => {
    try {
      await api.post(`/alarms/${alarmId}/acknowledge`);
      fetchAlarms();
    } catch (err) {
      console.error('Failed to acknowledge alarm:', err);
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
      setResolvingAlarm(null);
      fetchAlarms();
    } catch (err) {
      console.error('Failed to resolve alarm:', err);
    } finally {
      setSubmittingResolve(false);
    }
  };

  // Acknowledge Raw Event
  const handleAckEvent = async (id: string) => {
    try {
      await api.patch(`/events/${id}/ack`);
      fetchEvents();
    } catch (err) {
      console.error('Failed to acknowledge event:', err);
    }
  };

  const getSeverityBadge = (severity: string) => {
    switch (severity) {
      case 'CRITICAL':
        return (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-none bg-[#F85149]/10 text-[#F85149] border border-[#F85149]/40 text-[10px] font-mono font-bold tracking-wider">
            <AlertCircle className="w-3 h-3" />
            <span>CRITICAL</span>
          </span>
        );
      case 'WARNING':
        return (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-none bg-[#E3B341]/10 text-[#E3B341] border border-[#E3B341]/40 text-[10px] font-mono font-bold tracking-wider">
            <AlertTriangle className="w-3 h-3" />
            <span>WARNING</span>
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-none bg-[#58A6FF]/10 text-[#58A6FF] border border-[#58A6FF]/40 text-[10px] font-mono font-semibold tracking-wider">
            <Info className="w-3 h-3" />
            <span>INFO</span>
          </span>
        );
    }
  };

  const getAlarmStateBadge = (state: string) => {
    switch (state) {
      case 'ACTIVE':
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-none bg-[#F85149]/10 text-[#F85149] border border-[#F85149]/50 text-[10px] font-mono font-bold tracking-wider animate-pulse">
            <span className="w-1.5 h-1.5 bg-[#F85149]" />
            <span>[ ACTIVE ]</span>
          </span>
        );
      case 'ACKNOWLEDGED':
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-none bg-[#E3B341]/10 text-[#E3B341] border border-[#E3B341]/40 text-[10px] font-mono font-bold tracking-wider">
            <Clock className="w-3 h-3" />
            <span>[ IN_REVIEW ]</span>
          </span>
        );
      case 'RESOLVED':
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-none bg-[#3FB950]/10 text-[#3FB950] border border-[#3FB950]/40 text-[10px] font-mono font-semibold tracking-wider">
            <CheckCircle2 className="w-3 h-3 text-[#3FB950]" />
            <span>[ RESOLVED ]</span>
          </span>
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
    <div className="flex flex-col min-h-[calc(100vh-3.5rem)] bg-[#080B10] p-4 space-y-4 select-none font-mono">
      {/* Top Tactical Selector Tabs */}
      <div className="bg-[#0D1117] p-2 border border-[#21262D] flex items-center justify-between">
        <div className="flex space-x-2">
          <button
            onClick={() => setConsoleTab('ALARMS')}
            className={`flex items-center space-x-2 px-3.5 py-1.5 text-xs font-mono tracking-wider uppercase transition rounded-none ${
              consoleTab === 'ALARMS'
                ? 'bg-[#E3B341] text-[#080B10] font-bold shadow-sm'
                : 'text-slate-400 hover:text-white hover:bg-[#161B22]'
            }`}
          >
            <ShieldAlert className="w-4 h-4" />
            <span>[ 01 // ALARMS INCIDENT WORKFLOW ]</span>
            {activeCount > 0 && (
              <span className="px-1.5 py-0.2 bg-[#F85149] text-white text-[10px] font-bold">
                {activeCount}
              </span>
            )}
          </button>

          <button
            onClick={() => setConsoleTab('EVENTS')}
            className={`flex items-center space-x-2 px-3.5 py-1.5 text-xs font-mono tracking-wider uppercase transition rounded-none ${
              consoleTab === 'EVENTS'
                ? 'bg-[#E3B341] text-[#080B10] font-bold shadow-sm'
                : 'text-slate-400 hover:text-white hover:bg-[#161B22]'
            }`}
          >
            <ListFilter className="w-4 h-4" />
            <span>[ 02 // RAW SURVEILLANCE TELEMETRY ]</span>
            {eventStats.unacknowledgedTotal > 0 && (
              <span className="px-1.5 py-0.2 bg-[#21262D] text-slate-300 text-[10px]">
                {eventStats.unacknowledgedTotal}
              </span>
            )}
          </button>
        </div>

        <button
          onClick={() => (consoleTab === 'ALARMS' ? fetchAlarms() : fetchEvents())}
          className="p-1.5 text-slate-400 hover:text-white hover:bg-[#161B22] border border-[#21262D] transition rounded-none mr-1"
          title="Refresh Incident Feed"
        >
          <RefreshCw
            className={`w-4 h-4 ${alarmLoading || eventLoading ? 'animate-spin text-[#E3B341]' : ''}`}
          />
        </button>
      </div>

      {/* ========================================================================= */}
      {/* ALARMS WORKFLOW CONSOLE TAB                                              */}
      {/* ========================================================================= */}
      {consoleTab === 'ALARMS' && (
        <div className="space-y-4">
          {/* Tactical KPI Metrics Row */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div className="bg-[#0D1117] border border-[#21262D] p-3.5 relative">
              <span className="absolute -top-1 -left-1 text-[8px] text-[#30363D]">+</span>
              <span className="absolute -bottom-1 -right-1 text-[8px] text-[#30363D]">+</span>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[10px] text-slate-500 uppercase tracking-widest">ACTIVE_ALARMS</div>
                  <div className="text-2xl font-bold text-white mt-0.5 tracking-wider">{activeCount}</div>
                </div>
                <ShieldAlert className="w-6 h-6 text-[#E3B341]" />
              </div>
            </div>

            <div className="bg-[#0D1117] border border-[#21262D] p-3.5 relative">
              <span className="absolute -top-1 -left-1 text-[8px] text-[#30363D]">+</span>
              <span className="absolute -bottom-1 -right-1 text-[8px] text-[#30363D]">+</span>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[10px] text-[#F85149] uppercase tracking-widest">CRITICAL_SEVERITY</div>
                  <div className="text-2xl font-bold text-[#F85149] mt-0.5 tracking-wider">{criticalCount}</div>
                </div>
                <AlertCircle className="w-6 h-6 text-[#F85149]" />
              </div>
            </div>

            <div className="bg-[#0D1117] border border-[#21262D] p-3.5 relative">
              <span className="absolute -top-1 -left-1 text-[8px] text-[#30363D]">+</span>
              <span className="absolute -bottom-1 -right-1 text-[8px] text-[#30363D]">+</span>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[10px] text-[#E3B341] uppercase tracking-widest">IN_REVIEW (ACKED)</div>
                  <div className="text-2xl font-bold text-[#E3B341] mt-0.5 tracking-wider">{ackCount}</div>
                </div>
                <Clock className="w-6 h-6 text-[#E3B341]" />
              </div>
            </div>

            <div className="bg-[#0D1117] border border-[#21262D] p-3.5 relative">
              <span className="absolute -top-1 -left-1 text-[8px] text-[#30363D]">+</span>
              <span className="absolute -bottom-1 -right-1 text-[8px] text-[#30363D]">+</span>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[10px] text-[#3FB950] uppercase tracking-widest">RESOLVED_IN_QUERY</div>
                  <div className="text-2xl font-bold text-[#3FB950] mt-0.5 tracking-wider">{resolvedCount}</div>
                </div>
                <CheckCircle2 className="w-6 h-6 text-[#3FB950]" />
              </div>
            </div>
          </div>

          {/* Alarm Filters */}
          <div className="bg-[#0D1117] p-3 border border-[#21262D] flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center space-x-3">
              {/* State Filter Pills */}
              <div className="flex space-x-1 bg-[#080B10] p-0.5 border border-[#21262D]">
                {(['ALL', 'ACTIVE', 'ACKNOWLEDGED', 'RESOLVED'] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setAlarmStateFilter(s)}
                    className={`px-3 py-1 text-xs uppercase tracking-wider transition ${
                      alarmStateFilter === s
                        ? 'bg-[#E3B341] text-[#080B10] font-bold'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {s === 'ALL' ? '[ ALL STATES ]' : `[ ${s} ]`}
                  </button>
                ))}
              </div>

              {/* Severity Filter */}
              <select
                value={alarmSeverityFilter}
                onChange={(e) => setAlarmSeverityFilter(e.target.value)}
                className="bg-[#080B10] border border-[#21262D] px-3 py-1 text-xs text-slate-200 uppercase tracking-wider focus:outline-none focus:border-[#E3B341] rounded-none"
              >
                <option value="">ALL SEVERITIES</option>
                <option value="CRITICAL">CRITICAL</option>
                <option value="WARNING">WARNING</option>
                <option value="INFO">INFO</option>
              </select>
            </div>

            <div className="text-xs text-slate-500 uppercase tracking-wider">
              MATCHED_INCIDENTS: <span className="text-[#E3B341] font-bold">{alarms.length}</span>
            </div>
          </div>

          {/* Alarms Table */}
          <div className="bg-[#0D1117] border border-[#21262D] overflow-hidden">
            <div className="px-4 py-2.5 border-b border-[#21262D] font-bold text-xs uppercase tracking-wider text-slate-300 flex items-center justify-between bg-[#161B22]">
              <span>OPERATIONAL INCIDENT REGISTRY</span>
              <span className="text-[10px] text-slate-500">FORMAT: ED-25519 VERIFIED</span>
            </div>

            {alarms.length === 0 ? (
              <div className="p-12 text-center text-slate-500 text-xs uppercase tracking-widest">
                [ NO ACTIVE ALARM INCIDENTS IN SCOPE ]
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[#080B10] text-slate-400 uppercase text-[10px] border-b border-[#21262D]">
                    <tr>
                      <th className="px-4 py-2.5">SEVERITY</th>
                      <th className="px-4 py-2.5">INCIDENT DETAILS</th>
                      <th className="px-4 py-2.5">SOURCE CAMERA</th>
                      <th className="px-4 py-2.5">STATE</th>
                      <th className="px-4 py-2.5">TIMESTAMP (UTC)</th>
                      <th className="px-4 py-2.5">OPERATOR NOTES</th>
                      <th className="px-4 py-2.5 text-right">ACTION</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#21262D] text-slate-300">
                    {alarms.map((alarm) => (
                      <tr key={alarm.id} className="hover:bg-[#161B22] transition">
                        <td className="px-4 py-3">{getSeverityBadge(alarm.severity)}</td>
                        <td className="px-4 py-3">
                          <div className="font-bold text-white tracking-wide">{alarm.title}</div>
                          {alarm.description && (
                            <div className="text-[11px] text-slate-400 mt-0.5 line-clamp-1">
                              {alarm.description}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-[#E3B341] tracking-wider">
                          {alarm.camera?.name || 'FACILITY_SYSTEM'}
                        </td>
                        <td className="px-4 py-3">{getAlarmStateBadge(alarm.state)}</td>
                        <td className="px-4 py-3 text-slate-400 font-mono text-[11px]">
                          {new Date(alarm.createdAt).toISOString()}
                        </td>
                        <td className="px-4 py-3 text-slate-300 text-[11px] max-w-xs">
                          {alarm.state === 'RESOLVED' ? (
                            <div className="truncate text-[#3FB950]" title={alarm.resolutionNotes || ''}>
                              {alarm.resolutionNotes || 'RESOLVED'}
                            </div>
                          ) : alarm.state === 'ACKNOWLEDGED' ? (
                            <div className="text-[#E3B341]">
                              ACKED ({alarm.acknowledgedBy || 'OPERATOR'})
                            </div>
                          ) : (
                            <span className="text-slate-600">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end space-x-1.5">
                            {alarm.state === 'ACTIVE' && (
                              <button
                                onClick={() => handleAcknowledgeAlarm(alarm.id)}
                                title="Acknowledge alarm"
                                className="flex items-center space-x-1 px-2.5 py-1 bg-[#161B22] hover:bg-[#E3B341] hover:text-[#080B10] text-slate-200 border border-[#21262D] font-bold text-[10px] uppercase transition rounded-none"
                              >
                                <Check className="w-3 h-3" />
                                <span>ACKNOWLEDGE</span>
                              </button>
                            )}

                            {(alarm.state === 'ACTIVE' || alarm.state === 'ACKNOWLEDGED') && (
                              <button
                                onClick={() => handleOpenResolve(alarm)}
                                title="Resolve alarm with incident notes"
                                className="flex items-center space-x-1 px-2.5 py-1 bg-[#3FB950]/10 border border-[#3FB950]/40 text-[#3FB950] hover:bg-[#3FB950] hover:text-[#080B10] font-bold text-[10px] uppercase transition rounded-none"
                              >
                                <CheckCircle2 className="w-3 h-3" />
                                <span>RESOLVE</span>
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* RAW SURVEILLANCE EVENTS TAB                                               */}
      {/* ========================================================================= */}
      {consoleTab === 'EVENTS' && (
        <div className="space-y-4">
          {/* Top Banner & Stats */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div className="bg-[#0D1117] border border-[#21262D] p-3.5 relative">
              <span className="absolute -top-1 -left-1 text-[8px] text-[#30363D]">+</span>
              <span className="absolute -bottom-1 -right-1 text-[8px] text-[#30363D]">+</span>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[10px] text-slate-500 uppercase tracking-widest">UNACK_TELEMETRY</div>
                  <div className="text-2xl font-bold text-white mt-0.5 tracking-wider">
                    {eventStats.unacknowledgedTotal || 0}
                  </div>
                </div>
                <Bell className="w-6 h-6 text-[#E3B341]" />
              </div>
            </div>

            <div className="bg-[#0D1117] border border-[#21262D] p-3.5 relative">
              <span className="absolute -top-1 -left-1 text-[8px] text-[#30363D]">+</span>
              <span className="absolute -bottom-1 -right-1 text-[8px] text-[#30363D]">+</span>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[10px] text-[#F85149] uppercase tracking-widest">CRITICAL_EVENTS</div>
                  <div className="text-2xl font-bold text-[#F85149] mt-0.5 tracking-wider">{eventStats.critical || 0}</div>
                </div>
                <AlertCircle className="w-6 h-6 text-[#F85149]" />
              </div>
            </div>

            <div className="bg-[#0D1117] border border-[#21262D] p-3.5 relative">
              <span className="absolute -top-1 -left-1 text-[8px] text-[#30363D]">+</span>
              <span className="absolute -bottom-1 -right-1 text-[8px] text-[#30363D]">+</span>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[10px] text-[#E3B341] uppercase tracking-widest">WARNING_TRIGGERS</div>
                  <div className="text-2xl font-bold text-[#E3B341] mt-0.5 tracking-wider">{eventStats.warning || 0}</div>
                </div>
                <AlertTriangle className="w-6 h-6 text-[#E3B341]" />
              </div>
            </div>

            <div className="bg-[#0D1117] border border-[#21262D] p-3.5 relative">
              <span className="absolute -top-1 -left-1 text-[8px] text-[#30363D]">+</span>
              <span className="absolute -bottom-1 -right-1 text-[8px] text-[#30363D]">+</span>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[10px] text-[#58A6FF] uppercase tracking-widest">INFORMATIONAL</div>
                  <div className="text-2xl font-bold text-[#58A6FF] mt-0.5 tracking-wider">{eventStats.info || 0}</div>
                </div>
                <Info className="w-6 h-6 text-[#58A6FF]" />
              </div>
            </div>
          </div>

          {/* Filter Bar */}
          <div className="bg-[#0D1117] p-3 border border-[#21262D] flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center space-x-3">
              <select
                value={eventSeverityFilter}
                onChange={(e) => setEventSeverityFilter(e.target.value)}
                className="bg-[#080B10] border border-[#21262D] px-3 py-1 text-xs text-slate-200 uppercase tracking-wider focus:outline-none focus:border-[#E3B341] rounded-none"
              >
                <option value="">ALL SEVERITIES</option>
                <option value="CRITICAL">CRITICAL</option>
                <option value="WARNING">WARNING</option>
                <option value="INFO">INFO</option>
              </select>

              <label className="flex items-center space-x-1.5 text-xs text-slate-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={unackOnly}
                  onChange={(e) => setUnackOnly(e.target.checked)}
                  className="rounded-none bg-[#080B10] border-[#21262D] accent-[#E3B341]"
                />
                <span className="uppercase tracking-wider">UNACKNOWLEDGED ONLY</span>
              </label>
            </div>
          </div>

          {/* Events Table */}
          <div className="bg-[#0D1117] border border-[#21262D] overflow-hidden">
            <div className="px-4 py-2.5 border-b border-[#21262D] font-bold text-xs uppercase tracking-wider text-slate-300 bg-[#161B22] flex items-center justify-between">
              <span>RAW SURVEILLANCE TELEMETRY FEED</span>
              <span className="text-[10px] text-slate-500">TOTAL: {events.length}</span>
            </div>

            {events.length === 0 ? (
              <div className="p-12 text-center text-slate-500 text-xs uppercase tracking-widest">
                [ NO RAW EVENTS MATCHING QUERY ]
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[#080B10] text-slate-400 uppercase text-[10px] border-b border-[#21262D]">
                    <tr>
                      <th className="px-4 py-2.5">SEVERITY</th>
                      <th className="px-4 py-2.5">TITLE / TYPE</th>
                      <th className="px-4 py-2.5">CAMERA SOURCE</th>
                      <th className="px-4 py-2.5">ACTIVITY METRICS</th>
                      <th className="px-4 py-2.5">TIMESTAMP (UTC)</th>
                      <th className="px-4 py-2.5">STATUS</th>
                      <th className="px-4 py-2.5 text-right">ACTION</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#21262D] text-slate-300">
                    {events.map((evt) => (
                      <tr key={evt.id} className="hover:bg-[#161B22] transition">
                        <td className="px-4 py-3">{getSeverityBadge(evt.severity)}</td>
                        <td className="px-4 py-3">
                          <div className="font-bold text-white tracking-wide">{evt.title}</div>
                          <div className="text-[10px] text-slate-500 uppercase mt-0.5">{evt.type}</div>
                        </td>
                        <td className="px-4 py-3 text-[#E3B341] tracking-wider">{evt.camera?.name || 'FACILITY_SYSTEM'}</td>
                        <td className="px-4 py-3 text-slate-300 text-[11px]">
                          {evt.type === 'MOTION' ? (
                            <span>
                              {evt.motionSpikes} spikes // {evt.durationSeconds}s duration
                            </span>
                          ) : (
                            <span className="text-slate-600">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-slate-400 font-mono text-[11px]">
                          {new Date(evt.startTime).toISOString()}
                        </td>
                        <td className="px-4 py-3">
                          {evt.acknowledged ? (
                            <span className="flex items-center space-x-1 text-[#3FB950] text-[10px] uppercase">
                              <CheckCircle2 className="w-3 h-3" />
                              <span>ACK: {evt.acknowledgedBy || 'OPERATOR'}</span>
                            </span>
                          ) : (
                            <span className="px-1.5 py-0.5 rounded-none bg-[#F85149]/10 text-[#F85149] border border-[#F85149]/40 text-[10px] font-bold uppercase">
                              UNACK
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {!evt.acknowledged && (
                            <button
                              onClick={() => handleAckEvent(evt.id)}
                              className="px-2.5 py-1 bg-[#161B22] hover:bg-[#E3B341] hover:text-[#080B10] text-slate-200 border border-[#21262D] font-bold text-[10px] uppercase transition rounded-none"
                            >
                              ACKNOWLEDGE
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Resolve Alarm Modal Dialog */}
      {resolvingAlarm && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50 select-none">
          <div className="bg-[#0D1117] border border-[#21262D] rounded-none w-full max-w-md overflow-hidden shadow-2xl relative">
            <span className="absolute -top-1 -left-1 text-[9px] text-[#30363D]">+</span>
            <span className="absolute -top-1 -right-1 text-[9px] text-[#30363D]">+</span>
            <span className="absolute -bottom-1 -left-1 text-[9px] text-[#30363D]">+</span>
            <span className="absolute -bottom-1 -right-1 text-[9px] text-[#30363D]">+</span>

            <div className="px-5 py-3.5 border-b border-[#21262D] flex justify-between items-center bg-[#161B22]">
              <div className="flex items-center space-x-2">
                <CheckCircle2 className="w-4 h-4 text-[#3FB950]" />
                <h3 className="text-xs font-bold text-white uppercase tracking-wider">
                  [ RESOLVE ALARM INCIDENT // ROOT CAUSE ]
                </h3>
              </div>
              <button onClick={() => setResolvingAlarm(null)} className="text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleConfirmResolve} className="p-5 space-y-4 bg-[#0D1117]">
              <div className="p-3 bg-[#161B22] border border-[#21262D] text-xs">
                <div className="text-slate-500 text-[10px] uppercase tracking-widest">INCIDENT IDENTIFIER:</div>
                <div className="font-bold text-white mt-0.5 tracking-wider">{resolvingAlarm.title}</div>
                <div className="text-slate-400 mt-1">
                  SOURCE: <span className="text-[#E3B341]">{resolvingAlarm.camera?.name || 'FACILITY_CHASSIS'}</span>
                </div>
              </div>

              <div>
                <label className="block text-xs text-slate-300 mb-1.5 flex items-center space-x-1 uppercase tracking-wider">
                  <FileText className="w-3.5 h-3.5 text-slate-500" />
                  <span>OPERATOR RESOLUTION ATTESTATION</span>
                </label>
                <textarea
                  rows={3}
                  required
                  placeholder="Enter verifiable root cause notes (e.g., Physical inspection confirmed perimeter secured; sensor re-calibrated)."
                  value={resolutionNotes}
                  onChange={(e) => setResolutionNotes(e.target.value)}
                  className="w-full bg-[#080B10] border border-[#21262D] rounded-none p-2.5 text-xs text-slate-200 focus:outline-none focus:border-[#E3B341]"
                />
              </div>

              <div className="flex justify-end space-x-2 pt-2 border-t border-[#21262D]">
                <button
                  type="button"
                  onClick={() => setResolvingAlarm(null)}
                  className="px-4 py-1.5 rounded-none text-xs text-slate-300 hover:bg-[#161B22] border border-[#21262D]"
                >
                  CANCEL
                </button>
                <button
                  type="submit"
                  disabled={submittingResolve || !resolutionNotes.trim()}
                  className="flex items-center space-x-1.5 px-4 py-1.5 rounded-none text-xs font-bold bg-[#3FB950] hover:bg-emerald-400 text-[#080B10] disabled:opacity-50 tracking-wider uppercase shadow"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>{submittingResolve ? 'RECORDING...' : 'CONFIRM RESOLUTION'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default Events;
