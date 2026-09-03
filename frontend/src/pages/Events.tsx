import React, { useState, useEffect } from 'react';
import { Bell, AlertTriangle, AlertCircle, Info, CheckCircle2, RefreshCw } from 'lucide-react';
import api from '../services/api';

export const Events: React.FC = () => {
  const [events, setEvents] = useState<any[]>([]);
  const [stats, setStats] = useState<any>({ critical: 0, warning: 0, info: 0, unacknowledgedTotal: 0 });
  const [severityFilter, setSeverityFilter] = useState<string>('');
  const [unackOnly, setUnackOnly] = useState<boolean>(false);
  const [loading, setLoading] = useState(false);

  const fetchEvents = async () => {
    setLoading(true);
    try {
      const params: any = {};
      if (severityFilter) params.severity = severityFilter;
      if (unackOnly) params.unacknowledgedOnly = 'true';

      const [resEvents, resStats] = await Promise.all([
        api.get('/events', { params }),
        api.get('/events/stats'),
      ]);

      setEvents(resEvents.data.events || []);
      setStats(resStats.data || {});
    } catch (err) {
      console.error('Failed to load events:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEvents();
  }, [severityFilter, unackOnly]);

  const handleAck = async (id: string) => {
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

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] bg-graphite-900 p-4 space-y-4 overflow-y-auto">
      {/* Top Banner & Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <div className="bg-graphite-850 border border-graphite-700 p-3.5 rounded flex items-center justify-between">
          <div>
            <div className="text-[11px] font-mono text-slate-400 uppercase">Unacknowledged Total</div>
            <div className="text-xl font-bold font-mono text-white mt-0.5">{stats.unacknowledgedTotal || 0}</div>
          </div>
          <Bell className="w-6 h-6 text-cctv-amber" />
        </div>

        <div className="bg-graphite-850 border border-graphite-700 p-3.5 rounded flex items-center justify-between">
          <div>
            <div className="text-[11px] font-mono text-rose-400 uppercase">Critical Alarms</div>
            <div className="text-xl font-bold font-mono text-rose-300 mt-0.5">{stats.critical || 0}</div>
          </div>
          <AlertCircle className="w-6 h-6 text-rose-400" />
        </div>

        <div className="bg-graphite-850 border border-graphite-700 p-3.5 rounded flex items-center justify-between">
          <div>
            <div className="text-[11px] font-mono text-amber-400 uppercase">Warnings</div>
            <div className="text-xl font-bold font-mono text-amber-300 mt-0.5">{stats.warning || 0}</div>
          </div>
          <AlertTriangle className="w-6 h-6 text-amber-400" />
        </div>

        <div className="bg-graphite-850 border border-graphite-700 p-3.5 rounded flex items-center justify-between">
          <div>
            <div className="text-[11px] font-mono text-sky-400 uppercase">Informational</div>
            <div className="text-xl font-bold font-mono text-sky-300 mt-0.5">{stats.info || 0}</div>
          </div>
          <Info className="w-6 h-6 text-sky-400" />
        </div>
      </div>

      {/* Filter Bar */}
      <div className="bg-graphite-850 p-3 rounded border border-graphite-700 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center space-x-3">
          <select
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value)}
            className="bg-graphite-900 border border-graphite-700 rounded px-2.5 py-1 text-xs text-slate-200 font-mono focus:outline-none focus:border-cctv-amber"
          >
            <option value="">All Severities</option>
            <option value="CRITICAL">CRITICAL</option>
            <option value="WARNING">WARNING</option>
            <option value="INFO">INFO</option>
          </select>

          <label className="flex items-center space-x-1.5 text-xs text-slate-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={unackOnly}
              onChange={(e) => setUnackOnly(e.target.checked)}
              className="rounded bg-graphite-900 border-graphite-700"
            />
            <span>Unacknowledged Only</span>
          </label>
        </div>

        <button
          onClick={fetchEvents}
          className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-graphite-700 transition"
          title="Refresh Events"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Events Table */}
      <div className="bg-graphite-850 rounded border border-graphite-700 overflow-hidden flex-1">
        <div className="px-4 py-3 border-b border-graphite-700 font-semibold text-xs uppercase tracking-wider text-slate-300">
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
                  <th className="px-4 py-2.5">Timestamp (UTC)</th>
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
                      {new Date(evt.startTime).toLocaleTimeString()}
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
                          onClick={() => handleAck(evt.id)}
                          className="px-2 py-1 rounded bg-graphite-700 hover:bg-cctv-amber hover:text-graphite-900 font-semibold text-[10px] transition"
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
  );
};

export default Events;
