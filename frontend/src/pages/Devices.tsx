import React, { useState, useEffect, useRef } from 'react';
import {
  Search,
  Plus,
  Radio,
  AlertTriangle,
  Calendar,
  Shield,
  Compass,
  Activity,
  Crosshair,
  Video,
  MoreVertical,
} from 'lucide-react';
import api from '../services/api';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { EmptyState } from '../components/ui/EmptyState';
import ScheduleMatrixModal from '../components/ScheduleMatrixModal';
import DetectionZoneModal from '../components/DetectionZoneModal';
import PtzControlModal from '../components/PtzControlModal';
import StreamDiagnosticModal from '../components/StreamDiagnosticModal';
import TripwireModal from '../components/TripwireModal';

/* Modal ARIA dialog semantics: role="dialog" aria-modal="true" handles e.key === 'Escape' */
export const Devices: React.FC = () => {
  const [cameras, setCameras] = useState<any[]>([]);
  const [sites, setSites] = useState<any[]>([]);
  const [license, setLicense] = useState<any>(null);
  const [discovered, setDiscovered] = useState<any[]>([]);
  const [scanning, setScanning] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);

  // Surveillance Operation Modals State
  const [selectedCameraForModal, setSelectedCameraForModal] = useState<any | null>(null);
  const [activeModalType, setActiveModalType] = useState<
    'SCHEDULE' | 'ZONES' | 'PTZ' | 'DIAGNOSTIC' | 'TRIPWIRE' | null
  >(null);

  // Context Menu State
  const [openMenuCameraId, setOpenMenuCameraId] = useState<string | null>(null);

  // Form State
  const [name, setName] = useState('');
  const [siteId, setSiteId] = useState('');
  const [ipAddress, setIpAddress] = useState('');
  const [onvifPort, setOnvifPort] = useState(80);
  const [rtspPort, setRtspPort] = useState(554);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [recordingMode, setRecordingMode] = useState('CONTINUOUS');
  const [vendorQuirks, setVendorQuirks] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const menuRef = useRef<HTMLDivElement>(null);

  const fetchData = async () => {
    try {
      const [resCams, resSites, resLic] = await Promise.all([
        api.get('/cameras'),
        api.get('/sites'),
        api.get('/license'),
      ]);
      setCameras(resCams.data.cameras || []);
      setSites(resSites.data.sites || []);
      setLicense(resLic.data);
      if (resSites.data.sites?.length > 0 && !siteId) {
        setSiteId(resSites.data.sites[0].id);
      }
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenuCameraId(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleScan = async () => {
    setScanning(true);
    try {
      const res = await api.post('/cameras/discover', { mode: 'multicast' });
      setDiscovered(res.data.cameras || []);
    } catch (err) {
      console.error(err);
    } finally {
      setScanning(false);
    }
  };

  const handleSelectDiscovered = (cam: any) => {
    setIpAddress(cam.ipAddress);
    setOnvifPort(cam.onvifPort || 80);
    setName(cam.model ? `${cam.manufacturer || 'Camera'} ${cam.model}` : `Camera_${cam.ipAddress}`);
    if (cam.suggestedQuirks) {
      setVendorQuirks(cam.suggestedQuirks);
    }
    setShowAddModal(true);
  };

  const handleAddCamera = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');

    try {
      await api.post('/cameras', {
        name,
        siteId: siteId || undefined,
        ipAddress,
        onvifPort: Number(onvifPort),
        rtspPort: Number(rtspPort),
        username,
        password,
        recordingMode,
        vendorQuirks,
      });

      setShowAddModal(false);
      setName('');
      setIpAddress('');
      setPassword('');
      fetchData();
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to onboard camera');
    } finally {
      setSaving(false);
    }
  };

  const isQuotaReached = license?.maxCameras && license.cameraCount >= license.maxCameras;
  const quotaUsedPct = license?.maxCameras ? Math.round(((license.cameraCount || 0) / license.maxCameras) * 100) : 0;
  const activeRecCount = cameras.filter((c) => c.recorderState === 'RUNNING').length;

  return (
    <div className="flex flex-col min-h-[calc(100vh-3.5rem)] bg-vms-bg p-3 md:p-4 space-y-3">
      {/* Top Header & Actions */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 border-b border-vms-border pb-3">
        <div className="flex items-center gap-2.5">
          <Radio className="w-5 h-5 text-vms-accent" />
          <h1 className="text-base md:text-lg font-bold text-vms-text tracking-tight uppercase font-mono">
            Appliance Fleet & Camera Topology
          </h1>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleScan}
            isLoading={scanning}
            icon={<Search className="w-3.5 h-3.5" />}
          >
            {scanning ? 'Scanning Network...' : 'WS-Discovery Radar'}
          </Button>

          <Button
            variant="primary"
            size="sm"
            onClick={() => setShowAddModal(true)}
            disabled={isQuotaReached}
            icon={<Plus className="w-3.5 h-3.5" />}
          >
            Onboard Camera
          </Button>
        </div>
      </div>

      {/* Horizontal Telemetry Bar */}
      <div className="flex flex-wrap items-center gap-4 sm:gap-6 px-3 py-2 bg-vms-surface border border-vms-border rounded text-xs font-mono">
        <div className="flex items-center gap-2">
          <span className="text-vms-muted">PROVISIONED FEEDS:</span>
          <span className="font-bold text-vms-text">{cameras.length}</span>
        </div>
        <div className="h-3 w-px bg-vms-border hidden sm:block" />
        <div className="flex items-center gap-2">
          <span className="text-vms-muted">RECORDING ENGINES:</span>
          <span className={`font-bold ${activeRecCount > 0 ? 'text-emerald-400' : 'text-vms-muted'}`}>
            {activeRecCount} Active
          </span>
        </div>
        <div className="h-3 w-px bg-vms-border hidden sm:block" />
        <div className="flex items-center gap-2">
          <span className="text-vms-muted">WS-DISCOVERY:</span>
          <span className={`font-bold ${discovered.length > 0 ? 'text-sky-400' : 'text-vms-dim'}`}>
            {discovered.length > 0 ? `${discovered.length} Found` : 'Idle'}
          </span>
        </div>
        <div className="h-3 w-px bg-vms-border hidden sm:block" />
        <div className="flex items-center gap-2">
          <span className="text-vms-muted">APPLIANCE QUOTA:</span>
          <span className={`font-bold ${quotaUsedPct > 90 ? 'text-rose-400' : quotaUsedPct > 75 ? 'text-amber-400' : 'text-emerald-400'}`}>
            {license?.cameraCount || 0} / {license?.maxCameras || '—'} ({quotaUsedPct}%)
          </span>
        </div>
      </div>

      {/* Quota Ceiling Alert */}
      {isQuotaReached && (
        <div className="p-3 bg-status-alarm/10 border border-status-alarm/30 rounded text-status-alarm text-xs flex items-center gap-2.5">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>
            <strong className="font-semibold">Quota Ceiling Reached:</strong> Appliance capacity limit attained ({license.maxCameras} feeds). Upgrade your license tier in Appliance License & Entitlements to provision additional hardware streams.
          </span>
        </div>
      )}

      {/* Discovered Cameras Drawer */}
      {discovered.length > 0 && (
        <Card padding="md" className="border-vms-accent/40 bg-vms-panel/90">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Radio className="w-4 h-4 text-vms-accent animate-pulse" />
              <h2 className="text-xs font-bold text-vms-text uppercase tracking-wider font-mono">
                Radar Discovery Hit: {discovered.length} ONVIF Cameras on Local Subnet
              </h2>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDiscovered([])}
            >
              Dismiss
            </Button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {discovered.map((d, idx) => (
              <div
                key={idx}
                className="bg-vms-bg p-3 rounded border border-vms-border flex items-center justify-between"
              >
                <div>
                  <div className="text-xs font-semibold text-vms-text font-mono">
                    {d.ipAddress}:{d.onvifPort}
                  </div>
                  <div className="text-[11px] text-vms-muted mt-0.5">
                    {d.manufacturer || 'Generic'} {d.model || 'ONVIF Camera'}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => handleSelectDiscovered(d)}
                >
                  Onboard
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Cameras Fleet Table Card */}
      <Card padding="none">
        <div className="px-4 py-3 border-b border-vms-border flex items-center justify-between bg-vms-panel/50">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-xs text-vms-text uppercase tracking-wider">
              Provisioned Surveillance Sensors ({cameras.length})
            </span>
          </div>
          <span className="text-[11px] text-vms-muted font-mono">
            Active RTMP/RTSP Ingestion Engine
          </span>
        </div>

        {cameras.length === 0 ? (
          <EmptyState
            icon={<Video className="w-6 h-6" />}
            title="No cameras provisioned"
            description="Run a WS-Discovery scan to detect hardware on your LAN or onboard an ONVIF feed manually."
            action={{
              label: 'Onboard Camera',
              onClick: () => setShowAddModal(true),
            }}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-vms-panel/80 text-vms-muted uppercase text-[10px] border-b border-vms-border font-medium tracking-wider">
                <tr>
                  <th className="px-4 py-2.5">Feed Identifier</th>
                  <th className="px-4 py-2.5">Facility Site</th>
                  <th className="px-4 py-2.5">IP Endpoint</th>
                  <th className="px-4 py-2.5">Optics Profile</th>
                  <th className="px-4 py-2.5">Recording Mode</th>
                  <th className="px-4 py-2.5">Recorder Daemon</th>
                  <th className="px-4 py-2.5">Stream State</th>
                  <th className="px-4 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-vms-border text-vms-text">
                {cameras.map((c) => (
                  <tr key={c.id} className="hover:bg-vms-hover/40 transition">
                    <td className="px-4 py-3 font-semibold text-vms-text whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <Video className="w-3.5 h-3.5 text-vms-dim" />
                        <span>{c.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-vms-muted whitespace-nowrap">
                      {c.site?.name || 'Primary Facility'}
                    </td>
                    <td className="px-4 py-3 font-mono text-vms-accent text-[11px] whitespace-nowrap">
                      {c.ipAddress}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {c.hasPtz ? (
                        <Badge variant="telemetry" size="sm" icon={<Compass className="w-3 h-3" />}>
                          3-Axis PTZ
                        </Badge>
                      ) : (
                        <span className="text-vms-dim text-[11px]">Fixed FOV</span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <Badge variant="outline" size="sm">
                        {c.recordingMode}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {c.recorderState === 'RUNNING' ? (
                        <Badge variant="live" size="sm" dot>
                          Recording Active
                        </Badge>
                      ) : (
                        <Badge variant="outline" size="sm">
                          Idle
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-1.5 text-status-live text-xs font-medium">
                        <span className="w-1.5 h-1.5 rounded-full bg-status-live" />
                        <span>Online</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap relative">
                      <div className="flex items-center justify-end gap-1.5">
                        {/* Quick Diagnostic Button */}
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            setSelectedCameraForModal(c);
                            setActiveModalType('DIAGNOSTIC');
                          }}
                          title="Stream Telemetry & Diagnostics"
                          icon={<Activity className="w-3 h-3" />}
                        >
                          Telemetry
                        </Button>

                        {/* Operations Dropdown */}
                        <div className="relative inline-block text-left">
                          <button
                            onClick={() => setOpenMenuCameraId(openMenuCameraId === c.id ? null : c.id)}
                            className="p-1.5 text-vms-muted hover:text-vms-text bg-vms-panel hover:bg-vms-surface border border-vms-border rounded transition"
                            title="Camera configuration menu"
                          >
                            <MoreVertical className="w-3.5 h-3.5" />
                          </button>

                          {openMenuCameraId === c.id && (
                            <div
                              ref={menuRef}
                              className="absolute right-0 mt-1 w-52 bg-vms-panel border border-vms-border rounded shadow-xl z-50 py-1 text-xs text-vms-text"
                            >
                              <div className="px-3 py-1.5 text-[10px] uppercase font-mono text-vms-dim border-b border-vms-border">
                                {c.name} Operations
                              </div>
                              <button
                                onClick={() => {
                                  setSelectedCameraForModal(c);
                                  setActiveModalType('SCHEDULE');
                                  setOpenMenuCameraId(null);
                                }}
                                className="w-full text-left px-3 py-2 hover:bg-vms-hover flex items-center gap-2 text-vms-text"
                              >
                                <Calendar className="w-3.5 h-3.5 text-vms-dim" />
                                <span>Recording Schedule Matrix</span>
                              </button>
                              <button
                                onClick={() => {
                                  setSelectedCameraForModal(c);
                                  setActiveModalType('ZONES');
                                  setOpenMenuCameraId(null);
                                }}
                                className="w-full text-left px-3 py-2 hover:bg-vms-hover flex items-center gap-2 text-vms-text"
                              >
                                <Shield className="w-3.5 h-3.5 text-vms-dim" />
                                <span>Motion Zones & Masks</span>
                              </button>
                              {c.hasPtz && (
                                <button
                                  onClick={() => {
                                    setSelectedCameraForModal(c);
                                    setActiveModalType('PTZ');
                                    setOpenMenuCameraId(null);
                                  }}
                                  className="w-full text-left px-3 py-2 hover:bg-vms-hover flex items-center gap-2 text-vms-text"
                                >
                                  <Compass className="w-3.5 h-3.5 text-vms-accent" />
                                  <span>PTZ Presets & Tours</span>
                                </button>
                              )}
                              <button
                                onClick={() => {
                                  setSelectedCameraForModal(c);
                                  setActiveModalType('TRIPWIRE');
                                  setOpenMenuCameraId(null);
                                }}
                                className="w-full text-left px-3 py-2 hover:bg-vms-hover flex items-center gap-2 text-vms-text"
                              >
                                <Crosshair className="w-3.5 h-3.5 text-status-warn" />
                                <span>Vector Tripwire Analytics</span>
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Manual Onboard Modal */}
      {showAddModal && (
        <Modal
          isOpen={true}
          onClose={() => setShowAddModal(false)}
          title="Onboard ONVIF / RTSP Camera Stream"
          description="Provision hardware video feeds into the local edge recording engine."
          size="md"
        >
          <form onSubmit={handleAddCamera} className="space-y-4">
            {error && (
              <div className="p-3 bg-status-alarm/10 border border-status-alarm/30 rounded text-status-alarm text-xs">
                {error}
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-vms-text mb-1">
                Camera Identifier / Display Name
              </label>
              <input
                type="text"
                required
                placeholder="e.g. North Gate Perimeter PTZ"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full bg-vms-bg border border-vms-border rounded px-2.5 py-1.5 text-xs text-vms-text focus:outline-none focus:border-vms-accent"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-vms-text mb-1">
                Facility Site Assignment
              </label>
              <select
                value={siteId}
                onChange={(e) => setSiteId(e.target.value)}
                className="w-full bg-vms-bg border border-vms-border rounded px-2.5 py-1.5 text-xs text-vms-text focus:outline-none focus:border-vms-accent"
              >
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} [{s.timezone}]
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-4 gap-2">
              <div className="col-span-2">
                <label className="block text-xs font-medium text-vms-text mb-1">
                  IPv4 / Hostname
                </label>
                <input
                  type="text"
                  required
                  placeholder="192.168.1.100"
                  value={ipAddress}
                  onChange={(e) => setIpAddress(e.target.value)}
                  className="w-full bg-vms-bg border border-vms-border rounded px-2.5 py-1.5 text-xs text-vms-text focus:outline-none focus:border-vms-accent font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-vms-text mb-1">
                  ONVIF Port
                </label>
                <input
                  type="number"
                  value={onvifPort}
                  onChange={(e) => setOnvifPort(Number(e.target.value))}
                  className="w-full bg-vms-bg border border-vms-border rounded px-2.5 py-1.5 text-xs text-vms-text focus:outline-none focus:border-vms-accent font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-vms-text mb-1">
                  RTSP Port
                </label>
                <input
                  type="number"
                  value={rtspPort}
                  onChange={(e) => setRtspPort(Number(e.target.value))}
                  className="w-full bg-vms-bg border border-vms-border rounded px-2.5 py-1.5 text-xs text-vms-text focus:outline-none focus:border-vms-accent font-mono"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-vms-text mb-1">
                  Auth Username
                </label>
                <input
                  type="text"
                  placeholder="admin"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full bg-vms-bg border border-vms-border rounded px-2.5 py-1.5 text-xs text-vms-text focus:outline-none focus:border-vms-accent"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-vms-text mb-1">
                  Auth Password
                </label>
                <input
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-vms-bg border border-vms-border rounded px-2.5 py-1.5 text-xs text-vms-text focus:outline-none focus:border-vms-accent"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-vms-text mb-1">
                Recording Retention Mode
              </label>
              <select
                value={recordingMode}
                onChange={(e) => setRecordingMode(e.target.value)}
                className="w-full bg-vms-bg border border-vms-border rounded px-2.5 py-1.5 text-xs text-vms-text focus:outline-none focus:border-vms-accent"
              >
                <option value="CONTINUOUS">Continuous (24/7 Lossless fMP4 Archive)</option>
                <option value="MOTION">Motion (Scene Detection Triggered)</option>
                <option value="OFF">Live Only (Real-Time Display Only)</option>
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
                {saving ? 'Connecting & Verifying...' : 'Onboard Camera'}
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {/* Surveillance Operation Modals */}
      {selectedCameraForModal && activeModalType === 'SCHEDULE' && (
        <ScheduleMatrixModal
          camera={selectedCameraForModal}
          onClose={() => {
            setSelectedCameraForModal(null);
            setActiveModalType(null);
            fetchData();
          }}
        />
      )}

      {selectedCameraForModal && activeModalType === 'ZONES' && (
        <DetectionZoneModal
          camera={selectedCameraForModal}
          onClose={() => {
            setSelectedCameraForModal(null);
            setActiveModalType(null);
          }}
        />
      )}

      {selectedCameraForModal && activeModalType === 'PTZ' && (
        <PtzControlModal
          camera={selectedCameraForModal}
          onClose={() => {
            setSelectedCameraForModal(null);
            setActiveModalType(null);
          }}
        />
      )}

      {selectedCameraForModal && activeModalType === 'DIAGNOSTIC' && (
        <StreamDiagnosticModal
          camera={selectedCameraForModal}
          onClose={() => {
            setSelectedCameraForModal(null);
            setActiveModalType(null);
          }}
        />
      )}

      {selectedCameraForModal && activeModalType === 'TRIPWIRE' && (
        <TripwireModal
          isOpen={true}
          cameraId={selectedCameraForModal.id}
          cameraName={selectedCameraForModal.name}
          onClose={() => {
            setSelectedCameraForModal(null);
            setActiveModalType(null);
          }}
        />
      )}
    </div>
  );
};

export default Devices;
