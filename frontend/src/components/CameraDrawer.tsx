import React, { useState, useMemo } from 'react';
import {
  Search,
  X,
  ChevronRight,
  ChevronDown,
  Layers,
  Crosshair,
  Filter,
} from 'lucide-react';
import { CameraData } from './CameraTile';

interface CameraDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  cameras: CameraData[];
  selectedSlotIndex: number | null;
  cameraSlots: Array<{ slotIndex: number; cameraId: string | null }>;
  onAssignCameraToSlot: (cameraId: string, slotIndex: number) => void;
  onSelectSlot: (slotIndex: number) => void;
  slotCount: number;
}

export const CameraDrawer: React.FC<CameraDrawerProps> = ({
  isOpen,
  onClose,
  cameras,
  selectedSlotIndex,
  cameraSlots,
  onAssignCameraToSlot,
  onSelectSlot,
  slotCount,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ONLINE' | 'OFFLINE'>('ALL');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  // Group cameras by sector or prefix
  const groupedCameras = useMemo(() => {
    const groups: Record<string, CameraData[]> = {};

    cameras.forEach((cam) => {
      // Filter by search
      const matchesSearch =
        cam.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (cam.ipAddress && cam.ipAddress.toLowerCase().includes(searchQuery.toLowerCase()));

      if (!matchesSearch) return;

      // Filter by status
      if (statusFilter === 'ONLINE' && !cam.isOnline) return;
      if (statusFilter === 'OFFLINE' && cam.isOnline) return;

      // Extract sector name (e.g., "Sector A" or prefix before "—" or "-")
      let sector = 'General Facility';
      if (cam.name.includes('—')) {
        sector = cam.name.split('—')[0].trim();
      } else if (cam.name.includes('-')) {
        sector = cam.name.split('-')[0].trim();
      }

      if (!groups[sector]) {
        groups[sector] = [];
      }
      groups[sector].push(cam);
    });

    return groups;
  }, [cameras, searchQuery, statusFilter]);

  const toggleGroup = (groupName: string) => {
    setCollapsedGroups((prev) => ({
      ...prev,
      [groupName]: !prev[groupName],
    }));
  };

  const assignedCameraIds = useMemo(() => {
    const set = new Set<string>();
    cameraSlots.forEach((slot) => {
      if (slot.cameraId) set.add(slot.cameraId);
    });
    return set;
  }, [cameraSlots]);

  if (!isOpen) return null;

  const targetSlot = selectedSlotIndex !== null ? selectedSlotIndex : 0;

  return (
    <aside
      aria-label="Camera Directory"
      className="w-80 h-full bg-vms-panel border-r border-vms-border flex flex-col z-20 shrink-0 transition-all duration-200"
    >
      {/* Header */}
      <div className="px-3.5 py-3 border-b border-vms-border bg-vms-surface/70 flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <div className="p-1 rounded bg-vms-elevated border border-vms-border text-amber-500">
            <Layers className="w-3.5 h-3.5" />
          </div>
          <div>
            <h2 className="text-xs font-semibold text-vms-text uppercase tracking-wider font-sans">
              Camera Directory
            </h2>
            <div className="text-[10px] text-vms-dim font-mono">
              {cameras.filter((c) => c.isOnline).length} Online / {cameras.length} Total
            </div>
          </div>
        </div>
        <button
          onClick={onClose}
          title="Close Camera Directory"
          aria-label="Close Camera Directory"
          className="p-1 rounded text-vms-muted hover:text-vms-text hover:bg-vms-hover transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Target Slot Assignment Banner */}
      <div className="px-3.5 py-2 border-b border-vms-border bg-amber-500/5 flex items-center justify-between">
        <div className="flex items-center space-x-1.5 text-xs">
          <span className="text-[11px] font-mono text-vms-muted uppercase">Target:</span>
          <span className="font-mono text-xs font-bold text-amber-400">
            Slot {targetSlot + 1 < 10 ? `0${targetSlot + 1}` : targetSlot + 1}
          </span>
        </div>
        <div className="flex items-center space-x-1">
          <span className="text-[10px] text-vms-dim font-sans">Change slot:</span>
          <select
            value={targetSlot}
            onChange={(e) => onSelectSlot(Number(e.target.value))}
            aria-label="Target Grid Slot"
            className="bg-vms-surface border border-vms-border text-[11px] font-mono text-vms-text rounded px-1.5 py-0.5 focus:outline-none focus:border-amber-500"
          >
            {Array.from({ length: slotCount }, (_, i) => (
              <option key={i} value={i}>
                Slot {i + 1 < 10 ? `0${i + 1}` : i + 1}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Search & Filter Controls */}
      <div className="p-3 border-b border-vms-border space-y-2 bg-vms-surface/30">
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-vms-dim absolute left-2.5 top-2.5 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter by name or IP..."
            className="w-full pl-8 pr-2.5 py-1.5 bg-vms-surface border border-vms-border rounded text-xs text-vms-text placeholder-vms-dim focus:outline-none focus:border-amber-500 transition-colors"
          />
        </div>

        {/* Status Filter Tabs */}
        <div className="flex items-center space-x-1">
          {(['ALL', 'ONLINE', 'OFFLINE'] as const).map((filter) => (
            <button
              key={filter}
              onClick={() => setStatusFilter(filter)}
              className={`flex-1 py-1 text-[10px] font-mono uppercase tracking-wider rounded border transition-colors ${
                statusFilter === filter
                  ? 'bg-vms-elevated border-amber-500/50 text-amber-400 font-bold'
                  : 'bg-vms-surface border-vms-border text-vms-muted hover:text-vms-text hover:bg-vms-hover'
              }`}
            >
              {filter}
            </button>
          ))}
        </div>
      </div>

      {/* Camera Tree List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-3">
        {Object.keys(groupedCameras).length === 0 ? (
          <div className="p-4 text-center text-vms-dim text-xs font-mono">
            <Filter className="w-5 h-5 mx-auto mb-1.5 opacity-40" />
            No cameras match filters
          </div>
        ) : (
          Object.entries(groupedCameras).map(([groupName, groupCams]) => {
            const isCollapsed = collapsedGroups[groupName];
            return (
              <div key={groupName} className="rounded border border-vms-border/60 bg-vms-surface/20 overflow-hidden">
                {/* Group Header */}
                <button
                  onClick={() => toggleGroup(groupName)}
                  className="w-full px-2.5 py-1.5 bg-vms-surface/80 flex items-center justify-between text-left hover:bg-vms-hover transition-colors"
                >
                  <div className="flex items-center space-x-1.5">
                    {isCollapsed ? (
                      <ChevronRight className="w-3.5 h-3.5 text-vms-dim" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5 text-vms-dim" />
                    )}
                    <span className="text-xs font-medium text-vms-text font-sans">
                      {groupName}
                    </span>
                  </div>
                  <span className="text-[10px] font-mono text-vms-dim px-1.5 py-0.5 rounded bg-vms-elevated border border-vms-border/50">
                    {groupCams.length}
                  </span>
                </button>

                {/* Group Items */}
                {!isCollapsed && (
                  <div className="p-1 space-y-1">
                    {groupCams.map((cam) => {
                      const isAssigned = assignedCameraIds.has(cam.id);
                      const assignedInSlot = cameraSlots.findIndex((s) => s.cameraId === cam.id);

                      return (
                        <div
                          key={cam.id}
                          className={`group p-2 rounded border transition-all flex items-center justify-between gap-2 ${
                            isAssigned
                              ? 'bg-amber-500/5 border-amber-500/30'
                              : 'bg-vms-surface/50 border-vms-border/40 hover:border-vms-border hover:bg-vms-surface'
                          }`}
                        >
                          <div className="flex items-center space-x-2 min-w-0 flex-1">
                            <span
                              className={`w-2 h-2 rounded-full shrink-0 ${
                                cam.isOnline ? 'bg-emerald-400' : 'bg-rose-500'
                              }`}
                              title={cam.isOnline ? 'Camera Online' : 'Camera Offline'}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="text-xs font-medium text-vms-text truncate font-sans group-hover:text-amber-300 transition-colors">
                                {cam.name}
                              </div>
                              <div className="text-[10px] font-mono text-vms-dim flex items-center space-x-2">
                                <span>{cam.ipAddress || 'DHCP'}</span>
                                {cam.hasPtz && (
                                  <span className="text-sky-400 font-bold tracking-tight">PTZ</span>
                                )}
                                {isAssigned && assignedInSlot !== -1 && (
                                  <span className="text-amber-400 font-bold">
                                    Slot {assignedInSlot + 1 < 10 ? `0${assignedInSlot + 1}` : assignedInSlot + 1}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>

                          {/* Quick Bind Button */}
                          <button
                            onClick={() => onAssignCameraToSlot(cam.id, targetSlot)}
                            title={`Assign ${cam.name} to Slot ${targetSlot + 1}`}
                            className="px-2 py-1 rounded text-[10px] font-mono font-medium border border-vms-border bg-vms-elevated text-vms-muted hover:text-slate-950 hover:bg-amber-400 hover:border-amber-400 transition-colors shrink-0 flex items-center space-x-1 active:translate-y-[1px]"
                          >
                            <Crosshair className="w-3 h-3" />
                            <span>Slot {targetSlot + 1 < 10 ? `0${targetSlot + 1}` : targetSlot + 1}</span>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Footer Helper */}
      <div className="p-2 border-t border-vms-border bg-vms-surface/50 text-[10px] font-sans text-vms-dim flex items-center justify-between">
        <span>Click any slot in grid to refocus target</span>
        <span className="font-mono text-amber-500 font-medium">Click-to-Slot</span>
      </div>
    </aside>
  );
};

export default CameraDrawer;
