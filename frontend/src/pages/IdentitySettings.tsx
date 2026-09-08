import React, { useState, useEffect } from 'react';
import {
  KeyRound,
  Shield,
  Clock,
  Lock,
  Unlock,
  Plus,
  Trash2,
  CheckCircle2,
  LogOut,
} from 'lucide-react';
import api from '../services/api';

interface IdentityProviderItem {
  id: string;
  name: string;
  type: string;
  issuerUrl: string;
  clientId: string;
  scopes: string[];
  enabled: boolean;
  createdAt: string;
}

interface UserSessionItem {
  id: string;
  state: 'ACTIVE' | 'LOCKED' | 'REVOKED' | 'EXPIRED';
  createdAt: string;
  lastActivityAt: string;
  expiresAt: string;
}

export const IdentitySettings: React.FC = () => {
  const [providers, setProviders] = useState<IdentityProviderItem[]>([]);
  const [sessions, setSessions] = useState<UserSessionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);

  // New Provider Form
  const [name, setName] = useState('');
  const [issuerUrl, setIssuerUrl] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [scopes, setScopes] = useState('openid profile email');
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [provRes, sessRes] = await Promise.all([
        api.get('/sso/providers').catch(() => ({ data: [] })),
        api.get('/sso/sessions').catch(() => ({ data: [] })),
      ]);
      setProviders(provRes.data || []);
      setSessions(sessRes.data || []);
    } catch (err: any) {
      console.error('Failed to load identity settings:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateProvider = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    try {
      await api.post('/sso/providers', {
        name,
        issuerUrl,
        clientId,
        clientSecret,
        scopes: scopes.split(' ').filter(Boolean),
      });
      setShowAddModal(false);
      setName('');
      setIssuerUrl('');
      setClientId('');
      setClientSecret('');
      setNotice('Enterprise Identity Provider configured successfully');
      loadData();
    } catch (err: any) {
      setFormError(err.response?.data?.error || err.message || 'Failed to create provider');
    }
  };

  const handleDeleteProvider = async (id: string) => {
    if (!confirm('Are you sure you want to remove this Identity Provider?')) return;
    try {
      await api.delete(`/sso/providers/${id}`);
      setNotice('Identity Provider removed');
      loadData();
    } catch (err: any) {
      alert(err.response?.data?.error || err.message);
    }
  };

  const handleUnlockSession = async (sessionId: string) => {
    try {
      await api.post(`/sso/sessions/${sessionId}/unlock`);
      setNotice('Session unlocked');
      loadData();
    } catch (err: any) {
      alert(err.response?.data?.error || err.message);
    }
  };

  const handleRevokeSession = async (sessionId: string) => {
    try {
      await api.post(`/sso/sessions/${sessionId}/revoke`);
      setNotice('Session revoked');
      loadData();
    } catch (err: any) {
      alert(err.response?.data?.error || err.message);
    }
  };

  const handleRevokeAll = async () => {
    if (!confirm('Revoke all workstation sessions for this account?')) return;
    try {
      await api.post('/sso/sessions/revoke-all');
      setNotice('All active sessions revoked');
      loadData();
    } catch (err: any) {
      alert(err.response?.data?.error || err.message);
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6 text-slate-100 font-sans select-none">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-4">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <KeyRound className="w-6 h-6 text-amber-400" />
            <span>Enterprise Identity, SSO & Session Governance</span>
          </h1>
          <p className="text-xs text-slate-400 font-mono mt-1">
            Configure OpenID Connect (OIDC) identity federation, role mapping, and workstation auto-lock.
          </p>
        </div>

        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-graphite-900 font-semibold text-xs rounded transition shadow"
        >
          <Plus className="w-4 h-4" />
          <span>Add OIDC Provider</span>
        </button>
      </div>

      {loading && (
        <div className="p-4 bg-slate-800/40 border border-slate-700 rounded text-center text-xs font-mono text-slate-400 animate-pulse">
          Loading identity federation profiles and active user sessions...
        </div>
      )}

      {notice && (
        <div className="p-3 bg-emerald-950/40 border border-emerald-800/80 rounded text-emerald-300 text-xs flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {/* Identity Providers Table */}
      <div className="bg-graphite-800 border border-slate-700 rounded-lg p-5 space-y-4 shadow">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-200 flex items-center gap-2">
          <Shield className="w-4 h-4 text-cyan-400" />
          <span>Configured Identity Providers</span>
        </h2>

        {providers.length === 0 ? (
          <div className="p-6 bg-graphite-900 border border-slate-800 rounded text-center text-slate-500 font-mono text-xs">
            No external identity providers configured. Local database credentials active.
          </div>
        ) : (
          <div className="border border-slate-700 rounded overflow-hidden divide-y divide-slate-800 bg-graphite-900">
            {providers.map((p) => (
              <div key={p.id} className="p-4 flex items-center justify-between hover:bg-slate-800/30 transition">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-200 text-xs">{p.name}</span>
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">
                      {p.type}
                    </span>
                    {p.enabled && (
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/20 text-emerald-400">
                        ENABLED
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] font-mono text-slate-400">{p.issuerUrl}</div>
                  <div className="text-[10px] font-mono text-slate-500">Client ID: {p.clientId}</div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleDeleteProvider(p.id)}
                    className="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-slate-800 rounded transition"
                    title="Remove Provider"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Active Workstation Sessions */}
      <div className="bg-graphite-800 border border-slate-700 rounded-lg p-5 space-y-4 shadow">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-200 flex items-center gap-2">
            <Clock className="w-4 h-4 text-amber-400" />
            <span>Active Workstation Sessions & Inactivity Locks</span>
          </h2>
          <button
            onClick={handleRevokeAll}
            className="flex items-center gap-1.5 px-3 py-1 bg-rose-950/60 hover:bg-rose-900 text-rose-300 border border-rose-800/80 rounded font-mono text-xs transition"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Revoke All Sessions</span>
          </button>
        </div>

        <div className="border border-slate-700 rounded overflow-hidden divide-y divide-slate-800 bg-graphite-900">
          {sessions.length === 0 ? (
            <div className="p-4 text-center text-slate-500 font-mono text-xs">
              No active sessions found.
            </div>
          ) : (
            sessions.map((sess) => (
              <div key={sess.id} className="p-3 flex items-center justify-between hover:bg-slate-800/30 transition">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-slate-300 font-medium">{sess.id}</span>
                    {sess.state === 'ACTIVE' ? (
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/20 text-emerald-400 flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" /> ACTIVE
                      </span>
                    ) : sess.state === 'LOCKED' ? (
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-amber-500/20 text-amber-400 flex items-center gap-1">
                        <Lock className="w-3 h-3" /> LOCKED (INACTIVITY)
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-500/20 text-slate-400">
                        {sess.state}
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] font-mono text-slate-500">
                    Last active: {new Date(sess.lastActivityAt).toLocaleString()} | Expires:{' '}
                    {new Date(sess.expiresAt).toLocaleTimeString()}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {sess.state === 'LOCKED' && (
                    <button
                      onClick={() => handleUnlockSession(sess.id)}
                      className="px-2.5 py-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 rounded font-mono text-xs flex items-center gap-1"
                    >
                      <Unlock className="w-3 h-3" /> Unlock
                    </button>
                  )}
                  {sess.state !== 'REVOKED' && (
                    <button
                      onClick={() => handleRevokeSession(sess.id)}
                      className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded font-mono text-xs"
                    >
                      Revoke
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Add Provider Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-graphite-800 border border-slate-700 rounded-lg max-w-lg w-full p-6 shadow-2xl space-y-4">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-100 border-b border-slate-700 pb-2">
              Configure OpenID Connect (OIDC) Provider
            </h3>

            {formError && (
              <div className="p-3 bg-rose-950/40 border border-rose-800/80 rounded text-rose-300 text-xs">
                {formError}
              </div>
            )}

            <form onSubmit={handleCreateProvider} className="space-y-4 text-xs font-mono">
              <div>
                <label className="text-slate-400 block mb-1">Provider Name</label>
                <input
                  type="text"
                  placeholder="e.g. Okta / Azure AD / Keycloak"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full bg-graphite-900 border border-slate-700 rounded p-2 text-slate-200"
                  required
                />
              </div>

              <div>
                <label className="text-slate-400 block mb-1">Issuer URL (Discovery Endpoint)</label>
                <input
                  type="url"
                  placeholder="https://auth.enterprise.com/oauth2/v1"
                  value={issuerUrl}
                  onChange={(e) => setIssuerUrl(e.target.value)}
                  className="w-full bg-graphite-900 border border-slate-700 rounded p-2 text-slate-200"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-slate-400 block mb-1">Client ID</label>
                  <input
                    type="text"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    className="w-full bg-graphite-900 border border-slate-700 rounded p-2 text-slate-200"
                    required
                  />
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">Client Secret</label>
                  <input
                    type="password"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    className="w-full bg-graphite-900 border border-slate-700 rounded p-2 text-slate-200"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="text-slate-400 block mb-1">Requested Scopes (space-separated)</label>
                <input
                  type="text"
                  value={scopes}
                  onChange={(e) => setScopes(e.target.value)}
                  className="w-full bg-graphite-900 border border-slate-700 rounded p-2 text-slate-200"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-700">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-amber-500 hover:bg-amber-400 text-graphite-900 font-bold rounded"
                >
                  Save Provider
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default IdentitySettings;
