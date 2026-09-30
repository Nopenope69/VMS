import React, { useEffect, useState } from 'react';
import { Radio, Lock, Mail, ShieldAlert, KeyRound, Building2, User, Zap } from 'lucide-react';
import api from '../services/api';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { DEMO_FORM_PREFILL, DEMO_TOKEN, DEMO_USER } from '../demo/fixtures';

const SSO_ERRORS: Record<string, string> = {
  NO_ACCOUNT: 'Your identity was verified, but there is no VigilOne account for it. Ask an administrator.',
  EMAIL_NOT_VERIFIED: 'Your identity provider did not confirm your email address, so it cannot be matched to an account.',
  EMAIL_DOMAIN_NOT_ALLOWED: 'Your email domain is not allowed to sign in through this provider.',
  ACCOUNT_DISABLED: 'Your VigilOne account is disabled.',
  ACCOUNT_IN_OTHER_TENANT: 'Your account belongs to another organisation on this system.',
  SUPER_ADMIN_NOT_VIA_SSO: 'Super administrators sign in with their password.',
  LOGIN_EXPIRED_OR_REPLAYED: 'The sign-in took too long or was already used. Please try again.',
};

interface LoginProps {
  onLoginSuccess: (user: any, token: string) => void;
}

export const Login: React.FC<LoginProps> = ({ onLoginSuccess }) => {
  const [isBootstrap, setIsBootstrap] = useState(false);

  // Login form
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Bootstrap form
  const [tenantName, setTenantName] = useState('');
  const [adminName, setAdminName] = useState('');
  const [setupToken, setSetupToken] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [ssoProviders, setSsoProviders] = useState<{ id: string; name: string }[]>([]);

  // Phase 8 single sign-on. Providers are listed only when OIDC_SSO is on (otherwise the call fails and none show).
  // The provider sends the browser back through the backend to /sso/complete#code=... (or #error=...); the one-time
  // code is exchanged for a session here and removed from the address bar.
  useEffect(() => {
    api
      .get('/sso/login-options')
      .then((res) => setSsoProviders(res.data?.providers || []))
      .catch(() => setSsoProviders([]));
    if (window.location.pathname !== '/sso/complete') return;
    const params = new URLSearchParams(window.location.hash.slice(1));
    window.history.replaceState(null, '', '/');
    const code = params.get('code');
    const ssoError = params.get('error');
    if (ssoError) {
      setError(SSO_ERRORS[ssoError] || `Single sign-on failed (${ssoError}).`);
      return;
    }
    if (!code) return;
    setLoading(true);
    api
      .post('/sso/exchange', { code })
      .then((res) => onLoginSuccess(res.data.user, res.data.token))
      .catch((err) => setError(err.response?.data?.error || 'Single sign-on failed.'))
      .finally(() => setLoading(false));
    // Once per page load: the one-time code must not be exchanged twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Demo-only helpers: compiled out of production builds (__DEMO_MODE__ === false).
  const handleBypassDemo = () => {
    if (!__DEMO_MODE__) return;
    onLoginSuccess(DEMO_USER, DEMO_TOKEN);
  };

  const handleFillDemo = () => {
    if (!__DEMO_MODE__) return;
    if (isBootstrap) {
      setTenantName(DEMO_FORM_PREFILL.facilityName);
      setAdminName(DEMO_FORM_PREFILL.adminName);
      setEmail(DEMO_FORM_PREFILL.email);
      setPassword(DEMO_FORM_PREFILL.password);
      setSetupToken(DEMO_FORM_PREFILL.setupToken);
    } else {
      setEmail(DEMO_FORM_PREFILL.email);
      setPassword(DEMO_FORM_PREFILL.password);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      if (isBootstrap) {
        const res = await api.post(
          '/auth/bootstrap',
          {
            tenantName,
            adminEmail: email,
            adminPassword: password,
            adminName,
          },
          {
            headers: { 'X-Setup-Token': setupToken },
          }
        );

        onLoginSuccess(res.data.user, res.data.token);
      } else {
        const res = await api.post('/auth/login', { email, password });
        onLoginSuccess(res.data.user, res.data.token);
      }
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-vms-bg flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-4">
        {/* Brand Header */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded bg-vms-panel border border-vms-border mb-1 shadow-sm">
            <Radio className="w-6 h-6 text-vms-accent" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-vms-text">
              VigilOne VMS
            </h1>
            <p className="text-xs text-vms-muted mt-0.5">
              Edge-First Commercial Video Management System
            </p>
          </div>

          <div className="flex items-center justify-center gap-2 pt-1">
            <Badge variant="live" size="sm" dot>
              Local NVR Appliance
            </Badge>
            <Badge variant="outline" size="sm">
              Strict RBAC
            </Badge>
          </div>
        </div>

        {/* Login Card */}
        <Card padding="lg" className="shadow-2xl space-y-4">
          {/* Demo-build-only banner (VITE_DEMO_MODE=true); absent from production bundles */}
          {__DEMO_MODE__ && (
          <div className="p-3 bg-vms-panel border border-vms-accent/40 rounded flex flex-col gap-2.5">
            <div className="flex items-start gap-2">
              <Zap className="w-4 h-4 text-vms-accent flex-shrink-0 mt-0.5" />
              <div>
                <div className="text-xs font-semibold text-vms-text font-mono">
                  UI/UX Evaluation & Testing Mode
                </div>
                <div className="text-[11px] text-vms-muted leading-tight mt-0.5">
                  Bypass login immediately or auto-fill standard credentials to test all 15 operational consoles.
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 pt-1 border-t border-vms-border/60">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleFillDemo}
                title="Pre-fill form with standard test credentials"
              >
                Fill Credentials
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={handleBypassDemo}
                title="Instantly bypass login as Super Admin"
              >
                Bypass & Test UI
              </Button>
            </div>
          </div>
          )}

          {error && (
            <div className="p-3 bg-status-alarm/10 border border-status-alarm/30 rounded text-xs text-status-alarm flex items-center gap-2.5">
              <ShieldAlert className="w-4 h-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-4 text-xs">
            {isBootstrap && (
              <>
                <div>
                  <label className="block text-xs font-medium text-vms-text mb-1">
                    Facility / Tenant Name
                  </label>
                  <div className="relative">
                    <Building2 className="w-4 h-4 absolute left-3 top-2.5 text-vms-dim" />
                    <input
                      type="text"
                      required
                      placeholder="e.g. Central Command Facility"
                      value={tenantName}
                      onChange={(e) => setTenantName(e.target.value)}
                      className="w-full bg-vms-bg border border-vms-border rounded pl-9 pr-3 py-2 text-xs text-vms-text placeholder-vms-dim focus:outline-none focus:border-vms-accent"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-vms-text mb-1">
                    Administrator Full Name
                  </label>
                  <div className="relative">
                    <User className="w-4 h-4 absolute left-3 top-2.5 text-vms-dim" />
                    <input
                      type="text"
                      required
                      placeholder="e.g. Chief Security Officer"
                      value={adminName}
                      onChange={(e) => setAdminName(e.target.value)}
                      className="w-full bg-vms-bg border border-vms-border rounded pl-9 pr-3 py-2 text-xs text-vms-text placeholder-vms-dim focus:outline-none focus:border-vms-accent"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-vms-text mb-1">
                    Appliance Setup PIN / Token
                  </label>
                  <div className="relative">
                    <KeyRound className="w-4 h-4 absolute left-3 top-2.5 text-vms-dim" />
                    <input
                      type="password"
                      required
                      placeholder="Enter hardware initialization token"
                      value={setupToken}
                      onChange={(e) => setSetupToken(e.target.value)}
                      className="w-full bg-vms-bg border border-vms-border rounded pl-9 pr-3 py-2 text-xs text-vms-text placeholder-vms-dim focus:outline-none focus:border-vms-accent font-mono"
                    />
                  </div>
                </div>
              </>
            )}

            <div>
              <label className="block text-xs font-medium text-vms-text mb-1">
                Operator Identity (Email)
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 absolute left-3 top-2.5 text-vms-dim" />
                <input
                  type="email"
                  required
                  placeholder="operator@facility.local"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full bg-vms-bg border border-vms-border rounded pl-9 pr-3 py-2 text-xs text-vms-text placeholder-vms-dim focus:outline-none focus:border-vms-accent font-mono"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-vms-text mb-1">
                Security Credential (Password)
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 absolute left-3 top-2.5 text-vms-dim" />
                <input
                  type="password"
                  required
                  placeholder="••••••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-vms-bg border border-vms-border rounded pl-9 pr-3 py-2 text-xs text-vms-text placeholder-vms-dim focus:outline-none focus:border-vms-accent font-mono"
                />
              </div>
            </div>

            <Button
              type="submit"
              variant="primary"
              isLoading={loading}
              className="w-full justify-center py-2 text-xs font-semibold mt-2"
            >
              {isBootstrap ? 'Initialize First-Run Tenant' : 'Sign In to Console'}
            </Button>
          </form>

          {!isBootstrap && ssoProviders.length > 0 && (
            <div className="mt-4 space-y-2">
              {ssoProviders.map((p) => (
                <a
                  key={p.id}
                  href={`/api/v1/sso/authorize/${encodeURIComponent(p.id)}`}
                  className="block w-full text-center border border-vms-border rounded py-2 text-xs text-vms-text hover:border-vms-accent transition"
                >
                  Sign in with {p.name}
                </a>
              ))}
            </div>
          )}

          <div className="mt-5 pt-4 text-center border-t border-vms-border">
            <button
              type="button"
              onClick={() => {
                setIsBootstrap(!isBootstrap);
                setError('');
              }}
              className="text-xs text-vms-muted hover:text-vms-accent transition"
            >
              {isBootstrap ? '← Return to Operator Login' : 'Initial Appliance Setup / Bootstrap →'}
            </button>
          </div>
        </Card>

        <div className="text-center text-[11px] text-vms-dim">
          Air-gapped NVR node • Compliant with Section 63 BSA
        </div>
      </div>
    </div>
  );
};

export default Login;
