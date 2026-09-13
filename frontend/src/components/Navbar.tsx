import React, { useState, useEffect } from 'react';
import {
  Camera,
  Film,
  HardDrive,
  ShieldCheck,
  LogOut,
  Radio,
  Bell,
  Users,
  FileText,
  Archive,
  Send,
  Compass,
  Database,
  Server,
} from 'lucide-react';
import api from '../services/api';
import NotificationSettingsModal from './NotificationSettingsModal';
import BackupModal from './BackupModal';

interface NavbarProps {
  currentTab: string;
  onSelectTab: (tab: string) => void;
  user: any;
  onLogout: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({ currentTab, onSelectTab, user, onLogout }) => {
  const [unackAlarms, setUnackAlarms] = useState<number>(0);
  const [showNotificationModal, setShowNotificationModal] = useState(false);
  const [showBackupModal, setShowBackupModal] = useState(false);

  useEffect(() => {
    const fetchStats = () => {
      api
        .get('/events/stats')
        .then((res) => {
          setUnackAlarms(res.data.unacknowledgedTotal || 0);
        })
        .catch(() => {});
    };

    fetchStats();
    const interval = setInterval(fetchStats, 10000);
    return () => clearInterval(interval);
  }, []);

  const role = user?.role || 'VIEWER';

  const allNavItems = [
    { id: 'live', label: 'Live Grid', icon: Camera, roles: ['VIEWER', 'OPERATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'] },
    { id: 'investigation', label: 'Investigation', icon: Film, roles: ['VIEWER', 'OPERATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'] },
    { id: 'floorplans', label: 'Floorplans', icon: Compass, roles: ['VIEWER', 'OPERATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'] },
    { id: 'devices', label: 'Cameras', icon: HardDrive, roles: ['OPERATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'] },
    { id: 'events', label: 'Events', icon: Bell, badge: unackAlarms, roles: ['OPERATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'] },
    { id: 'evidence', label: 'Section 63 Evidence', icon: ShieldCheck, roles: ['TENANT_ADMIN', 'SUPER_ADMIN'] },
    { id: 'users', label: 'Staff', icon: Users, roles: ['TENANT_ADMIN', 'SUPER_ADMIN'] },
    { id: 'storage', label: 'Storage', icon: Database, roles: ['TENANT_ADMIN', 'SUPER_ADMIN'] },
    { id: 'appliance', label: 'Appliance', icon: Server, roles: ['SUPER_ADMIN'] },
    { id: 'audit', label: 'Audit Trail', icon: FileText, roles: ['TENANT_ADMIN', 'SUPER_ADMIN'] },
  ];

  const navItems = allNavItems.filter((item) => item.roles.includes(role));
  const canManageNotifications = role === 'OPERATOR' || role === 'TENANT_ADMIN' || role === 'SUPER_ADMIN';
  const canBackup = role === 'TENANT_ADMIN' || role === 'SUPER_ADMIN';

  return (
    <header className="bg-graphite-850 border-b border-graphite-700 select-none">
      <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
        {/* Brand */}
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 rounded bg-cctv-amber/20 border border-cctv-amber/60 flex items-center justify-center">
            <Radio className="w-5 h-5 text-cctv-amber" />
          </div>
          <div>
            <span className="font-bold tracking-wider text-slate-100 uppercase text-sm">VigilOne</span>
            <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-cctv-teal/20 text-cctv-teal border border-cctv-teal/40 font-mono">
              VMS 2.0
            </span>
          </div>
        </div>

        {/* Navigation Tabs */}
        <nav className="flex space-x-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = currentTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onSelectTab(item.id)}
                className={`relative flex items-center space-x-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors ${
                  active
                    ? 'bg-cctv-amber text-graphite-900 font-semibold shadow-sm'
                    : 'text-slate-300 hover:text-white hover:bg-graphite-700'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{item.label}</span>
                {item.badge !== undefined && item.badge > 0 && (
                  <span
                    className={`ml-1 px-1.5 py-0.2 rounded-full text-[9px] font-bold ${
                      active ? 'bg-red-600 text-white' : 'bg-red-500 text-white'
                    }`}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Action icons & User profile & logout */}
        <div className="flex items-center space-x-3 text-xs">
          {canManageNotifications && (
            <button
              onClick={() => setShowNotificationModal(true)}
              title="Notification Channels & Webhooks"
              className="p-1.5 rounded hover:bg-graphite-700 text-slate-400 hover:text-cctv-amber transition"
            >
              <Send className="w-4 h-4" />
            </button>
          )}

          {canBackup && (
            <button
              onClick={() => setShowBackupModal(true)}
              title="Disaster Recovery & Appliance Backup"
              className="p-1.5 rounded hover:bg-graphite-700 text-slate-400 hover:text-cctv-teal transition"
            >
              <Archive className="w-4 h-4" />
            </button>
          )}

          <div className="h-4 w-px bg-graphite-700 mx-1" />

          <div className="text-right">
            <div className="font-medium text-slate-200">{user?.name || 'Operator'}</div>
            <div className="text-slate-400 font-mono text-[10px]">
              {user?.role || 'OPERATOR'} • {user?.tenantName || 'Main Facility'}
            </div>
          </div>
          <button
            onClick={onLogout}
            title="Sign Out"
            className="p-1.5 rounded hover:bg-graphite-700 text-slate-400 hover:text-rose-400 transition"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>

      <NotificationSettingsModal
        isOpen={showNotificationModal}
        onClose={() => setShowNotificationModal(false)}
      />

      <BackupModal
        isOpen={showBackupModal}
        onClose={() => setShowBackupModal(false)}
      />
    </header>
  );
};

export default Navbar;
