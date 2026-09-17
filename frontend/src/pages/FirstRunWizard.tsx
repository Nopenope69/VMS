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
  Zap,
} from 'lucide-react';
import api from '../services/api';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';

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

  const handleBypassSetup = () => {
    const demoUser = {
      id: 'demo-super-admin',
      name: 'Alex Vance (Chief Security Officer)',
      email: 'admin@vigilone.local',
      role: 'SUPER_ADMIN',
      tenantId: 'demo-tenant-hq',
      tenant: {
        id: 'demo-tenant-hq',
        name: 'Metro Transit Command Facility',
      },
    };
    const demoToken = 'demo-jwt-token-preview-mode';
    onBootstrapComplete(demoUser, demoToken);
  };

  const handleFillAllDemo = () => {
    setSetupToken('vigilone_dev_setup_token_99182');
    setFacilityName('Metro Transit Command Facility');
    setTimezone('UTC');
    setAdminName('Alex Vance (Chief Security Officer)');
    setAdminEmail('admin@vigilone.local');
    setAdminPassword('Password123!');
    setConfirmPassword('Password123!');
    setCaAcknowledged(true);
    setErrorMessage('');
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

  const steps = [
    { num: 1, label: 'Setup PIN' },
    { num: 2, label: 'Facility Profile' },
    { num: 3, label: 'Super Admin' },
    { num: 4, label: 'TLS Trust' },
  ];

  return (
    <div className="min-h-screen bg-vms-bg text-vms-text flex flex-col items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-3xl bg-vms-surface border border-vms-border rounded-lg shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="bg-vms-panel border-b border-vms-border px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded bg-vms-surface border border-vms-border flex items-center justify-center">
              <Radio className="w-5 h-5 text-vms-accent" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold tracking-tight text-vms-text text-sm">VigilOne VMS</span>
                <Badge variant="warn" size="sm">
                  First-Run Commissioning
                </Badge>
              </div>
              <p className="text-xs text-vms-muted mt-0.5">Zero-Terminal Onboarding & Appliance Provisioning</p>
            </div>
          </div>

          <div className="text-right hidden sm:block">
            <div className="text-[10px] text-vms-muted uppercase font-mono tracking-wider">Target Appliance</div>
            <div className="text-xs font-mono text-vms-accent font-semibold">https://vigilone.local</div>
          </div>
        </div>

        {/* Quick Test / Demo Bypass Bar */}
        {!isSuccess && !alreadyBootstrapped && (
          <div className="bg-vms-surface border-b border-vms-border px-6 py-2.5 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2">
              <Zap className="w-3.5 h-3.5 text-vms-accent flex-shrink-0" />
              <span className="text-vms-muted font-mono uppercase text-[11px]">TESTING & EVALUATION:</span>
              <span className="text-vms-text text-[11px]">Skip manual setup or auto-fill demo credentials</span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleFillAllDemo}
                title="Auto-fill all 4 steps with standard test credentials"
              >
                Fill Demo Data
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={handleBypassSetup}
                title="Instant bypass into the surveillance workspace"
              >
                Bypass Setup & Test UI
              </Button>
            </div>
          </div>
        )}

        {/* Wizard Steps Navigation Bar */}
        {!isSuccess && !alreadyBootstrapped && (
          <div className="bg-vms-bg border-b border-vms-border px-6 py-3">
            <div className="grid grid-cols-4 gap-2 text-center text-xs">
              {steps.map((s) => (
                <div
                  key={s.num}
                  className={`py-1.5 px-2 rounded border transition-all flex items-center justify-center gap-1.5 ${
                    currentStep === s.num
                      ? 'bg-vms-surface text-vms-text font-semibold border-vms-accent shadow-xs'
                      : currentStep > s.num
                      ? 'bg-vms-panel text-status-live border-status-live/40 font-medium'
                      : 'bg-vms-panel/50 text-vms-dim border-vms-border/60'
                  }`}
                >
                  <span className="w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold font-mono">
                    {currentStep > s.num ? '✓' : s.num}
                  </span>
                  <span className="truncate">{s.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Error Banner */}
        {errorMessage && (
          <div className="mx-6 mt-4 p-3 bg-status-alarm/10 border border-status-alarm/30 rounded text-xs text-status-alarm flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="font-semibold uppercase tracking-wider mb-0.5">Provisioning Fault</div>
              <div className="text-xs text-vms-text leading-relaxed">{errorMessage}</div>
            </div>
          </div>
        )}

        {/* Step Content */}
        <div className="p-6 sm:p-8 flex-1">
          {alreadyBootstrapped ? (
            <div className="text-center py-8 space-y-4">
              <div className="inline-flex w-12 h-12 rounded bg-vms-panel border border-vms-border items-center justify-center text-vms-muted">
                <Server className="w-6 h-6 text-vms-accent" />
              </div>
              <h2 className="text-base font-bold text-vms-text uppercase tracking-wider">
                Appliance Commissioning Completed
              </h2>
              <p className="text-xs text-vms-muted max-w-md mx-auto leading-relaxed">
                This edge surveillance appliance has completed its initial commissioning sequence. The one-time setup
                lock has been cryptographically sealed to prevent unauthorized tenant takeover.
              </p>
              {onSwitchToLogin && (
                <Button
                  variant="primary"
                  onClick={onSwitchToLogin}
                  className="mt-4"
                >
                  Proceed to Operator Login
                </Button>
              )}
            </div>
          ) : isSuccess ? (
            <div className="text-center py-6 space-y-5">
              <div className="inline-flex w-12 h-12 rounded bg-status-live/10 border border-status-live/40 items-center justify-center text-status-live">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <div>
                <h2 className="text-base font-bold text-vms-text uppercase tracking-wider">
                  Commissioning Complete — Lock Sealed
                </h2>
                <p className="text-xs text-vms-muted mt-1 leading-relaxed">
                  VigilOne edge server has provisioned the facility partition, master credential, and evidentiary storage volume.
                </p>
              </div>

              <div className="bg-vms-panel border border-vms-border rounded p-4 max-w-md mx-auto text-left text-xs space-y-2.5">
                <div className="flex justify-between border-b border-vms-border pb-2">
                  <span className="text-vms-dim uppercase font-mono text-[11px]">Facility:</span>
                  <span className="text-vms-text font-semibold">{facilityName}</span>
                </div>
                <div className="flex justify-between border-b border-vms-border pb-2">
                  <span className="text-vms-dim uppercase font-mono text-[11px]">Super Admin:</span>
                  <span className="text-vms-accent font-mono font-semibold">{adminEmail}</span>
                </div>
                <div className="flex justify-between border-b border-vms-border pb-2">
                  <span className="text-vms-dim uppercase font-mono text-[11px]">Timezone:</span>
                  <span className="text-vms-text font-mono">{timezone}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-vms-dim uppercase font-mono text-[11px]">License Entitlement:</span>
                  <Badge variant="live" size="sm">
                    Enterprise (Evaluation 90d)
                  </Badge>
                </div>
              </div>

              <div className="pt-2">
                <Button
                  variant="primary"
                  onClick={handleLaunchConsole}
                  icon={<ChevronRight className="w-4 h-4" />}
                >
                  Launch Surveillance Console
                </Button>
              </div>
            </div>
          ) : (
            <>
              {/* STEP 1: PIN Verification */}
              {currentStep === 1 && (
                <div className="space-y-5">
                  <div>
                    <h2 className="text-sm font-semibold text-vms-text flex items-center gap-2">
                      <KeyRound className="w-4 h-4 text-vms-accent" />
                      <span>Step 1: Appliance Physical Setup PIN</span>
                    </h2>
                    <p className="text-xs text-vms-muted mt-1 leading-relaxed">
                      Enter the one-time authorization PIN printed to the physical terminal during initial Linux installation.
                    </p>
                  </div>

                  <div className="space-y-4">
                    <div>
                      <label className="block text-xs font-medium text-vms-text mb-1.5">
                        Appliance Setup Token / PIN <span className="text-status-alarm">*</span>
                      </label>
                      <div className="relative">
                        <KeyRound className="w-4 h-4 absolute left-3 top-2.5 text-vms-dim" />
                        <input
                          type="password"
                          autoFocus
                          value={setupToken}
                          onChange={(e) => setSetupToken(e.target.value)}
                          placeholder="Paste or enter 32-hex token / PIN"
                          className="w-full bg-vms-bg border border-vms-border rounded pl-9 pr-3 py-2 text-xs text-vms-text font-mono placeholder-vms-dim focus:outline-none focus:border-vms-accent"
                        />
                      </div>
                    </div>

                    <div className="p-4 bg-vms-panel rounded border border-vms-border space-y-2">
                      <div className="font-semibold text-vms-text flex items-center gap-2 text-xs">
                        <Terminal className="w-3.5 h-3.5 text-vms-accent" />
                        <span>Locating Your Setup Token on Appliance</span>
                      </div>
                      <p className="text-xs text-vms-muted leading-relaxed">
                        On the physical appliance terminal or serial console, execute:
                      </p>
                      <div className="bg-vms-bg border border-vms-border rounded p-2.5 text-xs text-vms-accent font-mono flex items-center justify-between">
                        <span>$ sudo vigilonectl token</span>
                        <span className="text-[10px] text-vms-dim uppercase">Host CLI</span>
                      </div>
                      <p className="text-[11px] text-vms-dim leading-relaxed">
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
                    <h2 className="text-sm font-semibold text-vms-text flex items-center gap-2">
                      <Building2 className="w-4 h-4 text-vms-accent" />
                      <span>Step 2: Facility Profile & Legal Timezone</span>
                    </h2>
                    <p className="text-xs text-vms-muted mt-1 leading-relaxed">
                      Configure your installation site name and legal evidentiary timezone reference.
                    </p>
                  </div>

                  <div className="space-y-4">
                    <div>
                      <label className="block text-xs font-medium text-vms-text mb-1.5">
                        Facility / Organization Name <span className="text-status-alarm">*</span>
                      </label>
                      <input
                        type="text"
                        autoFocus
                        value={facilityName}
                        onChange={(e) => setFacilityName(e.target.value)}
                        placeholder="e.g. Metro Logistics Center - Site 1"
                        className="w-full bg-vms-bg border border-vms-border rounded px-3 py-2 text-xs text-vms-text placeholder-vms-dim focus:outline-none focus:border-vms-accent"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-vms-text mb-1.5 flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5 text-vms-dim" />
                        <span>Evidentiary Reference Timezone</span>
                      </label>
                      <select
                        value={timezone}
                        onChange={(e) => setTimezone(e.target.value)}
                        className="w-full bg-vms-bg border border-vms-border rounded px-3 py-2 text-xs text-vms-text focus:outline-none focus:border-vms-accent"
                      >
                        {COMMON_TIMEZONES.map((tz) => (
                          <option key={tz.value} value={tz.value}>
                            {tz.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Section 63 BSA Notice */}
                    <div className="legal-disclaimer space-y-1.5">
                      <div className="text-xs font-semibold text-status-legal uppercase tracking-wider">
                        Section 63 BSA Admissibility Notice
                      </div>
                      <p className="text-xs leading-relaxed text-vms-muted">
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
                    <h2 className="text-sm font-semibold text-vms-text flex items-center gap-2">
                      <UserCheck className="w-4 h-4 text-vms-accent" />
                      <span>Step 3: Super Administrator Master Credential</span>
                    </h2>
                    <p className="text-xs text-vms-muted mt-1 leading-relaxed">
                      Enroll the primary administrative identity holding appliance recovery keys and cryptographic authority.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                    <div>
                      <label className="block text-xs font-medium text-vms-text mb-1">
                        Administrator Full Name <span className="text-status-alarm">*</span>
                      </label>
                      <input
                        type="text"
                        autoFocus
                        value={adminName}
                        onChange={(e) => setAdminName(e.target.value)}
                        placeholder="Security Administrator"
                        className="w-full bg-vms-bg border border-vms-border rounded px-3 py-2 text-xs text-vms-text placeholder-vms-dim focus:outline-none focus:border-vms-accent"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-vms-text mb-1">
                        Super Admin Email <span className="text-status-alarm">*</span>
                      </label>
                      <div className="relative">
                        <Mail className="w-3.5 h-3.5 absolute left-3 top-2.5 text-vms-dim" />
                        <input
                          type="email"
                          value={adminEmail}
                          onChange={(e) => setAdminEmail(e.target.value)}
                          placeholder="admin@facility.local"
                          className="w-full bg-vms-bg border border-vms-border rounded pl-9 pr-3 py-2 text-xs text-vms-text font-mono placeholder-vms-dim focus:outline-none focus:border-vms-accent"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-vms-text mb-1">
                        Master Password <span className="text-status-alarm">*</span>
                      </label>
                      <div className="relative">
                        <Lock className="w-3.5 h-3.5 absolute left-3 top-2.5 text-vms-dim" />
                        <input
                          type="password"
                          value={adminPassword}
                          onChange={(e) => setAdminPassword(e.target.value)}
                          placeholder="Min 12 characters"
                          className="w-full bg-vms-bg border border-vms-border rounded pl-9 pr-3 py-2 text-xs text-vms-text font-mono placeholder-vms-dim focus:outline-none focus:border-vms-accent"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-vms-text mb-1">
                        Confirm Master Password <span className="text-status-alarm">*</span>
                      </label>
                      <div className="relative">
                        <Lock className="w-3.5 h-3.5 absolute left-3 top-2.5 text-vms-dim" />
                        <input
                          type="password"
                          value={confirmPassword}
                          onChange={(e) => setConfirmPassword(e.target.value)}
                          placeholder="Re-type password"
                          className="w-full bg-vms-bg border border-vms-border rounded pl-9 pr-3 py-2 text-xs text-vms-text font-mono placeholder-vms-dim focus:outline-none focus:border-vms-accent"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Password Requirements Checklist */}
                  <div className="p-3 bg-vms-panel rounded border border-vms-border text-xs space-y-2">
                    <div className="text-vms-dim font-mono text-[10px] uppercase tracking-wider font-semibold">
                      Credential Security Requirements:
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                      <div className={`flex items-center gap-1.5 ${hasMinLength ? 'text-status-live' : 'text-vms-dim'}`}>
                        <span>{hasMinLength ? '✓' : '○'}</span>
                        <span>Min 12 characters</span>
                      </div>
                      <div className={`flex items-center gap-1.5 ${hasUppercase ? 'text-status-live' : 'text-vms-dim'}`}>
                        <span>{hasUppercase ? '✓' : '○'}</span>
                        <span>Uppercase (A-Z)</span>
                      </div>
                      <div className={`flex items-center gap-1.5 ${hasLowercase ? 'text-status-live' : 'text-vms-dim'}`}>
                        <span>{hasLowercase ? '✓' : '○'}</span>
                        <span>Lowercase (a-z)</span>
                      </div>
                      <div className={`flex items-center gap-1.5 ${hasNumber ? 'text-status-live' : 'text-vms-dim'}`}>
                        <span>{hasNumber ? '✓' : '○'}</span>
                        <span>Numerical (0-9)</span>
                      </div>
                      <div className={`flex items-center gap-1.5 ${hasSpecial ? 'text-status-live' : 'text-vms-dim'}`}>
                        <span>{hasSpecial ? '✓' : '○'}</span>
                        <span>Special Symbol (!@#$)</span>
                      </div>
                      <div className={`flex items-center gap-1.5 ${passwordsMatch ? 'text-status-live' : 'text-vms-dim'}`}>
                        <span>{passwordsMatch ? '✓' : '○'}</span>
                        <span>Passwords Match</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* STEP 4: TLS Certificate Trust */}
              {currentStep === 4 && (
                <div className="space-y-5">
                  <div>
                    <h2 className="text-sm font-semibold text-vms-text flex items-center gap-2">
                      <ShieldCheck className="w-4 h-4 text-vms-accent" />
                      <span>Step 4: TLS Security & Root CA Attestation</span>
                    </h2>
                    <p className="text-xs text-vms-muted mt-1 leading-relaxed">
                      VigilOne secures all video streams and data with hardware-isolated HTTPS. To eliminate browser warnings on{' '}
                      <strong className="text-vms-accent font-mono">https://vigilone.local</strong>, install the appliance Root CA.
                    </p>
                  </div>

                  {/* Download CA card */}
                  <div className="p-4 bg-vms-panel rounded border border-vms-border flex items-center justify-between">
                    <div className="space-y-0.5">
                      <div className="text-xs font-semibold text-vms-text flex items-center gap-2">
                        <FileCheck className="w-4 h-4 text-vms-accent" />
                        <span>VigilOne Appliance Root CA Certificate</span>
                      </div>
                      <p className="text-xs text-vms-muted">
                        SHA-256 root certificate generated by appliance internal Caddy PKI for local domain resolution.
                      </p>
                    </div>
                    <a
                      href="/ca.crt"
                      download="vigilone-root-ca.crt"
                    >
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<Download className="w-3.5 h-3.5" />}
                      >
                        Download ca.crt
                      </Button>
                    </a>
                  </div>

                  {/* OS-specific Trust Instructions */}
                  <div className="border border-vms-border rounded overflow-hidden bg-vms-panel">
                    <div className="flex border-b border-vms-border bg-vms-surface text-xs">
                      {(['windows', 'mac', 'linux', 'browser'] as const).map((os) => (
                        <button
                          key={os}
                          type="button"
                          onClick={() => setSelectedOsTab(os)}
                          className={`px-3.5 py-2 font-medium capitalize border-r border-vms-border transition ${
                            selectedOsTab === os
                              ? 'bg-vms-panel text-vms-text font-semibold'
                              : 'text-vms-muted hover:text-vms-text'
                          }`}
                        >
                          {os === 'mac' ? 'macOS' : os === 'browser' ? 'Firefox / Chrome' : os}
                        </button>
                      ))}
                    </div>

                    <div className="p-4 text-xs text-vms-muted space-y-2">
                      {selectedOsTab === 'windows' && (
                        <ol className="list-decimal list-inside space-y-1 leading-relaxed">
                          <li>Double-click the downloaded <strong className="font-mono text-vms-text">vigilone-root-ca.crt</strong> file.</li>
                          <li>Click <strong>"Install Certificate..."</strong> and select <strong>Local Machine</strong>.</li>
                          <li>Choose <strong>"Place all certificates in the following store"</strong>.</li>
                          <li>Click Browse and select <strong className="text-vms-accent font-mono">"Trusted Root Certification Authorities"</strong>.</li>
                          <li>Click Next, Finish, and confirm prompt. Restart your browser.</li>
                        </ol>
                      )}

                      {selectedOsTab === 'mac' && (
                        <ol className="list-decimal list-inside space-y-1 leading-relaxed">
                          <li>Double-click <strong className="font-mono text-vms-text">vigilone-root-ca.crt</strong> to open in <strong>Keychain Access</strong>.</li>
                          <li>Add the certificate to the <strong>System</strong> keychain.</li>
                          <li>Find <strong className="text-vms-accent font-mono">Caddy Local Authority</strong>, double click, expand <strong>Trust</strong>.</li>
                          <li>Change "When using this certificate" to <strong className="text-status-live">"Always Trust"</strong>.</li>
                          <li>Save with administrator password and restart browser.</li>
                        </ol>
                      )}

                      {selectedOsTab === 'linux' && (
                        <div className="space-y-1.5 leading-relaxed">
                          <p>Copy certificate to the system trust anchor:</p>
                          <div className="p-2.5 bg-vms-bg text-vms-accent text-xs rounded border border-vms-border font-mono leading-relaxed">
                            sudo cp ca.crt /usr/local/share/ca-certificates/vigilone-ca.crt<br />
                            sudo update-ca-certificates
                          </div>
                        </div>
                      )}

                      {selectedOsTab === 'browser' && (
                        <ol className="list-decimal list-inside space-y-1 leading-relaxed">
                          <li>Open Settings → Privacy & Security → Certificates → View Certificates.</li>
                          <li>Under <strong>Authorities</strong>, click <strong>Import</strong>.</li>
                          <li>Select <strong className="font-mono text-vms-text">vigilone-root-ca.crt</strong>.</li>
                          <li>Check <strong className="text-vms-accent font-mono">"Trust this CA to identify websites"</strong> and click OK.</li>
                        </ol>
                      )}
                    </div>
                  </div>

                  <div className="pt-1">
                    <label className="flex items-start gap-2.5 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={caAcknowledged}
                        onChange={(e) => setCaAcknowledged(e.target.checked)}
                        className="mt-0.5 rounded bg-vms-bg border-vms-border text-vms-accent focus:ring-0"
                      />
                      <span className="text-xs text-vms-text leading-relaxed">
                        I acknowledge that the root certificate is required for warning-free zero-trust HTTPS access to{' '}
                        <strong className="text-vms-accent font-mono">https://vigilone.local</strong>.
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
          <div className="bg-vms-panel border-t border-vms-border px-6 py-3.5 flex items-center justify-between">
            <div>
              {currentStep > 1 ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleBack}
                  disabled={submitting}
                  icon={<ChevronLeft className="w-3.5 h-3.5" />}
                >
                  Previous
                </Button>
              ) : onSwitchToLogin ? (
                <button
                  type="button"
                  onClick={onSwitchToLogin}
                  className="text-xs text-vms-muted hover:text-vms-accent transition"
                >
                  Switch to Operator Login
                </button>
              ) : null}
            </div>

            <div>
              {currentStep < 4 ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleNext}
                >
                  <span>Next Step</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleCompleteBootstrap}
                  isLoading={submitting}
                  disabled={!caAcknowledged}
                  icon={<ShieldCheck className="w-4 h-4" />}
                >
                  Complete Commissioning
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default FirstRunWizard;
