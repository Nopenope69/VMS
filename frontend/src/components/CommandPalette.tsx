import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Search,
  Camera,
  Film,
  Compass,
  Bell,
  ShieldCheck,
  HardDrive,
  Database,
  Server,
  Users,
  FileText,
  KeyRound,
  Download,
  Plus,
  Radio,
  CheckCircle2,
  CornerDownLeft,
} from 'lucide-react';

export interface CommandItem {
  id: string;
  title: string;
  subtitle?: string;
  category: 'CONSOLES' | 'CAMERAS' | 'ACTIONS';
  icon: any;
  shortcut?: string;
  onSelect: () => void;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectTab: (tabId: string) => void;
  cameras?: Array<{ id: string; name: string; ipAddress?: string }>;
  onFocusCamera?: (camId: string) => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  onSelectTab,
  cameras = [],
  onFocusCamera,
}) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Build static command items
  const baseItems: CommandItem[] = useMemo(() => {
    const items: CommandItem[] = [
      // Consoles
      {
        id: 'nav-live',
        title: 'Live Monitoring Grid',
        subtitle: 'Multi-stream real-time surveillance video matrix',
        category: 'CONSOLES',
        icon: Camera,
        shortcut: 'Alt + 1',
        onSelect: () => {
          onSelectTab('live');
          onClose();
        },
      },
      {
        id: 'nav-investigation',
        title: 'Forensic Investigation',
        subtitle: 'Synchronized multi-camera playback & variable transport shuttle',
        category: 'CONSOLES',
        icon: Film,
        shortcut: 'Alt + 2',
        onSelect: () => {
          onSelectTab('investigation');
          onClose();
        },
      },
      {
        id: 'nav-floorplans',
        title: 'Facility Floorplans',
        subtitle: '2D spatial maps, camera field-of-view cones & live alarms',
        category: 'CONSOLES',
        icon: Compass,
        shortcut: 'Alt + 3',
        onSelect: () => {
          onSelectTab('floorplans');
          onClose();
        },
      },
      {
        id: 'nav-events',
        title: 'Alarms & Incident Command',
        subtitle: 'Operational alarm triage, attestation presets & event logs',
        category: 'CONSOLES',
        icon: Bell,
        shortcut: 'Alt + 4',
        onSelect: () => {
          onSelectTab('events');
          onClose();
        },
      },
      {
        id: 'nav-evidence',
        title: 'Section 63 BSA Evidence Registry',
        subtitle: 'Tamper-evident legal packages, Merkle roots & digital signatures',
        category: 'CONSOLES',
        icon: ShieldCheck,
        shortcut: 'Alt + 5',
        onSelect: () => {
          onSelectTab('evidence');
          onClose();
        },
      },
      {
        id: 'nav-devices',
        title: 'Camera Fleet & ONVIF Devices',
        subtitle: 'Camera discovery, onboarding, PTZ configurations & schedules',
        category: 'CONSOLES',
        icon: HardDrive,
        shortcut: 'Alt + 6',
        onSelect: () => {
          onSelectTab('devices');
          onClose();
        },
      },
      {
        id: 'nav-storage',
        title: 'Storage Management',
        subtitle: 'Storage pools, retention enforcement & disk exhaustion forecasts',
        category: 'CONSOLES',
        icon: Database,
        shortcut: 'Alt + 7',
        onSelect: () => {
          onSelectTab('storage');
          onClose();
        },
      },
      {
        id: 'nav-appliance',
        title: 'Appliance Host Telemetry',
        subtitle: 'CPU/RAM vitals, systemd services & NVMe mount guards',
        category: 'CONSOLES',
        icon: Server,
        shortcut: 'Alt + 8',
        onSelect: () => {
          onSelectTab('appliance');
          onClose();
        },
      },
      {
        id: 'nav-users',
        title: 'Staff & Security Roles',
        subtitle: 'RBAC identity administration, operators & audit permissions',
        category: 'CONSOLES',
        icon: Users,
        shortcut: 'Alt + 9',
        onSelect: () => {
          onSelectTab('users');
          onClose();
        },
      },
      {
        id: 'nav-audit',
        title: 'Tamper-Evident Audit Ledger',
        subtitle: 'Monotonically chained SHA-256 cryptographic audit logs',
        category: 'CONSOLES',
        icon: FileText,
        shortcut: 'Alt + 0',
        onSelect: () => {
          onSelectTab('audit');
          onClose();
        },
      },
      {
        id: 'nav-license',
        title: 'Appliance License & Entitlements',
        subtitle: 'Ed25519 commercial license, channel quotas & offline activation',
        category: 'CONSOLES',
        icon: KeyRound,
        shortcut: 'Alt + L',
        onSelect: () => {
          onSelectTab('license');
          onClose();
        },
      },
      // Quick Actions
      {
        id: 'act-ack-alarms',
        title: 'Jump to Unacknowledged Alarms',
        subtitle: 'Review active alarms requiring operator verification',
        category: 'ACTIONS',
        icon: CheckCircle2,
        onSelect: () => {
          onSelectTab('events');
          onClose();
        },
      },
      {
        id: 'act-export-bsa',
        title: 'Seal Section 63 BSA Evidence Package',
        subtitle: 'Open legal export certificate workflow',
        category: 'ACTIONS',
        icon: Download,
        onSelect: () => {
          onSelectTab('evidence');
          onClose();
        },
      },
      {
        id: 'act-onboard-cam',
        title: 'Onboard New Camera Stream',
        subtitle: 'Discover on LAN or configure ONVIF / RTSP endpoint manually',
        category: 'ACTIONS',
        icon: Plus,
        onSelect: () => {
          onSelectTab('devices');
          onClose();
        },
      },
      {
        id: 'act-scan-lan',
        title: 'Trigger WS-Discovery Network Scan',
        subtitle: 'Probe subnet for ONVIF Profile S/G/T compliant cameras',
        category: 'ACTIONS',
        icon: Radio,
        onSelect: () => {
          onSelectTab('devices');
          onClose();
        },
      },
    ];

    // Add camera items
    cameras.forEach((cam) => {
      items.push({
        id: `cam-${cam.id}`,
        title: cam.name,
        subtitle: `Camera Feed • ${cam.ipAddress || 'RTSP Stream'}`,
        category: 'CAMERAS',
        icon: Camera,
        onSelect: () => {
          onSelectTab('live');
          if (onFocusCamera) onFocusCamera(cam.id);
          onClose();
        },
      });
    });

    return items;
  }, [cameras, onSelectTab, onFocusCamera, onClose]);

  // Filter items by query
  const filteredItems = useMemo(() => {
    if (!query.trim()) return baseItems;
    const q = query.toLowerCase();
    return baseItems.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        (item.subtitle && item.subtitle.toLowerCase().includes(q)) ||
        item.category.toLowerCase().includes(q)
    );
  }, [baseItems, query]);

  // Keep selected index bounded
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % Math.max(1, filteredItems.length));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + filteredItems.length) % Math.max(1, filteredItems.length));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (filteredItems[selectedIndex]) {
          filteredItems[selectedIndex].onSelect();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, filteredItems, selectedIndex, onClose]);

  // Scroll active item into view
  useEffect(() => {
    if (!listRef.current) return;
    const selectedEl = listRef.current.querySelector(`[data-index="${selectedIndex}"]`) as HTMLElement;
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Universal Command Palette"
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-start justify-center pt-16 sm:pt-24 p-4 animate-in fade-in duration-150"
    >
      <div className="w-full max-w-xl bg-vms-surface border border-vms-border rounded-lg shadow-2xl flex flex-col overflow-hidden">
        {/* Search Input Bar */}
        <div className="px-4 py-3.5 border-b border-vms-border bg-vms-panel/90 flex items-center space-x-3">
          <Search className="w-4 h-4 text-amber-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command, camera, or console... (↑↓ to navigate, Enter to select)"
            className="w-full bg-transparent border-none text-xs sm:text-sm text-vms-text placeholder:text-vms-dim font-sans focus:outline-none"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="text-[10px] text-vms-dim hover:text-vms-text font-mono uppercase bg-vms-elevated px-1.5 py-0.5 rounded border border-vms-border"
            >
              Clear
            </button>
          )}
        </div>

        {/* Results List */}
        <div
          ref={listRef}
          className="max-h-80 overflow-y-auto divide-y divide-vms-border/40 p-1.5"
        >
          {filteredItems.length === 0 ? (
            <div className="py-8 text-center text-xs text-vms-muted font-sans">
              No matching commands or cameras found for <strong className="text-vms-text font-mono">"{query}"</strong>
            </div>
          ) : (
            filteredItems.map((item, idx) => {
              const Icon = item.icon;
              const isSelected = idx === selectedIndex;
              return (
                <div
                  key={item.id}
                  data-index={idx}
                  onClick={() => item.onSelect()}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={`px-3 py-2.5 rounded flex items-center justify-between cursor-pointer transition-colors ${
                    isSelected
                      ? 'bg-vms-hover text-vms-text border border-amber-500/30'
                      : 'text-vms-muted hover:bg-vms-surface'
                  }`}
                >
                  <div className="flex items-center space-x-3 min-w-0 pr-2">
                    <div
                      className={`p-1.5 rounded border ${
                        isSelected
                          ? 'bg-amber-500/20 border-amber-500 text-amber-400'
                          : 'bg-vms-panel border-vms-border text-vms-dim'
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5" />
                    </div>
                    <div className="min-w-0">
                      <div className="font-sans text-xs font-semibold text-vms-text truncate">
                        {item.title}
                      </div>
                      {item.subtitle && (
                        <div className="font-sans text-[11px] text-vms-muted truncate">
                          {item.subtitle}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center space-x-2 shrink-0">
                    {item.shortcut ? (
                      <kbd className="px-1.5 py-0.5 font-mono text-[10px] bg-vms-elevated text-amber-400 border border-vms-border rounded">
                        {item.shortcut}
                      </kbd>
                    ) : isSelected ? (
                      <CornerDownLeft className="w-3.5 h-3.5 text-amber-400" />
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer Bar */}
        <div className="px-4 py-2 border-t border-vms-border bg-vms-panel/90 flex items-center justify-between text-[10px] font-mono text-vms-dim">
          <div className="flex items-center space-x-3">
            <span>
              <kbd className="px-1 py-0.5 bg-vms-elevated border border-vms-border rounded text-vms-text">↑</kbd>{' '}
              <kbd className="px-1 py-0.5 bg-vms-elevated border border-vms-border rounded text-vms-text">↓</kbd> Navigate
            </span>
            <span>
              <kbd className="px-1 py-0.5 bg-vms-elevated border border-vms-border rounded text-vms-text">↵</kbd> Select
            </span>
            <span>
              <kbd className="px-1 py-0.5 bg-vms-elevated border border-vms-border rounded text-vms-text">Esc</kbd> Close
            </span>
          </div>
          <span className="text-amber-400 font-semibold">{filteredItems.length} available</span>
        </div>
      </div>
    </div>
  );
};

export default CommandPalette;
