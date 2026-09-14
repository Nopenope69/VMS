import React, { useState, useEffect } from 'react';
import { Search, Plus, Radio, AlertTriangle, Calendar, Shield, Compass, Activity, Crosshair } from 'lucide-react';
import api from '../services/api';
import ScheduleMatrixModal from '../components/ScheduleMatrixModal';
import DetectionZoneModal from '../components/DetectionZoneModal';
import PtzControlModal from '../components/PtzControlModal';
import StreamDiagnosticModal from '../components/StreamDiagnosticModal';
import TripwireModal from '../components/TripwireModal';

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
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowAddModal(false);
        setSelectedCameraForModal(null);
        setActiveModalType(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
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

  // Render a segmented gauge for quota
  const renderQuotaGauge = () => {
    if (!license || !license.maxCameras) return null;
    const total = license.maxCameras;
    const current = license.cameraCount || 0;
    const pct = Math.round((current / total) * 100);

    return (
      <div className="flex items-center space-x-2 bg-[#161B22] border border-[#30363D] px-2.5 py-1 text-xs">
        <span className="text-[10px] text-[#8B949E] uppercase tracking-wider">APPLIANCE_QUOTA:</span>
        <div className="w-16 bg-[#080B10] border border-[#30363D] h-2 p-0.5">
          <div
            className={`h-full ${pct > 90 ? 'bg-[#F85149]' : pct > 75 ? 'bg-[#E3B341]' : 'bg-[#3FB950]'}`}
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        </div>
        <span className="font-bold text-[#C9D1D9]">
          <span className="text-[#E3B341]">{current}</span>/{total}
        </span>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] bg-tactical-canvas p-4 space-y-3 overflow-y-auto font-mono text-tactical-text">
      {/* Top Action Bar */}
      <div className="bg-tactical-panel p-3.5 border border-tactical-border flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center space-x-2">
            <Radio className="w-5 h-5 text-phosphor-amber" />
            <h2 className="text-sm font-bold text-tactical-bright uppercase tracking-wider font-mono">
              Appliance Fleet & Sensor Topology
            </h2>
          </div>
          <p className="text-[11px] text-tactical-muted mt-0.5 font-sans">
            ONVIF PROFILE S/G/T APPLIANCES • RTSP/H.264 CAPTURE FLEET • FACILITY SENSOR REGISTRY
          </p>
        </div>

        <div className="flex items-center space-x-2">
          {renderQuotaGauge()}

          <button
            onClick={handleScan}
            disabled={scanning}
            className="btn-tactical-secondary flex items-center space-x-1.5 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors"
          >
            <Search className={`w-3.5 h-3.5 ${scanning ? 'animate-spin text-phosphor-cyan' : ''}`} />
            <span>{scanning ? 'Scanning LAN...' : 'WS-Discovery Radar'}</span>
          </button>

          <button
            onClick={() => setShowAddModal(true)}
            disabled={isQuotaReached}
            className="btn-tactical-primary flex items-center space-x-1.5 px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition-colors disabled:opacity-40"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>+ Onboard Feed</span>
          </button>
        </div>
      </div>

      {isQuotaReached && (
        <div className="p-2.5 bg-tactical-canvas border border-phosphor-amber text-phosphor-amber text-xs flex items-center space-x-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 text-phosphor-amber" />
          <span>
            [ QUOTA CEILING REACHED ] Appliance capacity limit attained ({license.maxCameras} feeds). Upgrade your license tier in License & Entitlements to provision additional hardware streams.
          </span>
        </div>
      )}

      {/* Discovered Cameras Notice */}
      {discovered.length > 0 && (
        <div className="bg-tactical-panel border border-phosphor-cyan/60 p-3">
          <div className="text-xs font-bold text-phosphor-cyan uppercase tracking-wider mb-2 flex items-center space-x-1.5 font-mono">
            <Radio className="w-4 h-4 animate-pulse" />
            <span>[ RADAR HIT ] FOUND {discovered.length} ONVIF BROADCASTING FEEDS ON LAN:</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            {discovered.map((d, idx) => (
              <div
                key={idx}
                className="bg-tactical-surface p-2 border border-tactical-border flex items-center justify-between"
              >
                <div>
                  <div className="text-xs font-bold text-white font-mono">{d.ipAddress}:{d.onvifPort}</div>
                  <div className="text-[10px] text-tactical-muted font-sans">{d.manufacturer || 'GENERIC'} {d.model || 'ONVIF-CAMERA'}</div>
                </div>
                <button
                  onClick={() => handleSelectDiscovered(d)}
                  className="btn-tactical-primary px-2.5 py-1 font-bold text-[10px] uppercase tracking-wider transition-colors"
                >
                  Onboard
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Configured Cameras Table */}
      <div className="bg-[#0D1117] border border-[#21262D] flex-1 flex flex-col">
        <div className="px-3.5 py-2.5 border-b border-[#21262D] bg-[#161B22] flex items-center justify-between text-xs">
          <span className="font-bold uppercase tracking-wider text-[#C9D1D9]">
            PROVISIONED SENSORS ({cameras.length})
          </span>
          <span className="text-[10px] text-[#8B949E]">
            ENGINE: ACTIVE RTMP/RTSP INGESTION DAEMON
          </span>
        </div>

        {cameras.length === 0 ? (
          <div className="p-12 text-center text-[#484F58] text-xs">
            [ NO CAMERAS CURRENTLY PROVISIONED. RUN A WS-DISCOVERY SCAN OR ADD AN ONVIF FEED MANUALLY. ]
          </div>
        ) : (
          <div className="overflow-x-auto flex-1">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#080B10] text-[#8B949E] uppercase text-[10px] border-b border-[#21262D] tracking-wider">
                <tr>
                  <th className="px-3.5 py-2">FEED_NAME</th>
                  <th className="px-3.5 py-2">FACILITY_SITE</th>
                  <th className="px-3.5 py-2">IP_ENDPOINT</th>
                  <th className="px-3.5 py-2">PTZ_OPTICS</th>
                  <th className="px-3.5 py-2">RECORDING_MODE</th>
                  <th className="px-3.5 py-2">REC_ENGINE</th>
                  <th className="px-3.5 py-2">STREAM_STATE</th>
                  <th className="px-3.5 py-2 text-right">OPERATIONS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#21262D] text-[#C9D1D9]">
                {cameras.map((c) => (
                  <tr key={c.id} className="hover:bg-[#161B22] transition-colors">
                    <td className="px-3.5 py-2.5 font-bold text-white">{c.name}</td>
                    <td className="px-3.5 py-2.5 text-[#8B949E]">{c.site?.name || 'PRIMARY_FACILITY'}</td>
                    <td className="px-3.5 py-2.5 text-[#E3B341]">{c.ipAddress}</td>
                    <td className="px-3.5 py-2.5">
                      {c.hasPtz ? (
                        <span className="px-1.5 py-0.5 bg-[#080B10] border border-[#58A6FF] text-[#58A6FF] text-[9px] font-bold">
                          3-AXIS PTZ
                        </span>
                      ) : (
                        <span className="text-[#484F58] text-[10px]">FIXED FOV</span>
                      )}
                    </td>
                    <td className="px-3.5 py-2.5">
                      <span className="px-1.5 py-0.5 bg-[#080B10] border border-[#30363D] text-[#C9D1D9] text-[10px] font-bold">
                        {c.recordingMode}
                      </span>
                    </td>
                    <td className="px-3.5 py-2.5">
                      <span
                        className={`px-1.5 py-0.5 text-[9px] font-bold border ${
                          c.recorderState === 'RUNNING'
                            ? 'bg-[#080B10] text-[#3FB950] border-[#238636]'
                            : 'bg-[#080B10] text-[#8B949E] border-[#30363D]'
                        }`}
                      >
                        {c.recorderState === 'RUNNING' ? 'REC: ACTIVE' : 'REC: IDLE'}
                      </span>
                    </td>
                    <td className="px-3.5 py-2.5">
                      <span className="inline-flex items-center space-x-1 text-[#3FB950] text-[10px] font-bold">
                        <span className="w-1.5 h-1.5 bg-[#3FB950] animate-pulse" />
                        <span>ONLINE</span>
                      </span>
                    </td>
                    <td className="px-3.5 py-2.5 text-right">
                      <div className="flex items-center justify-end space-x-1">
                        <button
                          onClick={() => {
                            setSelectedCameraForModal(c);
                            setActiveModalType('SCHEDULE');
                          }}
                          title="Weekly Recording Schedule Matrix"
                          className="px-2 py-1 bg-[#161B22] hover:bg-[#21262D] border border-[#30363D] hover:border-[#E3B341] text-[#8B949E] hover:text-[#E3B341] text-[10px] font-bold uppercase transition-colors"
                        >
                          <Calendar className="w-3 h-3 inline mr-1" />
                          <span>SCHED</span>
                        </button>
                        <button
                          onClick={() => {
                            setSelectedCameraForModal(c);
                            setActiveModalType('ZONES');
                          }}
                          title="Motion Detection Zones & Exclusion Masks"
                          className="px-2 py-1 bg-[#161B22] hover:bg-[#21262D] border border-[#30363D] hover:border-[#E3B341] text-[#8B949E] hover:text-[#E3B341] text-[10px] font-bold uppercase transition-colors"
                        >
                          <Shield className="w-3 h-3 inline mr-1" />
                          <span>ZONES</span>
                        </button>
                        {c.hasPtz && (
                          <button
                            onClick={() => {
                              setSelectedCameraForModal(c);
                              setActiveModalType('PTZ');
                            }}
                            title="PTZ Presets & Guard Patrol Tours"
                            className="px-2 py-1 bg-[#161B22] hover:bg-[#21262D] border border-[#30363D] hover:border-[#58A6FF] text-[#8B949E] hover:text-[#58A6FF] text-[10px] font-bold uppercase transition-colors"
                          >
                            <Compass className="w-3 h-3 inline mr-1" />
                            <span>PTZ</span>
                          </button>
                        )}
                        <button
                          onClick={() => {
                            setSelectedCameraForModal(c);
                            setActiveModalType('DIAGNOSTIC');
                          }}
                          title="Stream Telemetry & Diagnostics"
                          className="px-2 py-1 bg-[#161B22] hover:bg-[#21262D] border border-[#30363D] hover:border-[#3FB950] text-[#8B949E] hover:text-[#3FB950] text-[10px] font-bold uppercase transition-colors"
                        >
                          <Activity className="w-3 h-3 inline mr-1" />
                          <span>DIAG</span>
                        </button>
                        <button
                          onClick={() => {
                            setSelectedCameraForModal(c);
                            setActiveModalType('TRIPWIRE');
                          }}
                          title="Vector Tripwire & Continuous Loitering Analytics"
                          className="px-2 py-1 bg-[#161B22] hover:bg-[#21262D] border border-[#30363D] hover:border-[#E3B341] text-[#8B949E] hover:text-[#E3B341] text-[10px] font-bold uppercase transition-colors"
                        >
                          <Crosshair className="w-3 h-3 inline mr-1" />
                          <span>TRIP</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Manual Onboard Modal */}
      {showAddModal && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 bg-black/85 flex items-center justify-center p-4 z-50 font-mono"
        >
          <div className="bg-tactical-panel border border-tactical-border rounded-none w-full max-w-lg overflow-hidden shadow-2xl">
            <div className="px-4 py-3 border-b border-tactical-border flex justify-between items-center bg-tactical-surface">
              <div className="flex items-center space-x-2">
                <Radio className="w-4 h-4 text-phosphor-amber" />
                <h3 className="text-xs font-bold text-tactical-bright uppercase tracking-wider font-mono">
                  Onboard ONVIF / RTSP Hardware Feed
                </h3>
              </div>
              <button
                onClick={() => setShowAddModal(false)}
                className="text-tactical-muted hover:text-white text-xs px-2 py-0.5 border border-tactical-border hover:bg-tactical-raised"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleAddCamera} className="p-4 space-y-3 text-xs">
              {error && (
                <div className="p-2.5 bg-tactical-canvas border border-phosphor-red text-phosphor-red text-xs">
                  {error}
                </div>
              )}

              <div>
                <label className="block text-tactical-muted uppercase text-[10px] mb-1 font-mono">CAMERA_IDENTIFIER:</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. North Gate PTZ"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="input-tactical w-full px-2.5 py-1.5"
                />
              </div>

              <div>
                <label className="block text-tactical-muted uppercase text-[10px] mb-1 font-mono">FACILITY_SITE:</label>
                <select
                  value={siteId}
                  onChange={(e) => setSiteId(e.target.value)}
                  className="input-tactical w-full px-2.5 py-1.5"
                >
                  {sites.map((s) => (
                    <option key={s.id} value={s.id} className="bg-tactical-panel text-tactical-text">
                      {s.name} [{s.timezone}]
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-4 gap-2">
                <div className="col-span-2">
                  <label className="block text-tactical-muted uppercase text-[10px] mb-1 font-mono">IP_ADDRESS:</label>
                  <input
                    type="text"
                    required
                    placeholder="192.168.1.100"
                    value={ipAddress}
                    onChange={(e) => setIpAddress(e.target.value)}
                    className="input-tactical w-full px-2.5 py-1.5"
                  />
                </div>
                <div>
                  <label className="block text-tactical-muted uppercase text-[10px] mb-1 font-mono">ONVIF_PORT:</label>
                  <input
                    type="number"
                    value={onvifPort}
                    onChange={(e) => setOnvifPort(Number(e.target.value))}
                    className="input-tactical w-full px-2.5 py-1.5"
                  />
                </div>
                <div>
                  <label className="block text-tactical-muted uppercase text-[10px] mb-1 font-mono">RTSP_PORT:</label>
                  <input
                    type="number"
                    value={rtspPort}
                    onChange={(e) => setRtspPort(Number(e.target.value))}
                    className="input-tactical w-full px-2.5 py-1.5"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-tactical-muted uppercase text-[10px] mb-1 font-mono">AUTH_USERNAME:</label>
                  <input
                    type="text"
                    placeholder="admin"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="input-tactical w-full px-2.5 py-1.5"
                  />
                </div>
                <div>
                  <label className="block text-tactical-muted uppercase text-[10px] mb-1 font-mono">AUTH_PASSWORD:</label>
                  <input
                    type="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="input-tactical w-full px-2.5 py-1.5"
                  />
                </div>
              </div>

              <div>
                <label className="block text-tactical-muted uppercase text-[10px] mb-1 font-mono">RECORDING_MODE:</label>
                <select
                  value={recordingMode}
                  onChange={(e) => setRecordingMode(e.target.value)}
                  className="input-tactical w-full px-2.5 py-1.5"
                >
                  <option value="CONTINUOUS" className="bg-tactical-panel">CONTINUOUS (24/7 Lossless fMP4 Archive)</option>
                  <option value="MOTION" className="bg-tactical-panel">MOTION (Scene Detection Triggered)</option>
                  <option value="OFF" className="bg-tactical-panel">LIVE ONLY (Real-Time Display Only)</option>
                </select>
              </div>

              <div className="flex justify-end space-x-2 pt-3 border-t border-tactical-border">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="btn-tactical-secondary px-3 py-1.5 text-xs font-semibold uppercase tracking-wider"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="btn-tactical-primary px-4 py-1.5 text-xs font-bold uppercase tracking-wider disabled:opacity-50"
                >
                  {saving ? 'Connecting & Verifying...' : 'Onboard Camera'}
                </button>
              </div>
            </form>
          </div>
        </div>
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
