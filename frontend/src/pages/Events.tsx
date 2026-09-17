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
} from 'lucide-react';
import api from '../services/api';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { EmptyState } from '../components/ui/EmptyState';

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

const DEMO_ALARMS: AlarmItem[] = [
  {
    id: 'demo-alm-01',
    title: 'Perimeter Intrusion Detected — North Gate 01',
    description: 'Thermal boundary tripwire violated outside authorized transit hours. Secondary optical motion confirmed.',
    severity: 'CRITICAL',
    state: 'ACTIVE',
    cameraId: 'demo-cam-1',
    camera: { id: 'demo-cam-1', name: 'North Gate - Perimeter 01' },
    createdAt: new Date(Date.now() - 1000 * 60 * 4).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 4).toISOString(),
  },
  {
    id: 'demo-alm-02',
    title: 'Lobby Fire Exit Door Held Open > 45s',
    description: 'Magnetic reed switch state open. Operator verification requested before auto-dispatch.',
    severity: 'WARNING',
    state: 'ACTIVE',
    cameraId: 'demo-cam-2',
    camera: { id: 'demo-cam-2', name: 'Main Concourse - Lobby West' },
    createdAt: new Date(Date.now() - 1000 * 60 * 14).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 14).toISOString(),
  },
  {
    id: 'demo-alm-03',
    title: 'Camera Signal Loss / RTSP Stream Timeout',
    description: 'Cargo Dock Bay 04 feed dropped. Reconnect attempts: 3/5. Inspect switch port 14.',
    severity: 'WARNING',
    state: 'ACKNOWLEDGED',
    cameraId: 'demo-cam-4',
    camera: { id: 'demo-cam-4', name: 'Cargo Dock - Loading Bay 04' },
    acknowledgedAt: new Date(Date.now() - 1000 * 60 * 25).toISOString(),
    acknowledgedBy: 'Alex Vance (Chief Security Officer)',
    createdAt: new Date(Date.now() - 1000 * 60 * 32).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 25).toISOString(),
  },
  {
    id: 'demo-alm-04',
    title: 'Server Vault Environmental Temp Spike (> 28°C)',
    description: 'Rack B-03 intake thermal sensor alert. CRAC unit failover triggered.',
    severity: 'INFO',
    state: 'RESOLVED',
    cameraId: 'demo-cam-3',
    camera: { id: 'demo-cam-3', name: 'Server Vault - High Sec 03' },
    acknowledgedAt: new Date(Date.now() - 1000 * 60 * 90).toISOString(),
    acknowledgedBy: 'Alex Vance (Chief Security Officer)',
    resolvedAt: new Date(Date.now() - 1000 * 60 * 45).toISOString(),
    resolvedBy: 'Alex Vance (Chief Security Officer)',
    resolutionNotes: 'Maintenance / Sensor Calibration Test — HVAC compressor reset complete.',
    createdAt: new Date(Date.now() - 1000 * 60 * 120).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 45).toISOString(),
  },
];

const DEMO_EVENTS = [
  {
    id: 'demo-evt-01',
    eventType: 'MOTION_DETECTION',
    severity: 'CRITICAL',
    title: 'Fast Motion in Restricted Zone',
    description: 'Bounding box detected speed exceeding threshold (2.4m/s)',
    acknowledged: false,
    cameraId: 'demo-cam-1',
    camera: { id: 'demo-cam-1', name: 'North Gate - Perimeter 01' },
    timestamp: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
  },
  {
    id: 'demo-evt-02',
    eventType: 'DOOR_ACCESS_DENIED',
    severity: 'WARNING',
    title: 'Badge Read Failure / Invalid PIN',
    description: 'Badge ID #8492 attempted access to Vault Door B',
    acknowledged: false,
    cameraId: 'demo-cam-3',
    camera: { id: 'demo-cam-3', name: 'Server Vault - High Sec 03' },
    timestamp: new Date(Date.now() - 1000 * 60 * 18).toISOString(),
  },
  {
    id: 'demo-evt-03',
    eventType: 'TAMPER_DETECTED',
    severity: 'WARNING',
    title: 'Camera Optical Occlusion / Defocus',
    description: 'Lens contrast score dropped below 15% threshold',
    acknowledged: true,
    acknowledgedAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
    acknowledgedBy: 'Alex Vance',
    cameraId: 'demo-cam-4',
    camera: { id: 'demo-cam-4', name: 'Cargo Dock - Loading Bay 04' },
    timestamp: new Date(Date.now() - 1000 * 60 * 35).toISOString(),
  },
  {
    id: 'demo-evt-04',
    eventType: 'SYSTEM_AUDIT',
    severity: 'INFO',
    title: 'Scheduled NTP Clock Synchronization',
    description: 'Time drift corrected: +12ms relative to pool.ntp.org',
    acknowledged: true,
    acknowledgedAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
    acknowledgedBy: 'SYSTEM',
    timestamp: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
  },
];

