import React, { useState } from 'react';
import { Radio, Lock, Mail, ShieldAlert, KeyRound } from 'lucide-react';
import api from '../services/api';

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
    <div className="min-h-screen bg-graphite-900 flex items-center justify-center p-4 selection:bg-cctv-amber/30">
      <div className="bg-graphite-850 border border-graphite-700 rounded-lg w-full max-w-md p-8 shadow-2xl space-y-6">
        {/* Brand Header */}
        <div className="text-center space-y-2">
          <div className="inline-flex w-12 h-12 rounded-lg bg-cctv-amber/20 border border-cctv-amber/60 items-center justify-center mb-1 shadow-inner">
            <Radio className="w-6 h-6 text-cctv-amber" />
          </div>
          <h1 className="text-lg font-bold tracking-wider text-white uppercase">VigilOne VMS</h1>
          <p className="text-xs font-mono text-slate-400">Commercial Edge-First CCTV Surveillance Appliance</p>
        </div>

        {error && (
          <div className="p-3 bg-red-900/40 border border-red-500 rounded text-xs text-red-200 flex items-center space-x-2">
            <ShieldAlert className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-4">
          {isBootstrap && (
            <>
              <div>
                <label className="block text-xs font-mono text-slate-300 mb-1">Facility / Tenant Name</label>
                <input
                  type="text"
                  required
                  value={tenantName}
                  onChange={(e) => setTenantName(e.target.value)}
                  className="w-full bg-graphite-900 border border-graphite-700 rounded px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-cctv-amber"
                />
              </div>

              <div>
                <label className="block text-xs font-mono text-slate-300 mb-1">Administrator Full Name</label>
                <input
                  type="text"
                  required
                  value={adminName}
                  onChange={(e) => setAdminName(e.target.value)}
                  className="w-full bg-graphite-900 border border-graphite-700 rounded px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-cctv-amber"
                />
              </div>

              <div>
                <label className="block text-xs font-mono text-slate-300 mb-1">Appliance Setup Token</label>
                <div className="relative">
                  <KeyRound className="w-4 h-4 absolute left-3 top-2.5 text-slate-500" />
                  <input
                    type="password"
                    required
                    value={setupToken}
                    onChange={(e) => setSetupToken(e.target.value)}
                    className="w-full bg-graphite-900 border border-graphite-700 rounded pl-9 pr-3 py-2 text-xs text-slate-200 font-mono focus:outline-none focus:border-cctv-amber"
                  />
                </div>
              </div>
            </>
          )}

          <div>
            <label className="block text-xs font-mono text-slate-300 mb-1">Operator Email</label>
            <div className="relative">
              <Mail className="w-4 h-4 absolute left-3 top-2.5 text-slate-500" />
              <input
                type="email"
                required
                placeholder="operator@facility.local"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-graphite-900 border border-graphite-700 rounded pl-9 pr-3 py-2 text-xs text-slate-200 font-mono focus:outline-none focus:border-cctv-amber"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-mono text-slate-300 mb-1">Security Password</label>
            <div className="relative">
              <Lock className="w-4 h-4 absolute left-3 top-2.5 text-slate-500" />
              <input
                type="password"
                required
                placeholder="••••••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-graphite-900 border border-graphite-700 rounded pl-9 pr-3 py-2 text-xs text-slate-200 font-mono focus:outline-none focus:border-cctv-amber"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 rounded bg-cctv-amber text-graphite-900 font-semibold text-xs tracking-wider uppercase hover:bg-amber-400 transition disabled:opacity-50 shadow-md"
          >
            {loading ? 'Authenticating...' : isBootstrap ? 'Bootstrap First-Run Tenant' : 'Sign In to Surveillance Console'}
          </button>
        </form>

        <div className="pt-2 text-center border-t border-graphite-700">
          <button
            type="button"
            onClick={() => {
              setIsBootstrap(!isBootstrap);
              setError('');
            }}
            className="text-xs font-mono text-slate-400 hover:text-cctv-amber transition"
          >
            {isBootstrap ? 'Back to Operator Login' : 'Initial Appliance Setup / First-Run Bootstrap'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default Login;
