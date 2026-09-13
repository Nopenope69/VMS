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
    <div className="flex flex-col h-[calc(100vh-3.5rem)] bg-[#080B10] p-4 space-y-3 overflow-y-auto font-mono text-[#C9D1D9]">
      {/* Top Header */}
      <div className="bg-[#0D1117] p-3.5 border border-[#21262D] flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center space-x-2">
            <KeyRound className="w-5 h-5 text-[#E3B341]" />
            <h2 className="text-sm font-bold text-[#C9D1D9] uppercase tracking-wider">
              [ COMMERCIAL LICENSE & CRYPTOGRAPHIC ENTITLEMENTS ]
            </h2>
            <span className="text-[10px] bg-[#161B22] text-[#3FB950] border border-[#238636] px-1.5 py-0.5 font-bold">
              ED25519 LOCAL VERIFICATION
            </span>
          </div>
          <p className="text-[11px] text-[#8B949E] mt-1 max-w-4xl leading-relaxed">
            Offline Ed25519 cryptographic license authority. Verification executes strictly on the local NVR hardware against the vendor public key with zero cloud dependencies and guaranteed non-disruptive surveillance continuity.
          </p>
        </div>

        <button
          onClick={() => setShowApplyModal(true)}
          className="flex items-center space-x-1.5 px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-[#E3B341] text-[#080B10] hover:bg-[#F2CC60] transition-colors shadow-none"
        >
          <UploadCloud className="w-3.5 h-3.5" />
          <span>[ APPLY LICENSE ARTIFACT ]</span>
        </button>
      </div>

      {/* Main License Cards */}
      {licenseData && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* Status & Tier */}
          <div className="bg-[#0D1117] p-3.5 border border-[#21262D] flex flex-col justify-between space-y-2.5">
            <div className="text-[10px] uppercase tracking-wider text-[#8B949E]">CRYPTOGRAPHIC_STATUS:</div>
            <div className="flex items-center space-x-2">
              <span
                className={`px-2 py-0.5 text-xs font-bold uppercase tracking-wider border ${
                  licenseData.status === 'ACTIVE'
                    ? 'bg-[#080B10] text-[#3FB950] border-[#238636]'
                    : 'bg-[#080B10] text-[#F85149] border-[#F85149]'
                }`}
              >
                [{licenseData.status}]
              </span>
              <span className="px-2 py-0.5 text-xs font-bold uppercase bg-[#161B22] text-[#58A6FF] border border-[#30363D]">
                {licenseData.tier} TIER
              </span>
            </div>

            <div className="text-xs text-[#8B949E] space-y-1 pt-2 border-t border-[#21262D]">
              <div>TYPE: {licenseData.expiresAt ? 'TERM SUBSCRIPTION' : 'PERPETUAL AIR-GAPPED COMMERCIAL'}</div>
              <div>EXPIRATION: {licenseData.expiresAt ? new Date(licenseData.expiresAt).toLocaleDateString() : 'NEVER (PERPETUAL)'}</div>
              <div>LICENSE_ID: <span className="text-[#C9D1D9]">{licenseData.claims?.licenseId || 'N/A'}</span></div>
            </div>
          </div>

          {/* Camera Capacity Gauge */}
          <div className="bg-[#0D1117] p-3.5 border border-[#21262D] flex flex-col justify-between space-y-2.5">
            <div className="text-[10px] uppercase tracking-wider text-[#8B949E]">FEED_CAPACITY_QUOTA:</div>
            <div className="flex justify-between items-baseline">
              <span className="text-xl font-bold text-white">
                {licenseData.cameraCount}{' '}
                <span className="text-xs font-normal text-[#8B949E]">/ {licenseData.maxCameras} MAX FEEDS</span>
              </span>
              <span className="text-xs font-bold text-[#E3B341]">[{usagePercent}% USED]</span>
            </div>

            {/* Segmented Progress Bar */}
            <div className="w-full h-2 bg-[#080B10] border border-[#30363D] p-0.5">
              <div
                className={`h-full transition-all ${
                  usagePercent >= 90 ? 'bg-[#F85149]' : usagePercent >= 75 ? 'bg-[#E3B341]' : 'bg-[#3FB950]'
                }`}
                style={{ width: `${usagePercent}%` }}
              />
            </div>

            <p className="text-[10px] text-[#8B949E]">
              {licenseData.maxCameras - licenseData.cameraCount > 0
                ? `[ CAPACITY HEADROOM: ${licenseData.maxCameras - licenseData.cameraCount} ADDITIONAL FEEDS ]`
                : '[ CAPACITY CEILING: UPGRADE TIER TO EXPAND SENSOR FLEET ]'}
            </p>
          </div>

          {/* Non-Disruptive Policy Guarantee */}
          <div className="bg-[#0D1117] p-3.5 border border-[#21262D] flex flex-col justify-between space-y-2">
            <div className="text-[10px] uppercase tracking-wider text-[#8B949E] flex items-center space-x-1.5">
              <Shield className="w-3.5 h-3.5 text-[#58A6FF]" />
              <span>FAIL-SAFE SURVEILLANCE CONTINUITY</span>
            </div>
            <p className="text-[11px] text-[#8B949E] leading-relaxed">
              VigilOne enforces an inviolable air-gapped commercial principle: licensing validation never intercepts or terminates live view or real-time recording engines. Even under expired credentials, live video pipelines continue uninterrupted.
            </p>
            <div className="text-[10px] text-[#3FB950] font-bold">
              INVARIANT: NON-DISRUPTIVE FAIL-SAFE ACTIVE
            </div>
          </div>
        </div>
      )}

      {/* Entitled Features Matrix */}
      <div className="bg-[#0D1117] border border-[#21262D] flex flex-col p-3.5">
        <div className="text-xs font-bold uppercase tracking-wider text-[#C9D1D9] mb-3 pb-2 border-b border-[#21262D]">
          CRYPTOGRAPHIC ENTITLEMENT MATRIX
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5">
          {[
            { id: 'EVIDENCE_EXPORT', name: 'Section 63 BSA Evidence Package Generator', desc: 'SHA-256 Merkle root & statutory Part A & B certificates' },
            { id: 'ADVANCED_PTZ', name: 'Continuous PTZ & Virtual Joystick Controls', desc: 'Hardware camera pan-tilt-zoom & patrol tours' },
            { id: 'MULTI_SITE', name: 'Multi-Facility & Site Partitioning', desc: 'Per-site timezone isolation & physical tenancy boundaries' },
            { id: 'ANPR', name: 'Automatic Number Plate Recognition (Phase 4)', desc: 'High-speed OCR plate extraction & hotlist triggers' },
            { id: 'AUDIT_INTEGRITY', name: 'Tamper-Evident Hash Chain Audit Registry', desc: 'Cryptographically linked operator audit ledger' },
          ].map((feat) => {
            const isEntitled = licenseData?.features?.includes(feat.id);
            return (
              <div
                key={feat.id}
                className={`p-2.5 border flex items-start space-x-2.5 ${
                  isEntitled
                    ? 'bg-[#161B22] border-[#21262D] text-[#C9D1D9]'
                    : 'bg-[#080B10] border-[#21262D] text-[#484F58]'
                }`}
              >
                {isEntitled ? (
                  <CheckCircle className="w-4 h-4 text-[#3FB950] flex-shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-[#484F58] flex-shrink-0 mt-0.5" />
                )}
                <div>
                  <div className="text-xs font-bold">{feat.name}</div>
                  <div className="text-[10px] text-[#8B949E] mt-0.5">{feat.desc}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Apply License Modal */}
      {showApplyModal && (
        <div className="fixed inset-0 bg-black/85 flex items-center justify-center p-4 z-50 font-mono">
          <div className="bg-[#0D1117] border border-[#30363D] rounded-none w-full max-w-lg overflow-hidden shadow-2xl">
            <div className="px-4 py-3 border-b border-[#21262D] flex justify-between items-center bg-[#161B22]">
              <h3 className="text-xs font-bold text-[#C9D1D9] uppercase tracking-wider">
                [ APPLY ED25519 SIGNED LICENSE ARTIFACT ]
              </h3>
              <button
                onClick={() => setShowApplyModal(false)}
                className="text-[#8B949E] hover:text-white text-xs px-2 py-0.5 border border-[#30363D] hover:bg-[#21262D]"
              >
                [ X ]
              </button>
            </div>

            <form onSubmit={handleApply} className="p-4 space-y-3 text-xs">
              {applyError && (
                <div className="p-2.5 bg-[#080B10] border border-[#F85149] text-xs text-[#F85149] flex items-center space-x-2">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                  <span>{applyError}</span>
                </div>
              )}

              <div>
                <label className="block text-[10px] uppercase text-[#8B949E] mb-1">
                  CANONICAL_LICENSE_JSON_ARTIFACT:
                </label>
                <textarea
                  rows={8}
                  required
                  placeholder='{"signedPayload": "...", "signatureEd25519": "..."}'
                  value={rawArtifact}
                  onChange={(e) => setRawArtifact(e.target.value)}
                  className="w-full bg-[#080B10] border border-[#30363D] p-2 text-xs text-[#C9D1D9] focus:outline-none focus:border-[#E3B341]"
                />
              </div>

              <div className="flex justify-end space-x-2 pt-2 border-t border-[#21262D]">
                <button
                  type="button"
                  onClick={() => setShowApplyModal(false)}
                  className="px-3 py-1.5 bg-[#161B22] hover:bg-[#21262D] border border-[#30363D] text-[#8B949E] hover:text-[#C9D1D9] uppercase font-bold text-xs"
                >
                  [ CANCEL ]
                </button>
                <button
                  type="submit"
                  disabled={applyLoading}
                  className="px-4 py-1.5 bg-[#E3B341] text-[#080B10] hover:bg-[#F2CC60] uppercase font-bold text-xs disabled:opacity-50"
                >
                  {applyLoading ? '[ VERIFYING ED25519... ]' : '[ VERIFY & ACTIVATE ]'}
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