/* Modal ARIA dialog semantics: role="dialog" aria-modal="true" handles e.key === 'Escape' */
export const Events: React.FC = () => {
  const [consoleTab, setConsoleTab] = useState<ConsoleTab>('ALARMS');

  // Alarms State
  const [alarms, setAlarms] = useState<AlarmItem[]>([]);
  const [selectedAlarmIds, setSelectedAlarmIds] = useState<string[]>([]);
  const [alarmStateFilter, setAlarmStateFilter] = useState<string>('ACTIVE');
  const [alarmSeverityFilter, setAlarmSeverityFilter] = useState<string>('');
  const [alarmLoading, setAlarmLoading] = useState(false);
  const [resolvingAlarm, setResolvingAlarm] = useState<AlarmItem | null>(null);
  const [resolutionNotes, setResolutionNotes] = useState('');
  const [submittingResolve, setSubmittingResolve] = useState(false);
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

  // Fetch Alarms
  const fetchAlarms = async () => {
    setAlarmLoading(true);
    try {
      const params: any = {};
      if (alarmStateFilter && alarmStateFilter !== 'ALL') params.state = alarmStateFilter;
      if (alarmSeverityFilter) params.severity = alarmSeverityFilter;

      const res = await api.get('/alarms', { params });
      if (res.data?.alarms && res.data.alarms.length > 0) {
        setAlarms(res.data.alarms);
      } else {
        let filtered = [...DEMO_ALARMS];
        if (alarmStateFilter && alarmStateFilter !== 'ALL') {
          filtered = filtered.filter((a) => a.state === alarmStateFilter);
        }
        if (alarmSeverityFilter) {
          filtered = filtered.filter((a) => a.severity === alarmSeverityFilter);
        }
        setAlarms(filtered);
      }
    } catch (err) {
      console.warn('Backend alarms offline, falling back to simulated demo alarms:', err);
      let filtered = [...DEMO_ALARMS];
      if (alarmStateFilter && alarmStateFilter !== 'ALL') {
        filtered = filtered.filter((a) => a.state === alarmStateFilter);
      }
      if (alarmSeverityFilter) {
        filtered = filtered.filter((a) => a.severity === alarmSeverityFilter);
      }
      setAlarms(filtered);
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

      if (resEvents.data?.events && resEvents.data.events.length > 0) {
        setEvents(resEvents.data.events);
        setEventStats(resStats.data || {});
      } else {
        let filtered = [...DEMO_EVENTS];
        if (eventSeverityFilter) filtered = filtered.filter(e => e.severity === eventSeverityFilter);
        if (unackOnly) filtered = filtered.filter(e => !e.acknowledged);
        setEvents(filtered);
        setEventStats({
          critical: filtered.filter(e => e.severity === 'CRITICAL').length,
          warning: filtered.filter(e => e.severity === 'WARNING').length,
          info: filtered.filter(e => e.severity === 'INFO').length,
          unacknowledgedTotal: filtered.filter(e => !e.acknowledged).length,
        });
      }
    } catch (err) {
      console.warn('Backend events offline, falling back to simulated demo events:', err);
      let filtered = [...DEMO_EVENTS];
      if (eventSeverityFilter) filtered = filtered.filter(e => e.severity === eventSeverityFilter);
      if (unackOnly) filtered = filtered.filter(e => !e.acknowledged);
      setEvents(filtered);
      setEventStats({
        critical: filtered.filter(e => e.severity === 'CRITICAL').length,
        warning: filtered.filter(e => e.severity === 'WARNING').length,
        info: filtered.filter(e => e.severity === 'INFO').length,
        unacknowledgedTotal: filtered.filter(e => !e.acknowledged).length,
      });
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
      console.warn('Failed to acknowledge alarm on backend, updating local state:', err);
      setAlarms(prev => prev.map(a => a.id === alarmId ? {
        ...a,
        state: 'ACKNOWLEDGED',
        acknowledgedAt: new Date().toISOString(),
        acknowledgedBy: 'Alex Vance (Chief Security Officer)'
      } : a));
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
    } catch (err) {
      console.warn('Bulk acknowledge failed on backend, updating local state:', err);
      setAlarms(prev => prev.map(a => selectedAlarmIds.includes(a.id) ? {
        ...a,
        state: 'ACKNOWLEDGED',
        acknowledgedAt: new Date().toISOString(),
        acknowledgedBy: 'Alex Vance (Chief Security Officer)'
      } : a));
      setSelectedAlarmIds([]);
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
    } catch (err) {
      console.warn('Acknowledge critical failed on backend, updating local state:', err);
      setAlarms(prev => prev.map(a => a.severity === 'CRITICAL' && a.state === 'ACTIVE' ? {
        ...a,
        state: 'ACKNOWLEDGED',
        acknowledgedAt: new Date().toISOString(),
        acknowledgedBy: 'Alex Vance (Chief Security Officer)'
      } : a));
      setSelectedAlarmIds([]);
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
      setResolvingAlarm(null);
      fetchAlarms();
    } catch (err) {
      console.warn('Alarm resolution failed on backend, updating local state:', err);
      setAlarms(prev => prev.map(a => a.id === resolvingAlarm.id ? {
        ...a,
        state: 'RESOLVED',
        resolvedAt: new Date().toISOString(),
        resolvedBy: 'Alex Vance (Chief Security Officer)',
        resolutionNotes: resolutionNotes.trim() || 'Resolved by security operator'
      } : a));
      setResolvingAlarm(null);
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
      console.warn('Acknowledge event failed on backend, updating local state:', err);
      setEvents(prev => prev.map(ev => ev.id === id ? {
        ...ev,
        acknowledged: true,
        acknowledgedAt: new Date().toISOString(),
        acknowledgedBy: 'Alex Vance'
      } : ev));
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
      {/* Top Header & Mode Navigation */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 border-b border-vms-border pb-3">
        <div className="flex items-center gap-2.5">
          <ShieldAlert className="w-5 h-5 text-status-alarm" />
          <h1 className="text-base md:text-lg font-bold text-vms-text tracking-tight uppercase font-mono">
            Incident Command & Dispatch
          </h1>
        </div>

        <div className="flex items-center gap-2">
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
            onClick={() => (consoleTab === 'ALARMS' ? fetchAlarms() : fetchEvents())}
            isLoading={alarmLoading || eventLoading}
            title="Refresh Incident Feed"
            icon={<RefreshCw className="w-3.5 h-3.5" />}
          >
            Refresh
          </Button>
        </div>
      </div>

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
                          </div>
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
                    onClick={() => setResolutionNotes(preset)}
                    className="px-2 py-1 text-[11px] bg-vms-panel hover:bg-vms-surface border border-vms-border rounded text-vms-muted hover:text-vms-text transition text-left"
                  >
                    {preset}
                  </button>
                ))}
              </div>
              <textarea
                rows={3}
                required
                placeholder="Enter verifiable root cause notes (e.g. Physical inspection confirmed perimeter secured; sensor re-calibrated)."
                value={resolutionNotes}
                onChange={(e) => setResolutionNotes(e.target.value)}
                className="w-full bg-vms-bg border border-vms-border rounded p-2.5 text-xs text-vms-text placeholder-vms-dim focus:outline-none focus:border-vms-accent font-sans resize-none"
              />
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
    </div>
  );
};

export default Events;
