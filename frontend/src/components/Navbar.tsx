import React, { useState, useEffect } from 'react';
import {
  Camera,
  Film,
  HardDrive,
  ShieldCheck,
  LogOut,
  Bell,
  Users,
  FileText,
  Archive,
  Send,
  Compass,
  Database,
  Server,
  Activity,
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
  const [utcClock, setUtcClock] = useState<string>('');

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      const pad = (n: number) => n.toString().padStart(2, '0');
      const timeStr = `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} UTC`;
      setUtcClock(timeStr);
    };

    updateTime();
    const clockTimer = setInterval(updateTime, 1000);
    return () => clearInterval(clockTimer);
  }, []);

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
    { id: 'live', index: '1', label: 'LIVE', icon: Camera, roles: ['VIEWER', 'OPERATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'] },
    { id: 'investigation', index: '2', label: 'INVESTIGATE', icon: Film, roles: ['VIEWER', 'OPERATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'] },
    { id: 'floorplans', index: '3', label: 'MAPS', icon: Compass, roles: ['VIEWER', 'OPERATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'] },
    { id: 'devices', index: '4', label: 'CAMERAS', icon: HardDrive, roles: ['OPERATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'] },
    { id: 'events', index: '5', label: 'EVENTS', icon: Bell, badge: unackAlarms, roles: ['OPERATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'] },
    { id: 'evidence', index: '6', label: 'SEC-63', icon: ShieldCheck, roles: ['TENANT_ADMIN', 'SUPER_ADMIN'] },
    { id: 'users', index: '7', label: 'STAFF', icon: Users, roles: ['TENANT_ADMIN', 'SUPER_ADMIN'] },
    { id: 'storage', index: '8', label: 'STORAGE', icon: Database, roles: ['TENANT_ADMIN', 'SUPER_ADMIN'] },
    { id: 'appliance', index: '9', label: 'APPLIANCE', icon: Server, roles: ['SUPER_ADMIN'] },
    { id: 'audit', index: '0', label: 'AUDIT', icon: FileText, roles: ['TENANT_ADMIN', 'SUPER_ADMIN'] },
  ];

  const navItems = allNavItems.filter((item) => item.roles.includes(role));
  const canManageNotifications = role === 'OPERATOR' || role === 'TENANT_ADMIN' || role === 'SUPER_ADMIN';
  const canBackup = role === 'TENANT_ADMIN' || role === 'SUPER_ADMIN';

  // Functional keyboard navigation: map numbers 1-9, 0 to active nav tabs
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Never trigger when user is focused on an interactive input
      const activeTag = (document.activeElement?.tagName || '').toLowerCase();
      if (
        activeTag === 'input' ||
        activeTag === 'textarea' ||
        activeTag === 'select' ||
        (document.activeElement as HTMLElement)?.isContentEditable
      ) {
        return;
      }

      if (showNotificationModal || showBackupModal) {
        if (e.key === 'Escape') {
          setShowNotificationModal(false);
          setShowBackupModal(false);
        }
        return;
      }

      const matched = navItems.find((item) => item.index === e.key);
      if (matched) {
        e.preventDefault();
        onSelectTab(matched.id);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navItems, onSelectTab, showNotificationModal, showBackupModal]);

  return (
    <header className="bg-tactical-panel border-b border-tactical-border select-none relative z-30">
      <div className="w-full px-3 h-12 flex items-center justify-between gap-2">
        {/* Left: Tactical Brand & Hardware Telemetry */}
        <div className="flex items-center space-x-3 shrink-0">
          <div className="flex items-center space-x-2 bg-tactical-canvas px-2.5 py-1 border border-tactical-border">
            <div className="w-2 h-2 rounded-none bg-phosphor-green animate-phosphor" />
            <span className="font-mono font-bold tracking-wider text-tactical-text text-xs uppercase">
              VIGILONE <span className="text-phosphor-amber">//</span> NVR-01
            </span>
            <span className="text-[10px] text-tactical-muted font-mono border-l border-tactical-border pl-2">
              v1.0.0
            </span>
          </div>

          {/* Real-time UTC Precision Clock */}
          <div className="hidden lg:flex items-center space-x-1.5 font-mono text-[11px] text-phosphor-cyan bg-tactical-canvas px-2 py-1 border border-tactical-border">
            <Activity className="w-3 h-3 text-phosphor-cyan animate-pulse" />
            <span>{utcClock || '00:00:00 UTC'}</span>
          </div>
        </div>

        {/* Center: Mission-Critical Hotkey-Wired Navigation */}
        <nav className="flex items-center space-x-0.5 overflow-x-auto" aria-label="Main Navigation">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = currentTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onSelectTab(item.id)}
                aria-current={active ? 'page' : undefined}
                className={`relative flex items-center space-x-1.5 px-2.5 py-1.5 text-xs font-mono tracking-wider transition-all duration-75 border-b-2 active:translate-y-[1px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-phosphor-cyan ${
                  active
                    ? 'border-phosphor-amber bg-tactical-surface text-tactical-bright font-bold'
                    : 'border-transparent text-tactical-muted hover:text-tactical-text hover:bg-tactical-surface/60'
                }`}
              >
                <span className="badge-hotkey">{item.index}</span>
                <Icon className={`w-3.5 h-3.5 ${active ? 'text-phosphor-amber' : 'text-tactical-muted'}`} />
                <span>{item.label}</span>
                {item.badge !== undefined && item.badge > 0 && (
                  <span className="ml-1 px-1.5 py-[2px] text-[9px] font-mono font-bold bg-phosphor-red text-tactical-canvas animate-pulse">
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Right: Telemetry Actions & User Profile */}
        <div className="flex items-center space-x-2 shrink-0 text-xs font-mono">
          {canManageNotifications && (
            <button
              onClick={() => setShowNotificationModal(true)}
              title="Notification Channels & Webhooks"
              className="p-1.5 border border-tactical-border bg-tactical-canvas text-tactical-muted hover:text-phosphor-amber hover:border-tactical-border-active active:translate-y-[1px] transition-all"
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          )}

          {canBackup && (
            <button
              onClick={() => setShowBackupModal(true)}
              title="Disaster Recovery & Appliance Backup"
              className="p-1.5 border border-tactical-border bg-tactical-canvas text-tactical-muted hover:text-phosphor-cyan hover:border-tactical-border-active active:translate-y-[1px] transition-all"
            >
              <Archive className="w-3.5 h-3.5" />
            </button>
          )}

          <div className="hidden sm:block text-right border-l border-tactical-border pl-2.5 py-0.5">
            <div className="font-mono text-tactical-bright text-[11px] font-semibold uppercase tracking-wider">
              {user?.name || 'OPERATOR'}
            </div>
            <div className="text-tactical-muted text-[10px]">
              ROLE // <span className="text-phosphor-amber font-semibold">{user?.role || 'VIEWER'}</span>
            </div>
          </div>

          <button
            onClick={onLogout}
            title="Sign Out of Appliance"
            className="p-1.5 border border-tactical-border bg-tactical-canvas text-tactical-muted hover:text-phosphor-red hover:border-tactical-border-active active:translate-y-[1px] transition-all"
          >
            <LogOut className="w-3.5 h-3.5" />
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
