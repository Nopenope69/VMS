import React, { useState, useEffect } from 'react';
import { KeyRound, Shield, CheckCircle, AlertTriangle, UploadCloud } from 'lucide-react';
import api from '../services/api';

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
    <div className="flex flex-col h-[calc(100vh-3.5rem)] bg-graphite-900 p-4 space-y-4 overflow-y-auto">
      {/* Top Header */}
      <div className="bg-graphite-850 p-4 rounded border border-graphite-700 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center space-x-2">
            <KeyRound className="w-5 h-5 text-cctv-amber" />
            <h2 className="text-sm font-semibold text-slate-100 uppercase tracking-wider">
              Commercial License & Entitlements
            </h2>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Offline Ed25519 cryptographic license authority. Verification is strictly local against the root vendor public key with non-disruptive surveillance continuity guarantees.
          </p>
        </div>

        <button
          onClick={() => setShowApplyModal(true)}
          className="flex items-center space-x-1.5 px-3 py-1.5 rounded text-xs font-semibold bg-cctv-amber text-graphite-900 hover:bg-amber-400 transition shadow-sm"
        >
          <UploadCloud className="w-3.5 h-3.5" />
          <span>Apply License Artifact</span>
        </button>
      </div>

      {/* Main License Card */}
      {licenseData && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Status & Tier */}
          <div className="bg-graphite-850 p-4 rounded border border-graphite-700 space-y-3">
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">License Status</div>
            <div className="flex items-center space-x-2">
              <span
                className={`px-2.5 py-1 rounded text-xs font-bold font-mono tracking-wider ${
                  licenseData.status === 'ACTIVE'
                    ? 'bg-emerald-950 text-emerald-300 border border-emerald-700'
                    : 'bg-rose-950 text-rose-300 border border-rose-700'
                }`}
              >
                {licenseData.status}
              </span>
              <span className="px-2.5 py-1 rounded text-xs font-bold font-mono bg-graphite-700 text-cctv-teal">
                {licenseData.tier} TIER
              </span>
            </div>

            <div className="text-xs font-mono text-slate-400 space-y-1 pt-2 border-t border-graphite-700">
              <div>Type: {licenseData.expiresAt ? 'Term Subscription' : 'Perpetual Commercial'}</div>
              <div>Expires: {licenseData.expiresAt ? new Date(licenseData.expiresAt).toLocaleDateString() : 'Never'}</div>
              <div>License ID: {licenseData.claims?.licenseId || 'N/A'}</div>
            </div>
          </div>

          {/* Camera Capacity Gauge */}
          <div className="bg-graphite-850 p-4 rounded border border-graphite-700 space-y-3">
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Camera Quota</div>
            <div className="flex justify-between items-baseline">
              <span className="text-2xl font-bold font-mono text-white">
                {licenseData.cameraCount}{' '}
                <span className="text-xs font-normal text-slate-400">/ {licenseData.maxCameras} Limit</span>
              </span>
              <span className="text-xs font-mono text-cctv-amber">{usagePercent}% Used</span>
            </div>

            {/* Progress Bar */}
            <div className="w-full h-2.5 bg-graphite-900 rounded-full overflow-hidden border border-graphite-700">
              <div
                className={`h-full transition-all ${
                  usagePercent >= 90 ? 'bg-rose-500' : usagePercent >= 75 ? 'bg-amber-500' : 'bg-cctv-teal'
                }`}
                style={{ width: `${usagePercent}%` }}
              />
            </div>

            <p className="text-[11px] text-slate-400">
              {licenseData.maxCameras - licenseData.cameraCount > 0
                ? `${licenseData.maxCameras - licenseData.cameraCount} additional camera slots available.`
                : 'Quota reached. Upgrade required to onboard additional cameras.'}
            </p>
          </div>

          {/* Non-Disruptive Policy Guarantee */}
          <div className="bg-graphite-850 p-4 rounded border border-graphite-700 space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center space-x-1.5">
              <Shield className="w-4 h-4 text-cctv-teal" />
              <span>Surveillance Continuity</span>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              VigilOne enforces an inviolable commercial invariant: licensing checks never intercept live view or recording pipelines. Even in an expired state, existing video and live surveillance remain operational.
            </p>
          </div>
        </div>
      )}

      {/* Entitled Features Matrix */}
      <div className="bg-graphite-850 rounded border border-graphite-700 p-4">
        <div className="text-xs font-semibold uppercase tracking-wider text-slate-300 mb-3">
          Entitled Feature Matrix
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {[
            { id: 'EVIDENCE_EXPORT', name: 'Section 63 BSA Evidence Package Generator', desc: 'SHA-256 manifests & statutory Part A & B PDFs' },
            { id: 'ADVANCED_PTZ', name: 'Continuous PTZ & Virtual Joystick Controls', desc: 'Real-time camera movement & optical zoom' },
            { id: 'MULTI_SITE', name: 'Multi-Facility & Site Management', desc: 'Per-site timezones & physical tenancy boundaries' },
            { id: 'ANPR', name: 'Automatic Number Plate Recognition (Phase 4)', desc: 'Indian state vehicle registration extraction' },
            { id: 'AUDIT_INTEGRITY', name: 'Tamper-Evident Hash Chain Audit Registry', desc: 'Cryptographically linked operator audit trail' },
          ].map((feat) => {
            const isEntitled = licenseData?.features?.includes(feat.id);
            return (
              <div
                key={feat.id}
                className={`p-3 rounded border flex items-start space-x-2.5 ${
                  isEntitled
                    ? 'bg-graphite-900 border-graphite-700 text-slate-200'
                    : 'bg-graphite-900/40 border-graphite-800 text-slate-500 opacity-60'
                }`}
              >
                {isEntitled ? (
                  <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-slate-600 flex-shrink-0 mt-0.5" />
                )}
                <div>
                  <div className="text-xs font-semibold">{feat.name}</div>
                  <div className="text-[11px] text-slate-400 mt-0.5">{feat.desc}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Apply License Modal */}
      {showApplyModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50 backdrop-blur-sm">
          <div className="bg-graphite-850 border border-graphite-700 rounded-md w-full max-w-lg overflow-hidden shadow-2xl">
            <div className="px-5 py-4 border-b border-graphite-700 flex justify-between items-center bg-graphite-800">
              <h3 className="text-sm font-semibold text-slate-100 uppercase tracking-wider font-mono">
                Apply Signed License Artifact
              </h3>
              <button onClick={() => setShowApplyModal(false)} className="text-slate-400 hover:text-white">✕</button>
            </div>

            <form onSubmit={handleApply} className="p-5 space-y-3.5">
              {applyError && (
                <div className="p-2.5 bg-red-900/40 border border-red-500 rounded text-xs text-red-200 flex items-center space-x-2">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                  <span>{applyError}</span>
                </div>
              )}

              <div>
                <label className="block text-xs font-mono text-slate-300 mb-1">
                  Paste Canonical License JSON Artifact
                </label>
                <textarea
                  rows={8}
                  required
                  placeholder='{"signedPayload": "...", "signatureEd25519": "..."}'
                  value={rawArtifact}
                  onChange={(e) => setRawArtifact(e.target.value)}
                  className="w-full bg-graphite-900 border border-graphite-700 rounded p-2.5 text-xs text-slate-200 font-mono focus:outline-none focus:border-cctv-amber"
                />
              </div>

              <div className="flex justify-end space-x-2 pt-3 border-t border-graphite-700">
                <button
                  type="button"
                  onClick={() => setShowApplyModal(false)}
                  className="px-4 py-1.5 rounded text-xs text-slate-300 hover:bg-graphite-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={applyLoading}
                  className="px-4 py-1.5 rounded text-xs font-semibold bg-cctv-amber text-graphite-900 hover:bg-amber-400 disabled:opacity-50"
                >
                  {applyLoading ? 'Verifying Ed25519...' : 'Verify & Activate'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default License;
