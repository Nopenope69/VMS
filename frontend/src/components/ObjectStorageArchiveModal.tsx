import React, { useState, useEffect } from 'react';
import {
  X,
  Cloud,
  Save,
  Clock,
  ShieldCheck,
  RefreshCw,
  HardDrive,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react';
import api from '../services/api';
import Button from './ui/Button';
import Input from './ui/Input';

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
  const [statusNotice, setStatusNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

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
      setStatusNotice(null);
      await api.post('/archive/config', config);
      setStatusNotice({ type: 'success', message: 'Object storage archival configuration saved successfully.' });
      fetchConfigAndJobs();
    } catch (err: any) {
      setStatusNotice({ type: 'error', message: err.response?.data?.error || 'Failed to save archival config' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="archive-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 font-sans text-vms-text select-none"
    >
      <div className="bg-vms-elevated border border-vms-border rounded shadow-2xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-vms-border flex items-center justify-between bg-vms-panel">
          <div className="flex items-center space-x-2">
            <Cloud className="w-5 h-5 text-sky-400" />
            <div>
              <h2 id="archive-modal-title" className="text-xs font-bold tracking-wider uppercase font-mono text-vms-text">
                Offsite Object Storage Archive (S3 / MinIO)
              </h2>
              <p className="text-[11px] font-mono text-vms-muted">
                Provider-neutral cold storage tiering with content-addressed pre-flight deduplication
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-vms-muted hover:text-vms-text hover:bg-vms-surface transition-colors"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {statusNotice && (
            <div
              className={`p-3 rounded text-xs font-mono flex items-center justify-between ${
                statusNotice.type === 'error'
                  ? 'bg-rose-950/70 border border-rose-800 text-rose-300'
                  : 'bg-emerald-950/70 border border-emerald-800 text-emerald-300'
              }`}
            >
              <div className="flex items-center space-x-2">
                {statusNotice.type === 'error' ? (
                  <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                ) : (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                )}
                <span>{statusNotice.message}</span>
              </div>
              <button
                type="button"
                onClick={() => setStatusNotice(null)}
                className="text-vms-muted hover:text-vms-text ml-2"
              >
                ×
              </button>
            </div>
          )}

          <form onSubmit={handleSaveConfig} className="space-y-4 text-xs">
            <div className="flex items-center justify-between p-3.5 bg-vms-panel border border-vms-border rounded">
              <div>
                <div className="font-semibold text-vms-text font-mono">Automatic Offsite Archival</div>
                <div className="text-[11px] text-vms-muted font-sans">
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
                <div className="w-11 h-6 bg-vms-surface peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-vms-accent"></div>
              </label>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-vms-muted mb-1 font-mono uppercase tracking-wider text-[10px]">
                  Storage Provider
                </label>
                <select
                  value={config.provider}
                  onChange={(e) => setConfig({ ...config, provider: e.target.value })}
                  className="w-full bg-vms-surface border border-vms-border rounded p-2 text-vms-text font-mono text-xs focus:border-vms-accent focus:outline-none"
                >
                  <option value="S3_COMPATIBLE">AWS S3 / S3-Compatible</option>
                  <option value="MINIO">MinIO Self-Hosted</option>
                  <option value="CEPH">Ceph Object Gateway (RADOS)</option>
                  <option value="WASABI">Wasabi Hot Cloud Storage</option>
                </select>
              </div>
              <div>
                <label className="block text-vms-muted mb-1 font-mono uppercase tracking-wider text-[10px]">
                  Target Bucket Name
                </label>
                <Input
                  value={config.bucket}
                  onChange={(e) => setConfig({ ...config, bucket: e.target.value })}
                  className="w-full text-xs font-mono"
                  required
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-vms-muted mb-1 font-mono uppercase tracking-wider text-[10px]">
                  Endpoint URI
                </label>
                <Input
                  value={config.endpoint}
                  onChange={(e) => setConfig({ ...config, endpoint: e.target.value })}
                  className="w-full text-xs font-mono"
                  placeholder="https://s3.ap-south-1.amazonaws.com"
                  required
                />
              </div>
              <div>
                <label className="block text-vms-muted mb-1 font-mono uppercase tracking-wider text-[10px]">
                  Region
                </label>
                <Input
                  value={config.region}
                  onChange={(e) => setConfig({ ...config, region: e.target.value })}
                  className="w-full text-xs font-mono"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-vms-muted mb-1 font-mono uppercase tracking-wider text-[10px]">
                  Access Key ID
                </label>
                <Input
                  value={config.accessKeyId}
                  onChange={(e) => setConfig({ ...config, accessKeyId: e.target.value })}
                  className="w-full text-xs font-mono"
                  placeholder="AKIAIOSFODNN7EXAMPLE"
                />
              </div>
              <div>
                <label className="block text-vms-muted mb-1 font-mono uppercase tracking-wider text-[10px]">
                  Secret Access Key
                </label>
                <Input
                  type="password"
                  value={config.secretAccessKey}
                  onChange={(e) => setConfig({ ...config, secretAccessKey: e.target.value })}
                  className="w-full text-xs font-mono"
                  placeholder="••••••••••••••••••••••••"
                />
              </div>
            </div>

            {/* Off-Peak Sync Window & Bandwidth Limiter */}
            <div className="p-4 bg-vms-panel border border-vms-border rounded space-y-3">
              <div className="font-semibold text-vms-text flex items-center space-x-2 font-mono text-xs uppercase tracking-wider">
                <Clock className="w-4 h-4 text-vms-accent" />
                <span>Off-Peak Synchronization Window & Bandwidth Throttling</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-[10px] text-vms-muted mb-1 font-mono uppercase tracking-wider">
                    Window Start (UTC)
                  </label>
                  <Input
                    type="time"
                    value={config.offPeakStartUtc}
                    onChange={(e) => setConfig({ ...config, offPeakStartUtc: e.target.value })}
                    className="w-full text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-vms-muted mb-1 font-mono uppercase tracking-wider">
                    Window End (UTC)
                  </label>
                  <Input
                    type="time"
                    value={config.offPeakEndUtc}
                    onChange={(e) => setConfig({ ...config, offPeakEndUtc: e.target.value })}
                    className="w-full text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-vms-muted mb-1 font-mono uppercase tracking-wider">
                    Rate Limit (MB/s)
                  </label>
                  <Input
                    type="number"
                    min="1"
                    max="100"
                    value={Math.round(config.rateLimitBps / 1048576)}
                    onChange={(e) =>
                      setConfig({ ...config, rateLimitBps: Number(e.target.value) * 1048576 })
                    }
                    className="w-full text-xs font-mono"
                  />
                </div>
              </div>
              <div className="text-[11px] text-vms-muted flex items-center space-x-1.5 pt-1">
                <ShieldCheck className="w-4 h-4 text-sky-400 shrink-0" />
                <span>
                  <strong className="text-vms-text">Legal Evidence Bypass:</strong> Segments pinned under Section 63 BSA evidence
                  holds bypass off-peak restrictions and sync immediately.
                </span>
              </div>
            </div>

            <div className="flex justify-end space-x-2 pt-2">
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={saving}
                isLoading={saving}
                icon={Save}
              >
                Save Configuration
              </Button>
            </div>
          </form>

          {/* Archival Queue & Status */}
          <div className="border-t border-vms-border pt-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="font-semibold text-xs text-vms-text flex items-center space-x-2 font-mono uppercase tracking-wider">
                <HardDrive className="w-4 h-4 text-vms-dim" />
                <span>Recent Offsite Archival Jobs</span>
              </div>
              <button
                onClick={fetchConfigAndJobs}
                className="text-[10px] text-sky-400 hover:underline flex items-center space-x-1 font-mono"
              >
                <RefreshCw className="w-3 h-3" />
                <span>Refresh Jobs</span>
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-[11px] font-mono">
                <thead>
                  <tr className="border-b border-vms-border text-vms-muted uppercase text-[10px]">
                    <th className="py-1">Created</th>
                    <th className="py-1">Segment Key</th>
                    <th className="py-1">Size</th>
                    <th className="py-1">Priority</th>
                    <th className="py-1">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-vms-border/60 text-vms-text">
                  {jobs.map((j) => (
                    <tr key={j.id} className="hover:bg-vms-surface/40">
                      <td className="py-1.5 text-vms-muted">
                        {new Date(j.createdAt).toLocaleTimeString()}
                      </td>
                      <td className="py-1.5 text-vms-text truncate max-w-xs">{j.objectKey}</td>
                      <td className="py-1.5 text-vms-muted">
                        {(Number(j.sizeBytes) / 1048576).toFixed(1)} MB
                      </td>
                      <td className="py-1.5">
                        {j.priority ? (
                          <span className="px-1.5 py-[2px] rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[9px] font-bold">
                            LEGAL PIN
                          </span>
                        ) : (
                          <span className="text-vms-dim">NORMAL</span>
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
                      <td colSpan={5} className="py-4 text-center text-vms-dim">
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
