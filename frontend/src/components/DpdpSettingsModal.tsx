import React, { useState, useEffect } from 'react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { ShieldCheck, Trash2, AlertTriangle, CheckCircle, Info } from 'lucide-react';
import api from '../services/api';

interface DpdpSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const DpdpSettingsModal: React.FC<DpdpSettingsModalProps> = ({ isOpen, onClose }) => {
  const [, setSettings] = useState<any>(null);
  const [purposes, setPurposes] = useState<string[]>([]);
  const [needReference, setNeedReference] = useState<string[]>([]);
  const [faceProcessingEnabled, setFaceProcessingEnabled] = useState(false);
  const [faceAck, setFaceAck] = useState(false);
  const [retentionDays, setRetentionDays] = useState(30);
  const [allowedPurposes, setAllowedPurposes] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [purging, setPurging] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fetchSettings = async () => {
    setLoading(true);
    setStatusMessage(null);
    try {
      const res = await api.get('/privacy/dpdp/settings');
      const s = res.data.settings || {};
      setSettings(s);
      setPurposes(res.data.purposes || []);
      setNeedReference(res.data.needReference || []);
      setFaceProcessingEnabled(!!s.faceProcessingEnabled);
      setRetentionDays(s.retentionDays || 30);
      setAllowedPurposes(s.allowedPurposes || []);
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err.response?.data?.error || err.message || 'Failed to load DPDP settings' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchSettings();
    }
  }, [isOpen]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setStatusMessage(null);

