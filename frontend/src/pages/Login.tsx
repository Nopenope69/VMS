import React, { useState } from 'react';
import { Radio, Lock, Mail, ShieldAlert, KeyRound, Building2, User, Zap } from 'lucide-react';
import api from '../services/api';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';

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

  const handleBypassDemo = () => {
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
    onLoginSuccess(demoUser, demoToken);
  };

  const handleFillDemo = () => {
    if (isBootstrap) {
      setTenantName('Metro Transit Command Facility');
      setAdminName('Alex Vance (Chief Security Officer)');
      setEmail('admin@vigilone.local');
      setPassword('Password123!');
      setSetupToken('vigilone_dev_setup_token_99182');
    } else {
      setEmail('admin@vigilone.local');
      setPassword('Password123!');
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
          {/* Quick Test / Demo Bypass Banner */}
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
