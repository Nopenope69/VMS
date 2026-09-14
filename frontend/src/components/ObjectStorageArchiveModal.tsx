import React, { useState, useEffect } from 'react';
import {
  X,
  Cloud,
  Save,
  Clock,
  ShieldCheck,
  RefreshCw,
  HardDrive,
} from 'lucide-react';
import api from '../services/api';

interface ObjectStorageArchiveModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ObjectStorageArchiveModal: React.FC<ObjectStorageArchiveModalProps> = ({
  isOpen,
  onClose,
}) => {
  const [config, setConfig] = useState({
    enabled: false,
    provider: 'S3_COMPATIBLE',
    endpoint: 'https://s3.ap-south-1.amazonaws.com',
    bucket: 'vigilone-cold-vault',
    region: 'ap-south-1',
    accessKeyId: '',
    secretAccessKey: '',
    offPeakStartUtc: '01:00',
    offPeakEndUtc: '05:00',
    rateLimitBps: 10485760, // 10 MB/s
  });

  const [jobs, setJobs] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);

  const fetchConfigAndJobs = async () => {
    try {
      const [configRes, jobsRes] = await Promise.all([
        api.get('/archive/config'),
        api.get('/archive/jobs?limit=15'),
      ]);
      if (configRes.data.config) {
        setConfig({
          ...configRes.data.config,
          accessKeyId: configRes.data.config.accessKeyId || '',
          secretAccessKey: '',
        });
      }
      setJobs(jobsRes.data.jobs || []);
    } catch (err) {
      console.error('Failed to load archive configuration', err);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchConfigAndJobs();
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') onClose();
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setSaving(true);
      await api.post('/archive/config', config);
      alert('Object storage archival configuration saved successfully.');
      fetchConfigAndJobs();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to save archival config');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="archive-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 font-sans text-slate-100"
    >
      <div className="bg-graphite-900 border border-graphite-700 rounded-xl shadow-2xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-graphite-700 flex items-center justify-between bg-graphite-850">
          <div className="flex items-center space-x-2">
            <Cloud className="w-5 h-5 text-cctv-teal" />
            <div>
              <h2 id="archive-modal-title" className="text-base font-bold tracking-wider uppercase text-slate-100">
                Offsite Object Storage Archive (S3 / MinIO)
              </h2>
              <p className="text-[11px] font-mono text-slate-400">
                Provider-neutral cold storage tiering with content-addressed pre-flight deduplication
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-graphite-700 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          <form onSubmit={handleSaveConfig} className="space-y-4 text-xs">
            <div className="flex items-center justify-between p-3 bg-graphite-850 border border-graphite-750 rounded-lg">
              <div>
                <div className="font-semibold text-slate-200">Automatic Offsite Archival</div>
                <div className="text-[11px] text-slate-400">
                  Enable scheduled tiering of fMP4 video segments to S3-compatible cold storage
                </div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.enabled}
                  onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-graphite-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-cctv-teal"></div>
              </label>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-slate-400 mb-1">Storage Provider</label>
                <select
                  value={config.provider}
                  onChange={(e) => setConfig({ ...config, provider: e.target.value })}
                  className="w-full bg-graphite-800 border border-graphite-700 rounded p-2 text-slate-200 font-mono"
                >
                  <option value="S3_COMPATIBLE">AWS S3 / S3-Compatible</option>
                  <option value="MINIO">MinIO Self-Hosted</option>
                  <option value="CEPH">Ceph Object Gateway (RADOS)</option>
                  <option value="WASABI">Wasabi Hot Cloud Storage</option>
                </select>
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Target Bucket Name</label>
                <input
                  type="text"
                  value={config.bucket}
                  onChange={(e) => setConfig({ ...config, bucket: e.target.value })}
                  className="w-full bg-graphite-800 border border-graphite-700 rounded p-2 text-slate-200 font-mono"
                  required
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-slate-400 mb-1">Endpoint URI</label>
                <input
                  type="text"
                  value={config.endpoint}
                  onChange={(e) => setConfig({ ...config, endpoint: e.target.value })}
                  className="w-full bg-graphite-800 border border-graphite-700 rounded p-2 text-slate-200 font-mono"
                  placeholder="https://s3.ap-south-1.amazonaws.com"
                  required
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Region</label>
                <input
                  type="text"
                  value={config.region}
                  onChange={(e) => setConfig({ ...config, region: e.target.value })}
                  className="w-full bg-graphite-800 border border-graphite-700 rounded p-2 text-slate-200 font-mono"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-slate-400 mb-1">Access Key ID</label>
                <input
                  type="text"
                  value={config.accessKeyId}
                  onChange={(e) => setConfig({ ...config, accessKeyId: e.target.value })}
                  className="w-full bg-graphite-800 border border-graphite-700 rounded p-2 text-slate-200 font-mono"
                  placeholder="AKIAIOSFODNN7EXAMPLE"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Secret Access Key</label>
                <input
                  type="password"
                  value={config.secretAccessKey}
                  onChange={(e) => setConfig({ ...config, secretAccessKey: e.target.value })}
                  className="w-full bg-graphite-800 border border-graphite-700 rounded p-2 text-slate-200 font-mono"
                  placeholder="••••••••••••••••••••••••"
                />
              </div>
            </div>

            {/* Off-Peak Sync Window & Bandwidth Limiter */}
            <div className="p-4 bg-graphite-850 border border-graphite-750 rounded-lg space-y-3">
              <div className="font-semibold text-slate-200 flex items-center space-x-2">
                <Clock className="w-4 h-4 text-cctv-amber" />
                <span>Off-Peak Synchronization Window & Bandwidth Throttling</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-[10px] text-slate-400 mb-1">Window Start (UTC)</label>
                  <input
                    type="time"
                    value={config.offPeakStartUtc}
                    onChange={(e) => setConfig({ ...config, offPeakStartUtc: e.target.value })}
                    className="w-full bg-graphite-800 border border-graphite-700 rounded p-1.5 font-mono text-slate-200"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-400 mb-1">Window End (UTC)</label>
                  <input
                    type="time"
                    value={config.offPeakEndUtc}
                    onChange={(e) => setConfig({ ...config, offPeakEndUtc: e.target.value })}
                    className="w-full bg-graphite-800 border border-graphite-700 rounded p-1.5 font-mono text-slate-200"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-400 mb-1">Rate Limit (MB/s)</label>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={Math.round(config.rateLimitBps / 1048576)}
                    onChange={(e) =>
                      setConfig({ ...config, rateLimitBps: Number(e.target.value) * 1048576 })
                    }
                    className="w-full bg-graphite-800 border border-graphite-700 rounded p-1.5 font-mono text-slate-200"
                  />
                </div>
              </div>
              <div className="text-[11px] text-slate-400 flex items-center space-x-1.5 pt-1">
                <ShieldCheck className="w-4 h-4 text-cctv-teal shrink-0" />
                <span>
                  <strong>Legal Evidence Bypass:</strong> Segments pinned under Section 63 BSA evidence
                  holds bypass off-peak restrictions and sync immediately.
                </span>
              </div>
            </div>

            <div className="flex justify-end space-x-2 pt-2">
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 rounded bg-cctv-teal text-graphite-900 font-bold hover:bg-teal-400 transition flex items-center space-x-1.5"
              >
                <Save className="w-3.5 h-3.5" />
                <span>{saving ? 'Saving...' : 'Save Configuration'}</span>
              </button>
            </div>
          </form>

          {/* Archival Queue & Status */}
          <div className="border-t border-graphite-750 pt-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="font-semibold text-xs text-slate-300 flex items-center space-x-2">
                <HardDrive className="w-4 h-4 text-slate-400" />
                <span>Recent Offsite Archival Jobs</span>
              </div>
              <button
                onClick={fetchConfigAndJobs}
                className="text-[10px] text-cctv-teal hover:underline flex items-center space-x-1"
              >
                <RefreshCw className="w-3 h-3" />
                <span>Refresh Jobs</span>
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-[11px] font-mono">
                <thead>
                  <tr className="border-b border-graphite-800 text-slate-500">
                    <th className="py-1">Created</th>
                    <th className="py-1">Segment Key</th>
                    <th className="py-1">Size</th>
                    <th className="py-1">Priority</th>
                    <th className="py-1">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-graphite-800/60 text-slate-300">
                  {jobs.map((j) => (
                    <tr key={j.id}>
                      <td className="py-1.5 text-slate-400">
                        {new Date(j.createdAt).toLocaleTimeString()}
                      </td>
                      <td className="py-1.5 text-slate-200 truncate max-w-xs">{j.objectKey}</td>
                      <td className="py-1.5 text-slate-400">
                        {(Number(j.sizeBytes) / 1048576).toFixed(1)} MB
                      </td>
                      <td className="py-1.5">
                        {j.priority ? (
                          <span className="px-1.5 py-[2px] rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[9px] font-bold">
                            LEGAL PIN
                          </span>
                        ) : (
                          <span className="text-slate-500">NORMAL</span>
                        )}
                      </td>
                      <td className="py-1.5">
                        <span
                          className={`px-1.5 py-[2px] rounded text-[9px] font-bold ${
                            j.status === 'COMPLETED'
                              ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                              : j.status === 'FAILED'
                              ? 'bg-rose-500/20 text-rose-400 border border-rose-500/40'
                              : 'bg-amber-500/20 text-amber-400 border border-amber-500/40'
                          }`}
                        >
                          {j.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {jobs.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-4 text-center text-slate-500">
                        No offsite archive jobs queued yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ObjectStorageArchiveModal;