    try {
      await api.put('/privacy/dpdp/settings', {
        faceProcessingEnabled,
        faceAcknowledgement: faceProcessingEnabled ? faceAck : undefined,
        retentionDays,
        allowedPurposes,
      });
      setStatusMessage({ type: 'success', text: 'DPDP compliance settings updated successfully.' });
      setTimeout(() => {
        fetchSettings();
      }, 1000);
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err.response?.data?.error || err.message || 'Failed to save settings' });
    } finally {
      setSaving(false);
    }
  };

  const handlePurge = async () => {
    if (!window.confirm('Execute immediate statutory retention purge? Expired ANPR reads and temporary files older than the retention threshold will be permanently deleted.')) {
      return;
    }

    setPurging(true);
    setStatusMessage(null);
    try {
      const res = await api.post('/privacy/dpdp/purge');
      setStatusMessage({
        type: 'success',
        text: `Purge executed: ${res.data.deletedObservations || 0} reads deleted, ${res.data.deletedFiles || 0} files purged.`,
      });
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err.response?.data?.error || err.message || 'Purge failed' });
    } finally {
      setPurging(false);
    }
  };

  const togglePurpose = (p: string) => {
    setAllowedPurposes((prev) =>
      prev.includes(p) ? prev.filter((item) => item !== p) : [...prev, p]
    );
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="DPDP Act 2023 Statutory Privacy Controls"
      description="Configure purpose limitation, biometric face processing consent, and retention purge rules under the Digital Personal Data Protection Act, 2023."
      size="lg"
    >
      {loading ? (
        <div className="p-8 text-center text-xs font-mono text-vms-muted">Loading DPDP settings...</div>
      ) : (
        <form onSubmit={handleSave} className="space-y-4">
          {statusMessage && (
            <div
              className={`p-3 rounded text-xs flex items-center gap-2 ${
                statusMessage.type === 'success'
                  ? 'bg-emerald-950/40 border border-emerald-500/50 text-emerald-200'
                  : 'bg-red-950/40 border border-red-500/50 text-red-200'
              }`}
            >
              {statusMessage.type === 'success' ? (
                <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />
              ) : (
                <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
              )}
              <span>{statusMessage.text}</span>
            </div>
          )}

          {/* Face Processing Switch */}
          <div className="bg-vms-panel p-3.5 rounded border border-vms-border space-y-2.5">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs font-bold text-vms-text font-mono uppercase tracking-wide block">
                  Biometric Face Analytics & Redaction
                </span>
                <span className="text-[11px] text-vms-muted block mt-0.5">
                  DPDP Section 4 lawful processing switch. Disabling immediately halts camera face detection and YuNet redaction.
                </span>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={faceProcessingEnabled}
                  onChange={(e) => {
                    setFaceProcessingEnabled(e.target.checked);
                    if (!e.target.checked) setFaceAck(false);
                  }}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-vms-surface border border-vms-border peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-vms-text after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-vms-accent" />
              </label>
            </div>

            {faceProcessingEnabled && (
              <div className="p-2.5 bg-amber-950/30 border border-amber-500/40 rounded space-y-2 mt-2">
                <div className="flex items-start gap-2 text-xs text-amber-200">
                  <Info className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <span>
                    Statutory Attestation: Enabling biometric face processing requires confirmation that your organization has established a lawful ground for processing under Section 4 / 6 of the DPDP Act, 2023.
                  </span>
                </div>
                <label className="flex items-center gap-2 text-xs text-vms-text cursor-pointer pt-1">
                  <input
                    type="checkbox"
                    checked={faceAck}
                    onChange={(e) => setFaceAck(e.target.checked)}
                    className="rounded border-vms-border text-vms-accent focus:ring-0 bg-vms-bg"
                    required
                  />
                  <span className="font-semibold text-amber-300">
                    I acknowledge and confirm lawful basis for biometric face processing.
                  </span>
                </label>
              </div>
            )}
          </div>

          {/* Retention Period & Purge */}
          <div className="bg-vms-panel p-3.5 rounded border border-vms-border space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs font-bold text-vms-text font-mono uppercase tracking-wide block">
                  ANPR & Forensic Data Retention
                </span>
                <span className="text-[11px] text-vms-muted block mt-0.5">
                  Maximum storage lifespan for plate queries and telemetry before automated purge.
                </span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={retentionDays}
                  onChange={(e) => setRetentionDays(parseInt(e.target.value) || 30)}
                  className="w-20 bg-vms-bg border border-vms-border rounded px-2.5 py-1 text-xs text-vms-text font-mono text-center focus:border-vms-accent focus:outline-none"
                />
                <span className="text-xs text-vms-muted font-mono">Days</span>
              </div>
            </div>

            <div className="pt-2 border-t border-vms-border flex items-center justify-between">
              <span className="text-[11px] text-vms-dim">
                Statutory Purge Engine: Permanently removes expired reads not held under active legal pin.
              </span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handlePurge}
                isLoading={purging}
                icon={<Trash2 className="w-3.5 h-3.5 text-red-400" />}
              >
                Trigger Purge Now
              </Button>
            </div>
          </div>

          {/* Purpose Limitation */}
          <div className="bg-vms-panel p-3.5 rounded border border-vms-border space-y-2">
            <span className="text-xs font-bold text-vms-text font-mono uppercase tracking-wide block">
              Allowed Operational Purposes (Purpose Specification)
            </span>
            <span className="text-[11px] text-vms-muted block">
              Operators must select from authorized purposes during forensic searches and evidence exports.
            </span>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
              {purposes.map((p) => {
                const checked = allowedPurposes.includes(p);
                const needsRef = needReference.includes(p);
                return (
                  <label
                    key={p}
                    className={`flex items-start gap-2 p-2 rounded border cursor-pointer text-xs font-mono transition-colors ${
                      checked
                        ? 'border-vms-accent/60 bg-vms-accent/10 text-vms-text'
                        : 'border-vms-border bg-vms-bg text-vms-muted hover:text-vms-text'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => togglePurpose(p)}
                      className="mt-0.5 rounded border-vms-border text-vms-accent focus:ring-0 bg-vms-bg"
                    />
                    <div>
                      <div className="font-medium">{p}</div>
                      {needsRef && (
                        <div className="text-[10px] text-amber-400 mt-0.5">
                          Requires statutory reference / incident ID
                        </div>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-vms-border">
            <Button variant="secondary" type="button" onClick={onClose} disabled={saving || purging}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" isLoading={saving} icon={<ShieldCheck className="w-3.5 h-3.5" />}>
              Save Compliance Policy
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
};
export default DpdpSettingsModal;
