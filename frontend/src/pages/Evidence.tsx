import React, { useState, useEffect } from 'react';
import { ShieldCheck, Download, CheckCircle2, Eye } from 'lucide-react';
import api from '../services/api';

export const Evidence: React.FC = () => {
  const [exportsList, setExportsList] = useState<any[]>([]);
  const [selectedExport, setSelectedExport] = useState<any | null>(null);

  const fetchExports = async () => {
    try {
      const res = await api.get('/evidence');
      setExportsList(res.data.exports || []);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchExports();
  }, []);

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] bg-graphite-900 p-4 space-y-4 overflow-y-auto">
      {/* Top Banner */}
      <div className="bg-graphite-850 p-4 rounded border border-graphite-700 flex justify-between items-center">
        <div>
          <div className="flex items-center space-x-2">
            <ShieldCheck className="w-5 h-5 text-cctv-amber" />
            <h2 className="text-sm font-semibold text-slate-100 uppercase tracking-wider">
              Section 63 BSA Evidence Registry
            </h2>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Audit trail of exported surveillance records with SHA-256 integrity checksums, appliance Ed25519 signatures, and pre-populated Part A & Part B certificates under the Bharatiya Sakshya Adhiniyam, 2023.
          </p>
        </div>
      </div>

      {/* Table */}
      <div className="bg-graphite-850 rounded border border-graphite-700 overflow-hidden flex-1">
        <div className="px-4 py-3 border-b border-graphite-700 font-semibold text-xs uppercase tracking-wider text-slate-300">
          Generated Packages ({exportsList.length})
        </div>

        {exportsList.length === 0 ? (
          <div className="p-12 text-center text-slate-500 font-mono text-xs">
            No evidentiary packages generated yet. Go to Playback & Review to select an interval and export.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-graphite-900 text-slate-400 uppercase text-[10px] border-b border-graphite-700">
                <tr>
                  <th className="px-4 py-2.5">Export ID</th>
                  <th className="px-4 py-2.5">Camera</th>
                  <th className="px-4 py-2.5">Time Interval (UTC)</th>
                  <th className="px-4 py-2.5">Mode</th>
                  <th className="px-4 py-2.5">SHA-256 Checksum</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-graphite-700 text-slate-300">
                {exportsList.map((exp) => (
                  <tr key={exp.id} className="hover:bg-graphite-800 transition">
                    <td className="px-4 py-3 font-semibold text-white">EV_{exp.id.slice(0, 8)}</td>
                    <td className="px-4 py-3 text-cctv-amber">{exp.camera?.name || 'Camera'}</td>
                    <td className="px-4 py-3 text-slate-400">
                      {new Date(exp.startTime).toLocaleTimeString()} - {new Date(exp.endTime).toLocaleTimeString()}
                    </td>
                    <td className="px-4 py-3">
                      <span className="px-1.5 py-0.5 rounded bg-graphite-700 text-[10px] text-slate-200">
                        {exp.exportMode}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-400 text-[11px]">
                      {exp.sha256Hash ? `${exp.sha256Hash.slice(0, 16)}...` : 'Pending'}
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex items-center space-x-1 text-emerald-400 text-[11px]">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>COMPLETED</span>
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right space-x-2">
                      <button
                        onClick={() => setSelectedExport(exp)}
                        className="p-1.5 rounded bg-graphite-700 text-slate-300 hover:text-white"
                        title="Inspect Manifest & Signatures"
                      >
                        <Eye className="w-3.5 h-3.5" />
                      </button>
                      <a
                        href={`/api/v1/evidence/download/Evidence_${exp.id}.zip`}
                        download
                        className="inline-flex items-center space-x-1 px-2.5 py-1 rounded bg-cctv-amber text-graphite-900 font-semibold text-xs hover:bg-amber-400 transition"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Zip</span>
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Manifest Inspection Modal */}
      {selectedExport && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50 backdrop-blur-sm">
          <div className="bg-graphite-850 border border-graphite-700 rounded-md w-full max-w-2xl overflow-hidden shadow-2xl">
            <div className="px-5 py-4 border-b border-graphite-700 flex justify-between items-center bg-graphite-800">
              <h3 className="text-sm font-semibold text-slate-100 uppercase tracking-wider font-mono">
                Evidence Manifest — EV_{selectedExport.id}
              </h3>
              <button onClick={() => setSelectedExport(null)} className="text-slate-400 hover:text-white">✕</button>
            </div>

            <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto text-xs font-mono">
              <div>
                <span className="text-slate-400 block mb-1">Video SHA-256 Checksum:</span>
                <div className="p-2 bg-graphite-900 rounded border border-graphite-700 text-cctv-amber break-all">
                  {selectedExport.sha256Hash}
                </div>
              </div>

              <div>
                <span className="text-slate-400 block mb-1">Appliance Ed25519 Digital Signature:</span>
                <div className="p-2 bg-graphite-900 rounded border border-graphite-700 text-slate-300 break-all text-[11px]">
                  {selectedExport.signatureEd25519 || 'N/A'}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 bg-graphite-900 p-3 rounded border border-graphite-700">
                <div>
                  <div className="text-cctv-teal font-semibold mb-1">Part A Signatory (Party In-Charge)</div>
                  <div>Name: {selectedExport.partAPartyName || 'N/A'}</div>
                  <div>Designation: {selectedExport.partAPartyDesignation || 'N/A'}</div>
                </div>
                <div>
                  <div className="text-cctv-amber font-semibold mb-1">Part B Signatory (Expert)</div>
                  <div>Name: {selectedExport.partBExpertName || 'N/A'}</div>
                  <div>Designation: {selectedExport.partBExpertDesignation || 'N/A'}</div>
                  <div>Organization: {selectedExport.partBExpertOrganization || 'N/A'}</div>
                </div>
              </div>

              <div>
                <span className="text-slate-400 block mb-1">Full Canonical Manifest JSON:</span>
                <pre className="p-3 bg-graphite-900 rounded border border-graphite-700 text-[10px] text-slate-300 overflow-x-auto">
                  {JSON.stringify(selectedExport.manifestJson, null, 2)}
                </pre>
              </div>
            </div>

            <div className="p-4 border-t border-graphite-700 flex justify-end">
              <button
                onClick={() => setSelectedExport(null)}
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

export default Evidence;
