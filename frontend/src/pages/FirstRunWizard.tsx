import React, { useState } from 'react';
import {
  Radio,
  ShieldCheck,
  KeyRound,
  Building2,
  Clock,
  UserCheck,
  Lock,
  Mail,
  Download,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  ChevronLeft,
  Server,
  FileCheck,
  Terminal,
} from 'lucide-react';
import api from '../services/api';

interface FirstRunWizardProps {
  onBootstrapComplete: (user: any, token: string) => void;
  onSwitchToLogin?: () => void;
}

const COMMON_TIMEZONES = [
  { value: 'UTC', label: 'UTC (Coordinated Universal Time)' },
  { value: 'America/New_York', label: 'America/New_York (Eastern Time - UTC-5/UTC-4)' },
  { value: 'America/Chicago', label: 'America/Chicago (Central Time - UTC-6/UTC-5)' },
  { value: 'America/Denver', label: 'America/Denver (Mountain Time - UTC-7/UTC-6)' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles (Pacific Time - UTC-8/UTC-7)' },
  { value: 'Europe/London', label: 'Europe/London (GMT/BST - UTC+0/UTC+1)' },
  { value: 'Europe/Paris', label: 'Europe/Paris (CET/CEST - UTC+1/UTC+2)' },
  { value: 'Asia/Dubai', label: 'Asia/Dubai (GST - UTC+4)' },
  { value: 'Asia/Kolkata', label: 'Asia/Kolkata (IST - UTC+5:30)' },
  { value: 'Asia/Singapore', label: 'Asia/Singapore (SGT - UTC+8)' },
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo (JST - UTC+9)' },
  { value: 'Australia/Sydney', label: 'Australia/Sydney (AEST/AEDT - UTC+10/UTC+11)' },
];

export const FirstRunWizard: React.FC<FirstRunWizardProps> = ({
  onBootstrapComplete,
  onSwitchToLogin,
}) => {
  const [currentStep, setCurrentStep] = useState<number>(1);

  // Step 1: PIN
  const [setupToken, setSetupToken] = useState('');

  // Step 2: Facility / Regional
  const [facilityName, setFacilityName] = useState('');
  const [timezone, setTimezone] = useState('UTC');

  // Step 3: Super Admin
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // Step 4: CA Trust acknowledged
  const [caAcknowledged, setCaAcknowledged] = useState(false);
  const [selectedOsTab, setSelectedOsTab] = useState<'windows' | 'mac' | 'linux' | 'browser'>('windows');

  // Request & Status state
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [alreadyBootstrapped, setAlreadyBootstrapped] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [bootstrapResult, setBootstrapResult] = useState<{ user: any; token: string } | null>(null);

  // Password Validation
  const hasMinLength = adminPassword.length >= 12;
  const hasUppercase = /[A-Z]/.test(adminPassword);
  const hasLowercase = /[a-z]/.test(adminPassword);
  const hasNumber = /[0-9]/.test(adminPassword);
  const hasSpecial = /[^A-Za-z0-9]/.test(adminPassword);
  const passwordsMatch = adminPassword === confirmPassword && adminPassword.length > 0;
  const isPasswordValid =
    hasMinLength && hasUppercase && hasLowercase && hasNumber && hasSpecial && passwordsMatch;

  const handleNext = () => {
    setErrorMessage('');
    if (currentStep === 1) {
      if (!setupToken.trim()) {
        setErrorMessage('Please enter the appliance setup PIN / token generated during installation.');
        return;
      }
      setCurrentStep(2);
    } else if (currentStep === 2) {
      if (!facilityName.trim()) {
        setErrorMessage('Please enter a facility or organization name.');
        return;
      }
      setCurrentStep(3);
    } else if (currentStep === 3) {
      if (!adminName.trim() || !adminEmail.trim()) {
        setErrorMessage('Please provide an administrator name and email address.');
        return;
      }
      if (!isPasswordValid) {
        setErrorMessage('Please ensure your password satisfies all security requirements and matches.');
        return;
      }
      setCurrentStep(4);
    }
  };

  const handleBack = () => {
    setErrorMessage('');
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleCompleteBootstrap = async () => {
    setErrorMessage('');
    setSubmitting(true);

    try {
      const res = await api.post(
        '/auth/bootstrap',
        {
          tenantName: facilityName.trim(),
          adminEmail: adminEmail.trim(),
          adminPassword,
          adminName: adminName.trim(),
          siteTimezone: timezone,
        },
        {
          headers: {
            'X-Setup-Token': setupToken.trim(),
          },
        }
      );

      const data = res.data;
      setBootstrapResult({ user: data.user, token: data.token });
      setIsSuccess(true);
    } catch (err: any) {
      if (err.response?.status === 410) {
        setAlreadyBootstrapped(true);
        setErrorMessage(
          'Appliance has already completed initial initialization. Setup cannot be re-run.'
        );
      } else if (err.response?.status === 401) {
        setErrorMessage(
          'Unauthorized: The provided Setup PIN / Token is invalid or expired. Check "sudo vigilonectl token" on appliance.'
        );
        setCurrentStep(1);
      } else {
        setErrorMessage(
          err.response?.data?.error ||
            err.message ||
            'Failed to bootstrap appliance. Verify system connectivity.'
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleLaunchConsole = () => {
    if (bootstrapResult) {
      onBootstrapComplete(bootstrapResult.user, bootstrapResult.token);
    } else if (onSwitchToLogin) {
      onSwitchToLogin();
    }
  };

  return (
    <div className="min-h-screen bg-tactical-canvas text-tactical-text font-sans flex flex-col items-center justify-center p-4 sm:p-6 selection:bg-phosphor-amber/30 relative overflow-x-hidden">
      {/* Background ambient CRT scanlines / subtle grid */}
      <div className="fixed inset-0 pointer-events-none opacity-20 bg-[radial-gradient(#1F2735_1px,transparent_1px)] [background-size:16px_16px]" />

      <div className="w-full max-w-3xl bg-tactical-panel border border-tactical-border rounded-none shadow-2xl overflow-hidden flex flex-col relative z-10">
        {/* Optical corner reticles */}
        <span className="absolute -top-1 -left-1 text-[9px] text-tactical-border-focus select-none leading-none z-20">+</span>
        <span className="absolute -top-1 -right-1 text-[9px] text-tactical-border-focus select-none leading-none z-20">+</span>
        <span className="absolute -bottom-1 -left-1 text-[9px] text-tactical-border-focus select-none leading-none z-20">+</span>
        <span className="absolute -bottom-1 -right-1 text-[9px] text-tactical-border-focus select-none leading-none z-20">+</span>

        {/* Header */}
        <div className="bg-tactical-surface border-b border-tactical-border px-6 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-9 h-9 rounded-none bg-phosphor-amber/10 border border-phosphor-amber/40 flex items-center justify-center">
              <Radio className="w-5 h-5 text-phosphor-amber" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="font-bold tracking-wider text-tactical-bright uppercase text-sm font-mono">VIGILONE VMS</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-none bg-phosphor-amber/10 text-phosphor-amber border border-phosphor-amber/30 font-mono font-bold tracking-wider">
                  FIRST-RUN COMMISSIONING
                </span>
              </div>
              <p className="text-xs text-tactical-muted font-sans mt-0.5">Zero-Terminal Onboarding & Provisioning Engine</p>
            </div>
          </div>

          <div className="text-right hidden sm:block">
            <div className="text-[10px] font-mono text-tactical-muted uppercase tracking-wider">TARGET APPLIANCE</div>
            <div className="text-xs font-mono text-phosphor-cyan font-semibold">https://vigilone.local</div>
          </div>
        </div>

        {/* Wizard Steps Bar */}
        {!isSuccess && !alreadyBootstrapped && (
          <div className="bg-tactical-canvas border-b border-tactical-border px-6 py-2.5">
            <div className="grid grid-cols-4 gap-2 text-center text-xs font-mono">
              <div
                className={`py-1.5 px-2 border transition-colors flex items-center justify-center space-x-1 ${
                  currentStep === 1
                    ? 'bg-phosphor-amber text-[#07090E] font-bold border-phosphor-amber'
                    : currentStep > 1
                    ? 'bg-phosphor-green/10 text-phosphor-green border-phosphor-green/40 font-medium'
                    : 'bg-tactical-panel text-tactical-muted border-tactical-border'
                }`}
              >
                <span className="badge-hotkey !bg-transparent !border-0 !p-0">{currentStep > 1 ? '✓' : '1'}</span>
                <span className="truncate">SETUP PIN</span>
              </div>

              <div
                className={`py-1.5 px-2 border transition-colors flex items-center justify-center space-x-1 ${
                  currentStep === 2
                    ? 'bg-phosphor-amber text-[#07090E] font-bold border-phosphor-amber'
                    : currentStep > 2
                    ? 'bg-phosphor-green/10 text-phosphor-green border-phosphor-green/40 font-medium'
                    : 'bg-tactical-panel text-tactical-muted border-tactical-border'
                }`}
              >
                <span className="badge-hotkey !bg-transparent !border-0 !p-0">{currentStep > 2 ? '✓' : '2'}</span>
                <span className="truncate">FACILITY</span>
              </div>

              <div
                className={`py-1.5 px-2 border transition-colors flex items-center justify-center space-x-1 ${
                  currentStep === 3
                    ? 'bg-phosphor-amber text-[#07090E] font-bold border-phosphor-amber'
                    : currentStep > 3
                    ? 'bg-phosphor-green/10 text-phosphor-green border-phosphor-green/40 font-medium'
                    : 'bg-tactical-panel text-tactical-muted border-tactical-border'
                }`}
              >
                <span className="badge-hotkey !bg-transparent !border-0 !p-0">{currentStep > 3 ? '✓' : '3'}</span>
                <span className="truncate">SUPER ADMIN</span>
              </div>

              <div
                className={`py-1.5 px-2 border transition-colors flex items-center justify-center space-x-1 ${
                  currentStep === 4
                    ? 'bg-phosphor-amber text-[#07090E] font-bold border-phosphor-amber'
                    : 'bg-tactical-panel text-tactical-muted border-tactical-border'
                }`}
              >
                <span className="badge-hotkey !bg-transparent !border-0 !p-0">4</span>
                <span className="truncate">TLS TRUST</span>
              </div>
            </div>
          </div>
        )}

        {/* Error Banner */}
        {errorMessage && (
          <div role="alert" className="mx-6 mt-4 p-3.5 bg-tactical-canvas border border-phosphor-red text-xs text-phosphor-red flex items-start space-x-3">
            <AlertTriangle className="w-4 h-4 text-phosphor-red flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="font-bold font-mono uppercase tracking-wider mb-0.5">PROVISIONING FAULT // ATTESTATION REJECTED</div>
              <div className="text-[13px] font-sans text-tactical-text leading-relaxed">{errorMessage}</div>
            </div>
          </div>
        )}

        {/* Step Content */}
        <div className="p-6 sm:p-8 flex-1">
          {alreadyBootstrapped ? (
            <div className="text-center py-8 space-y-4">
              <div className="inline-flex w-14 h-14 rounded-none bg-tactical-surface border border-tactical-border items-center justify-center text-tactical-muted">
                <Server className="w-7 h-7 text-phosphor-amber" />
              </div>
              <h2 className="text-base font-bold font-mono text-tactical-bright uppercase tracking-wider">
                APPLIANCE COMMISSIONING COMPLETED
              </h2>
              <p className="text-[14px] font-sans text-tactical-muted max-w-md mx-auto leading-relaxed">
                This edge surveillance appliance has completed its initial commissioning sequence. The one-time setup
                lock has been cryptographically sealed to prevent unauthorized tenant takeover.
              </p>
              {onSwitchToLogin && (
                <button
                  type="button"
                  onClick={onSwitchToLogin}
                  className="btn-tactical-primary mt-4"
                >
                  <span>Proceed to Operator Login</span>
                </button>
              )}
            </div>
          ) : isSuccess ? (
            <div className="text-center py-6 space-y-5">
              <div className="inline-flex w-14 h-14 rounded-none bg-phosphor-green/10 border border-phosphor-green/60 items-center justify-center text-phosphor-green">
                <CheckCircle2 className="w-8 h-8 text-phosphor-green" />
              </div>
              <div>
                <h2 className="text-base font-bold font-mono text-tactical-bright uppercase tracking-wider">
                  COMMISSIONING COMPLETE // LOCK SEALED
                </h2>
                <p className="text-[14px] font-sans text-tactical-muted mt-1 leading-relaxed">
                  VigilOne edge server has provisioned the facility partition, master credential, and evidentiary storage volume.
                </p>
              </div>

              <div className="bg-tactical-canvas border border-tactical-border p-4 max-w-md mx-auto text-left text-xs space-y-2 font-mono">
                <div className="flex justify-between border-b border-tactical-surface pb-1.5">
                  <span className="text-tactical-muted uppercase tracking-wider text-[11px]">FACILITY:</span>
                  <span className="text-tactical-text font-bold">{facilityName}</span>
                </div>
                <div className="flex justify-between border-b border-tactical-surface pb-1.5">
                  <span className="text-tactical-muted uppercase tracking-wider text-[11px]">SUPER ADMIN:</span>
                  <span className="text-phosphor-amber font-bold">{adminEmail}</span>
                </div>
                <div className="flex justify-between border-b border-tactical-surface pb-1.5">
                  <span className="text-tactical-muted uppercase tracking-wider text-[11px]">TIMEZONE:</span>
                  <span className="text-phosphor-cyan">{timezone}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-tactical-muted uppercase tracking-wider text-[11px]">LICENSE ENTITLEMENT:</span>
                  <span className="text-phosphor-green font-bold">ENTERPRISE (Evaluation 90d)</span>
                </div>
              </div>

              <div className="pt-2">
                <button
                  type="button"
                  onClick={handleLaunchConsole}
                  className="btn-tactical-primary"
                >
                  <span>Launch Surveillance Console</span>
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* STEP 1: PIN Verification */}
              {currentStep === 1 && (
                <div className="space-y-5">
                  <div>
                    <h2 className="text-xs font-bold font-mono text-tactical-bright uppercase tracking-wider flex items-center space-x-2">
                      <KeyRound className="w-4 h-4 text-phosphor-amber" />
                      <span>STEP 01 // APPLIANCE PHYSICAL SETUP PIN</span>
                    </h2>
                    <p className="text-[13px] font-sans text-tactical-muted mt-1 leading-relaxed">
                      Enter the one-time authorization PIN printed to the physical terminal during initial Linux installation.
                    </p>
                  </div>

                  <div className="space-y-4">
                    <div>
                      <label className="block text-xs font-sans font-medium text-tactical-text mb-1.5">
                        Appliance Setup Token / PIN <span className="text-phosphor-red">*</span>
                      </label>
                      <div className="relative">
                        <KeyRound className="w-4 h-4 absolute left-3 top-2.5 text-tactical-muted" />
                        <input
                          type="password"
                          autoFocus
                          value={setupToken}
                          onChange={(e) => setSetupToken(e.target.value)}
                          placeholder="Paste or enter 32-hex token / PIN"
                          className="input-tactical w-full pl-9 pr-3"
                        />
                      </div>
                    </div>

                    <div className="p-4 bg-tactical-canvas border border-tactical-border space-y-2">
                      <div className="font-bold font-mono text-tactical-text flex items-center space-x-1.5 text-xs uppercase tracking-wider">
                        <Terminal className="w-3.5 h-3.5 text-phosphor-cyan" />
                        <span>Locating Your Setup Token On Appliance</span>
                      </div>
                      <p className="text-[13px] font-sans text-tactical-muted leading-relaxed">
                        On the physical appliance terminal or serial console, execute:
                      </p>
                      <div className="bg-tactical-surface border border-tactical-border p-2.5 text-xs text-phosphor-amber font-mono flex items-center justify-between">
                        <span>$ sudo vigilonectl token</span>
                        <span className="text-[10px] text-tactical-muted uppercase font-mono">HOST CLI</span>
                      </div>
                      <p className="text-xs font-sans text-tactical-muted leading-relaxed">
                        Air-gap security invariant: Setup token prevents unauthorized rogue provisioning over the local broadcast subnet.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* STEP 2: Facility Profile */}
              {currentStep === 2 && (
                <div className="space-y-5">
                  <div>
                    <h2 className="text-xs font-bold font-mono text-tactical-bright uppercase tracking-wider flex items-center space-x-2">
                      <Building2 className="w-4 h-4 text-phosphor-amber" />
                      <span>STEP 02 // FACILITY PROFILE & LEGAL TIMEZONE</span>
                    </h2>
                    <p className="text-[13px] font-sans text-tactical-muted mt-1 leading-relaxed">
                      Configure your installation site name and legal evidentiary timezone reference.
                    </p>
                  </div>

                  <div className="space-y-4">
                    <div>
                      <label className="block text-xs font-sans font-medium text-tactical-text mb-1.5">
                        Facility / Organization Name <span className="text-phosphor-red">*</span>
                      </label>
                      <input
                        type="text"
                        autoFocus
                        value={facilityName}
                        onChange={(e) => setFacilityName(e.target.value)}
                        placeholder="e.g. Metro Logistics Center - Site 1"
                        className="input-tactical w-full px-3 py-2 text-xs"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-sans font-medium text-tactical-text mb-1.5 flex items-center space-x-1.5">
                        <Clock className="w-3.5 h-3.5 text-phosphor-cyan" />
                        <span>Evidentiary Reference Timezone</span>
                      </label>
                      <select
                        value={timezone}
                        onChange={(e) => setTimezone(e.target.value)}
                        className="input-tactical w-full px-3 py-2 text-xs"
                      >
                        {COMMON_TIMEZONES.map((tz) => (
                          <option key={tz.value} value={tz.value} className="bg-tactical-panel text-tactical-text">
                            {tz.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Section 63 BSA Legal Disclaimer Box with 14px Font & Dedicated Breathing Room */}
                    <div className="legal-disclaimer">
                      <div className="font-mono text-xs font-bold text-phosphor-amber uppercase tracking-wider mb-1">
                        Section 63 BSA Admissibility Notice
                      </div>
                      <p className="text-[14px] leading-relaxed font-sans text-tactical-text">
                        All evidentiary recordings, Merkle audit log entries, and export manifests are permanently anchored to Coordinated Universal Time (UTC) and localized to this jurisdiction. Timestamp monotonic sanity checks are cryptographically attested under Bharatiya Sakshya Adhiniyam standards.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* STEP 3: Super Admin Creation */}
              {currentStep === 3 && (
                <div className="space-y-5">
                  <div>
                    <h2 className="text-xs font-bold font-mono text-tactical-bright uppercase tracking-wider flex items-center space-x-2">
                      <UserCheck className="w-4 h-4 text-phosphor-amber" />
                      <span>STEP 03 // SUPER ADMINISTRATOR MASTER CREDENTIAL</span>
                    </h2>
                    <p className="text-[13px] font-sans text-tactical-muted mt-1 leading-relaxed">
                      Enroll the primary administrative identity holding appliance recovery keys and cryptographic authority.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                    <div>
                      <label className="block text-xs font-sans font-medium text-tactical-text mb-1">
                        Administrator Full Name <span className="text-phosphor-red">*</span>
                      </label>
                      <input
                        type="text"
                        autoFocus
                        value={adminName}
                        onChange={(e) => setAdminName(e.target.value)}
                        placeholder="Security Administrator"
                        className="input-tactical w-full px-3 py-2 text-xs"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-sans font-medium text-tactical-text mb-1">
                        Super Admin Email <span className="text-phosphor-red">*</span>
                      </label>
                      <div className="relative">
                        <Mail className="w-3.5 h-3.5 absolute left-3 top-2.5 text-tactical-muted" />
                        <input
                          type="email"
                          value={adminEmail}
                          onChange={(e) => setAdminEmail(e.target.value)}
                          placeholder="admin@facility.local"
                          className="input-tactical w-full pl-9 pr-3 py-2 text-xs"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-sans font-medium text-tactical-text mb-1">
                        Master Password <span className="text-phosphor-red">*</span>
                      </label>
                      <div className="relative">
                        <Lock className="w-3.5 h-3.5 absolute left-3 top-2.5 text-tactical-muted" />
                        <input
                          type="password"
                          value={adminPassword}
                          onChange={(e) => setAdminPassword(e.target.value)}
                          placeholder="Min 12 characters"
                          className="input-tactical w-full pl-9 pr-3 py-2 text-xs"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-sans font-medium text-tactical-text mb-1">
                        Confirm Master Password <span className="text-phosphor-red">*</span>
                      </label>
                      <div className="relative">
                        <Lock className="w-3.5 h-3.5 absolute left-3 top-2.5 text-tactical-muted" />
                        <input
                          type="password"
                          value={confirmPassword}
                          onChange={(e) => setConfirmPassword(e.target.value)}
                          placeholder="Re-type password"
                          className="input-tactical w-full pl-9 pr-3 py-2 text-xs"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Password Requirements Checklist */}
                  <div className="p-3 bg-tactical-canvas border border-tactical-border text-xs space-y-2">
                    <div className="text-tactical-muted font-mono text-[10px] uppercase tracking-wider font-bold">
                      ADMINISTRATIVE CREDENTIAL HYGIENE INVARIANTS:
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
                      <div className={`flex items-center space-x-1.5 ${hasMinLength ? 'text-phosphor-green' : 'text-tactical-muted'}`}>
                        <span className="font-bold">{hasMinLength ? '[✓]' : '[ ]'}</span>
                        <span>MIN 12 CHARACTERS</span>
                      </div>
                      <div className={`flex items-center space-x-1.5 ${hasUppercase ? 'text-phosphor-green' : 'text-tactical-muted'}`}>
                        <span className="font-bold">{hasUppercase ? '[✓]' : '[ ]'}</span>
                        <span>UPPERCASE (A-Z)</span>
                      </div>
                      <div className={`flex items-center space-x-1.5 ${hasLowercase ? 'text-phosphor-green' : 'text-tactical-muted'}`}>
                        <span className="font-bold">{hasLowercase ? '[✓]' : '[ ]'}</span>
                        <span>LOWERCASE (a-z)</span>
                      </div>
                      <div className={`flex items-center space-x-1.5 ${hasNumber ? 'text-phosphor-green' : 'text-tactical-muted'}`}>
                        <span className="font-bold">{hasNumber ? '[✓]' : '[ ]'}</span>
                        <span>NUMERICAL (0-9)</span>
                      </div>
                      <div className={`flex items-center space-x-1.5 ${hasSpecial ? 'text-phosphor-green' : 'text-tactical-muted'}`}>
                        <span className="font-bold">{hasSpecial ? '[✓]' : '[ ]'}</span>
                        <span>SPECIAL SYMBOL (!@#$%^&*)</span>
                      </div>
                      <div className={`flex items-center space-x-1.5 ${passwordsMatch ? 'text-phosphor-green' : 'text-tactical-muted'}`}>
                        <span className="font-bold">{passwordsMatch ? '[✓]' : '[ ]'}</span>
                        <span>PASSWORDS MATCH</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* STEP 4: TLS Certificate Trust */}
              {currentStep === 4 && (
                <div className="space-y-5">
                  <div>
                    <h2 className="text-xs font-bold font-mono text-tactical-bright uppercase tracking-wider flex items-center space-x-2">
                      <ShieldCheck className="w-4 h-4 text-phosphor-amber" />
                      <span>STEP 04 // TLS SECURITY & ROOT CA ATTESTATION</span>
                    </h2>
                    <p className="text-[14px] font-sans text-tactical-text mt-1 leading-relaxed">
                      VigilOne secures all video streams and data with hardware-isolated HTTPS. To eliminate browser warnings on{' '}
                      <strong className="text-phosphor-amber font-mono">https://vigilone.local</strong>, install the appliance Root CA.
                    </p>
                  </div>

                  {/* Download CA card */}
                  <div className="p-4 bg-tactical-surface border border-phosphor-cyan/40 flex items-center justify-between">
                    <div className="space-y-0.5">
                      <div className="text-xs font-bold font-mono text-tactical-bright flex items-center space-x-2 uppercase tracking-wider">
                        <FileCheck className="w-4 h-4 text-phosphor-cyan" />
                        <span>VIGILONE APPLIANCE ROOT CA CERTIFICATE</span>
                      </div>
                      <p className="text-[13px] font-sans text-tactical-muted">
                        SHA-256 root certificate generated by appliance internal Caddy PKI for local domain resolution.
                      </p>
                    </div>
                    <a
                      href="/ca.crt"
                      download="vigilone-root-ca.crt"
                      className="btn-tactical-secondary !text-xs !py-1.5 !px-3"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Download ca.crt</span>
                    </a>
                  </div>

                  {/* OS-specific Trust Instructions */}
                  <div className="border border-tactical-border bg-tactical-canvas">
                    <div className="flex border-b border-tactical-border bg-tactical-surface text-xs font-mono">
                      <button
                        type="button"
                        onClick={() => setSelectedOsTab('windows')}
                        className={`px-3.5 py-1.5 font-bold uppercase tracking-wider border-r border-tactical-border transition-colors ${
                          selectedOsTab === 'windows'
                            ? 'bg-phosphor-amber text-[#07090E]'
                            : 'text-tactical-muted hover:text-tactical-text'
                        }`}
                      >
                        Windows
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedOsTab('mac')}
                        className={`px-3.5 py-1.5 font-bold uppercase tracking-wider border-r border-tactical-border transition-colors ${
                          selectedOsTab === 'mac'
                            ? 'bg-phosphor-amber text-[#07090E]'
                            : 'text-tactical-muted hover:text-tactical-text'
                        }`}
                      >
                        macOS
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedOsTab('linux')}
                        className={`px-3.5 py-1.5 font-bold uppercase tracking-wider border-r border-tactical-border transition-colors ${
                          selectedOsTab === 'linux'
                            ? 'bg-phosphor-amber text-[#07090E]'
                            : 'text-tactical-muted hover:text-tactical-text'
                        }`}
                      >
                        Linux
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedOsTab('browser')}
                        className={`px-3.5 py-1.5 font-bold uppercase tracking-wider transition-colors ${
                          selectedOsTab === 'browser'
                            ? 'bg-phosphor-amber text-[#07090E]'
                            : 'text-tactical-muted hover:text-tactical-text'
                        }`}
                      >
                        Firefox / Chrome
                      </button>
                    </div>

                    <div className="p-4 text-xs font-mono text-tactical-text space-y-2">
                      {selectedOsTab === 'windows' && (
                        <ol className="list-decimal list-inside space-y-1 text-tactical-muted text-[12px] font-sans leading-relaxed">
                          <li>Double-click the downloaded <strong className="font-mono text-tactical-bright">vigilone-root-ca.crt</strong> file.</li>
                          <li>Click <strong>"Install Certificate..."</strong> and select <strong>Local Machine</strong>.</li>
                          <li>Choose <strong>"Place all certificates in the following store"</strong>.</li>
                          <li>Click Browse and select <strong className="text-phosphor-amber font-mono">"Trusted Root Certification Authorities"</strong>.</li>
                          <li>Click Next, Finish, and confirm prompt. Restart your browser.</li>
                        </ol>
                      )}

                      {selectedOsTab === 'mac' && (
                        <ol className="list-decimal list-inside space-y-1 text-tactical-muted text-[12px] font-sans leading-relaxed">
                          <li>Double-click <strong className="font-mono text-tactical-bright">vigilone-root-ca.crt</strong> to open in <strong>Keychain Access</strong>.</li>
                          <li>Add the certificate to the <strong>System</strong> keychain.</li>
                          <li>Find <strong className="text-phosphor-amber font-mono">Caddy Local Authority</strong>, double click, expand <strong>Trust</strong>.</li>
                          <li>Change "When using this certificate" to <strong className="text-phosphor-green">"Always Trust"</strong>.</li>
                          <li>Save with administrator password and restart browser.</li>
                        </ol>
                      )}

                      {selectedOsTab === 'linux' && (
                        <div className="space-y-1.5 text-tactical-muted text-[12px] font-sans leading-relaxed">
                          <p>Copy certificate to the system trust anchor:</p>
                          <div className="p-2.5 bg-tactical-surface text-phosphor-amber text-xs border border-tactical-border font-mono leading-relaxed">
                            sudo cp ca.crt /usr/local/share/ca-certificates/vigilone-ca.crt<br />
                            sudo update-ca-certificates
                          </div>
                        </div>
                      )}

                      {selectedOsTab === 'browser' && (
                        <ol className="list-decimal list-inside space-y-1 text-tactical-muted text-[12px] font-sans leading-relaxed">
                          <li>Open Settings → Privacy & Security → Certificates → View Certificates.</li>
                          <li>Under <strong>Authorities</strong>, click <strong>Import</strong>.</li>
                          <li>Select <strong className="font-mono text-tactical-bright">vigilone-root-ca.crt</strong>.</li>
                          <li>Check <strong className="text-phosphor-amber font-mono">"Trust this CA to identify websites"</strong> and click OK.</li>
                        </ol>
                      )}
                    </div>
                  </div>

                  <div className="pt-1">
                    <label className="flex items-start space-x-2.5 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={caAcknowledged}
                        onChange={(e) => setCaAcknowledged(e.target.checked)}
                        className="mt-0.5 rounded-none border-tactical-border bg-tactical-canvas text-phosphor-amber focus:ring-0"
                      />
                      <span className="text-[13px] font-sans text-tactical-text leading-relaxed">
                        I acknowledge that the root certificate is required for warning-free zero-trust HTTPS access to{' '}
                        <strong className="text-phosphor-amber font-mono">https://vigilone.local</strong>.
                      </span>
                    </label>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Action Footer */}
        {!isSuccess && !alreadyBootstrapped && (
          <div className="bg-tactical-surface border-t border-tactical-border px-6 py-3 flex items-center justify-between">
            <div>
              {currentStep > 1 ? (
                <button
                  type="button"
                  onClick={handleBack}
                  disabled={submitting}
                  className="btn-tactical-secondary"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  <span>← Previous</span>
                </button>
              ) : onSwitchToLogin ? (
                <button
                  type="button"
                  onClick={onSwitchToLogin}
                  className="text-xs font-mono text-tactical-muted hover:text-phosphor-amber transition-colors uppercase tracking-wider"
                >
                  Switch to Operator Login
                </button>
              ) : null}
            </div>

            <div>
              {currentStep < 4 ? (
                <button
                  type="button"
                  onClick={handleNext}
                  className="btn-tactical-primary"
                >
                  <span>Next Step →</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleCompleteBootstrap}
                  disabled={submitting || !caAcknowledged}
                  className="btn-tactical-primary"
                >
                  {submitting ? (
                    <span>Commissioning Appliance...</span>
                  ) : (
                    <>
                      <ShieldCheck className="w-4 h-4" />
                      <span>Complete Commissioning</span>
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default FirstRunWizard;
