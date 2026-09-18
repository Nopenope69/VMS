import React, { useEffect } from 'react';
import { X, Keyboard, Command, Film, Video, Monitor } from 'lucide-react';
import Button from './ui/Button';

interface HotkeyHelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface HotkeyEntry {
  key: string;
  description: string;
}

interface HotkeyGroup {
  category: string;
  icon: any;
  items: HotkeyEntry[];
}

export const HotkeyHelpModal: React.FC<HotkeyHelpModalProps> = ({ isOpen, onClose }) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const hotkeyGroups: HotkeyGroup[] = [
    {
      category: 'Global Navigation',
      icon: Monitor,
      items: [
        { key: 'Alt + 1', description: 'Live Monitoring Grid' },
        { key: 'Alt + 2', description: 'Forensic Investigation' },
        { key: 'Alt + 3', description: 'Facility Floorplans' },
        { key: 'Alt + 4', description: 'Alarms & Incident Command' },
        { key: 'Alt + 5', description: 'Section 63 BSA Evidence' },
        { key: 'Alt + 6', description: 'Camera Fleet & ONVIF Devices' },
        { key: 'Alt + 7', description: 'Storage Management' },
        { key: 'Alt + 8', description: 'Appliance Host Telemetry' },
        { key: 'Alt + 9', description: 'Staff & Security Roles' },
        { key: 'Alt + 0', description: 'Tamper-Evident Audit Ledger' },
        { key: 'Alt + L', description: 'License & Entitlements' },
      ],
    },
    {
      category: 'Surveillance Live Grid',
      icon: Video,
      items: [
        { key: '1', description: '1×1 Focus Stream View' },
        { key: '2', description: '2×2 Quad Surveillance Grid' },
        { key: '3', description: '3×3 9-Feed Matrix' },
        { key: '4', description: '4×4 16-Feed Matrix' },
        { key: '5', description: '1+5 Spotlight Peripherals View' },
        { key: 'Double Click', description: 'Maximize Tile to Full Screen / Restore' },
        { key: 'Esc', description: 'Exit Maximized Tile View' },
      ],
    },
    {
      category: 'Forensic Investigation Transport',
      icon: Film,
      items: [
        { key: 'Space', description: 'Play / Pause Synchronized Playback' },
        { key: '← / →', description: 'Step 1 Second Backward / Forward' },
        { key: 'J', description: 'Variable Shuttle Rewind (2x, 4x, 8x, 16x)' },
        { key: 'K', description: 'Pause Playhead at Current UTC' },
        { key: 'L', description: 'Variable Shuttle Fast-Forward (2x, 4x, 8x, 16x)' },
      ],
    },
    {
      category: 'Command & Control',
      icon: Command,
      items: [
        { key: 'Cmd + K / Ctrl + K', description: 'Universal Omnibar / Command Palette' },
        { key: '?', description: 'Open This Hotkey Cheatsheet' },
        { key: 'Esc', description: 'Close Active Modal Dialog' },
      ],
    },
  ];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="hotkey-modal-title"
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-150"
    >
      <div className="w-full max-w-3xl bg-vms-surface border border-vms-border rounded-lg shadow-2xl flex flex-col overflow-hidden max-h-[90vh]">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-vms-border flex items-center justify-between bg-vms-panel/90">
          <div className="flex items-center space-x-2.5">
            <div className="p-1.5 rounded bg-vms-elevated border border-vms-border text-amber-400">
              <Keyboard className="w-4 h-4" />
            </div>
            <div>
              <h2 id="hotkey-modal-title" className="text-sm font-bold font-mono uppercase text-vms-text tracking-wide">
                Control-Room Keyboard Accelerators
              </h2>
              <p className="text-[11px] text-vms-muted font-sans">
                Operator-grade shortcuts designed for low-latency command center workflows.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            title="Close [Esc]"
            aria-label="Close"
            className="p-1.5 rounded text-vms-muted hover:text-vms-text hover:bg-vms-hover transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content: Grid of Shortcut Groups */}
        <div className="p-5 overflow-y-auto grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          {hotkeyGroups.map((group) => {
            const Icon = group.icon;
            return (
              <div
                key={group.category}
                className="bg-vms-panel/60 border border-vms-border/70 rounded p-3.5 flex flex-col space-y-2.5"
              >
                <div className="flex items-center space-x-2 border-b border-vms-border/50 pb-1.5">
                  <Icon className="w-3.5 h-3.5 text-amber-400" />
                  <span className="font-mono font-bold text-[11px] uppercase tracking-wider text-vms-text">
                    {group.category}
                  </span>
                </div>

                <div className="space-y-1.5">
                  {group.items.map((item) => (
                    <div
                      key={item.key}
                      className="flex items-center justify-between text-[11px] py-0.5"
                    >
                      <span className="text-vms-muted font-sans">{item.description}</span>
                      <kbd className="px-1.5 py-0.5 rounded font-mono text-[10px] font-semibold bg-vms-elevated text-amber-400 border border-vms-border shadow-xs">
                        {item.key}
                      </kbd>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-vms-border bg-vms-panel/80 flex items-center justify-between text-xs">
          <span className="text-[11px] text-vms-dim font-mono">
            Press <kbd className="px-1 py-0.5 bg-vms-surface border border-vms-border rounded text-vms-text font-bold">Esc</kbd> anytime to dismiss
          </span>
          <Button variant="secondary" size="xs" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
};

export default HotkeyHelpModal;
