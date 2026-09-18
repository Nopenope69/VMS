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
  Clock,
  KeyRound,
  Search,
  Keyboard,
} from 'lucide-react';
import api from '../services/api';
import NotificationSettingsModal from './NotificationSettingsModal';
import BackupModal from './BackupModal';

interface NavbarProps {
  currentTab: string;
  onSelectTab: (tab: string) => void;
  user: any;
  onLogout: () => void;
  onOpenCommandPalette?: () => void;
  onOpenHotkeyHelp?: () => void;
}

interface NavItem {
  id: string;
  index: string;
  label: string;
  icon: any;
  badge?: number;
  roles: string[];
}

export const Navbar: React.FC<NavbarProps> = ({
  currentTab,
  onSelectTab,
  user,
  onLogout,
  onOpenCommandPalette,
  onOpenHotkeyHelp,
}) => {
  const [unackAlarms, setUnackAlarms] = useState<number>(0);
  const [showNotificationModal, setShowNotificationModal] = useState(false);
  const [showBackupModal, setShowBackupModal] = useState(false);
  const [utcClock, setUtcClock] = useState<string>('');

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      const pad = (n: number) => n.toString().padStart(2, '0');
      const s = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${pad(
        now.getUTCHours()
      )}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} UTC`;
      setUtcClock(s);
    };

    updateTime();
    const timer = setInterval(updateTime, 1000);
    return () => clearInterval(timer);
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

  // Semantic Categories
  const surveillanceItems: NavItem[] = [
    { id: 'live', index: '1', label: 'Live Grid', icon: Camera, roles: ['VIEWER', 'OPERATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'] },
    { id: 'investigation', index: '2', label: 'Investigation', icon: Film, roles: ['VIEWER', 'OPERATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'] },
    { id: 'floorplans', index: '3', label: 'Floorplans', icon: Compass, roles: ['VIEWER', 'OPERATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'] },
  ];

  const incidentItems: NavItem[] = [
    { id: 'events', index: '4', label: 'Alarms', icon: Bell, badge: unackAlarms, roles: ['OPERATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'] },
    { id: 'evidence', index: '5', label: 'Evidence (Sec. 63)', icon: ShieldCheck, roles: ['TENANT_ADMIN', 'SUPER_ADMIN'] },
  ];

  const adminItems: NavItem[] = [
    { id: 'devices', index: '6', label: 'Cameras', icon: HardDrive, roles: ['OPERATOR', 'TENANT_ADMIN', 'SUPER_ADMIN'] },
    { id: 'storage', index: '7', label: 'Storage', icon: Database, roles: ['TENANT_ADMIN', 'SUPER_ADMIN'] },
    { id: 'appliance', index: '8', label: 'Appliance', icon: Server, roles: ['SUPER_ADMIN'] },
    { id: 'users', index: '9', label: 'Staff', icon: Users, roles: ['TENANT_ADMIN', 'SUPER_ADMIN'] },
    { id: 'audit', index: '0', label: 'Audit', icon: FileText, roles: ['TENANT_ADMIN', 'SUPER_ADMIN'] },
    { id: 'license', index: 'L', label: 'License', icon: KeyRound, roles: ['TENANT_ADMIN', 'SUPER_ADMIN'] },
  ];

  const allItems: NavItem[] = [...surveillanceItems, ...incidentItems, ...adminItems];
  const activeAllowedItems = allItems.filter((item) => item.roles.includes(role));

  const canManageNotifications = role === 'OPERATOR' || role === 'TENANT_ADMIN' || role === 'SUPER_ADMIN';
  const canBackup = role === 'TENANT_ADMIN' || role === 'SUPER_ADMIN';

  // Global hotkey navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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

      // Require Alt modifier for global tab navigation to preserve bare 1-5 for control-room camera grid presets
      if (!e.altKey) return;

      const pressedKey = e.key.toUpperCase();
      const matched = activeAllowedItems.find((item) => item.index === e.key || item.index.toUpperCase() === pressedKey);
      if (matched) {
        e.preventDefault();
        onSelectTab(matched.id);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeAllowedItems, onSelectTab, showNotificationModal, showBackupModal]);

  const renderNavGroup = (items: typeof allItems) => {
    return items
      .filter((item) => item.roles.includes(role))
      .map((item) => {
        const Icon = item.icon;
        const active = currentTab === item.id;
        return (
          <button
            key={item.id}
            onClick={() => onSelectTab(item.id)}
            aria-current={active ? 'page' : undefined}
            title={`${item.label} [Alt+${item.index}]`}
            className={`group relative flex items-center space-x-1.5 px-2.5 py-1.5 text-xs font-sans font-medium transition-colors rounded select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
              active
                ? 'bg-vms-surface text-vms-text font-semibold border border-vms-border shadow-sm'
                : 'text-vms-muted hover:text-vms-text hover:bg-vms-hover/70'
            }`}
          >
            <Icon
              className={`w-3.5 h-3.5 transition-colors ${
                active ? 'text-amber-400' : 'text-vms-dim group-hover:text-vms-muted'
              }`}
            />
            <span>{item.label}</span>
            <span
              className={`badge-hotkey px-1 py-0.5 rounded text-[9px] font-mono leading-none border ${
                active
                  ? 'bg-vms-elevated border-vms-border text-amber-400 font-bold'
                  : 'bg-vms-bg/60 border-vms-border/50 text-vms-dim'
              }`}
            >
              ⌥{item.index}
            </span>
            {item.badge !== undefined && item.badge > 0 && (
              <span className="ml-1 px-1.5 py-0.5 rounded-full text-[9px] font-mono font-bold bg-rose-500 text-white animate-pulse">
                {item.badge}
              </span>
            )}
          </button>
        );
      });
  };

  return (
    <header className="bg-vms-panel border-b border-vms-border select-none relative z-30 shrink-0">
      <div className="w-full px-3 h-12 flex items-center justify-between gap-3">
        {/* Left: Brand & Telemetry */}
        <div className="flex items-center space-x-3 shrink-0">
          <div className="flex items-center space-x-2 bg-vms-surface px-2.5 py-1 rounded border border-vms-border">
            <span className="flex h-2 w-2 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
            <span className="font-mono font-bold tracking-wider text-vms-text text-xs uppercase">
              VigilOne
            </span>
            <span className="text-[10px] text-vms-dim font-mono border-l border-vms-border pl-2">
              NVR-01
            </span>
          </div>

          {/* UTC Precision Time */}
          <div className="hidden xl:flex items-center space-x-1.5 font-mono text-[11px] text-sky-400 bg-vms-surface px-2.5 py-1 rounded border border-vms-border">
            <Clock className="w-3.5 h-3.5 text-sky-400" />
            <span>{utcClock || '00:00:00 UTC'}</span>
          </div>
        </div>

        {/* Center: Semantic Grouped Navigation */}
        <nav
          className="flex items-center space-x-3 overflow-x-auto py-1"
          aria-label="Surveillance Control Navigation"
        >
          {/* Surveillance Cluster */}
          <div className="flex items-center space-x-1 bg-vms-bg/60 p-0.5 rounded border border-vms-border/50">
            {renderNavGroup(surveillanceItems)}
          </div>

          <div className="h-4 w-px bg-vms-border hidden md:block" />

          {/* Incidents & Legal Cluster */}
          <div className="flex items-center space-x-1 bg-vms-bg/60 p-0.5 rounded border border-vms-border/50">
            {renderNavGroup(incidentItems)}
          </div>

          <div className="h-4 w-px bg-vms-border hidden lg:block" />

          {/* Appliance Administration Cluster */}
          <div className="hidden lg:flex items-center space-x-1 bg-vms-bg/60 p-0.5 rounded border border-vms-border/50">
            {renderNavGroup(adminItems)}
          </div>
        </nav>

        {/* Right: Quick Tools & Profile */}
        <div className="flex items-center space-x-1.5 shrink-0 text-xs">
          {onOpenCommandPalette && (
            <button
              onClick={onOpenCommandPalette}
              title="Command Palette & Fast Switcher (Cmd+K)"
              aria-label="Open Command Palette"
              className="flex items-center space-x-1 px-2 py-1 rounded border border-vms-border bg-vms-surface text-vms-muted hover:text-vms-text hover:border-amber-500/40 active:translate-y-[1px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-400"
            >
              <Search className="w-3.5 h-3.5 text-amber-400" />
              <span className="hidden xl:inline text-[11px] font-sans">Search</span>
              <kbd className="hidden sm:inline px-1 py-0.5 rounded text-[9px] font-mono bg-vms-elevated border border-vms-border text-vms-dim">
                ⌘K
              </kbd>
            </button>
          )}

          {onOpenHotkeyHelp && (
            <button
              onClick={onOpenHotkeyHelp}
              title="Keyboard Accelerators & Shortcuts (?)"
              aria-label="Keyboard Shortcuts"
              className="p-1.5 rounded border border-vms-border bg-vms-surface text-vms-muted hover:text-amber-400 hover:border-vms-hover active:translate-y-[1px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-400"
            >
              <Keyboard className="w-3.5 h-3.5" />
            </button>
          )}
          {canManageNotifications && (
            <button
              onClick={() => setShowNotificationModal(true)}
              title="Notification Channels & Webhooks"
              className="p-1.5 rounded border border-vms-border bg-vms-surface text-vms-muted hover:text-amber-400 hover:border-vms-hover active:translate-y-[1px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          )}

          {canBackup && (
            <button
              onClick={() => setShowBackupModal(true)}
              title="Disaster Recovery & Appliance Backup"
              className="p-1.5 rounded border border-vms-border bg-vms-surface text-vms-muted hover:text-sky-400 hover:border-vms-hover active:translate-y-[1px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              <Archive className="w-3.5 h-3.5" />
            </button>
          )}

          {/* User Role Tag */}
          <div className="hidden sm:flex items-center space-x-2 border-l border-vms-border pl-2.5 py-0.5">
            <div className="w-6 h-6 rounded bg-vms-elevated border border-vms-border flex items-center justify-center font-mono font-bold text-[10px] text-amber-400">
              {(user?.name || 'OP').slice(0, 2).toUpperCase()}
            </div>
            <div className="text-left leading-tight">
              <div className="font-sans text-vms-text text-[11px] font-semibold">
                {user?.name || 'Operator'}
              </div>
              <div className="text-vms-dim text-[10px] font-mono">
                {user?.role || 'VIEWER'}
              </div>
            </div>
          </div>

          <button
            onClick={onLogout}
            title="Sign Out of Appliance"
            className="p-1.5 rounded border border-vms-border bg-vms-surface text-vms-muted hover:text-rose-400 hover:border-rose-500/40 active:translate-y-[1px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
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
