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
    <div className="min-h-screen bg-[#080B10] flex items-center justify-center p-4 selection:bg-[#E3B341]/30 font-mono text-[#C9D1D9] relative overflow-hidden">
      {/* Background Decorative Reticles */}
      <div className="absolute top-6 left-6 text-[#21262D] text-xs select-none pointer-events-none">+</div>
      <div className="absolute top-6 right-6 text-[#21262D] text-xs select-none pointer-events-none">+</div>
      <div className="absolute bottom-6 left-6 text-[#21262D] text-xs select-none pointer-events-none">+</div>
      <div className="absolute bottom-6 right-6 text-[#21262D] text-xs select-none pointer-events-none">+</div>

      <div className="bg-[#0D1117] border border-[#30363D] rounded-none w-full max-w-md p-6 shadow-2xl space-y-5 relative">
        {/* Optical Corner Reticles */}
        <div className="absolute top-1.5 left-1.5 text-[#30363D] text-[10px] select-none pointer-events-none">+</div>
        <div className="absolute top-1.5 right-1.5 text-[#30363D] text-[10px] select-none pointer-events-none">+</div>
        <div className="absolute bottom-1.5 left-1.5 text-[#30363D] text-[10px] select-none pointer-events-none">+</div>
        <div className="absolute bottom-1.5 right-1.5 text-[#30363D] text-[10px] select-none pointer-events-none">+</div>

        {/* Brand & Telemetry Header */}
        <div className="text-center space-y-2 border-b border-[#21262D] pb-4">
          <div className="inline-flex items-center justify-center w-10 h-10 bg-[#161B22] border border-[#30363D] mb-1">
            <Radio className="w-5 h-5 text-[#E3B341]" />
          </div>
          <div>
            <h1 className="text-sm font-bold tracking-widest text-white uppercase">
              [ VIGILONE APPLIANCE TERMINAL ]
            </h1>
            <p className="text-[10px] text-[#8B949E] mt-0.5">
              AIR-GAPPED COMMERCIAL CCTV SURVEILLANCE NODE
            </p>
          </div>

          <div className="inline-flex items-center space-x-2 bg-[#080B10] border border-[#21262D] px-2 py-0.5 text-[9px] text-[#8B949E]">
            <span>NODE: <strong className="text-[#3FB950]">LOCAL_NVR_01</strong></span>
            <span>//</span>
            <span>SEC_LEVEL: <strong className="text-[#58A6FF]">STRICT_RBAC</strong></span>
          </div>
        </div>

        {error && (
          <div className="p-2.5 bg-[#080B10] border border-[#F85149] text-xs text-[#F85149] flex items-center space-x-2">
            <ShieldAlert className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-3.5 text-xs">
          {isBootstrap && (
            <>
              <div>
                <label className="block text-[10px] uppercase text-[#8B949E] mb-1">
                  FACILITY_OR_TENANT_NAME:
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Central Command Facility"
                  value={tenantName}
                  onChange={(e) => setTenantName(e.target.value)}
                  className="w-full bg-[#080B10] border border-[#30363D] px-2.5 py-1.5 text-xs text-[#C9D1D9] focus:outline-none focus:border-[#E3B341]"
                />
              </div>

              <div>
                <label className="block text-[10px] uppercase text-[#8B949E] mb-1">
                  ADMINISTRATOR_FULL_NAME:
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Chief Security Officer"
                  value={adminName}
                  onChange={(e) => setAdminName(e.target.value)}
                  className="w-full bg-[#080B10] border border-[#30363D] px-2.5 py-1.5 text-xs text-[#C9D1D9] focus:outline-none focus:border-[#E3B341]"
                />
              </div>

              <div>
                <label className="block text-[10px] uppercase text-[#8B949E] mb-1">
                  APPLIANCE_SETUP_TOKEN:
                </label>
                <div className="relative">
                  <KeyRound className="w-3.5 h-3.5 absolute left-2.5 top-2 text-[#8B949E]" />
                  <input
                    type="password"
                    required
                    placeholder="Enter hardware initialization token"
                    value={setupToken}
                    onChange={(e) => setSetupToken(e.target.value)}
                    className="w-full bg-[#080B10] border border-[#30363D] pl-8 pr-2.5 py-1.5 text-xs text-[#C9D1D9] focus:outline-none focus:border-[#E3B341]"
                  />
                </div>
              </div>
            </>
          )}

          <div>
            <label className="block text-[10px] uppercase text-[#8B949E] mb-1">
              OPERATOR_IDENTITY (EMAIL):
            </label>
            <div className="relative">
              <Mail className="w-3.5 h-3.5 absolute left-2.5 top-2 text-[#8B949E]" />
              <input
                type="email"
                required
                placeholder="operator@facility.local"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-[#080B10] border border-[#30363D] pl-8 pr-2.5 py-1.5 text-xs text-[#C9D1D9] focus:outline-none focus:border-[#E3B341]"
              />
            </div>
          </div>

          <div>
            <label className="block text-[10px] uppercase text-[#8B949E] mb-1">
              SECURITY_KEY (PASSWORD):
            </label>
            <div className="relative">
              <Lock className="w-3.5 h-3.5 absolute left-2.5 top-2 text-[#8B949E]" />
              <input
                type="password"
                required
                placeholder="••••••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-[#080B10] border border-[#30363D] pl-8 pr-2.5 py-1.5 text-xs text-[#C9D1D9] focus:outline-none focus:border-[#E3B341]"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 bg-[#E3B341] text-[#080B10] font-bold text-xs tracking-wider uppercase hover:bg-[#F2CC60] transition-colors disabled:opacity-50 mt-2"
          >
            {loading ? '[ AUTHENTICATING ACCESS... ]' : isBootstrap ? '[ INITIALIZE FIRST-RUN TENANT ]' : '[ AUTHENTICATE OPERATOR ]'}
          </button>
        </form>

        <div className="pt-2 text-center border-t border-[#21262D]">
          <button
            type="button"
            onClick={() => {
              setIsBootstrap(!isBootstrap);
              setError('');
            }}
            className="text-[11px] text-[#8B949E] hover:text-[#E3B341] transition-colors"
          >
            {isBootstrap ? '[ ← RETURN TO OPERATOR LOGIN ]' : '[ INITIAL APPLIANCE SETUP // BOOTSTRAP → ]'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default Login;
