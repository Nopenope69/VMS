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
          <span className="flex items-center space-x-1 px-2 py-0.5 rounded bg-rose-950 text-rose-400 border border-rose-800 text-[10px] font-bold">
            <AlertCircle className="w-3 h-3" />
            <span>CRITICAL</span>
          </span>
        );
      case 'WARNING':
        return (
          <span className="flex items-center space-x-1 px-2 py-0.5 rounded bg-amber-950 text-amber-400 border border-amber-800 text-[10px] font-bold">
            <AlertTriangle className="w-3 h-3" />
            <span>WARNING</span>
          </span>
        );
      default:
        return (
          <span className="flex items-center space-x-1 px-2 py-0.5 rounded bg-sky-950 text-sky-400 border border-sky-800 text-[10px] font-semibold">
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
          <span className="flex items-center space-x-1.5 px-2 py-0.5 rounded bg-rose-950/80 text-rose-400 border border-rose-800 text-[10px] font-bold animate-pulse">
            <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
            <span>ACTIVE</span>
          </span>
        );
      case 'ACKNOWLEDGED':
        return (
          <span className="flex items-center space-x-1.5 px-2 py-0.5 rounded bg-amber-950/80 text-amber-400 border border-amber-800 text-[10px] font-bold">
            <Clock className="w-3 h-3" />
            <span>IN REVIEW</span>
          </span>
        );
      case 'RESOLVED':
        return (
          <span className="flex items-center space-x-1.5 px-2 py-0.5 rounded bg-emerald-950/80 text-emerald-400 border border-emerald-800 text-[10px] font-semibold">
            <CheckCircle2 className="w-3 h-3 text-emerald-400" />
            <span>RESOLVED</span>
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

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] bg-graphite-900 p-4 space-y-4 overflow-y-auto">
      {/* Top View Selector Tabs */}
      <div className="bg-graphite-850 p-2 rounded border border-graphite-700 flex items-center justify-between">
        <div className="flex space-x-2">
          <button
            onClick={() => setConsoleTab('ALARMS')}
            className={`flex items-center space-x-2 px-4 py-2 rounded text-xs font-mono font-semibold transition ${
              consoleTab === 'ALARMS'
                ? 'bg-cctv-amber text-graphite-900 shadow-sm'
                : 'text-slate-300 hover:text-white hover:bg-graphite-750'
            }`}
          >
            <ShieldAlert className="w-4 h-4" />
            <span>Alarms Incident Workflow</span>
            {activeCount > 0 && (
              <span className="px-1.5 py-0.2 bg-red-600 text-white rounded-full text-[10px] font-bold">
                {activeCount}
              </span>
            )}
          </button>

          <button
            onClick={() => setConsoleTab('EVENTS')}
            className={`flex items-center space-x-2 px-4 py-2 rounded text-xs font-mono font-semibold transition ${
              consoleTab === 'EVENTS'
                ? 'bg-cctv-amber text-graphite-900 shadow-sm'
                : 'text-slate-300 hover:text-white hover:bg-graphite-750'
            }`}
          >
            <ListFilter className="w-4 h-4" />
            <span>Raw Surveillance Events</span>
            {eventStats.unacknowledgedTotal > 0 && (
              <span className="px-1.5 py-0.2 bg-graphite-700 text-slate-200 rounded-full text-[10px]">
                {eventStats.unacknowledgedTotal}
              </span>
            )}
          </button>
        </div>

        <button
          onClick={() => (consoleTab === 'ALARMS' ? fetchAlarms() : fetchEvents())}
          className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-graphite-700 transition mr-2"
          title="Refresh Feed"
        >
          <RefreshCw
            className={`w-4 h-4 ${alarmLoading || eventLoading ? 'animate-spin text-cctv-amber' : ''}`}
          />
        </button>
      </div>

      {/* ========================================================================= */}
      {/* ALARMS WORKFLOW CONSOLE TAB                                              */}
      {/* ========================================================================= */}
      {consoleTab === 'ALARMS' && (
        <div className="space-y-4">
          {/* Stats Bar */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div className="bg-graphite-850 border border-graphite-700 p-3.5 rounded flex items-center justify-between">
              <div>
                <div className="text-[11px] font-mono text-slate-400 uppercase">Active Alarms</div>
                <div className="text-xl font-bold font-mono text-white mt-0.5">{activeCount}</div>
              </div>
              <ShieldAlert className="w-6 h-6 text-cctv-amber" />
            </div>

            <div className="bg-graphite-850 border border-graphite-700 p-3.5 rounded flex items-center justify-between">
              <div>
                <div className="text-[11px] font-mono text-rose-400 uppercase">Critical Severity</div>
                <div className="text-xl font-bold font-mono text-rose-300 mt-0.5">{criticalCount}</div>
              </div>
              <AlertCircle className="w-6 h-6 text-rose-400" />
            </div>

            <div className="bg-graphite-850 border border-graphite-700 p-3.5 rounded flex items-center justify-between">
              <div>
                <div className="text-[11px] font-mono text-amber-400 uppercase">In Review (Acked)</div>
                <div className="text-xl font-bold font-mono text-amber-300 mt-0.5">{ackCount}</div>
              </div>
              <Clock className="w-6 h-6 text-amber-400" />
            </div>

            <div className="bg-graphite-850 border border-graphite-700 p-3.5 rounded flex items-center justify-between">
              <div>
                <div className="text-[11px] font-mono text-emerald-400 uppercase">Resolved In Query</div>
                <div className="text-xl font-bold font-mono text-emerald-300 mt-0.5">
                  {alarms.filter((a) => a.state === 'RESOLVED').length}
                </div>
              </div>
              <CheckCircle2 className="w-6 h-6 text-emerald-400" />
            </div>
          </div>

          {/* Alarm Filters */}
          <div className="bg-graphite-850 p-3 rounded border border-graphite-700 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center space-x-3">
              {/* State Filter Pills */}
              <div className="flex space-x-1 bg-graphite-900 p-0.5 rounded border border-graphite-700">
                {(['ALL', 'ACTIVE', 'ACKNOWLEDGED', 'RESOLVED'] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setAlarmStateFilter(s)}
                    className={`px-3 py-1 rounded text-xs font-mono font-medium transition ${
                      alarmStateFilter === s
                        ? 'bg-cctv-amber text-graphite-900 font-bold'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {s === 'ALL' ? 'All States' : s}
                  </button>
                ))}
              </div>

              {/* Severity Filter */}
              <select
                value={alarmSeverityFilter}
                onChange={(e) => setAlarmSeverityFilter(e.target.value)}
                className="bg-graphite-900 border border-graphite-700 rounded px-2.5 py-1 text-xs text-slate-200 font-mono focus:outline-none focus:border-cctv-amber"
              >
                <option value="">All Severities</option>
                <option value="CRITICAL">CRITICAL</option>
                <option value="WARNING">WARNING</option>
                <option value="INFO">INFO</option>
              </select>
            </div>

            <div className="text-xs font-mono text-slate-400">
              Showing <span className="text-cctv-amber font-semibold">{alarms.length}</span> security alarm incident(s)
            </div>
          </div>

          {/* Alarms Table */}
          <div className="bg-graphite-850 rounded border border-graphite-700 overflow-hidden">
            <div className="px-4 py-3 border-b border-graphite-700 font-semibold text-xs uppercase tracking-wider text-slate-300 font-mono">
              Operational Alarm Incidents
            </div>

            {alarms.length === 0 ? (
              <div className="p-12 text-center text-slate-500 font-mono text-xs">
                No alarm incidents matching the selected criteria.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs font-mono">
                  <thead className="bg-graphite-900 text-slate-400 uppercase text-[10px] border-b border-graphite-700">
                    <tr>
                      <th className="px-4 py-2.5">Severity</th>
                      <th className="px-4 py-2.5">Incident Title / Details</th>
                      <th className="px-4 py-2.5">Camera Source</th>
                      <th className="px-4 py-2.5">Workflow State</th>
                      <th className="px-4 py-2.5">Triggered At</th>
                      <th className="px-4 py-2.5">Resolution / Operator Notes</th>
                      <th className="px-4 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-graphite-700 text-slate-300">
                    {alarms.map((alarm) => (
                      <tr key={alarm.id} className="hover:bg-graphite-800 transition">
                        <td className="px-4 py-3">{getSeverityBadge(alarm.severity)}</td>
                        <td className="px-4 py-3">
                          <div className="font-semibold text-white">{alarm.title}</div>
                          {alarm.description && (
                            <div className="text-[11px] text-slate-400 mt-0.5 line-clamp-1">
                              {alarm.description}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-cctv-amber">
                          {alarm.camera?.name || 'System Facility'}
                        </td>
                        <td className="px-4 py-3">{getAlarmStateBadge(alarm.state)}</td>
                        <td className="px-4 py-3 text-slate-400">
                          {new Date(alarm.createdAt).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-slate-300 text-[11px] max-w-xs">
                          {alarm.state === 'RESOLVED' ? (
                            <div className="truncate text-emerald-300" title={alarm.resolutionNotes || ''}>
                              {alarm.resolutionNotes || 'Resolved'}
                            </div>
                          ) : alarm.state === 'ACKNOWLEDGED' ? (
                            <div className="text-amber-300">
                              Acked by operator ({new Date(alarm.acknowledgedAt || '').toLocaleTimeString()})
                            </div>
                          ) : (
                            <span className="text-slate-500">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end space-x-1.5">
                            {alarm.state === 'ACTIVE' && (
                              <button
                                onClick={() => handleAcknowledgeAlarm(alarm.id)}
                                title="Acknowledge alarm"
                                className="flex items-center space-x-1 px-2.5 py-1 rounded bg-graphite-750 hover:bg-cctv-amber hover:text-graphite-900 text-slate-200 font-semibold text-[10px] transition"
                              >
                                <Check className="w-3 h-3" />
                                <span>Acknowledge</span>
                              </button>
                            )}

                            {(alarm.state === 'ACTIVE' || alarm.state === 'ACKNOWLEDGED') && (
                              <button
                                onClick={() => handleOpenResolve(alarm)}
                                title="Resolve alarm with incident notes"
                                className="flex items-center space-x-1 px-2.5 py-1 rounded bg-emerald-950 border border-emerald-800 text-emerald-300 hover:bg-emerald-900 font-semibold text-[10px] transition"
                              >
                                <CheckCircle2 className="w-3 h-3" />
                                <span>Resolve</span>
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
            <div className="bg-graphite-850 border border-graphite-700 p-3.5 rounded flex items-center justify-between">
              <div>
                <div className="text-[11px] font-mono text-slate-400 uppercase">Unacknowledged Total</div>
                <div className="text-xl font-bold font-mono text-white mt-0.5">
                  {eventStats.unacknowledgedTotal || 0}
                </div>
              </div>
              <Bell className="w-6 h-6 text-cctv-amber" />
            </div>

            <div className="bg-graphite-850 border border-graphite-700 p-3.5 rounded flex items-center justify-between">
              <div>
                <div className="text-[11px] font-mono text-rose-400 uppercase">Critical Events</div>
                <div className="text-xl font-bold font-mono text-rose-300 mt-0.5">{eventStats.critical || 0}</div>
              </div>
              <AlertCircle className="w-6 h-6 text-rose-400" />
            </div>

            <div className="bg-graphite-850 border border-graphite-700 p-3.5 rounded flex items-center justify-between">
              <div>
                <div className="text-[11px] font-mono text-amber-400 uppercase">Warnings</div>
                <div className="text-xl font-bold font-mono text-amber-300 mt-0.5">{eventStats.warning || 0}</div>
              </div>
              <AlertTriangle className="w-6 h-6 text-amber-400" />
            </div>

            <div className="bg-graphite-850 border border-graphite-700 p-3.5 rounded flex items-center justify-between">
              <div>
                <div className="text-[11px] font-mono text-sky-400 uppercase">Informational</div>
                <div className="text-xl font-bold font-mono text-sky-300 mt-0.5">{eventStats.info || 0}</div>
              </div>
              <Info className="w-6 h-6 text-sky-400" />
            </div>
          </div>

          {/* Filter Bar */}
          <div className="bg-graphite-850 p-3 rounded border border-graphite-700 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center space-x-3">
              <select
                value={eventSeverityFilter}
                onChange={(e) => setEventSeverityFilter(e.target.value)}
                className="bg-graphite-900 border border-graphite-700 rounded px-2.5 py-1 text-xs text-slate-200 font-mono focus:outline-none focus:border-cctv-amber"
              >
                <option value="">All Severities</option>
                <option value="CRITICAL">CRITICAL</option>
                <option value="WARNING">WARNING</option>
                <option value="INFO">INFO</option>
              </select>

              <label className="flex items-center space-x-1.5 text-xs text-slate-300 cursor-pointer select-none font-mono">
                <input
                  type="checkbox"
                  checked={unackOnly}
                  onChange={(e) => setUnackOnly(e.target.checked)}
                  className="rounded bg-graphite-900 border-graphite-700 accent-cctv-amber"
                />
                <span>Unacknowledged Only</span>
              </label>
            </div>
          </div>

          {/* Events Table */}
          <div className="bg-graphite-850 rounded border border-graphite-700 overflow-hidden">
            <div className="px-4 py-3 border-b border-graphite-700 font-semibold text-xs uppercase tracking-wider text-slate-300 font-mono">
              Surveillance Events Log ({events.length})
            </div>

            {events.length === 0 ? (
              <div className="p-12 text-center text-slate-500 font-mono text-xs">
                No events recorded matching the selected criteria.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs font-mono">
                  <thead className="bg-graphite-900 text-slate-400 uppercase text-[10px] border-b border-graphite-700">
                    <tr>
                      <th className="px-4 py-2.5">Severity</th>
                      <th className="px-4 py-2.5">Title / Type</th>
                      <th className="px-4 py-2.5">Camera Source</th>
                      <th className="px-4 py-2.5">Activity Metrics</th>
                      <th className="px-4 py-2.5">Timestamp</th>
                      <th className="px-4 py-2.5">Status</th>
                      <th className="px-4 py-2.5 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-graphite-700 text-slate-300">
                    {events.map((evt) => (
                      <tr key={evt.id} className="hover:bg-graphite-800 transition">
                        <td className="px-4 py-3">{getSeverityBadge(evt.severity)}</td>
                        <td className="px-4 py-3">
                          <div className="font-semibold text-white">{evt.title}</div>
                          <div className="text-[10px] text-slate-400 mt-0.5">{evt.type}</div>
                        </td>
                        <td className="px-4 py-3 text-cctv-amber">{evt.camera?.name || 'Facility System'}</td>
                        <td className="px-4 py-3 text-slate-300 text-[11px]">
                          {evt.type === 'MOTION' ? (
                            <span>
                              {evt.motionSpikes} spikes • {evt.durationSeconds}s duration
                            </span>
                          ) : (
                            <span className="text-slate-500">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-slate-400">
                          {new Date(evt.startTime).toLocaleString()}
                        </td>
                        <td className="px-4 py-3">
                          {evt.acknowledged ? (
                            <span className="flex items-center space-x-1 text-emerald-400 text-[10px]">
                              <CheckCircle2 className="w-3 h-3" />
                              <span>Ack by {evt.acknowledgedBy || 'Operator'}</span>
                            </span>
                          ) : (
                            <span className="px-1.5 py-0.5 rounded bg-red-950 text-red-400 border border-red-800 text-[10px] font-bold">
                              UNACK
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {!evt.acknowledged && (
                            <button
                              onClick={() => handleAckEvent(evt.id)}
                              className="px-2.5 py-1 rounded bg-graphite-750 hover:bg-cctv-amber hover:text-graphite-900 font-semibold text-[10px] transition"
                            >
                              Acknowledge
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
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50 backdrop-blur-sm select-none">
          <div className="bg-graphite-850 border border-graphite-700 rounded-md w-full max-w-md overflow-hidden shadow-2xl">
            <div className="px-5 py-3.5 border-b border-graphite-700 flex justify-between items-center bg-graphite-800">
              <div className="flex items-center space-x-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <h3 className="text-sm font-semibold text-slate-100 uppercase tracking-wider font-mono">
                  Resolve Alarm Incident
                </h3>
              </div>
              <button onClick={() => setResolvingAlarm(null)} className="text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleConfirmResolve} className="p-5 space-y-4 bg-graphite-900">
              <div className="p-3 bg-graphite-850 rounded border border-graphite-700 text-xs font-mono">
                <div className="text-slate-400 text-[10px] uppercase">Incident:</div>
                <div className="font-semibold text-white mt-0.5">{resolvingAlarm.title}</div>
                <div className="text-slate-400 mt-1">
                  Source: <span className="text-cctv-amber">{resolvingAlarm.camera?.name || 'Facility'}</span>
                </div>
              </div>

              <div>
                <label className="block text-xs font-mono text-slate-300 mb-1.5 flex items-center space-x-1">
                  <FileText className="w-3.5 h-3.5 text-slate-400" />
                  <span>Operator Resolution & Root Cause Notes</span>
                </label>
                <textarea
                  rows={3}
                  required
                  placeholder="e.g. Guard dispatched to North Gate. Area inspected and secured; false trigger caused by wind blown banner."
                  value={resolutionNotes}
                  onChange={(e) => setResolutionNotes(e.target.value)}
                  className="w-full bg-graphite-850 border border-graphite-700 rounded p-2.5 text-xs text-slate-200 font-mono focus:outline-none focus:border-cctv-amber"
                />
              </div>

              <div className="flex justify-end space-x-2 pt-2 border-t border-graphite-700">
                <button
                  type="button"
                  onClick={() => setResolvingAlarm(null)}
                  className="px-4 py-1.5 rounded text-xs text-slate-300 hover:bg-graphite-800 font-mono"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submittingResolve || !resolutionNotes.trim()}
                  className="flex items-center space-x-1.5 px-4 py-1.5 rounded text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50 font-mono shadow"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>{submittingResolve ? 'Resolving...' : 'Confirm Resolution'}</span>
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
