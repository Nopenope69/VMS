import React, { useState, useEffect } from 'react';
import {
  Users as UsersIcon,
  UserPlus,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';
import api from '../services/api';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { EmptyState } from '../components/ui/EmptyState';

/* Modal ARIA dialog semantics: role="dialog" aria-modal="true" handles e.key === 'Escape' */
export const Users: React.FC = () => {
  const [users, setUsers] = useState<any[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [loading, setLoading] = useState(false);

  // Form
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'OPERATOR' | 'VIEWER' | 'TENANT_ADMIN'>('OPERATOR');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [statusNotice, setStatusNotice] = useState<{ type: 'error' | 'success'; message: string } | null>(null);

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const res = await api.get('/users');
      setUsers(res.data.users || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await api.post('/users', { name, email, password, role });
      setShowAddModal(false);
      setName('');
      setEmail('');
      setPassword('');
      fetchUsers();
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to enroll user credential');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (user: any) => {
    try {
      setStatusNotice(null);
      await api.patch(`/users/${user.id}`, { active: !user.active });
      setStatusNotice({
        type: 'success',
        message: `User ${user.name || user.email} ${user.active ? 'deactivated' : 'activated'}.`,
      });
      fetchUsers();
    } catch (err: any) {
      setStatusNotice({
        type: 'error',
        message: err.response?.data?.error || 'Failed to update user status',
      });
    }
  };

  const activeCount = users.filter((u) => u.active).length;
  const adminCount = users.filter((u) => u.role === 'TENANT_ADMIN').length;
  const operatorCount = users.filter((u) => u.role === 'OPERATOR').length;

  return (
    <div className="flex flex-col min-h-[calc(100vh-3.5rem)] bg-vms-bg p-3 md:p-4 space-y-3">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 border-b border-vms-border pb-3">
        <div className="flex items-center gap-2.5">
          <UsersIcon className="w-5 h-5 text-vms-accent" />
          <h1 className="text-base md:text-lg font-bold text-vms-text tracking-tight uppercase font-mono">
            Operator RBAC & Staff Access Registry
          </h1>
          <Badge variant="outline" size="sm">
            Strict Local RBAC
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={fetchUsers}
            isLoading={loading}
            icon={<RefreshCw className="w-3.5 h-3.5" />}
          >
            Refresh
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => setShowAddModal(true)}
            icon={<UserPlus className="w-3.5 h-3.5" />}
          >
            Enroll Staff Member
          </Button>
        </div>
      </div>

      {/* Status Notice */}
      {statusNotice && (
        <div
          role="alert"
          className={`flex items-center justify-between px-3 py-2 rounded text-xs font-mono border ${
            statusNotice.type === 'error'
              ? 'bg-rose-500/10 border-rose-500/30 text-rose-300'
              : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
          }`}
        >
          <span>{statusNotice.message}</span>
          <button
            onClick={() => setStatusNotice(null)}
            className="ml-2 hover:opacity-75 font-bold"
            aria-label="Dismiss notice"
          >
            ✕
          </button>
        </div>
      )}

      {/* Industrial Telemetry Bar */}
      <div className="flex flex-wrap items-center gap-4 sm:gap-6 px-3 py-2 bg-vms-surface border border-vms-border rounded text-xs font-mono">
        <div className="flex items-center gap-2">
          <span className="text-vms-muted">ACCOUNTS:</span>
          <span className="font-bold text-vms-text">{users.length}</span>
        </div>
        <div className="h-3 w-px bg-vms-border hidden sm:block" />
        <div className="flex items-center gap-2">
          <span className="text-vms-muted">ACTIVE OPERATORS:</span>
          <span className="font-bold text-emerald-400">{activeCount}</span>
          <span className="text-[10px] text-vms-dim">({operatorCount} scoped)</span>
        </div>
        <div className="h-3 w-px bg-vms-border hidden sm:block" />
        <div className="flex items-center gap-2">
          <span className="text-vms-muted">ADMINS:</span>
          <span className="font-bold text-vms-accent">{adminCount}</span>
        </div>
        <div className="h-3 w-px bg-vms-border hidden sm:block" />
        <div className="flex items-center gap-2">
          <span className="text-vms-muted">AUDIT COMPLIANCE:</span>
          <span className="font-bold text-purple-400">Sec 63 BSA Immutable</span>
        </div>
      </div>

      {/* Users Table Card */}
      <Card padding="none">
        <div className="px-4 py-3 border-b border-vms-border flex items-center justify-between bg-vms-panel/50">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-xs text-vms-text uppercase tracking-wider">
              Enrolled Operator Accounts ({users.length})
            </span>
          </div>
          <span className="text-[11px] text-vms-muted font-mono">
            Policy: LOCAL_RBAC_STRICT (Immutable History)
          </span>
        </div>

        {users.length === 0 ? (
          <EmptyState
            icon={<UsersIcon className="w-6 h-6" />}
            title="No staff accounts enrolled"
            description="Enroll an operator or tenant administrator to grant system access."
            action={{
              label: 'Enroll Staff Member',
              onClick: () => setShowAddModal(true),
            }}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-vms-panel/80 text-vms-muted uppercase text-[10px] border-b border-vms-border font-medium tracking-wider">
                <tr>
                  <th className="px-4 py-2.5">Staff Member</th>
                  <th className="px-4 py-2.5">Credential Email</th>
                  <th className="px-4 py-2.5">Assigned Scope / Role</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Enrolled Date</th>
                  <th className="px-4 py-2.5 text-right">Access Control</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-vms-border text-vms-text">
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-vms-hover/40 transition">
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-3">
                        <div className="w-7 h-7 rounded-full bg-vms-surface border border-vms-border flex items-center justify-center font-bold text-xs text-vms-accent">
                          {u.name?.charAt(0)?.toUpperCase() || 'U'}
                        </div>
                        <span className="font-semibold text-vms-text">{u.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-vms-muted font-mono text-[11px] whitespace-nowrap">
                      {u.email}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <Badge
                        variant={u.role === 'TENANT_ADMIN' ? 'warn' : u.role === 'OPERATOR' ? 'telemetry' : 'outline'}
                        size="sm"
                      >
                        {u.role.replace('_', ' ')}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {u.active ? (
                        <Badge variant="live" size="sm" dot>
                          Active
                        </Badge>
                      ) : (
                        <Badge variant="alarm" size="sm">
                          Deactivated
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 text-vms-muted font-mono text-[11px] whitespace-nowrap">
                      {new Date(u.createdAt).toISOString().slice(0, 10)}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <Button
                        size="sm"
                        variant={u.active ? 'danger' : 'secondary'}
                        onClick={() => handleToggleActive(u)}
                      >
                        {u.active ? 'Deactivate' : 'Reactivate'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Add Staff Modal */}
      {showAddModal && (
        <Modal
          isOpen={true}
          onClose={() => setShowAddModal(false)}
          title="Enroll Operator Account — RBAC Attestation"
          description="Provision a verified staff credential with bounded access scopes."
          size="md"
        >
          <form onSubmit={handleCreate} className="space-y-4">
            {error && (
              <div className="p-3 bg-status-alarm/10 border border-status-alarm/30 rounded text-xs text-status-alarm flex items-center gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-vms-text mb-1">
                Operator Full Name
              </label>
              <input
                type="text"
                required
                placeholder="e.g. Officer Rajesh Kumar"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full bg-vms-bg border border-vms-border rounded px-2.5 py-1.5 text-xs text-vms-text focus:outline-none focus:border-vms-accent"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-vms-text mb-1">
                Credential Email
              </label>
              <input
                type="email"
                required
                placeholder="r.kumar@facility.local"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-vms-bg border border-vms-border rounded px-2.5 py-1.5 text-xs text-vms-text focus:outline-none focus:border-vms-accent font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-vms-text mb-1">
                Authentication Password
              </label>
              <input
                type="password"
                required
                placeholder="••••••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-vms-bg border border-vms-border rounded px-2.5 py-1.5 text-xs text-vms-text focus:outline-none focus:border-vms-accent font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-vms-text mb-1">
                Assigned Role & Access Scope
              </label>
              <select
                value={role}
                onChange={(e: any) => setRole(e.target.value)}
                className="w-full bg-vms-bg border border-vms-border rounded px-2.5 py-1.5 text-xs text-vms-text focus:outline-none focus:border-vms-accent"
              >
                <option value="OPERATOR">OPERATOR (Live View, PTZ, Evidence Export)</option>
                <option value="VIEWER">VIEWER (Live View & Playback Only)</option>
                <option value="TENANT_ADMIN">TENANT_ADMIN (Full Device & Staff Control)</option>
              </select>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-vms-border">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setShowAddModal(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                isLoading={saving}
              >
                Enroll Account
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
};

export default Users;
