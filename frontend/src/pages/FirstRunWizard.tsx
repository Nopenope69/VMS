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
    <div className="min-h-screen bg-graphite-900 text-slate-100 flex flex-col items-center justify-center p-4 sm:p-6 selection:bg-cctv-amber/30">
      <div className="w-full max-w-3xl bg-graphite-850 border border-graphite-700 rounded-xl shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="bg-graphite-800 border-b border-graphite-700 px-8 py-5 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-lg bg-cctv-amber/20 border border-cctv-amber/60 flex items-center justify-center shadow-inner">
              <Radio className="w-6 h-6 text-cctv-amber" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="font-bold tracking-wider text-white uppercase text-base">VigilOne VMS</span>
                <span className="text-[10px] px-2 py-0.5 rounded bg-cctv-amber/20 text-cctv-amber border border-cctv-amber/40 font-mono font-bold">
                  APPLIANCE FIRST-RUN
                </span>
              </div>
              <p className="text-xs text-slate-400 font-mono">Zero-Terminal Onboarding & Provisioning Engine</p>
            </div>
          </div>

          <div className="text-right hidden sm:block">
            <div className="text-xs font-mono text-slate-400">Target Appliance</div>
            <div className="text-xs font-mono text-cctv-teal font-semibold">https://vigilone.local</div>
          </div>
        </div>

        {/* Wizard Steps Bar */}
        {!isSuccess && !alreadyBootstrapped && (
          <div className="bg-graphite-900/60 border-b border-graphite-700/60 px-8 py-3">
            <div className="grid grid-cols-4 gap-2 text-center text-xs font-mono">
              <div
                className={`flex items-center justify-center space-x-2 py-1.5 rounded transition ${
                  currentStep === 1
                    ? 'bg-cctv-amber text-graphite-900 font-bold'
                    : currentStep > 1
                    ? 'text-cctv-amber/80 font-medium'
                    : 'text-slate-500'
                }`}
              >
                <span>1. Setup PIN</span>
              </div>
              <div
                className={`flex items-center justify-center space-x-2 py-1.5 rounded transition ${
                  currentStep === 2
                    ? 'bg-cctv-amber text-graphite-900 font-bold'
                    : currentStep > 2
                    ? 'text-cctv-amber/80 font-medium'
                    : 'text-slate-500'
                }`}
              >
                <span>2. Facility</span>
              </div>
              <div
                className={`flex items-center justify-center space-x-2 py-1.5 rounded transition ${
                  currentStep === 3
                    ? 'bg-cctv-amber text-graphite-900 font-bold'
                    : currentStep > 3
                    ? 'text-cctv-amber/80 font-medium'
                    : 'text-slate-500'
                }`}
              >
                <span>3. Super Admin</span>
              </div>
              <div
                className={`flex items-center justify-center space-x-2 py-1.5 rounded transition ${
                  currentStep === 4
                    ? 'bg-cctv-amber text-graphite-900 font-bold'
                    : 'text-slate-500'
                }`}
              >
                <span>4. TLS Trust</span>
              </div>
            </div>
          </div>
        )}

        {/* Error Banner */}
        {errorMessage && (
          <div className="mx-8 mt-6 p-4 bg-red-950/60 border border-red-500/80 rounded-lg text-xs text-red-200 flex items-start space-x-3 shadow-inner">
            <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="font-semibold mb-1">Provisioning Notice</div>
              <div>{errorMessage}</div>
            </div>
          </div>
        )}

        {/* Step Content */}
        <div className="p-8 flex-1">
          {alreadyBootstrapped ? (
            <div className="text-center py-8 space-y-4">
              <div className="inline-flex w-16 h-16 rounded-full bg-slate-800 border border-slate-700 items-center justify-center text-slate-400">
                <Server className="w-8 h-8" />
              </div>
              <h2 className="text-lg font-bold text-white uppercase tracking-wider">Appliance Already Initialized</h2>
              <p className="text-xs text-slate-400 max-w-md mx-auto">
                This edge surveillance appliance has completed its initial commissioning sequence. The one-time setup
                lock has been sealed to prevent unauthorized tenant takeover.
              </p>
              {onSwitchToLogin && (
                <button
                  type="button"
                  onClick={onSwitchToLogin}
                  className="mt-4 px-6 py-2.5 bg-cctv-amber text-graphite-900 font-semibold text-xs rounded hover:bg-amber-400 transition uppercase tracking-wider"
                >
                  Proceed to Operator Login
                </button>
              )}
            </div>
          ) : isSuccess ? (
            <div className="text-center py-6 space-y-6">
              <div className="inline-flex w-16 h-16 rounded-full bg-emerald-900/30 border border-emerald-500/60 items-center justify-center text-emerald-400 shadow-inner">
                <CheckCircle2 className="w-10 h-10" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-white uppercase tracking-wider">Commissioning Complete</h2>
                <p className="text-xs text-slate-300 mt-1">
                  VigilOne edge server has successfully provisioned the facility and storage volume.
                </p>
              </div>

              <div className="bg-graphite-900 border border-graphite-700 rounded-lg p-5 max-w-md mx-auto text-left text-xs space-y-2 font-mono">
                <div className="flex justify-between border-b border-graphite-800 pb-2">
                  <span className="text-slate-400">Facility:</span>
                  <span className="text-white font-bold">{facilityName}</span>
                </div>
                <div className="flex justify-between border-b border-graphite-800 pb-2">
                  <span className="text-slate-400">Super Admin:</span>
                  <span className="text-cctv-amber">{adminEmail}</span>
                </div>
                <div className="flex justify-between border-b border-graphite-800 pb-2">
                  <span className="text-slate-400">Timezone:</span>
                  <span className="text-slate-200">{timezone}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">License:</span>
                  <span className="text-emerald-400 font-semibold">ENTERPRISE (Evaluation 90d)</span>
                </div>
              </div>

              <div className="pt-2">
                <button
                  type="button"
                  onClick={handleLaunchConsole}
                  className="px-8 py-3 bg-cctv-amber text-graphite-900 font-bold text-xs rounded-lg hover:bg-amber-400 transition shadow-lg uppercase tracking-wider inline-flex items-center space-x-2"
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
                <div className="space-y-6">
                  <div>
                    <h2 className="text-base font-bold text-white uppercase tracking-wider flex items-center space-x-2">
                      <KeyRound className="w-5 h-5 text-cctv-amber" />
                      <span>Step 1: Appliance Physical Setup PIN</span>
                    </h2>
                    <p className="text-xs text-slate-400 mt-1">
                      Enter the one-time authorization PIN printed to the physical terminal during initial Linux installation.
                    </p>
                  </div>

                  <div className="space-y-4">
                    <div>
                      <label className="block text-xs font-mono text-slate-300 mb-2">
                        Appliance Setup Token / PIN
                      </label>
                      <div className="relative">
                        <KeyRound className="w-5 h-5 absolute left-3 top-3 text-slate-500" />
                        <input
                          type="password"
                          autoFocus
                          value={setupToken}
                          onChange={(e) => setSetupToken(e.target.value)}
                          placeholder="Paste or enter 32-hex token / PIN"
                          className="w-full bg-graphite-900 border border-graphite-700 rounded-lg pl-10 pr-4 py-3 text-sm text-slate-100 font-mono focus:outline-none focus:border-cctv-amber"
                        />
                      </div>
                    </div>

                    <div className="p-4 bg-graphite-900/80 border border-graphite-700/80 rounded-lg text-xs text-slate-400 space-y-2">
                      <div className="font-semibold text-slate-300 flex items-center space-x-1.5">
                        <Server className="w-3.5 h-3.5 text-cctv-teal" />
                        <span>How to locate your Setup Token:</span>
                      </div>
                      <p>
                        On the appliance host terminal, run:
                        <code className="ml-2 px-2 py-0.5 rounded bg-graphite-800 text-cctv-amber font-mono text-[11px] border border-graphite-700">
                          sudo vigilonectl token
                        </code>
                      </p>
                      <p className="text-[11px] text-slate-500">
                        This token prevents unauthorized rogue provisioning over the local area network.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* STEP 2: Facility Profile */}
              {currentStep === 2 && (
                <div className="space-y-6">
                  <div>
                    <h2 className="text-base font-bold text-white uppercase tracking-wider flex items-center space-x-2">
                      <Building2 className="w-5 h-5 text-cctv-amber" />
                      <span>Step 2: Facility Profile & Timezone</span>
                    </h2>
                    <p className="text-xs text-slate-400 mt-1">
                      Configure your installation site name and legal evidentiary timezone reference.
                    </p>
                  </div>

                  <div className="space-y-4">
                    <div>
                      <label className="block text-xs font-mono text-slate-300 mb-2">
                        Facility / Organization Name <span className="text-red-400">*</span>
                      </label>
                      <input
                        type="text"
                        autoFocus
                        value={facilityName}
                        onChange={(e) => setFacilityName(e.target.value)}
                        placeholder="e.g. Metro Logistics Center - Site 1"
                        className="w-full bg-graphite-900 border border-graphite-700 rounded-lg px-4 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-cctv-amber"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-mono text-slate-300 mb-2 flex items-center space-x-2">
                        <Clock className="w-4 h-4 text-cctv-teal" />
                        <span>Evidentiary Timezone</span>
                      </label>
                      <select
                        value={timezone}
                        onChange={(e) => setTimezone(e.target.value)}
                        className="w-full bg-graphite-900 border border-graphite-700 rounded-lg px-4 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-cctv-amber"
                      >
                        {COMMON_TIMEZONES.map((tz) => (
                          <option key={tz.value} value={tz.value}>
                            {tz.label}
                          </option>
                        ))}
                      </select>
                      <p className="text-[11px] text-slate-500 mt-1.5 font-mono">
                        All Section 63 chain-of-custody timestamps will be recorded in UTC and localized to this zone.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* STEP 3: Super Admin Creation */}
              {currentStep === 3 && (
                <div className="space-y-6">
                  <div>
                    <h2 className="text-base font-bold text-white uppercase tracking-wider flex items-center space-x-2">
                      <UserCheck className="w-5 h-5 text-cctv-amber" />
                      <span>Step 3: Super Administrator Account</span>
                    </h2>
                    <p className="text-xs text-slate-400 mt-1">
                      Create the primary administrative credential for this appliance.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-mono text-slate-300 mb-1">
                        Administrator Full Name <span className="text-red-400">*</span>
                      </label>
                      <input
                        type="text"
                        autoFocus
                        value={adminName}
                        onChange={(e) => setAdminName(e.target.value)}
                        placeholder="Security Administrator"
                        className="w-full bg-graphite-900 border border-graphite-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-cctv-amber"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-mono text-slate-300 mb-1">
                        Super Admin Email <span className="text-red-400">*</span>
                      </label>
                      <div className="relative">
                        <Mail className="w-4 h-4 absolute left-3 top-2.5 text-slate-500" />
                        <input
                          type="email"
                          value={adminEmail}
                          onChange={(e) => setAdminEmail(e.target.value)}
                          placeholder="admin@facility.local"
                          className="w-full bg-graphite-900 border border-graphite-700 rounded-lg pl-9 pr-3 py-2 text-xs text-slate-100 font-mono focus:outline-none focus:border-cctv-amber"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-mono text-slate-300 mb-1">
                        Master Password <span className="text-red-400">*</span>
                      </label>
                      <div className="relative">
                        <Lock className="w-4 h-4 absolute left-3 top-2.5 text-slate-500" />
                        <input
                          type="password"
                          value={adminPassword}
                          onChange={(e) => setAdminPassword(e.target.value)}
                          placeholder="Min 12 characters"
                          className="w-full bg-graphite-900 border border-graphite-700 rounded-lg pl-9 pr-3 py-2 text-xs text-slate-100 font-mono focus:outline-none focus:border-cctv-amber"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-mono text-slate-300 mb-1">
                        Confirm Master Password <span className="text-red-400">*</span>
                      </label>
                      <div className="relative">
                        <Lock className="w-4 h-4 absolute left-3 top-2.5 text-slate-500" />
                        <input
                          type="password"
                          value={confirmPassword}
                          onChange={(e) => setConfirmPassword(e.target.value)}
                          placeholder="Re-type password"
                          className="w-full bg-graphite-900 border border-graphite-700 rounded-lg pl-9 pr-3 py-2 text-xs text-slate-100 font-mono focus:outline-none focus:border-cctv-amber"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Password Requirements Checklist */}
                  <div className="p-4 bg-graphite-900/60 border border-graphite-700/60 rounded-lg text-xs space-y-2">
                    <div className="text-slate-400 font-mono text-[11px] mb-2 font-medium">
                      Administrative Credential Hygiene Standards:
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
                      <div className={`flex items-center space-x-1.5 ${hasMinLength ? 'text-emerald-400' : 'text-slate-500'}`}>
                        <span>{hasMinLength ? '✓' : '○'}</span>
                        <span>At least 12 characters</span>
                      </div>
                      <div className={`flex items-center space-x-1.5 ${hasUppercase ? 'text-emerald-400' : 'text-slate-500'}`}>
                        <span>{hasUppercase ? '✓' : '○'}</span>
                        <span>Uppercase letter (A-Z)</span>
                      </div>
                      <div className={`flex items-center space-x-1.5 ${hasLowercase ? 'text-emerald-400' : 'text-slate-500'}`}>
                        <span>{hasLowercase ? '✓' : '○'}</span>
                        <span>Lowercase letter (a-z)</span>
                      </div>
                      <div className={`flex items-center space-x-1.5 ${hasNumber ? 'text-emerald-400' : 'text-slate-500'}`}>
                        <span>{hasNumber ? '✓' : '○'}</span>
                        <span>Numerical digit (0-9)</span>
                      </div>
                      <div className={`flex items-center space-x-1.5 ${hasSpecial ? 'text-emerald-400' : 'text-slate-500'}`}>
                        <span>{hasSpecial ? '✓' : '○'}</span>
                        <span>Special symbol (!@#$%^&*)</span>
                      </div>
                      <div className={`flex items-center space-x-1.5 ${passwordsMatch ? 'text-emerald-400' : 'text-slate-500'}`}>
                        <span>{passwordsMatch ? '✓' : '○'}</span>
                        <span>Passwords match exactly</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* STEP 4: TLS Certificate Trust */}
              {currentStep === 4 && (
                <div className="space-y-6">
                  <div>
                    <h2 className="text-base font-bold text-white uppercase tracking-wider flex items-center space-x-2">
                      <ShieldCheck className="w-5 h-5 text-cctv-amber" />
                      <span>Step 4: TLS Security & Root CA Trust</span>
                    </h2>
                    <p className="text-xs text-slate-400 mt-1">
                      VigilOne secures all video streams and data with hardware-isolated HTTPS. To eliminate browser warnings on{' '}
                      <span className="text-cctv-amber font-mono font-semibold">https://vigilone.local</span>, install the appliance Root CA.
                    </p>
                  </div>

                  {/* Download CA card */}
                  <div className="p-5 bg-gradient-to-r from-graphite-900 to-graphite-800 border border-cctv-teal/40 rounded-xl flex items-center justify-between shadow-lg">
                    <div className="space-y-1">
                      <div className="text-sm font-bold text-white flex items-center space-x-2">
                        <FileCheck className="w-4 h-4 text-cctv-teal" />
                        <span>VigilOne Appliance Root CA Certificate</span>
                      </div>
                      <p className="text-xs text-slate-400">
                        SHA-256 certificate issued by internal Caddy PKI for local domain resolution.
                      </p>
                    </div>
                    <a
                      href="/ca.crt"
                      download="vigilone-root-ca.crt"
                      className="px-4 py-2.5 bg-cctv-teal/20 text-cctv-teal hover:bg-cctv-teal hover:text-graphite-900 border border-cctv-teal font-semibold text-xs rounded-lg transition flex items-center space-x-2"
                    >
                      <Download className="w-4 h-4" />
                      <span>Download ca.crt</span>
                    </a>
                  </div>

                  {/* OS-specific Trust Instructions */}
                  <div className="border border-graphite-700 rounded-lg overflow-hidden bg-graphite-900/60">
                    <div className="flex border-b border-graphite-700 bg-graphite-800/80 text-xs font-mono">
                      <button
                        type="button"
                        onClick={() => setSelectedOsTab('windows')}
                        className={`px-4 py-2 font-medium border-r border-graphite-700 transition ${
                          selectedOsTab === 'windows'
                            ? 'bg-cctv-amber text-graphite-900 font-bold'
                            : 'text-slate-400 hover:text-white'
                        }`}
                      >
                        Windows
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedOsTab('mac')}
                        className={`px-4 py-2 font-medium border-r border-graphite-700 transition ${
                          selectedOsTab === 'mac'
                            ? 'bg-cctv-amber text-graphite-900 font-bold'
                            : 'text-slate-400 hover:text-white'
                        }`}
                      >
                        macOS
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedOsTab('linux')}
                        className={`px-4 py-2 font-medium border-r border-graphite-700 transition ${
                          selectedOsTab === 'linux'
                            ? 'bg-cctv-amber text-graphite-900 font-bold'
                            : 'text-slate-400 hover:text-white'
                        }`}
                      >
                        Linux
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedOsTab('browser')}
                        className={`px-4 py-2 font-medium transition ${
                          selectedOsTab === 'browser'
                            ? 'bg-cctv-amber text-graphite-900 font-bold'
                            : 'text-slate-400 hover:text-white'
                        }`}
                      >
                        Firefox / Chrome
                      </button>
                    </div>

                    <div className="p-4 text-xs font-mono text-slate-300 space-y-2">
                      {selectedOsTab === 'windows' && (
                        <ol className="list-decimal list-inside space-y-1 text-slate-400">
                          <li>Double-click the downloaded <span className="text-slate-200">vigilone-root-ca.crt</span> file.</li>
                          <li>Click <span className="text-slate-200">"Install Certificate..."</span> and select <span className="text-slate-200">Local Machine</span>.</li>
                          <li>Choose <span className="text-slate-200">"Place all certificates in the following store"</span>.</li>
                          <li>Click Browse and select <span className="text-cctv-amber font-semibold">"Trusted Root Certification Authorities"</span>.</li>
                          <li>Click Next, Finish, and confirm prompt. Restart your browser.</li>
                        </ol>
                      )}

                      {selectedOsTab === 'mac' && (
                        <ol className="list-decimal list-inside space-y-1 text-slate-400">
                          <li>Double-click <span className="text-slate-200">vigilone-root-ca.crt</span> to open in <span className="text-slate-200">Keychain Access</span>.</li>
                          <li>Add the certificate to the <span className="text-slate-200">System</span> keychain.</li>
                          <li>Find <span className="text-cctv-amber font-semibold">Caddy Local Authority</span>, double click, expand <span className="text-slate-200">Trust</span>.</li>
                          <li>Change "When using this certificate" to <span className="text-emerald-400 font-semibold">"Always Trust"</span>.</li>
                          <li>Save with administrator password and restart browser.</li>
                        </ol>
                      )}

                      {selectedOsTab === 'linux' && (
                        <div className="space-y-2 text-slate-400">
                          <p>Copy certificate to the system trust anchor:</p>
                          <code className="block p-2 bg-graphite-950 rounded text-cctv-amber text-[11px] border border-graphite-800">
                            sudo cp ca.crt /usr/local/share/ca-certificates/vigilone-ca.crt<br />
                            sudo update-ca-certificates
                          </code>
                        </div>
                      )}

                      {selectedOsTab === 'browser' && (
                        <ol className="list-decimal list-inside space-y-1 text-slate-400">
                          <li>Open Settings → Privacy & Security → Certificates → View Certificates.</li>
                          <li>Under <span className="text-slate-200">Authorities</span>, click <span className="text-slate-200">Import</span>.</li>
                          <li>Select <span className="text-slate-200">vigilone-root-ca.crt</span>.</li>
                          <li>Check <span className="text-cctv-amber font-semibold">"Trust this CA to identify websites"</span> and click OK.</li>
                        </ol>
                      )}
                    </div>
                  </div>

                  <div className="pt-2">
                    <label className="flex items-start space-x-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={caAcknowledged}
                        onChange={(e) => setCaAcknowledged(e.target.checked)}
                        className="mt-0.5 rounded border-graphite-700 bg-graphite-900 text-cctv-amber focus:ring-cctv-amber"
                      />
                      <span className="text-xs text-slate-300">
                        I acknowledge that the root certificate is required for warning-free zero-trust HTTPS access to{' '}
                        <span className="text-cctv-amber font-mono font-semibold">https://vigilone.local</span>.
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
          <div className="bg-graphite-800 border-t border-graphite-700 px-8 py-4 flex items-center justify-between">
            <div>
              {currentStep > 1 ? (
                <button
                  type="button"
                  onClick={handleBack}
                  disabled={submitting}
                  className="px-4 py-2 bg-graphite-700 text-slate-300 hover:text-white rounded text-xs font-semibold uppercase tracking-wider flex items-center space-x-1.5 transition disabled:opacity-50"
                >
                  <ChevronLeft className="w-4 h-4" />
                  <span>Previous</span>
                </button>
              ) : onSwitchToLogin ? (
                <button
                  type="button"
                  onClick={onSwitchToLogin}
                  className="text-xs font-mono text-slate-400 hover:text-cctv-amber transition"
                >
                  Switch to Existing Login
                </button>
              ) : null}
            </div>

            <div>
              {currentStep < 4 ? (
                <button
                  type="button"
                  onClick={handleNext}
                  className="px-6 py-2 bg-cctv-amber text-graphite-900 font-bold text-xs rounded hover:bg-amber-400 transition uppercase tracking-wider flex items-center space-x-1.5 shadow"
                >
                  <span>Next Step</span>
                  <ChevronRight className="w-4 h-4" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleCompleteBootstrap}
                  disabled={submitting || !caAcknowledged}
                  className="px-6 py-2.5 bg-cctv-amber text-graphite-900 font-bold text-xs rounded hover:bg-amber-400 transition uppercase tracking-wider flex items-center space-x-2 shadow-lg disabled:opacity-50"
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
