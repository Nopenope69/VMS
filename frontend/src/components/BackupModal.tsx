import React, { useState, useEffect } from 'react';
import { X, ShieldAlert, Download, Upload, CheckCircle2, AlertTriangle, RefreshCw } from 'lucide-react';
import api from '../services/api';
import Button from './ui/Button';

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
  const [showConfirmRestore, setShowConfirmRestore] = useState<boolean>(false);

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

  const handlePromptRestore = () => {
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

    setErrorMessage(null);
    setShowConfirmRestore(true);
  };

  const handleExecuteRestore = async () => {
    setShowConfirmRestore(false);
    let parsedBackup: any;
    try {
      parsedBackup = JSON.parse(restorePayloadJson);
    } catch (err) {
      setErrorMessage('Invalid JSON format in backup payload.');
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-xs p-4 select-none"
    >
      <div className="bg-vms-elevated border border-vms-border w-full max-w-2xl max-h-[90vh] rounded shadow-2xl flex flex-col overflow-hidden text-vms-text">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-vms-border flex items-center justify-between bg-vms-panel">
          <div className="flex items-center space-x-2.5">
            <div className="p-1.5 rounded bg-vms-accent/20 border border-vms-accent/40 text-vms-accent">
              <ShieldAlert className="w-4 h-4" />
            </div>
            <div>
              <h2 id="backup-modal-title" className="text-xs font-bold tracking-wider uppercase font-mono text-vms-text">
                Disaster Recovery & Appliance Backup
              </h2>
              <p className="text-[11px] text-vms-muted font-mono">
                AES-256-GCM Encrypted Configuration Archive (.vigilone-backup)
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1 rounded text-vms-muted hover:text-vms-text hover:bg-vms-surface transition-colors"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab Controls */}
        <div className="flex border-b border-vms-border bg-vms-surface px-5 pt-2">
          <button
            onClick={() => setActiveTab('export')}
            className={`py-2 px-4 text-xs font-mono font-semibold border-b-2 transition-colors ${
              activeTab === 'export'
                ? 'border-vms-accent text-vms-accent bg-vms-panel/50'
                : 'border-transparent text-vms-muted hover:text-vms-text'
            }`}
          >
            Export Archive
          </button>
          <button
            onClick={() => setActiveTab('restore')}
            className={`py-2 px-4 text-xs font-mono font-semibold border-b-2 transition-colors ${
              activeTab === 'restore'
                ? 'border-vms-accent text-vms-accent bg-vms-panel/50'
                : 'border-transparent text-vms-muted hover:text-vms-text'
            }`}
          >
            Transactional Restore
          </button>
        </div>

        {/* Content */}
        <div className="p-5 overflow-y-auto space-y-4">
          {errorMessage && (
            <div className="p-3 bg-rose-950/70 border border-rose-800 rounded text-rose-300 text-xs font-mono flex items-center space-x-2">
              <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
              <span>{errorMessage}</span>
            </div>
          )}

          {activeTab === 'export' ? (
            <div className="space-y-4">
              {/* Scope Boundary Warning */}
              <div className="p-3.5 bg-amber-500/10 border border-amber-500/30 rounded text-amber-200 text-xs space-y-1.5">
                <div className="font-bold flex items-center space-x-1.5 text-vms-accent font-mono">
                  <ShieldAlert className="w-4 h-4" />
                  <span>Configuration Metadata Scope Boundary (&lt; 5 MB)</span>
                </div>
                <p className="text-[11px] leading-relaxed text-vms-muted font-sans">
                  This backup contains appliance configuration, cameras, credentials, recording matrices,
                  detection zones, layout presets, vehicle watchlists, and notification channels.
                  <strong className="text-amber-300 ml-1">
                    Multi-terabyte video recordings and evidence media are strictly excluded
                  </strong>.
                </p>
              </div>

              <div className="bg-vms-panel border border-vms-border rounded p-4 space-y-2 text-xs">
                <div className="flex justify-between font-mono text-vms-text">
                  <span className="text-vms-muted">Archive Format:</span>
                  <span>VIGILONE_BACKUP_V1</span>
                </div>
                <div className="flex justify-between font-mono text-vms-text">
                  <span className="text-vms-muted">Encryption:</span>
                  <span>AES-256-GCM + SHA-256 Checksum</span>
                </div>
                <div className="flex justify-between font-mono text-vms-text">
                  <span className="text-vms-muted">Appliance Integrity:</span>
                  <span>Tamper-Evident HMAC Verification</span>
                </div>
              </div>

              <Button
                variant="primary"
                size="md"
                onClick={handleDownloadBackup}
                disabled={downloading}
                isLoading={downloading}
                icon={Download}
                className="w-full"
              >
                {downloading ? 'Generating Encrypted Package...' : 'Download Encrypted Backup'}
              </Button>
            </div>
          ) : (
            /* Restore Tab */
            <div className="space-y-4 text-xs">
              {restoreSummary ? (
                <div className="p-4 bg-emerald-950/60 border border-emerald-500/40 rounded space-y-3">
                  <div className="flex items-center space-x-2 text-emerald-300 font-bold font-mono">
                    <CheckCircle2 className="w-5 h-5" />
                    <span>Appliance Configuration Restored Successfully!</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 font-mono text-[11px] text-vms-text bg-vms-panel/80 p-3 rounded border border-vms-border">
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
                    className="text-xs text-vms-accent hover:underline font-mono"
                  >
                    Upload Another Backup
                  </button>
                </div>
              ) : (
                <>
                  <div className="border-2 border-dashed border-vms-border rounded p-6 text-center hover:border-vms-accent transition-colors bg-vms-panel/40">
                    <Upload className="w-8 h-8 text-vms-dim mx-auto mb-2" />
                    <label className="cursor-pointer">
                      <span className="text-vms-accent font-semibold hover:underline font-mono text-xs">
                        Upload .vigilone-backup file
                      </span>
                      <input type="file" accept=".json,.vigilone-backup" onChange={handleFileUpload} className="hidden" />
                    </label>
                    <p className="text-[11px] text-vms-dim mt-1 font-mono">or paste encrypted archive JSON below</p>
                  </div>

                  <div>
                    <label className="block text-[10px] uppercase font-mono text-vms-muted mb-1 tracking-wider">
                      Backup Archive JSON
                    </label>
                    <textarea
                      rows={5}
                      placeholder='{"format": "VIGILONE_BACKUP_V1", "checksumSha256": "...", "encryptedPayload": "..."}'
                      value={restorePayloadJson}
                      onChange={(e) => setRestorePayloadJson(e.target.value)}
                      className="w-full bg-vms-surface border border-vms-border rounded p-2.5 font-mono text-[11px] text-vms-text focus:border-vms-accent focus:outline-none"
                    />
                  </div>

                  {showConfirmRestore ? (
                    <div className="p-3.5 bg-rose-950/80 border border-rose-800 rounded space-y-2">
                      <div className="flex items-center space-x-2 text-rose-300 font-bold font-mono text-xs">
                        <AlertTriangle className="w-4 h-4 text-rose-400" />
                        <span>Confirm Transactional Restore?</span>
                      </div>
                      <p className="text-[11px] text-rose-200">
                        Existing appliance settings will be overwritten transactionally. This action cannot be undone.
                      </p>
                      <div className="flex justify-end space-x-2 pt-1">
                        <Button
                          variant="secondary"
                          size="xs"
                          onClick={() => setShowConfirmRestore(false)}
                        >
                          Cancel
                        </Button>
                        <Button
                          variant="danger"
                          size="xs"
                          icon={RefreshCw}
                          onClick={handleExecuteRestore}
                          isLoading={restoring}
                        >
                          Confirm & Restore
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      variant="danger"
                      size="md"
                      onClick={handlePromptRestore}
                      disabled={restoring || !restorePayloadJson.trim()}
                      icon={RefreshCw}
                      className="w-full"
                    >
                      Verify & Execute Transactional Restore
                    </Button>
                  )}
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
