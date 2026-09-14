import React, { useState, useEffect } from 'react';
import { Users as UsersIcon, UserPlus, CheckCircle, XCircle, AlertCircle, X } from 'lucide-react';
import api from '../services/api';

export const Users: React.FC = () => {
  const [users, setUsers] = useState<any[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);

  // Form
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'OPERATOR' | 'VIEWER' | 'TENANT_ADMIN'>('OPERATOR');
  const [error, setError] = useState('');

  const fetchUsers = async () => {
    try {
      const res = await api.get('/users');
      setUsers(res.data.users || []);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  useEffect(() => {
    if (!showAddModal) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowAddModal(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showAddModal]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api.post('/users', { name, email, password, role });
      setShowAddModal(false);
      setName('');
      setEmail('');
      setPassword('');
      fetchUsers();
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to enroll user credential');
    }
  };

  const handleToggleActive = async (user: any) => {
    try {
      await api.patch(`/users/${user.id}`, { active: !user.active });
      fetchUsers();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to update user status');
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] bg-[#080B10] p-4 space-y-4 overflow-y-auto select-none font-mono">
      {/* Header Banner */}
      <div className="bg-[#0D1117] p-4 border border-[#21262D] relative flex justify-between items-center shadow-lg">
        {/* Optical Corner Reticles */}
        <span className="absolute -top-1 -left-1 text-[9px] text-[#30363D]">+</span>
        <span className="absolute -top-1 -right-1 text-[9px] text-[#30363D]">+</span>
        <span className="absolute -bottom-1 -left-1 text-[9px] text-[#30363D]">+</span>
        <span className="absolute -bottom-1 -right-1 text-[9px] text-[#30363D]">+</span>

        <div>
          <div className="flex items-center space-x-2">
            <UsersIcon className="w-4 h-4 text-[#E3B341]" />
            <h2 className="text-xs font-bold text-white uppercase tracking-wider">
              Operator RBAC & Staff Access Registry
            </h2>
          </div>
          <p className="text-[11px] text-slate-400 mt-1 max-w-3xl leading-relaxed">
            Strict role-based access control. Accounts are sealed and deactivated rather than purged to preserve uninterrupted Section 63 chain-of-custody audit compliance.
          </p>
        </div>

        <button
          onClick={() => setShowAddModal(true)}
          className="btn-tactical-primary flex items-center space-x-1.5"
        >
          <UserPlus className="w-3.5 h-3.5" />
          <span>+ Enroll Staff Member</span>
        </button>
      </div>

      {/* Users Table */}
      <div className="bg-[#0D1117] border border-[#21262D] overflow-hidden flex-1">
        <div className="px-4 py-2.5 border-b border-[#21262D] font-bold text-xs uppercase tracking-wider text-slate-300 bg-[#161B22] flex items-center justify-between">
          <span>ENROLLED OPERATOR ACCOUNTS ({users.length})</span>
          <span className="text-[10px] text-slate-500">POLICY: LOCAL_RBAC_STRICT</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#080B10] text-slate-400 uppercase text-[10px] border-b border-[#21262D]">
              <tr>
                <th className="px-4 py-2.5">OPERATOR NAME</th>
                <th className="px-4 py-2.5">CREDENTIAL EMAIL</th>
                <th className="px-4 py-2.5">ASSIGNED ROLE</th>
                <th className="px-4 py-2.5">STATUS</th>
                <th className="px-4 py-2.5">ENROLLED DATE (UTC)</th>
                <th className="px-4 py-2.5 text-right">ACTION</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#21262D] text-slate-300">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-[#161B22] transition">
                  <td className="px-4 py-3 font-bold text-white tracking-wide">{u.name}</td>
                  <td className="px-4 py-3 text-slate-300 font-mono">{u.email}</td>
                  <td className="px-4 py-3">
                    <span className="px-2 py-0.5 rounded-none bg-[#161B22] border border-[#21262D] text-[10px] font-bold text-[#58A6FF] uppercase">
                      [{u.role}]
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {u.active ? (
                      <span className="inline-flex items-center space-x-1 text-[#3FB950] text-[11px] font-bold tracking-wider">
                        <CheckCircle className="w-3.5 h-3.5" />
                        <span>[ ACTIVE ]</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center space-x-1 text-[#F85149] text-[11px] font-bold tracking-wider">
                        <XCircle className="w-3.5 h-3.5" />
                        <span>[ DEACTIVATED ]</span>
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-400 font-mono text-[11px]">
                    {new Date(u.createdAt).toISOString().slice(0, 10)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => handleToggleActive(u)}
                      className={`px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider transition rounded-none border ${
                        u.active
                          ? 'bg-[#F85149]/10 text-[#F85149] hover:bg-[#F85149] hover:text-[#080B10] border-[#F85149]/40'
                          : 'bg-[#3FB950]/10 text-[#3FB950] hover:bg-[#3FB950] hover:text-[#080B10] border-[#3FB950]/40'
                      }`}
                    >
                      {u.active ? 'DEACTIVATE' : 'REACTIVATE'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add Staff Modal */}
      {showAddModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="enroll-modal-title"
          className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50 select-none"
        >
          <div className="bg-[#0D1117] border border-[#21262D] rounded-none w-full max-w-md overflow-hidden shadow-2xl relative">
            <span className="absolute -top-1 -left-1 text-[9px] text-[#30363D]">+</span>
            <span className="absolute -top-1 -right-1 text-[9px] text-[#30363D]">+</span>
            <span className="absolute -bottom-1 -left-1 text-[9px] text-[#30363D]">+</span>
            <span className="absolute -bottom-1 -right-1 text-[9px] text-[#30363D]">+</span>

            <div className="px-5 py-3.5 border-b border-[#21262D] flex justify-between items-center bg-[#161B22]">
              <h3 id="enroll-modal-title" className="text-xs font-bold text-white uppercase tracking-wider">
                Enroll Operator Account — RBAC Attestation
              </h3>
              <button onClick={() => setShowAddModal(false)} className="text-slate-400 hover:text-white" aria-label="Close modal">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreate} className="p-5 space-y-3.5 bg-[#0D1117]">
              {error && (
                <div className="p-2.5 bg-[#F85149]/10 border border-[#F85149]/40 text-xs text-[#F85149] flex items-center space-x-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <div>
                <label className="block text-xs text-slate-300 mb-1 uppercase tracking-wider">OPERATOR FULL NAME</label>
                <input
                  type="text"
                  required
                  placeholder="Officer Rajesh Kumar"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="input-tactical w-full"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-300 mb-1 uppercase tracking-wider">CREDENTIAL EMAIL</label>
                <input
                  type="email"
                  required
                  placeholder="r.kumar@facility.local"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="input-tactical w-full"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-300 mb-1 uppercase tracking-wider">AUTHENTICATION PASSWORD</label>
                <input
                  type="password"
                  required
                  placeholder="••••••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input-tactical w-full"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-300 mb-1 uppercase tracking-wider">ASSIGNED ROLE & ACCESS SCOPE</label>
                <select
                  value={role}
                  onChange={(e: any) => setRole(e.target.value)}
                  className="input-tactical w-full uppercase"
                >
                  <option value="OPERATOR">OPERATOR (Live View, PTZ, Evidence Export)</option>
                  <option value="VIEWER">VIEWER (Live View & Playback Only)</option>
                  <option value="TENANT_ADMIN">TENANT_ADMIN (Full Device & Staff Control)</option>
                </select>
              </div>

              <div className="flex justify-end space-x-2 pt-3 border-t border-[#21262D]">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="btn-tactical-secondary"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-tactical-primary"
                >
                  Enroll Account
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default Users;
