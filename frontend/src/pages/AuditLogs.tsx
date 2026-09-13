import React, { useState, useEffect } from 'react';
import { FileText, ShieldCheck, AlertOctagon, RefreshCw, Eye, X } from 'lucide-react';
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
    <div className="flex flex-col h-[calc(100vh-3.5rem)] bg-[#080B10] p-4 space-y-4 overflow-y-auto select-none font-mono">
      {/* Top Banner with Cryptographic Integrity Verification */}
      <div className="bg-[#0D1117] p-4 border border-[#21262D] relative flex flex-wrap items-center justify-between gap-3 shadow-lg">
        {/* Optical Corner Reticles */}
        <span className="absolute -top-1 -left-1 text-[9px] text-[#30363D]">+</span>
        <span className="absolute -top-1 -right-1 text-[9px] text-[#30363D]">+</span>
        <span className="absolute -bottom-1 -left-1 text-[9px] text-[#30363D]">+</span>
        <span className="absolute -bottom-1 -right-1 text-[9px] text-[#30363D]">+</span>

        <div>
          <div className="flex items-center space-x-2">
            <FileText className="w-4 h-4 text-[#E3B341]" />
            <h2 className="text-xs font-bold text-white uppercase tracking-wider">
              [ 01 // TAMPER-EVIDENT CRYPTOGRAPHIC AUDIT REGISTRY ]
            </h2>
          </div>
          <p className="text-[11px] text-slate-400 mt-1 max-w-3xl leading-relaxed">
            Cryptographic SHA-256 Merkle-linked immutable ledger. Strict sequential hash-chaining guarantees zero retroactive deletion, insertion, or modification of operator actions.
          </p>
        </div>

        {verifyStatus && (
          <div
            className={`flex items-center space-x-2 px-3 py-1.5 rounded-none border text-xs tracking-wider font-bold ${
              verifyStatus.tamperEvidentStatus === 'INTACT'
                ? 'bg-[#3FB950]/10 border-[#3FB950]/40 text-[#3FB950]'
                : 'bg-[#F85149]/10 border-[#F85149]/40 text-[#F85149]'
            }`}
          >
            {verifyStatus.tamperEvidentStatus === 'INTACT' ? (
              <>
                <ShieldCheck className="w-4 h-4 text-[#3FB950]" />
                <span>[ CHAIN_INTACT: {verifyStatus.verifiedCount} RECORDS VERIFIED ]</span>
              </>
            ) : (
              <>
                <AlertOctagon className="w-4 h-4 text-[#F85149]" />
                <span>[ CHAIN_TAMPER_DETECTED: SEQ #{verifyStatus.brokenSequence} ]</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* Filter Bar */}
      <div className="bg-[#0D1117] p-2.5 border border-[#21262D] flex justify-between items-center">
        <div className="flex items-center space-x-2">
          <span className="text-slate-500 text-xs uppercase tracking-wider">FILTER_ACTION:</span>
          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="bg-[#080B10] border border-[#21262D] px-3 py-1 text-xs text-slate-200 uppercase tracking-wider focus:outline-none focus:border-[#E3B341] rounded-none"
          >
            <option value="">ALL LOGGED ACTIONS</option>
            <option value="CAMERA_CREATE">CAMERA_CREATE</option>
            <option value="CAMERA_DELETE">CAMERA_DELETE</option>
            <option value="EXPORT_EVIDENCE_BSA63">EXPORT_EVIDENCE_BSA63</option>
            <option value="USER_CREATE">USER_CREATE</option>
            <option value="USER_DEACTIVATE">USER_DEACTIVATE</option>
            <option value="LOGIN_SUCCESS">LOGIN_SUCCESS</option>
            <option value="LICENSE_APPLY">LICENSE_APPLY</option>
          </select>
        </div>

        <button
          onClick={fetchAuditData}
          className="flex items-center gap-1.5 px-3 py-1 bg-[#161B22] hover:bg-[#21262D] text-slate-300 border border-[#21262D] text-xs uppercase tracking-wider transition rounded-none"
          title="Re-verify Hash Chain Integrity"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-[#E3B341]' : ''}`} />
          <span>RE-VERIFY CHAIN</span>
        </button>
      </div>

      {/* Audit Log Table */}
      <div className="bg-[#0D1117] border border-[#21262D] overflow-hidden flex-1">
        <div className="px-4 py-2.5 border-b border-[#21262D] font-bold text-xs uppercase tracking-wider text-slate-300 bg-[#161B22] flex items-center justify-between">
          <span>CHAINED LEDGER ENTRIES ({events.length})</span>
          <span className="text-[10px] text-slate-500">CANONICAL MERKLE TREE</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#080B10] text-slate-400 uppercase text-[10px] border-b border-[#21262D]">
              <tr>
                <th className="px-4 py-2.5">SEQ #</th>
                <th className="px-4 py-2.5">ACTION</th>
                <th className="px-4 py-2.5">ACTOR</th>
                <th className="px-4 py-2.5">TARGET RESOURCE</th>
                <th className="px-4 py-2.5">IP ADDRESS</th>
                <th className="px-4 py-2.5">TIMESTAMP (UTC)</th>
                <th className="px-4 py-2.5">SHA-256 HASH</th>
                <th className="px-4 py-2.5 text-right">INSPECT</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#21262D] text-slate-300">
              {events.map((evt) => (
                <tr key={evt.id} className="hover:bg-[#161B22] transition">
                  <td className="px-4 py-3 text-[#E3B341] font-bold tracking-wider">
                    #{String(evt.sequenceNumber).padStart(6, '0')}
                  </td>
                  <td className="px-4 py-3">
                    <span className="px-1.5 py-0.5 rounded-none bg-[#161B22] border border-[#21262D] text-white font-semibold text-[10px] uppercase">
                      {evt.action}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-200">{evt.user?.name || 'SYSTEM_DAEMON'}</td>
                  <td className="px-4 py-3 text-slate-400">
                    {evt.resourceType} {evt.resourceId ? `(${evt.resourceId.slice(0, 8)})` : ''}
                  </td>
                  <td className="px-4 py-3 text-slate-400 font-mono text-[11px]">{evt.ipAddress}</td>
                  <td className="px-4 py-3 text-slate-400 font-mono text-[11px]">
                    {new Date(evt.timestampUtc).toISOString().slice(11, 19)} UTC
                  </td>
                  <td className="px-4 py-3 text-[#58A6FF] text-[10px] font-mono">
                    {evt.eventHash.slice(0, 14)}...
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setSelectedEvent(evt)}
                      className="p-1.5 bg-[#161B22] hover:bg-[#E3B341] hover:text-[#080B10] text-slate-300 border border-[#21262D] transition rounded-none"
                      title="Inspect Block Cryptographic Signatures"
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
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50 select-none">
          <div className="bg-[#0D1117] border border-[#21262D] rounded-none w-full max-w-2xl overflow-hidden shadow-2xl relative">
            <span className="absolute -top-1 -left-1 text-[9px] text-[#30363D]">+</span>
            <span className="absolute -top-1 -right-1 text-[9px] text-[#30363D]">+</span>
            <span className="absolute -bottom-1 -left-1 text-[9px] text-[#30363D]">+</span>
            <span className="absolute -bottom-1 -right-1 text-[9px] text-[#30363D]">+</span>

            <div className="px-5 py-3.5 border-b border-[#21262D] flex justify-between items-center bg-[#161B22]">
              <h3 className="text-xs font-bold text-white uppercase tracking-wider">
                [ AUDIT BLOCK #{String(selectedEvent.sequenceNumber).padStart(6, '0')} // MERKLE LEAF DETAIL ]
              </h3>
              <button onClick={() => setSelectedEvent(null)} className="text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-3.5 text-xs max-h-[75vh] overflow-y-auto bg-[#0D1117]">
              <div>
                <span className="text-slate-500 block mb-1 uppercase tracking-widest text-[10px]">
                  PREVIOUS BLOCK HASH (PREV_HASH):
                </span>
                <div className="p-2.5 bg-[#080B10] border border-[#21262D] text-slate-400 break-all text-[11px] font-mono select-text">
                  {selectedEvent.prevHash || '0000000000000000000000000000000000000000000000000000000000000000'}
                </div>
              </div>

              <div>
                <span className="text-slate-500 block mb-1 uppercase tracking-widest text-[10px]">
                  CURRENT BLOCK MERKLE HASH (EVENT_HASH):
                </span>
                <div className="p-2.5 bg-[#080B10] border border-[#21262D] text-[#E3B341] break-all text-[11px] font-mono font-bold select-text">
                  {selectedEvent.eventHash}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 bg-[#161B22] p-3 border border-[#21262D]">
                <div>
                  <div className="text-slate-500 text-[10px] uppercase tracking-widest">ACTOR IDENTIFIER</div>
                  <div className="text-white font-bold tracking-wide mt-0.5">{selectedEvent.user?.name || 'SYSTEM_SERVICE'}</div>
                  <div className="text-[10px] text-slate-400">{selectedEvent.user?.email || 'N/A'}</div>
                </div>
                <div>
                  <div className="text-slate-500 text-[10px] uppercase tracking-widest">INGRESS NETWORK IP</div>
                  <div className="text-white font-mono mt-0.5">{selectedEvent.ipAddress}</div>
                  <div className="text-[10px] text-slate-400 truncate font-mono">{selectedEvent.userAgent || 'INTERNAL_IPC'}</div>
                </div>
              </div>

              <div>
                <span className="text-slate-500 block mb-1 uppercase tracking-widest text-[10px]">
                  PAYLOAD METADATA ATTESTATION (JSON):
                </span>
                <pre className="p-3 bg-[#080B10] border border-[#21262D] text-[10px] text-slate-300 overflow-x-auto select-text font-mono">
                  {JSON.stringify(selectedEvent.metadataJson, null, 2)}
                </pre>
              </div>
            </div>

            <div className="p-4 border-t border-[#21262D] flex justify-end bg-[#0D1117]">
              <button
                onClick={() => setSelectedEvent(null)}
                className="px-4 py-1.5 bg-[#161B22] hover:bg-[#21262D] text-slate-200 text-xs uppercase tracking-wider border border-[#21262D] rounded-none"
              >
                CLOSE INSPECTOR
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AuditLogs;
