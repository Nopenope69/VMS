import React, { useState, useEffect } from 'react';
import { Users as UsersIcon, UserPlus, CheckCircle, XCircle, AlertCircle } from 'lucide-react';
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
      setError(err.response?.data?.error || err.message || 'Failed to create user');
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
    <div className="flex flex-col h-[calc(100vh-3.5rem)] bg-graphite-900 p-4 space-y-4 overflow-y-auto">
      {/* Header Banner */}
      <div className="bg-graphite-850 p-4 rounded border border-graphite-700 flex justify-between items-center">
        <div>
          <div className="flex items-center space-x-2">
            <UsersIcon className="w-5 h-5 text-cctv-amber" />
            <h2 className="text-sm font-semibold text-slate-100 uppercase tracking-wider">
              Staff & Permission Management
            </h2>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Manage authorized operators, security administrators, and viewers. Accounts are deactivated rather than deleted to maintain full audit chain compliance.
          </p>
        </div>

        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center space-x-1.5 px-3 py-1.5 rounded text-xs font-semibold bg-cctv-amber text-graphite-900 hover:bg-amber-400 transition shadow-sm"
        >
          <UserPlus className="w-3.5 h-3.5" />
          <span>Add Staff Member</span>
        </button>
      </div>

      {/* Users Table */}
      <div className="bg-graphite-850 rounded border border-graphite-700 overflow-hidden flex-1">
        <div className="px-4 py-3 border-b border-graphite-700 font-semibold text-xs uppercase tracking-wider text-slate-300">
          Enrolled Accounts ({users.length})
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-mono">
            <thead className="bg-graphite-900 text-slate-400 uppercase text-[10px] border-b border-graphite-700">
              <tr>
                <th className="px-4 py-2.5">Name</th>
                <th className="px-4 py-2.5">Email</th>
                <th className="px-4 py-2.5">Assigned Role</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Enrolled Date</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-graphite-700 text-slate-300">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-graphite-800 transition">
                  <td className="px-4 py-3 font-semibold text-white">{u.name}</td>
                  <td className="px-4 py-3 text-slate-300">{u.email}</td>
                  <td className="px-4 py-3">
                    <span className="px-2 py-0.5 rounded bg-graphite-700 text-[10px] font-bold text-cctv-teal">
                      {u.role}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {u.active ? (
                      <span className="flex items-center space-x-1 text-emerald-400 text-[11px]">
                        <CheckCircle className="w-3.5 h-3.5" />
                        <span>ACTIVE</span>
                      </span>
                    ) : (
                      <span className="flex items-center space-x-1 text-rose-400 text-[11px]">
                        <XCircle className="w-3.5 h-3.5" />
                        <span>DEACTIVATED</span>
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-400">
                    {new Date(u.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => handleToggleActive(u)}
                      className={`px-2 py-1 rounded text-[10px] font-semibold transition ${
                        u.active
                          ? 'bg-rose-950/60 text-rose-300 hover:bg-rose-900 border border-rose-800'
                          : 'bg-emerald-950/60 text-emerald-300 hover:bg-emerald-900 border border-emerald-800'
                      }`}
                    >
                      {u.active ? 'Deactivate' : 'Reactivate'}
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
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50 backdrop-blur-sm">
          <div className="bg-graphite-850 border border-graphite-700 rounded-md w-full max-w-md overflow-hidden shadow-2xl">
            <div className="px-5 py-4 border-b border-graphite-700 flex justify-between items-center bg-graphite-800">
              <h3 className="text-sm font-semibold text-slate-100 uppercase tracking-wider">
                Enroll New Staff Member
              </h3>
              <button onClick={() => setShowAddModal(false)} className="text-slate-400 hover:text-white">✕</button>
            </div>

            <form onSubmit={handleCreate} className="p-5 space-y-3.5">
              {error && (
                <div className="p-2.5 bg-red-900/40 border border-red-500 rounded text-xs text-red-200 flex items-center space-x-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <div>
                <label className="block text-xs font-mono text-slate-300 mb-1">Full Name</label>
                <input
                  type="text"
                  required
                  placeholder="Officer Rajesh Kumar"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full bg-graphite-900 border border-graphite-700 rounded px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cctv-amber"
                />
              </div>

              <div>
                <label className="block text-xs font-mono text-slate-300 mb-1">Email Address</label>
                <input
                  type="email"
                  required
                  placeholder="r.kumar@facility.local"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full bg-graphite-900 border border-graphite-700 rounded px-3 py-1.5 text-xs text-slate-200 font-mono focus:outline-none focus:border-cctv-amber"
                />
              </div>

              <div>
                <label className="block text-xs font-mono text-slate-300 mb-1">Password</label>
                <input
                  type="password"
                  required
                  placeholder="••••••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-graphite-900 border border-graphite-700 rounded px-3 py-1.5 text-xs text-slate-200 font-mono focus:outline-none focus:border-cctv-amber"
                />
              </div>

              <div>
                <label className="block text-xs font-mono text-slate-300 mb-1">Role & Permissions</label>
                <select
                  value={role}
                  onChange={(e: any) => setRole(e.target.value)}
                  className="w-full bg-graphite-900 border border-graphite-700 rounded px-3 py-1.5 text-xs text-slate-200 font-mono focus:outline-none focus:border-cctv-amber"
                >
                  <option value="OPERATOR">OPERATOR (Live View, PTZ, Evidence Export)</option>
                  <option value="VIEWER">VIEWER (Live View & Playback Only)</option>
                  <option value="TENANT_ADMIN">TENANT_ADMIN (Full Device & Staff Control)</option>
                </select>
              </div>

              <div className="flex justify-end space-x-2 pt-3 border-t border-graphite-700">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-1.5 rounded text-xs text-slate-300 hover:bg-graphite-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded text-xs font-semibold bg-cctv-amber text-graphite-900 hover:bg-amber-400"
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
