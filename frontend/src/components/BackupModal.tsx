import React, { useState, useEffect } from 'react';
import { X, ShieldAlert, Download, Upload, CheckCircle2, AlertTriangle, RefreshCw } from 'lucide-react';
import api from '../services/api';

interface BackupModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const BackupModal: React.FC<BackupModalProps> = ({ isOpen, onClose }) => {
  const [activeTab, setActiveTab] = useState<'export' | 'restore'>('export');
  const [downloading, setDownloading] = useState<boolean>(false);
  const [restoring, setRestoring] = useState<boolean>(false);
  const [restorePayloadJson, setRestorePayloadJson] = useState<string>('');
  const [restoreSummary, setRestoreSummary] = useState<any | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const handleDownloadBackup = async () => {
    setDownloading(true);
    setErrorMessage(null);
    try {
      const res = await api.get('/system/backup');
      const backupData = res.data;

      // Trigger client-side file download
      const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `vigilone-backup-${backupData.tenantId}-${new Date().toISOString().slice(0, 10)}.vigilone-backup`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setErrorMessage(err.response?.data?.error || 'Failed to generate appliance backup archive.');
    } finally {
      setDownloading(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;
        setRestorePayloadJson(text);
        setErrorMessage(null);
      } catch (err) {
        setErrorMessage('Failed to read backup file.');
      }
    };
    reader.readAsText(file);
  };

