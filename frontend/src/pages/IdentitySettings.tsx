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
  AlertTriangle,
} from 'lucide-react';
import api from '../services/api';
import Modal, { ConfirmModal } from '../components/ui/Modal';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';

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
  const [providerToDelete, setProviderToDelete] = useState<string | null>(null);
  const [showConfirmRevokeAll, setShowConfirmRevokeAll] = useState(false);

  // New Provider Form
  const [name, setName] = useState('');
  const [issuerUrl, setIssuerUrl] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [scopes, setScopes] = useState('openid profile email');
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const handleDeleteProvider = (id: string) => {
    setProviderToDelete(id);
  };

  const confirmDelete = async () => {
    if (!providerToDelete) return;
    try {
      setError(null);
      await api.delete(`/sso/providers/${providerToDelete}`);
      setNotice('Identity Provider removed');
      setProviderToDelete(null);
      loadData();
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to remove provider');
      setProviderToDelete(null);
    }
  };

  const handleUnlockSession = async (sessionId: string) => {
    try {
      setError(null);
      await api.post(`/sso/sessions/${sessionId}/unlock`);
      setNotice('Session unlocked');
      loadData();
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to unlock session');
    }
  };

  const handleRevokeSession = async (sessionId: string) => {
    try {
      setError(null);
      await api.post(`/sso/sessions/${sessionId}/revoke`);
      setNotice('Session revoked');
      loadData();
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to revoke session');
    }
  };

  const handleRevokeAll = () => {
    setShowConfirmRevokeAll(true);
  };

  const confirmRevokeAll = async () => {
    try {
      setError(null);
      await api.post('/sso/sessions/revoke-all');
      setNotice('All active sessions revoked');
      setShowConfirmRevokeAll(false);
      loadData();
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to revoke sessions');
      setShowConfirmRevokeAll(false);
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6 text-vms-text font-sans select-none">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-vms-border pb-4">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <KeyRound className="w-6 h-6 text-vms-accent" />
            <span>Enterprise Identity, SSO & Session Governance</span>
          </h1>
          <p className="text-xs text-vms-muted font-mono mt-1">
            Configure OpenID Connect (OIDC) identity federation, role mapping, and workstation auto-lock.
          </p>
        </div>

        <Button
          onClick={() => setShowAddModal(true)}
          variant="primary"
          size="sm"
          className="flex items-center gap-1.5"
        >
          <Plus className="w-4 h-4" />
          <span>Add OIDC Provider</span>
        </Button>
      </div>

      {loading && (
        <div className="p-4 bg-vms-panel/40 border border-vms-border rounded text-center text-xs font-mono text-vms-muted animate-pulse">
          Loading identity federation profiles and active user sessions...
        </div>
      )}

      {notice && (
        <div className="p-3 bg-emerald-950/40 border border-emerald-800/80 rounded text-emerald-300 text-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
            <span>{notice}</span>
          </div>
          <button onClick={() => setNotice(null)} className="hover:opacity-75 text-xs font-bold" aria-label="Dismiss notice">✕</button>
        </div>
      )}

      {error && (
        <div className="p-3 bg-rose-950/40 border border-rose-800/80 rounded text-rose-300 text-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
          <button onClick={() => setError(null)} className="hover:opacity-75 text-xs font-bold" aria-label="Dismiss error">✕</button>
        </div>
      )}

      {/* Identity Providers Table */}
      <div className="bg-vms-surface border border-vms-border rounded-lg p-5 space-y-4 shadow">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-vms-text flex items-center gap-2">
          <Shield className="w-4 h-4 text-sky-400" />
          <span>Configured Identity Providers</span>
        </h2>

        {providers.length === 0 ? (
          <div className="p-6 bg-vms-panel border border-vms-border rounded text-center text-vms-dim font-mono text-xs">
            No external identity providers configured. Local database credentials active.
          </div>
        ) : (
          <div className="border border-vms-border rounded overflow-hidden divide-y divide-vms-border bg-vms-panel">
            {providers.map((p) => (
              <div key={p.id} className="p-4 flex items-center justify-between hover:bg-vms-hover/40 transition">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-vms-text text-xs">{p.name}</span>
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-sky-500/20 text-sky-400 border border-sky-500/30">
                      {p.type}
                    </span>
                    {p.enabled && (
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/20 text-emerald-400">
                        ENABLED
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] font-mono text-vms-muted">{p.issuerUrl}</div>
                  <div className="text-[10px] font-mono text-vms-dim">Client ID: {p.clientId}</div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleDeleteProvider(p.id)}
                    className="p-1.5 text-vms-muted hover:text-rose-400 hover:bg-vms-surface rounded transition"
                    title="Remove Provider"
                    aria-label={`Remove provider ${p.name}`}
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
      <div className="bg-vms-surface border border-vms-border rounded-lg p-5 space-y-4 shadow">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-vms-text flex items-center gap-2">
            <Clock className="w-4 h-4 text-vms-accent" />
            <span>Active Workstation Sessions & Inactivity Locks</span>
          </h2>
          <Button
            onClick={handleRevokeAll}
            variant="danger"
            size="sm"
            className="flex items-center gap-1.5"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Revoke All Sessions</span>
          </Button>
        </div>

        <div className="border border-vms-border rounded overflow-hidden divide-y divide-vms-border bg-vms-panel">
          {sessions.length === 0 ? (
            <div className="p-4 text-center text-vms-dim font-mono text-xs">
              No active sessions found.
            </div>
          ) : (
            sessions.map((sess) => (
              <div key={sess.id} className="p-3 flex items-center justify-between hover:bg-vms-hover/40 transition">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-vms-text font-medium">{sess.id}</span>
                    {sess.state === 'ACTIVE' ? (
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/20 text-emerald-400 flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" /> ACTIVE
                      </span>
                    ) : sess.state === 'LOCKED' ? (
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-amber-500/20 text-amber-400 flex items-center gap-1">
                        <Lock className="w-3 h-3" /> LOCKED (INACTIVITY)
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-500/20 text-vms-muted">
                        {sess.state}
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] font-mono text-vms-dim">
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
                      className="px-2.5 py-1 bg-vms-elevated hover:bg-vms-surface text-vms-text rounded font-mono text-xs"
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
      <Modal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        title="Configure OpenID Connect (OIDC) Provider"
        maxWidth="lg"
      >
        <div className="space-y-4">
          {formError && (
            <div className="p-3 bg-rose-950/40 border border-rose-800/80 rounded text-rose-300 text-xs">
              {formError}
            </div>
          )}

          <form onSubmit={handleCreateProvider} className="space-y-4 text-xs font-mono">
            <Input
              label="Provider Name"
              type="text"
              placeholder="e.g. Okta / Azure AD / Keycloak"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />

            <Input
              label="Issuer URL (Discovery Endpoint)"
              type="url"
              placeholder="https://auth.enterprise.com/oauth2/v1"
              value={issuerUrl}
              onChange={(e) => setIssuerUrl(e.target.value)}
              required
            />

            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Client ID"
                type="text"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                required
              />
              <Input
                label="Client Secret"
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                required
              />
            </div>

            <Input
              label="Requested Scopes (space-separated)"
              type="text"
              value={scopes}
              onChange={(e) => setScopes(e.target.value)}
            />

            <div className="flex justify-end gap-2 pt-2 border-t border-vms-border">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowAddModal(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
              >
                Save Provider
              </Button>
            </div>
          </form>
        </div>
      </Modal>

      {/* Delete Provider Confirmation */}
      <ConfirmModal
        isOpen={!!providerToDelete}
        onClose={() => setProviderToDelete(null)}
        onConfirm={confirmDelete}
        title="Remove Identity Provider"
        message="Are you sure you want to remove this external Identity Provider configuration? Active sessions may be affected."
        confirmLabel="Remove Provider"
        variant="danger"
      />

      {/* Revoke All Sessions Confirmation */}
      <ConfirmModal
        isOpen={showConfirmRevokeAll}
        onClose={() => setShowConfirmRevokeAll(false)}
        onConfirm={confirmRevokeAll}
        title="Revoke All Sessions"
        message="Are you sure you want to revoke all active workstation sessions across all accounts? Operators will be forced to log in again."
        confirmLabel="Revoke All"
        variant="danger"
      />
    </div>
  );
};

export default IdentitySettings;
