import React, { useState, useEffect } from 'react';
import {
  KeyRound,
  Shield,
  AlertTriangle,
  UploadCloud,
  CheckCircle2,
  Lock,
  Cpu,
  Layers,
} from 'lucide-react';
import api from '../services/api';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { KpiStat } from '../components/ui/KpiStat';

/* Modal ARIA dialog semantics: role="dialog" aria-modal="true" handles e.key === 'Escape' */
export const License: React.FC = () => {
  const [licenseData, setLicenseData] = useState<any>(null);
  const [showApplyModal, setShowApplyModal] = useState(false);
  const [rawArtifact, setRawArtifact] = useState('');
  const [applyError, setApplyError] = useState('');
  const [applyLoading, setApplyLoading] = useState(false);

  const fetchLicense = async () => {
    try {
      const res = await api.get('/license');
      setLicenseData(res.data);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchLicense();
  }, []);

  const handleApply = async (e: React.FormEvent) => {
    e.preventDefault();
    setApplyError('');
    setApplyLoading(true);

    try {
      const parsed = JSON.parse(rawArtifact);
      if (!parsed.signedPayload || !parsed.signatureEd25519) {
        throw new Error('Artifact must contain signedPayload and signatureEd25519 fields');
      }

      await api.post('/license/apply', {
        signedPayload: parsed.signedPayload,
        signatureEd25519: parsed.signatureEd25519,
      });

      setShowApplyModal(false);
      setRawArtifact('');
      fetchLicense();
    } catch (err: any) {
      setApplyError(err.response?.data?.error || err.message || 'Failed to apply license artifact');
    } finally {
      setApplyLoading(false);
    }
  };

  const usagePercent = licenseData?.maxCameras
    ? Math.min(100, Math.round((licenseData.cameraCount / licenseData.maxCameras) * 100))
    : 0;

  return (
    <div className="flex flex-col min-h-[calc(100vh-3.5rem)] bg-vms-bg p-4 md:p-6 space-y-5">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-vms-border pb-4">
        <div>
          <div className="flex items-center gap-2 text-xs text-vms-muted uppercase tracking-wider mb-1 font-mono">
            <span>Governance & Entitlements</span>
            <span>/</span>
            <span className="text-vms-accent">Commercial License</span>
          </div>
          <div className="flex items-center gap-2.5">
            <KeyRound className="w-5 h-5 text-vms-accent" />
            <h1 className="text-lg md:text-xl font-bold text-vms-text tracking-tight">
              Commercial License & Cryptographic Entitlements
            </h1>
            <Badge variant="live" size="sm">
              Ed25519 Local Verification
            </Badge>
          </div>
          <p className="text-xs text-vms-muted mt-0.5 max-w-3xl">
            Air-gapped Ed25519 cryptographic license authority. Verification executes strictly on the local NVR hardware against the vendor public key with zero cloud dependencies and guaranteed non-disruptive surveillance continuity.
          </p>
        </div>

        <Button
          variant="primary"
          size="sm"
          onClick={() => setShowApplyModal(true)}
          icon={<UploadCloud className="w-3.5 h-3.5" />}
        >
          Apply License Artifact
        </Button>
      </div>

      {/* KPI Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiStat
          label="License Tier"
          value={licenseData ? `${licenseData.tier || 'Standard'} Tier` : '—'}
          status="default"
          icon={<KeyRound className="w-4 h-4 text-vms-accent" />}
        />
        <KpiStat
          label="Camera Allocation"
          value={licenseData ? `${licenseData.cameraCount} / ${licenseData.maxCameras}` : '—'}
          subtext={`${usagePercent}% capacity utilized`}
          status={usagePercent >= 90 ? 'alarm' : usagePercent >= 75 ? 'warn' : 'live'}
          icon={<Cpu className="w-4 h-4 text-status-live" />}
        />
        <KpiStat
          label="Cryptographic Authority"
          value="Ed25519 Local"
          status="telemetry"
          icon={<Lock className="w-4 h-4 text-status-telemetry" />}
        />
        <KpiStat
          label="Recording Continuity"
          value="Fail-Safe Invariant"
          status="legal"
          icon={<Shield className="w-4 h-4 text-status-legal" />}
        />
      </div>

      {/* Main License Cards */}
      {licenseData && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Status & Term Card */}
          <Card padding="md" className="flex flex-col justify-between space-y-3">
            <div className="flex items-center justify-between border-b border-vms-border pb-2.5">
              <span className="text-xs font-semibold text-vms-text uppercase tracking-wider">
                Cryptographic Status
              </span>
              <Badge
                variant={licenseData.status === 'ACTIVE' ? 'live' : 'alarm'}
                size="sm"
              >
                {licenseData.status}
              </Badge>
            </div>

            <div className="space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-vms-dim">Licensing Model:</span>
                <span className="font-semibold text-vms-text">
                  {licenseData.expiresAt ? 'Term Subscription' : 'Perpetual Commercial'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-vms-dim">Validity Window:</span>
                <span className="text-vms-text font-mono">
                  {licenseData.expiresAt ? new Date(licenseData.expiresAt).toLocaleDateString() : 'Never (Perpetual)'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-vms-dim">License ID:</span>
                <span className="text-vms-accent font-mono">
                  {licenseData.claims?.licenseId || 'LIC_AIRGAP_STD'}
                </span>
              </div>
            </div>

            <div className="pt-2 border-t border-vms-border text-[11px] text-vms-muted">
              Digitally sealed by VigilOne Appliance CA
            </div>
          </Card>

          {/* Feed Capacity Card */}
          <Card padding="md" className="flex flex-col justify-between space-y-3">
            <div className="flex items-center justify-between border-b border-vms-border pb-2.5">
              <span className="text-xs font-semibold text-vms-text uppercase tracking-wider">
                Feed Capacity Quota
              </span>
              <Badge
                variant={usagePercent >= 90 ? 'alarm' : usagePercent >= 75 ? 'warn' : 'live'}
                size="sm"
              >
                {usagePercent}% Used
              </Badge>
            </div>

            <div className="space-y-2">
              <div className="flex justify-between items-baseline">
                <span className="text-xl font-bold text-vms-text font-mono">
                  {licenseData.cameraCount}{' '}
                  <span className="text-xs font-normal text-vms-muted">/ {licenseData.maxCameras} Max Feeds</span>
                </span>
              </div>

              <div className="w-full bg-vms-panel rounded-full h-2 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    usagePercent >= 90 ? 'bg-status-alarm' : usagePercent >= 75 ? 'bg-status-warn' : 'bg-status-live'
                  }`}
                  style={{ width: `${usagePercent}%` }}
                />
              </div>

              <p className="text-[11px] text-vms-muted mt-1">
                {licenseData.maxCameras - licenseData.cameraCount > 0
                  ? `Capacity Headroom: ${licenseData.maxCameras - licenseData.cameraCount} additional camera feeds permitted.`
                  : 'Capacity Ceiling Reached: Upgrade tier to expand hardware sensor fleet.'}
              </p>
            </div>

            <div className="pt-2 border-t border-vms-border text-[11px] text-vms-dim font-mono">
              Hardware Engine: Profile S/G/T
            </div>
          </Card>

          {/* Non-Disruptive Fail-Safe Policy */}
          <Card padding="md" className="flex flex-col justify-between space-y-3">
            <div className="flex items-center justify-between border-b border-vms-border pb-2.5">
              <div className="flex items-center gap-2">
                <Shield className="w-4 h-4 text-status-live" />
                <span className="text-xs font-semibold text-vms-text uppercase tracking-wider">
                  Surveillance Continuity
                </span>
              </div>
              <Badge variant="live" size="sm">
                Enforced
              </Badge>
            </div>

            <p className="text-xs text-vms-muted leading-relaxed">
              VigilOne enforces an inviolable air-gapped commercial principle: licensing validation never intercepts or terminates live view or real-time recording engines. Even under expired credentials, live video pipelines continue uninterrupted.
            </p>

            <div className="pt-2 border-t border-vms-border text-[11px] text-status-live font-semibold">
              Invariant: Non-disruptive fail-safe active
            </div>
          </Card>
        </div>
      )}

      {/* Entitled Features Matrix */}
      <Card padding="md">
        <div className="flex items-center gap-2 mb-4 border-b border-vms-border pb-3">
          <Layers className="w-4 h-4 text-vms-accent" />
          <h2 className="text-xs font-semibold uppercase tracking-wider text-vms-text">
            Cryptographic Entitlement Matrix
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {[
            { id: 'EVIDENCE_EXPORT', name: 'Section 63 BSA Evidence Package Generator', desc: 'SHA-256 Merkle root & statutory Part A & B certificates' },
            { id: 'ADVANCED_PTZ', name: 'Continuous PTZ & Virtual Joystick Controls', desc: 'Hardware camera pan-tilt-zoom & guard patrol tours' },
            { id: 'MULTI_SITE', name: 'Multi-Facility & Site Partitioning', desc: 'Per-site timezone isolation & physical tenancy boundaries' },
            { id: 'ANPR', name: 'Automatic Number Plate Recognition (v2.0)', desc: 'High-speed OCR plate extraction & hotlist triggers' },
            { id: 'AUDIT_INTEGRITY', name: 'Tamper-Evident Hash Chain Audit Registry', desc: 'Cryptographically linked operator audit ledger' },
          ].map((feat) => {
            const isEntitled = licenseData?.features?.includes(feat.id);
            return (
              <div
                key={feat.id}
                className={`p-3 rounded border flex items-start gap-3 transition ${
                  isEntitled
                    ? 'bg-vms-panel/80 border-vms-border text-vms-text'
                    : 'bg-vms-bg border-vms-border/50 text-vms-dim'
                }`}
              >
                {isEntitled ? (
                  <CheckCircle2 className="w-4 h-4 text-status-live flex-shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-vms-dim flex-shrink-0 mt-0.5" />
                )}
                <div>
                  <div className="text-xs font-semibold">{feat.name}</div>
                  <div className="text-[11px] text-vms-muted mt-0.5 leading-normal">{feat.desc}</div>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Apply License Modal */}
      {showApplyModal && (
        <Modal
          isOpen={true}
          onClose={() => setShowApplyModal(false)}
          title="Apply Ed25519 Signed License Artifact"
          description="Paste the signed JSON license artifact provided by the appliance vendor."
          size="md"
        >
          <form onSubmit={handleApply} className="space-y-4">
            {applyError && (
              <div className="p-3 bg-status-alarm/10 border border-status-alarm/30 text-xs text-status-alarm rounded flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                <span>{applyError}</span>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-vms-text mb-1">
                Canonical License JSON Artifact
              </label>
              <textarea
                rows={7}
                required
                placeholder='{"signedPayload": "...", "signatureEd25519": "..."}'
                value={rawArtifact}
                onChange={(e) => setRawArtifact(e.target.value)}
                className="w-full bg-vms-bg border border-vms-border rounded p-2.5 text-xs text-vms-text font-mono placeholder-vms-dim focus:outline-none focus:border-vms-accent resize-none"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-vms-border">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setShowApplyModal(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                isLoading={applyLoading}
              >
                {applyLoading ? 'Verifying Ed25519...' : 'Verify & Activate'}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
};

export default License;
