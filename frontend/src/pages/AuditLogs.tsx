import React, { useState, useEffect } from 'react';
import { FileText, ShieldCheck, AlertOctagon, RefreshCw, Eye } from 'lucide-react';
import api from '../services/api';

export const AuditLogs: React.FC = () => {
  const [events, setEvents] = useState<any[]>([]);
  const [verifyStatus, setVerifyStatus] = useState<any>(null);
  const [selectedEvent, setSelectedEvent] = useState<any | null>(null);
  const [actionFilter, setActionFilter] = useState('');
  const [loading, setLoading] = useState(false);

  const fetchAuditData = async () => {
    setLoading(true);
    try {
      const params: any = {};
      if (actionFilter) params.action = actionFilter;

      const [resEvents, resVerify] = await Promise.all([
        api.get('/audit', { params }),
        api.get('/audit/verify'),
      ]);

      setEvents(resEvents.data.events || []);
      setVerifyStatus(resVerify.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAuditData();
  }, [actionFilter]);

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] bg-graphite-900 p-4 space-y-4 overflow-y-auto">
      {/* Top Banner with Cryptographic Integrity Verification */}
      <div className="bg-graphite-850 p-4 rounded border border-graphite-700 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center space-x-2">
            <FileText className="w-5 h-5 text-cctv-amber" />
            <h2 className="text-sm font-semibold text-slate-100 uppercase tracking-wider">
              Tamper-Evident Audit Registry
            </h2>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Cryptographic SHA-256 hash-chained immutable activity log. Mathematical proof that operator logs have not been inserted, deleted, or modified.
          </p>
        </div>

        {verifyStatus && (
          <div
            className={`flex items-center space-x-2 px-3 py-1.5 rounded border text-xs font-mono font-semibold ${
              verifyStatus.tamperEvidentStatus === 'INTACT'
                ? 'bg-emerald-950/80 border-emerald-700 text-emerald-300'
                : 'bg-rose-950/80 border-rose-700 text-rose-300'
            }`}
          >
            {verifyStatus.tamperEvidentStatus === 'INTACT' ? (
              <>
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                <span>CHAIN INTACT ({verifyStatus.verifiedCount} records verified)</span>
              </>
            ) : (
              <>
                <AlertOctagon className="w-4 h-4 text-rose-400" />
                <span>CHAIN TAMPER DETECTED AT SEQ {verifyStatus.brokenSequence}</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* Filter Bar */}
      <div className="bg-graphite-850 p-3 rounded border border-graphite-700 flex justify-between items-center">
        <select
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          className="bg-graphite-900 border border-graphite-700 rounded px-2.5 py-1 text-xs text-slate-200 font-mono focus:outline-none focus:border-cctv-amber"
        >
          <option value="">All Actions</option>
          <option value="CAMERA_CREATE">CAMERA_CREATE</option>
          <option value="CAMERA_DELETE">CAMERA_DELETE</option>
          <option value="EXPORT_EVIDENCE_BSA63">EXPORT_EVIDENCE_BSA63</option>
          <option value="USER_CREATE">USER_CREATE</option>
          <option value="USER_DEACTIVATE">USER_DEACTIVATE</option>
          <option value="LOGIN_SUCCESS">LOGIN_SUCCESS</option>
          <option value="LICENSE_APPLY">LICENSE_APPLY</option>
        </select>

        <button
          onClick={fetchAuditData}
          className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-graphite-700 transition"
          title="Verify & Refresh Chain"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Audit Log Table */}
      <div className="bg-graphite-850 rounded border border-graphite-700 overflow-hidden flex-1">
        <div className="px-4 py-3 border-b border-graphite-700 font-semibold text-xs uppercase tracking-wider text-slate-300">
          Chained Entries ({events.length})
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-mono">
            <thead className="bg-graphite-900 text-slate-400 uppercase text-[10px] border-b border-graphite-700">
              <tr>
                <th className="px-4 py-2.5">Seq #</th>
                <th className="px-4 py-2.5">Action</th>
                <th className="px-4 py-2.5">Actor</th>
                <th className="px-4 py-2.5">Target Resource</th>
                <th className="px-4 py-2.5">IP Address</th>
                <th className="px-4 py-2.5">Timestamp (UTC)</th>
                <th className="px-4 py-2.5">SHA-256 Hash</th>
                <th className="px-4 py-2.5 text-right">Inspect</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-graphite-700 text-slate-300">
              {events.map((evt) => (
                <tr key={evt.id} className="hover:bg-graphite-800 transition">
                  <td className="px-4 py-3 text-cctv-amber font-bold">#{evt.sequenceNumber}</td>
                  <td className="px-4 py-3">
                    <span className="px-1.5 py-0.5 rounded bg-graphite-700 text-white font-semibold text-[10px]">
                      {evt.action}
                    </span>
                  </td>
                  <td className="px-4 py-3">{evt.user?.name || 'System Service'}</td>
                  <td className="px-4 py-3 text-slate-400">
                    {evt.resourceType} {evt.resourceId ? `(${evt.resourceId.slice(0, 8)})` : ''}
                  </td>
                  <td className="px-4 py-3 text-slate-400">{evt.ipAddress}</td>
                  <td className="px-4 py-3 text-slate-400">
                    {new Date(evt.timestampUtc).toLocaleTimeString()}
                  </td>
                  <td className="px-4 py-3 text-slate-500 text-[10px]">
                    {evt.eventHash.slice(0, 12)}...
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setSelectedEvent(evt)}
                      className="p-1.5 rounded bg-graphite-700 text-slate-300 hover:text-white"
                    >
                      <Eye className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Inspect Event Modal */}
      {selectedEvent && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50 backdrop-blur-sm">
          <div className="bg-graphite-850 border border-graphite-700 rounded-md w-full max-w-2xl overflow-hidden shadow-2xl">
            <div className="px-5 py-4 border-b border-graphite-700 flex justify-between items-center bg-graphite-800">
              <h3 className="text-sm font-semibold text-slate-100 uppercase tracking-wider font-mono">
                Audit Block #{selectedEvent.sequenceNumber} Details
              </h3>
              <button onClick={() => setSelectedEvent(null)} className="text-slate-400 hover:text-white">✕</button>
            </div>

            <div className="p-5 space-y-3.5 text-xs font-mono max-h-[75vh] overflow-y-auto">
              <div>
                <span className="text-slate-400 block mb-1">Preceding Block Hash (prevHash):</span>
                <div className="p-2 bg-graphite-900 rounded border border-graphite-700 text-slate-400 break-all text-[11px]">
                  {selectedEvent.prevHash}
                </div>
              </div>

              <div>
                <span className="text-slate-400 block mb-1">Current Block Hash (eventHash):</span>
                <div className="p-2 bg-graphite-900 rounded border border-graphite-700 text-cctv-amber break-all text-[11px]">
                  {selectedEvent.eventHash}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 bg-graphite-900 p-3 rounded border border-graphite-700">
                <div>
                  <div className="text-slate-400">Actor</div>
                  <div className="text-white font-semibold">{selectedEvent.user?.name || 'System Service'}</div>
                  <div className="text-[10px] text-slate-400">{selectedEvent.user?.email || 'N/A'}</div>
                </div>
                <div>
                  <div className="text-slate-400">IP & User-Agent</div>
                  <div className="text-white">{selectedEvent.ipAddress}</div>
                  <div className="text-[10px] text-slate-400 truncate">{selectedEvent.userAgent || 'Internal'}</div>
                </div>
              </div>

              <div>
                <span className="text-slate-400 block mb-1">Payload Metadata JSON:</span>
                <pre className="p-3 bg-graphite-900 rounded border border-graphite-700 text-[10px] text-slate-300 overflow-x-auto">
                  {JSON.stringify(selectedEvent.metadataJson, null, 2)}
                </pre>
              </div>
            </div>

            <div className="p-4 border-t border-graphite-700 flex justify-end">
              <button
                onClick={() => setSelectedEvent(null)}
                className="px-4 py-1.5 rounded bg-graphite-700 text-slate-200 text-xs hover:bg-graphite-600"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AuditLogs;