  const handleExecuteRestore = async () => {
    if (!restorePayloadJson.trim()) {
      setErrorMessage('Please upload or paste a valid .vigilone-backup payload JSON.');
      return;
    }

    let parsedBackup: any;
    try {
      parsedBackup = JSON.parse(restorePayloadJson);
    } catch (err) {
      setErrorMessage('Invalid JSON format in backup payload.');
      return;
    }

    if (parsedBackup.format !== 'VIGILONE_BACKUP_V1') {
      setErrorMessage('Unrecognized backup format. Expected "VIGILONE_BACKUP_V1".');
      return;
    }

    if (!window.confirm('Are you sure you want to restore this configuration? Existing settings will be updated transactionally.')) {
      return;
    }

    setRestoring(true);
    setErrorMessage(null);
    setRestoreSummary(null);

    try {
      const res = await api.post('/system/restore', { backupArchive: parsedBackup });
      setRestoreSummary(res.data);
    } catch (err: any) {
      setErrorMessage(
        err.response?.data?.error || 'Failed to restore configuration. Integrity check or decryption failed.'
      );
    } finally {
      setRestoring(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="backup-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-4"
    >
      <div className="bg-graphite-850 border border-graphite-700 w-full max-w-2xl max-h-[90vh] rounded-lg shadow-2xl flex flex-col overflow-hidden text-slate-100">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-graphite-700 flex items-center justify-between bg-graphite-900">
          <div className="flex items-center space-x-2.5">
            <div className="p-1.5 rounded bg-cctv-amber/20 border border-cctv-amber/40 text-cctv-amber">
              <ShieldAlert className="w-4 h-4" />
            </div>
            <div>
              <h2 id="backup-modal-title" className="text-sm font-bold tracking-wide uppercase">Disaster Recovery & Appliance Backup</h2>
              <p className="text-[11px] text-slate-400 font-mono">
                AES-256-GCM Encrypted Configuration Archive (.vigilone-backup)
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-graphite-700 transition"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab Controls */}
        <div className="flex border-b border-graphite-700 bg-graphite-850 px-5 pt-2">
          <button
            onClick={() => setActiveTab('export')}
            className={`py-2 px-4 text-xs font-semibold border-b-2 transition ${
              activeTab === 'export'
                ? 'border-cctv-amber text-cctv-amber bg-graphite-800/50'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Export Archive
          </button>
          <button
            onClick={() => setActiveTab('restore')}
            className={`py-2 px-4 text-xs font-semibold border-b-2 transition ${
              activeTab === 'restore'
                ? 'border-cctv-amber text-cctv-amber bg-graphite-800/50'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Transactional Restore
          </button>
        </div>

        {/* Content */}
        <div className="p-5 overflow-y-auto space-y-4">
          {errorMessage && (
            <div className="p-3 bg-red-500/20 border border-red-500/50 rounded text-red-200 text-xs flex items-center space-x-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          {activeTab === 'export' ? (
            <div className="space-y-4">
              {/* Scope Boundary Warning */}
              <div className="p-3.5 bg-amber-500/10 border border-amber-500/30 rounded-lg text-amber-200 text-xs space-y-1.5">
                <div className="font-bold flex items-center space-x-1.5 text-cctv-amber">
                  <ShieldAlert className="w-4 h-4" />
                  <span>Configuration Metadata Scope Boundary (&lt; 5 MB)</span>
                </div>
                <p className="text-[11px] leading-relaxed text-slate-300">
                  This backup contains appliance configuration, cameras, credentials, recording matrices,
                  detection zones, layout presets, vehicle watchlists, and notification channels.
                  <strong className="text-amber-200 ml-1">
                    Multi-terabyte video recordings and evidence media are strictly excluded
                  </strong>.
                </p>
              </div>

              <div className="bg-graphite-900 border border-graphite-700 rounded-lg p-4 space-y-2 text-xs">
                <div className="flex justify-between font-mono text-slate-300">
                  <span className="text-slate-400">Archive Format:</span>
                  <span>VIGILONE_BACKUP_V1</span>
                </div>
                <div className="flex justify-between font-mono text-slate-300">
                  <span className="text-slate-400">Encryption:</span>
                  <span>AES-256-GCM + SHA-256 Checksum</span>
                </div>
                <div className="flex justify-between font-mono text-slate-300">
                  <span className="text-slate-400">Appliance Integrity:</span>
                  <span>Tamper-Evident HMAC Verification</span>
                </div>
              </div>

              <button
                onClick={handleDownloadBackup}
                disabled={downloading}
                className="w-full flex items-center justify-center space-x-2 py-2.5 rounded bg-cctv-amber text-graphite-900 font-bold text-xs hover:bg-amber-400 transition disabled:opacity-50"
              >
                <Download className="w-4 h-4" />
                <span>{downloading ? 'Generating Encrypted Package...' : 'Download Encrypted Backup'}</span>
              </button>
            </div>
          ) : (
            /* Restore Tab */
            <div className="space-y-4 text-xs">
              {restoreSummary ? (
                <div className="p-4 bg-emerald-950/50 border border-emerald-500/50 rounded-lg space-y-3">
                  <div className="flex items-center space-x-2 text-emerald-300 font-bold">
                    <CheckCircle2 className="w-5 h-5" />
                    <span>Appliance Configuration Restored Successfully!</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 font-mono text-[11px] text-slate-300 bg-graphite-900/60 p-3 rounded">
                    <div>Sites: {restoreSummary.restoredCounts?.sites || 0}</div>
                    <div>Cameras: {restoreSummary.restoredCounts?.cameras || 0}</div>
                    <div>Schedules: {restoreSummary.restoredCounts?.schedules || 0}</div>
                    <div>Zones: {restoreSummary.restoredCounts?.zones || 0}</div>
                    <div>Layouts: {restoreSummary.restoredCounts?.layouts || 0}</div>
                    <div>Watchlists: {restoreSummary.restoredCounts?.watchlists || 0}</div>
                    <div>Channels: {restoreSummary.restoredCounts?.notificationChannels || 0}</div>
                  </div>
                  <button
                    onClick={() => {
                      setRestoreSummary(null);
                      setRestorePayloadJson('');
                    }}
                    className="text-xs text-cctv-amber hover:underline"
                  >
                    Upload Another Backup
                  </button>
                </div>
              ) : (
                <>
                  <div className="border-2 border-dashed border-graphite-700 rounded-lg p-6 text-center hover:border-cctv-amber transition">
                    <Upload className="w-8 h-8 text-slate-500 mx-auto mb-2" />
                    <label className="cursor-pointer">
                      <span className="text-cctv-amber font-semibold hover:underline">Upload .vigilone-backup file</span>
                      <input type="file" accept=".json,.vigilone-backup" onChange={handleFileUpload} className="hidden" />
                    </label>
                    <p className="text-[11px] text-slate-500 mt-1 font-mono">or paste encrypted archive JSON below</p>
                  </div>

                  <div>
                    <label className="block text-[10px] uppercase font-mono text-slate-400 mb-1">
                      Backup Archive JSON
                    </label>
                    <textarea
                      rows={5}
                      placeholder='{"format": "VIGILONE_BACKUP_V1", "checksumSha256": "...", "encryptedPayload": "..."}'
                      value={restorePayloadJson}
                      onChange={(e) => setRestorePayloadJson(e.target.value)}
                      className="w-full bg-graphite-900 border border-graphite-700 rounded p-2.5 font-mono text-[11px] text-slate-200 focus:border-cctv-amber focus:outline-none"
                    />
                  </div>

                  <button
                    onClick={handleExecuteRestore}
                    disabled={restoring || !restorePayloadJson.trim()}
                    className="w-full flex items-center justify-center space-x-2 py-2.5 rounded bg-rose-600 text-white font-bold text-xs hover:bg-rose-500 transition disabled:opacity-50"
                  >
                    <RefreshCw className={`w-4 h-4 ${restoring ? 'animate-spin' : ''}`} />
                    <span>{restoring ? 'Verifying & Restoring Transaction...' : 'Execute Transactional Restore'}</span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default BackupModal;
