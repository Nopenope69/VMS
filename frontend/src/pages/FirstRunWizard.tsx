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
    <div className="min-h-screen bg-[#080B10] text-[#E6EDF3] font-mono flex flex-col items-center justify-center p-4 sm:p-6 selection:bg-[#E3B341]/30 relative overflow-x-hidden">
      {/* Background ambient CRT scanlines / subtle grid */}
      <div className="fixed inset-0 pointer-events-none opacity-20 bg-[radial-gradient(#21262D_1px,transparent_1px)] [background-size:16px_16px]" />

      <div className="w-full max-w-3xl bg-[#0D1117] border border-[#21262D] rounded-none shadow-2xl overflow-hidden flex flex-col relative z-10">
        {/* Optical corner reticles */}
        <span className="absolute -top-1 -left-1 text-[9px] text-[#30363D] select-none leading-none z-20">+</span>
        <span className="absolute -top-1 -right-1 text-[9px] text-[#30363D] select-none leading-none z-20">+</span>
        <span className="absolute -bottom-1 -left-1 text-[9px] text-[#30363D] select-none leading-none z-20">+</span>
        <span className="absolute -bottom-1 -right-1 text-[9px] text-[#30363D] select-none leading-none z-20">+</span>

        {/* Header */}
        <div className="bg-[#161B22] border-b border-[#21262D] px-6 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-9 h-9 rounded-none bg-[#E3B341]/10 border border-[#E3B341]/40 flex items-center justify-center">
              <Radio className="w-5 h-5 text-[#E3B341]" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="font-bold tracking-wider text-[#E6EDF3] uppercase text-sm">VIGILONE VMS</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-none bg-[#E3B341]/10 text-[#E3B341] border border-[#E3B341]/30 font-mono font-bold tracking-wider">
                  FIRST-RUN COMMISSIONING
                </span>
              </div>
              <p className="text-[11px] text-[#8B949E] font-mono mt-0.5">ZERO-TERMINAL ONBOARDING & PROVISIONING ENGINE</p>
            </div>
          </div>

          <div className="text-right hidden sm:block">
            <div className="text-[10px] font-mono text-[#8B949E] uppercase tracking-wider">TARGET APPLIANCE</div>
            <div className="text-xs font-mono text-[#58A6FF] font-semibold">https://vigilone.local</div>
          </div>
        </div>

        {/* Wizard Steps Bar */}
        {!isSuccess && !alreadyBootstrapped && (
          <div className="bg-[#080B10] border-b border-[#21262D] px-6 py-2.5">
            <div className="grid grid-cols-4 gap-2 text-center text-[11px] font-mono">
              <div
                className={`py-1.5 px-2 border transition-colors flex items-center justify-center space-x-1 ${
                  currentStep === 1
                    ? 'bg-[#E3B341] text-[#080B10] font-bold border-[#E3B341]'
                    : currentStep > 1
                    ? 'bg-[#238636]/10 text-[#3FB950] border-[#238636]/40 font-medium'
                    : 'bg-[#0D1117] text-[#484F58] border-[#21262D]'
                }`}
              >
                <span>{currentStep > 1 ? '[✓]' : '[1]'}</span>
                <span className="truncate">SETUP PIN</span>
              </div>

              <div
                className={`py-1.5 px-2 border transition-colors flex items-center justify-center space-x-1 ${
                  currentStep === 2
                    ? 'bg-[#E3B341] text-[#080B10] font-bold border-[#E3B341]'
                    : currentStep > 2
                    ? 'bg-[#238636]/10 text-[#3FB950] border-[#238636]/40 font-medium'
                    : 'bg-[#0D1117] text-[#484F58] border-[#21262D]'
                }`}
              >
                <span>{currentStep > 2 ? '[✓]' : '[2]'}</span>
                <span className="truncate">FACILITY</span>
              </div>

              <div
                className={`py-1.5 px-2 border transition-colors flex items-center justify-center space-x-1 ${
                  currentStep === 3
                    ? 'bg-[#E3B341] text-[#080B10] font-bold border-[#E3B341]'
                    : currentStep > 3
                    ? 'bg-[#238636]/10 text-[#3FB950] border-[#238636]/40 font-medium'
                    : 'bg-[#0D1117] text-[#484F58] border-[#21262D]'
                }`}
              >
                <span>{currentStep > 3 ? '[✓]' : '[3]'}</span>
                <span className="truncate">SUPER ADMIN</span>
              </div>

              <div
                className={`py-1.5 px-2 border transition-colors flex items-center justify-center space-x-1 ${
                  currentStep === 4
                    ? 'bg-[#E3B341] text-[#080B10] font-bold border-[#E3B341]'
                    : 'bg-[#0D1117] text-[#484F58] border-[#21262D]'
                }`}
              >
                <span>[4]</span>
                <span className="truncate">TLS TRUST</span>
              </div>
            </div>
          </div>
        )}

        {/* Error Banner */}
        {errorMessage && (
          <div className="mx-6 mt-4 p-3 bg-[#080B10] border border-[#F85149] text-xs text-[#F85149] flex items-start space-x-3">
            <AlertTriangle className="w-4 h-4 text-[#F85149] flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="font-bold uppercase tracking-wider mb-0.5">[ PROVISIONING FAULT // ATTESTATION REJECTED ]</div>
              <div className="text-[11px] text-[#E6EDF3]">{errorMessage}</div>
            </div>
          </div>
        )}

        {/* Step Content */}
        <div className="p-6 sm:p-8 flex-1">
          {alreadyBootstrapped ? (
            <div className="text-center py-8 space-y-4">
              <div className="inline-flex w-14 h-14 rounded-none bg-[#161B22] border border-[#30363D] items-center justify-center text-[#8B949E]">
                <Server className="w-7 h-7 text-[#E3B341]" />
              </div>
              <h2 className="text-base font-bold text-[#E6EDF3] uppercase tracking-wider">
                [ APPLIANCE COMMISSIONING COMPLETED ]
              </h2>
              <p className="text-xs text-[#8B949E] max-w-md mx-auto leading-relaxed">
                This edge surveillance appliance has completed its initial commissioning sequence. The one-time setup
                lock has been cryptographically sealed to prevent unauthorized tenant takeover.
              </p>
              {onSwitchToLogin && (
                <button
                  type="button"
                  onClick={onSwitchToLogin}
                  className="mt-4 px-5 py-2.5 bg-[#E3B341] text-[#080B10] font-bold text-xs uppercase tracking-wider hover:bg-[#F2CC60] transition-colors rounded-none"
                >
                  [ PROCEED TO OPERATOR LOGIN ]
                </button>
              )}
            </div>
          ) : isSuccess ? (
            <div className="text-center py-6 space-y-5">
              <div className="inline-flex w-14 h-14 rounded-none bg-[#238636]/10 border border-[#238636]/60 items-center justify-center text-[#3FB950]">
                <CheckCircle2 className="w-8 h-8 text-[#3FB950]" />
              </div>
              <div>
                <h2 className="text-base font-bold text-[#E6EDF3] uppercase tracking-wider">
                  [ COMMISSIONING COMPLETE // LOCK SEALED ]
                </h2>
                <p className="text-xs text-[#8B949E] mt-1">
                  VigilOne edge server has provisioned the facility partition, master credential, and evidentiary storage.
                </p>
              </div>

              <div className="bg-[#080B10] border border-[#21262D] p-4 max-w-md mx-auto text-left text-xs space-y-2 font-mono">
                <div className="flex justify-between border-b border-[#161B22] pb-1.5">
                  <span className="text-[#8B949E] uppercase tracking-wider text-[11px]">FACILITY:</span>
                  <span className="text-[#E6EDF3] font-bold">{facilityName}</span>
                </div>
                <div className="flex justify-between border-b border-[#161B22] pb-1.5">
                  <span className="text-[#8B949E] uppercase tracking-wider text-[11px]">SUPER ADMIN:</span>
                  <span className="text-[#E3B341] font-bold">{adminEmail}</span>
                </div>
                <div className="flex justify-between border-b border-[#161B22] pb-1.5">
                  <span className="text-[#8B949E] uppercase tracking-wider text-[11px]">TIMEZONE:</span>
                  <span className="text-[#58A6FF]">{timezone}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#8B949E] uppercase tracking-wider text-[11px]">LICENSE ENTITLEMENT:</span>
                  <span className="text-[#3FB950] font-bold">ENTERPRISE (Evaluation 90d)</span>
                </div>
              </div>

              <div className="pt-2">
                <button
                  type="button"
                  onClick={handleLaunchConsole}
                  className="px-6 py-2.5 bg-[#E3B341] text-[#080B10] font-bold text-xs uppercase tracking-wider hover:bg-[#F2CC60] transition-colors inline-flex items-center space-x-2 rounded-none shadow"
                >
                  <span>[ LAUNCH SURVEILLANCE CONSOLE ]</span>
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
                    <h2 className="text-xs font-bold text-[#E6EDF3] uppercase tracking-wider flex items-center space-x-2">
                      <KeyRound className="w-4 h-4 text-[#E3B341]" />
                      <span>STEP 01 // APPLIANCE PHYSICAL SETUP PIN</span>
                    </h2>
                    <p className="text-[11px] text-[#8B949E] mt-1">
                      Enter the one-time authorization PIN printed to the physical terminal during initial Linux installation.
                    </p>
                  </div>

                  <div className="space-y-4">
                    <div>
                      <label className="block text-[11px] font-mono text-[#8B949E] uppercase tracking-wider mb-1.5">
                        APPLIANCE SETUP TOKEN / PIN <span className="text-[#F85149]">*</span>
                      </label>
                      <div className="relative">
                        <KeyRound className="w-4 h-4 absolute left-3 top-2.5 text-[#484F58]" />
                        <input
                          type="password"
                          autoFocus
                          value={setupToken}
                          onChange={(e) => setSetupToken(e.target.value)}
                          placeholder="Paste or enter 32-hex token / PIN"
                          className="w-full bg-[#080B10] border border-[#30363D] focus:border-[#E3B341] pl-9 pr-3 py-2 text-xs text-[#E6EDF3] font-mono rounded-none outline-none"
                        />
                      </div>
                    </div>

                    <div className="p-3.5 bg-[#080B10] border border-[#21262D] text-xs text-[#8B949E] space-y-2">
                      <div className="font-bold text-[#C9D1D9] flex items-center space-x-1.5 text-[11px] uppercase tracking-wider">
                        <Terminal className="w-3.5 h-3.5 text-[#58A6FF]" />
                        <span>LOCATING YOUR SETUP TOKEN ON APPLIANCE:</span>
                      </div>
                      <p className="text-[11px]">
                        On the physical appliance terminal or serial console, execute:
                      </p>
                      <div className="bg-[#05070A] border border-[#21262D] p-2 text-[11px] text-[#E3B341] font-mono flex items-center justify-between">
                        <span>$ sudo vigilonectl token</span>
                        <span className="text-[10px] text-[#484F58] uppercase">HOST CLI</span>
                      </div>
                      <p className="text-[10px] text-[#484F58] uppercase tracking-wider">
                        Air-gap invariant: Setup token prevents unauthorized rogue provisioning over the local broadcast subnet.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* STEP 2: Facility Profile */}
              {currentStep === 2 && (
                <div className="space-y-5">
                  <div>
                    <h2 className="text-xs font-bold text-[#E6EDF3] uppercase tracking-wider flex items-center space-x-2">
                      <Building2 className="w-4 h-4 text-[#E3B341]" />
                      <span>STEP 02 // FACILITY PROFILE & LEGAL TIMEZONE</span>
                    </h2>
                    <p className="text-[11px] text-[#8B949E] mt-1">
                      Configure your installation site name and legal evidentiary timezone reference.
                    </p>
                  </div>

                  <div className="space-y-4">
                    <div>
                      <label className="block text-[11px] font-mono text-[#8B949E] uppercase tracking-wider mb-1.5">
                        FACILITY / JURISDICTION NAME <span className="text-[#F85149]">*</span>
                      </label>
                      <input
                        type="text"
                        autoFocus
                        value={facilityName}
                        onChange={(e) => setFacilityName(e.target.value)}
                        placeholder="e.g. Metro Logistics Center - Site 1"
                        className="w-full bg-[#080B10] border border-[#30363D] focus:border-[#E3B341] px-3 py-2 text-xs text-[#E6EDF3] font-mono rounded-none outline-none"
                      />
                    </div>

                    <div>
                      <label className="block text-[11px] font-mono text-[#8B949E] uppercase tracking-wider mb-1.5 flex items-center space-x-1.5">
                        <Clock className="w-3.5 h-3.5 text-[#58A6FF]" />
                        <span>EVIDENTIARY REFERENCE TIMEZONE</span>
                      </label>
                      <select
                        value={timezone}
                        onChange={(e) => setTimezone(e.target.value)}
                        className="w-full bg-[#080B10] border border-[#30363D] focus:border-[#E3B341] px-3 py-2 text-xs text-[#E6EDF3] font-mono rounded-none outline-none"
                      >
                        {COMMON_TIMEZONES.map((tz) => (
                          <option key={tz.value} value={tz.value} className="bg-[#0D1117] text-[#E6EDF3]">
                            {tz.label}
                          </option>
                        ))}
                      </select>
                      <p className="text-[10px] text-[#484F58] mt-1.5 font-mono uppercase tracking-wider">
                        Section 63 BSA compliance: All Merkle audit log entries and forensic video fragments are bound to UTC and localized to this zone.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* STEP 3: Super Admin Creation */}
              {currentStep === 3 && (
                <div className="space-y-5">
                  <div>
                    <h2 className="text-xs font-bold text-[#E6EDF3] uppercase tracking-wider flex items-center space-x-2">
                      <UserCheck className="w-4 h-4 text-[#E3B341]" />
                      <span>STEP 03 // SUPER ADMINISTRATOR MASTER CREDENTIAL</span>
                    </h2>
                    <p className="text-[11px] text-[#8B949E] mt-1">
                      Enroll the primary administrative identity holding appliance recovery keys and cryptographic authority.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                    <div>
                      <label className="block text-[11px] font-mono text-[#8B949E] uppercase tracking-wider mb-1">
                        ADMINISTRATOR FULL NAME <span className="text-[#F85149]">*</span>
                      </label>
                      <input
                        type="text"
                        autoFocus
                        value={adminName}
                        onChange={(e) => setAdminName(e.target.value)}
                        placeholder="Security Administrator"
                        className="w-full bg-[#080B10] border border-[#30363D] focus:border-[#E3B341] px-3 py-2 text-xs text-[#E6EDF3] font-mono rounded-none outline-none"
                      />
                    </div>

                    <div>
                      <label className="block text-[11px] font-mono text-[#8B949E] uppercase tracking-wider mb-1">
                        SUPER ADMIN EMAIL <span className="text-[#F85149]">*</span>
                      </label>
                      <div className="relative">
                        <Mail className="w-3.5 h-3.5 absolute left-3 top-2.5 text-[#484F58]" />
                        <input
                          type="email"
                          value={adminEmail}
                          onChange={(e) => setAdminEmail(e.target.value)}
                          placeholder="admin@facility.local"
                          className="w-full bg-[#080B10] border border-[#30363D] focus:border-[#E3B341] pl-9 pr-3 py-2 text-xs text-[#E6EDF3] font-mono rounded-none outline-none"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-[11px] font-mono text-[#8B949E] uppercase tracking-wider mb-1">
                        MASTER PASSWORD <span className="text-[#F85149]">*</span>
                      </label>
                      <div className="relative">
                        <Lock className="w-3.5 h-3.5 absolute left-3 top-2.5 text-[#484F58]" />
                        <input
                          type="password"
                          value={adminPassword}
                          onChange={(e) => setAdminPassword(e.target.value)}
                          placeholder="Min 12 characters"
                          className="w-full bg-[#080B10] border border-[#30363D] focus:border-[#E3B341] pl-9 pr-3 py-2 text-xs text-[#E6EDF3] font-mono rounded-none outline-none"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-[11px] font-mono text-[#8B949E] uppercase tracking-wider mb-1">
                        CONFIRM MASTER PASSWORD <span className="text-[#F85149]">*</span>
                      </label>
                      <div className="relative">
                        <Lock className="w-3.5 h-3.5 absolute left-3 top-2.5 text-[#484F58]" />
                        <input
                          type="password"
                          value={confirmPassword}
                          onChange={(e) => setConfirmPassword(e.target.value)}
                          placeholder="Re-type password"
                          className="w-full bg-[#080B10] border border-[#30363D] focus:border-[#E3B341] pl-9 pr-3 py-2 text-xs text-[#E6EDF3] font-mono rounded-none outline-none"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Password Requirements Checklist */}
                  <div className="p-3 bg-[#080B10] border border-[#21262D] text-xs space-y-2">
                    <div className="text-[#8B949E] font-mono text-[10px] uppercase tracking-wider font-bold">
                      ADMINISTRATIVE CREDENTIAL HYGIENE INVARIANTS:
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
                      <div className={`flex items-center space-x-1.5 ${hasMinLength ? 'text-[#3FB950]' : 'text-[#484F58]'}`}>
                        <span className="font-bold">{hasMinLength ? '[✓]' : '[ ]'}</span>
                        <span>MIN 12 CHARACTERS</span>
                      </div>
                      <div className={`flex items-center space-x-1.5 ${hasUppercase ? 'text-[#3FB950]' : 'text-[#484F58]'}`}>
                        <span className="font-bold">{hasUppercase ? '[✓]' : '[ ]'}</span>
                        <span>UPPERCASE (A-Z)</span>
                      </div>
                      <div className={`flex items-center space-x-1.5 ${hasLowercase ? 'text-[#3FB950]' : 'text-[#484F58]'}`}>
                        <span className="font-bold">{hasLowercase ? '[✓]' : '[ ]'}</span>
                        <span>LOWERCASE (a-z)</span>
                      </div>
                      <div className={`flex items-center space-x-1.5 ${hasNumber ? 'text-[#3FB950]' : 'text-[#484F58]'}`}>
                        <span className="font-bold">{hasNumber ? '[✓]' : '[ ]'}</span>
                        <span>NUMERICAL (0-9)</span>
                      </div>
                      <div className={`flex items-center space-x-1.5 ${hasSpecial ? 'text-[#3FB950]' : 'text-[#484F58]'}`}>
                        <span className="font-bold">{hasSpecial ? '[✓]' : '[ ]'}</span>
                        <span>SPECIAL SYMBOL (!@#$%^&*)</span>
                      </div>
                      <div className={`flex items-center space-x-1.5 ${passwordsMatch ? 'text-[#3FB950]' : 'text-[#484F58]'}`}>
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
                    <h2 className="text-xs font-bold text-[#E6EDF3] uppercase tracking-wider flex items-center space-x-2">
                      <ShieldCheck className="w-4 h-4 text-[#E3B341]" />
                      <span>STEP 04 // TLS SECURITY & ROOT CA ATTESTATION</span>
                    </h2>
                    <p className="text-[11px] text-[#8B949E] mt-1">
                      VigilOne secures all video streams and data with hardware-isolated HTTPS. To eliminate browser warnings on{' '}
                      <span className="text-[#E3B341] font-mono font-bold">https://vigilone.local</span>, install the appliance Root CA.
                    </p>
                  </div>

                  {/* Download CA card */}
                  <div className="p-4 bg-[#161B22] border border-[#58A6FF]/40 flex items-center justify-between">
                    <div className="space-y-0.5">
                      <div className="text-xs font-bold text-[#E6EDF3] flex items-center space-x-2 uppercase tracking-wider">
                        <FileCheck className="w-4 h-4 text-[#58A6FF]" />
                        <span>VIGILONE APPLIANCE ROOT CA CERTIFICATE</span>
                      </div>
                      <p className="text-[11px] text-[#8B949E]">
                        SHA-256 root certificate generated by appliance internal Caddy PKI for local domain resolution.
                      </p>
                    </div>
                    <a
                      href="/ca.crt"
                      download="vigilone-root-ca.crt"
                      className="px-3 py-1.5 bg-[#58A6FF]/10 text-[#58A6FF] hover:bg-[#58A6FF] hover:text-[#080B10] border border-[#58A6FF] font-bold text-xs uppercase tracking-wider transition-colors flex items-center space-x-1.5"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>DOWNLOAD CA.CRT</span>
                    </a>
                  </div>

                  {/* OS-specific Trust Instructions */}
                  <div className="border border-[#21262D] bg-[#080B10]">
                    <div className="flex border-b border-[#21262D] bg-[#161B22] text-xs font-mono">
                      <button
                        type="button"
                        onClick={() => setSelectedOsTab('windows')}
                        className={`px-3.5 py-1.5 font-bold uppercase tracking-wider border-r border-[#21262D] transition-colors ${
                          selectedOsTab === 'windows'
                            ? 'bg-[#E3B341] text-[#080B10]'
                            : 'text-[#8B949E] hover:text-[#E6EDF3]'
                        }`}
                      >
                        [ WINDOWS ]
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedOsTab('mac')}
                        className={`px-3.5 py-1.5 font-bold uppercase tracking-wider border-r border-[#21262D] transition-colors ${
                          selectedOsTab === 'mac'
                            ? 'bg-[#E3B341] text-[#080B10]'
                            : 'text-[#8B949E] hover:text-[#E6EDF3]'
                        }`}
                      >
                        [ MACOS ]
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedOsTab('linux')}
                        className={`px-3.5 py-1.5 font-bold uppercase tracking-wider border-r border-[#21262D] transition-colors ${
                          selectedOsTab === 'linux'
                            ? 'bg-[#E3B341] text-[#080B10]'
                            : 'text-[#8B949E] hover:text-[#E6EDF3]'
                        }`}
                      >
                        [ LINUX ]
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedOsTab('browser')}
                        className={`px-3.5 py-1.5 font-bold uppercase tracking-wider transition-colors ${
                          selectedOsTab === 'browser'
                            ? 'bg-[#E3B341] text-[#080B10]'
                            : 'text-[#8B949E] hover:text-[#E6EDF3]'
                        }`}
                      >
                        [ FIREFOX / CHROME ]
                      </button>
                    </div>

                    <div className="p-3.5 text-xs font-mono text-[#C9D1D9] space-y-2">
                      {selectedOsTab === 'windows' && (
                        <ol className="list-decimal list-inside space-y-1 text-[#8B949E] text-[11px]">
                          <li>Double-click the downloaded <span className="text-[#E6EDF3] font-bold">vigilone-root-ca.crt</span> file.</li>
                          <li>Click <span className="text-[#E6EDF3]">"Install Certificate..."</span> and select <span className="text-[#E6EDF3]">Local Machine</span>.</li>
                          <li>Choose <span className="text-[#E6EDF3]">"Place all certificates in the following store"</span>.</li>
                          <li>Click Browse and select <span className="text-[#E3B341] font-bold">"Trusted Root Certification Authorities"</span>.</li>
                          <li>Click Next, Finish, and confirm prompt. Restart your browser.</li>
                        </ol>
                      )}

                      {selectedOsTab === 'mac' && (
                        <ol className="list-decimal list-inside space-y-1 text-[#8B949E] text-[11px]">
                          <li>Double-click <span className="text-[#E6EDF3] font-bold">vigilone-root-ca.crt</span> to open in <span className="text-[#E6EDF3]">Keychain Access</span>.</li>
                          <li>Add the certificate to the <span className="text-[#E6EDF3]">System</span> keychain.</li>
                          <li>Find <span className="text-[#E3B341] font-bold">Caddy Local Authority</span>, double click, expand <span className="text-[#E6EDF3]">Trust</span>.</li>
                          <li>Change "When using this certificate" to <span className="text-[#3FB950] font-bold">"Always Trust"</span>.</li>
                          <li>Save with administrator password and restart browser.</li>
                        </ol>
                      )}

                      {selectedOsTab === 'linux' && (
                        <div className="space-y-1.5 text-[#8B949E] text-[11px]">
                          <p>Copy certificate to the system trust anchor:</p>
                          <div className="p-2 bg-[#05070A] text-[#E3B341] text-[11px] border border-[#21262D] font-mono leading-relaxed">
                            sudo cp ca.crt /usr/local/share/ca-certificates/vigilone-ca.crt<br />
                            sudo update-ca-certificates
                          </div>
                        </div>
                      )}

                      {selectedOsTab === 'browser' && (
                        <ol className="list-decimal list-inside space-y-1 text-[#8B949E] text-[11px]">
                          <li>Open Settings → Privacy & Security → Certificates → View Certificates.</li>
                          <li>Under <span className="text-[#E6EDF3]">Authorities</span>, click <span className="text-[#E6EDF3]">Import</span>.</li>
                          <li>Select <span className="text-[#E6EDF3] font-bold">vigilone-root-ca.crt</span>.</li>
                          <li>Check <span className="text-[#E3B341] font-bold">"Trust this CA to identify websites"</span> and click OK.</li>
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
                        className="mt-0.5 rounded-none border-[#30363D] bg-[#080B10] text-[#E3B341] focus:ring-0"
                      />
                      <span className="text-[11px] text-[#8B949E]">
                        I acknowledge that the root certificate is required for warning-free zero-trust HTTPS access to{' '}
                        <span className="text-[#E3B341] font-mono font-bold">https://vigilone.local</span>.
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
          <div className="bg-[#161B22] border-t border-[#21262D] px-6 py-3 flex items-center justify-between">
            <div>
              {currentStep > 1 ? (
                <button
                  type="button"
                  onClick={handleBack}
                  disabled={submitting}
                  className="px-3.5 py-1.5 bg-[#0D1117] text-[#8B949E] hover:text-[#E6EDF3] border border-[#30363D] text-xs font-bold uppercase tracking-wider flex items-center space-x-1.5 transition-colors disabled:opacity-50"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  <span>[ PREVIOUS ]</span>
                </button>
              ) : onSwitchToLogin ? (
                <button
                  type="button"
                  onClick={onSwitchToLogin}
                  className="text-xs font-mono text-[#8B949E] hover:text-[#E3B341] transition-colors uppercase tracking-wider"
                >
                  [ SWITCH TO OPERATOR LOGIN ]
                </button>
              ) : null}
            </div>

            <div>
              {currentStep < 4 ? (
                <button
                  type="button"
                  onClick={handleNext}
                  className="px-5 py-2 bg-[#E3B341] text-[#080B10] hover:bg-[#F2CC60] font-bold text-xs uppercase tracking-wider flex items-center space-x-1.5 transition-colors shadow"
                >
                  <span>[ NEXT STEP ]</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleCompleteBootstrap}
                  disabled={submitting || !caAcknowledged}
                  className="px-5 py-2 bg-[#E3B341] text-[#080B10] hover:bg-[#F2CC60] font-bold text-xs uppercase tracking-wider flex items-center space-x-2 transition-colors shadow disabled:opacity-40"
                >
                  {submitting ? (
                    <span>[ COMMISSIONING APPLIANCE... ]</span>
                  ) : (
                    <>
                      <ShieldCheck className="w-4 h-4" />
                      <span>[ COMPLETE COMMISSIONING ]</span>
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
