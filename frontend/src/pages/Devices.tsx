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

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] bg-graphite-900 p-4 space-y-4 overflow-y-auto">
      {/* Top Action Bar */}
      <div className="bg-graphite-850 p-4 rounded border border-graphite-700 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100 uppercase tracking-wider">Device Management</h2>
          <p className="text-xs text-slate-400">
            Manage ONVIF / RTSP camera appliances across your physical facility sites.
          </p>
        </div>

        <div className="flex items-center space-x-2">
          {license && (
            <div className="text-xs font-mono px-2.5 py-1 rounded bg-graphite-800 border border-graphite-700 text-slate-300 mr-2">
              Quota: <span className="text-cctv-amber font-semibold">{license.cameraCount}</span> / {license.maxCameras}
            </div>
          )}
          <button
            onClick={handleScan}
            disabled={scanning}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded text-xs font-medium bg-graphite-700 text-slate-200 hover:bg-graphite-600 transition"
          >
            <Search className={`w-3.5 h-3.5 ${scanning ? 'animate-spin' : ''}`} />
            <span>{scanning ? 'Scanning...' : 'WS-Discovery'}</span>
          </button>
          <button
            onClick={() => setShowAddModal(true)}
            disabled={isQuotaReached}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded text-xs font-semibold bg-cctv-amber text-graphite-900 hover:bg-amber-400 transition disabled:opacity-50"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Manual IP Entry</span>
          </button>
        </div>
      </div>

      {isQuotaReached && (
        <div className="p-3 bg-amber-950/40 border border-amber-600 rounded flex items-center space-x-2 text-xs text-amber-200">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 text-amber-400" />
          <span>
            Camera capacity quota reached ({license.maxCameras} cameras). Please upgrade your commercial license under the License tab to onboard additional feeds.
          </span>
        </div>
      )}

      {/* Discovered Cameras Notice */}
      {discovered.length > 0 && (
        <div className="bg-cctv-teal/10 border border-cctv-teal/50 rounded p-3">
          <div className="text-xs font-semibold text-cctv-teal mb-2 flex items-center space-x-1.5">
            <Radio className="w-4 h-4" />
            <span>Found {discovered.length} ONVIF Cameras on LAN:</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            {discovered.map((d, idx) => (
              <div
                key={idx}
                className="bg-graphite-850 p-2.5 rounded border border-graphite-700 flex items-center justify-between"
              >
                <div>
                  <div className="text-xs font-mono font-semibold text-slate-200">{d.ipAddress}:{d.onvifPort}</div>
                  <div className="text-[10px] text-slate-400">{d.manufacturer || 'Generic'} {d.model || 'Device'}</div>
                </div>
                <button
                  onClick={() => handleSelectDiscovered(d)}
                  className="px-2 py-1 bg-cctv-teal text-graphite-900 font-bold rounded text-[10px] hover:bg-teal-400"
                >
                  Onboard
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Configured Cameras Table */}
      <div className="bg-graphite-850 rounded border border-graphite-700 overflow-hidden">
        <div className="px-4 py-3 border-b border-graphite-700 font-semibold text-xs uppercase tracking-wider text-slate-300">
          Configured Cameras ({cameras.length})
        </div>

        {cameras.length === 0 ? (
          <div className="p-8 text-center text-slate-500 font-mono text-xs">
            No cameras currently onboarded. Run a WS-Discovery scan or add one manually.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-graphite-900 text-slate-400 uppercase text-[10px] border-b border-graphite-700">
                <tr>
                  <th className="px-4 py-2.5">Name</th>
                  <th className="px-4 py-2.5">Site Location</th>
                  <th className="px-4 py-2.5">IP Address</th>
                  <th className="px-4 py-2.5">PTZ</th>
                  <th className="px-4 py-2.5">Configured Mode</th>
                  <th className="px-4 py-2.5">Engine Status</th>
                  <th className="px-4 py-2.5">Stream State</th>
                  <th className="px-4 py-2.5 text-right">Surveillance Operations</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-graphite-700 text-slate-300">
                {cameras.map((c) => (
                  <tr key={c.id} className="hover:bg-graphite-800 transition">
                    <td className="px-4 py-3 font-semibold text-white">{c.name}</td>
                    <td className="px-4 py-3 text-slate-400">{c.site?.name || 'Primary Site'}</td>
                    <td className="px-4 py-3 text-cctv-amber">{c.ipAddress}</td>
                    <td className="px-4 py-3">
                      {c.hasPtz ? (
                        <span className="px-1.5 py-0.5 rounded bg-cctv-teal/20 text-cctv-teal text-[10px]">
                          SUPPORTED
                        </span>
                      ) : (
                        <span className="text-slate-500 text-[10px]">FIXED</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="px-1.5 py-0.5 rounded bg-graphite-700 text-slate-200 text-[10px]">
                        {c.recordingMode}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                          c.recorderState === 'RUNNING'
                            ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                            : 'bg-graphite-800 text-slate-400'
                        }`}
                      >
                        REC: {c.recorderState || 'STOPPED'}
                      </span>
                    </td>
                    <td className="px-4 py-3 flex items-center space-x-1.5">
                      <span className="w-2 h-2 rounded-full bg-emerald-400" />
                      <span className="text-emerald-400">ONLINE</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end space-x-1.5">
                        <button
                          onClick={() => {
                            setSelectedCameraForModal(c);
                            setActiveModalType('SCHEDULE');
                          }}
                          title="Weekly Recording Schedule Matrix"
                          className="p-1.5 rounded bg-graphite-800 text-slate-300 hover:text-cctv-amber hover:bg-graphite-700 transition"
                        >
                          <Calendar className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => {
                            setSelectedCameraForModal(c);
                            setActiveModalType('ZONES');
                          }}
                          title="Motion Detection Zones & Exclusion Masks"
                          className="p-1.5 rounded bg-graphite-800 text-slate-300 hover:text-cctv-amber hover:bg-graphite-700 transition"
                        >
                          <Shield className="w-3.5 h-3.5" />
                        </button>
                        {c.hasPtz && (
                          <button
                            onClick={() => {
                              setSelectedCameraForModal(c);
                              setActiveModalType('PTZ');
                            }}
                            title="PTZ Presets & Guard Patrol Tours"
                            className="p-1.5 rounded bg-graphite-800 text-slate-300 hover:text-cctv-amber hover:bg-graphite-700 transition"
                          >
                            <Compass className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button
                          onClick={() => {
                            setSelectedCameraForModal(c);
                            setActiveModalType('DIAGNOSTIC');
                          }}
                          title="Stream Telemetry & Diagnostics"
                          className="p-1.5 rounded bg-graphite-800 text-slate-300 hover:text-cctv-teal hover:bg-graphite-700 transition"
                        >
                          <Activity className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => {
                            setSelectedCameraForModal(c);
                            setActiveModalType('TRIPWIRE');
                          }}
                          title="Vector Tripwire & Continuous Loitering Analytics"
                          className="p-1.5 rounded bg-graphite-800 text-slate-300 hover:text-cctv-amber hover:bg-graphite-700 transition"
                        >
                          <Crosshair className="w-3.5 h-3.5" />
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
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50 backdrop-blur-sm">
          <div className="bg-graphite-850 border border-graphite-700 rounded-md w-full max-w-lg overflow-hidden shadow-2xl">
            <div className="px-5 py-4 border-b border-graphite-700 flex justify-between items-center bg-graphite-800">
              <h3 className="text-sm font-semibold text-slate-100 uppercase tracking-wider">
                Onboard ONVIF / RTSP Camera
              </h3>
              <button onClick={() => setShowAddModal(false)} className="text-slate-400 hover:text-white">✕</button>
            </div>

            <form onSubmit={handleAddCamera} className="p-5 space-y-3.5">
              {error && (
                <div className="p-2.5 bg-red-900/40 border border-red-500 rounded text-xs text-red-200">
                  {error}
                </div>
              )}

              <div>
                <label className="block text-xs font-mono text-slate-300 mb-1">Camera Name</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. North Gate PTZ"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full bg-graphite-900 border border-graphite-700 rounded px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cctv-amber"
                />
              </div>

              <div>
                <label className="block text-xs font-mono text-slate-300 mb-1">Assigned Site</label>
                <select
                  value={siteId}
                  onChange={(e) => setSiteId(e.target.value)}
                  className="w-full bg-graphite-900 border border-graphite-700 rounded px-3 py-1.5 text-xs text-slate-200 font-mono focus:outline-none focus:border-cctv-amber"
                >
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.timezone})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-4 gap-2">
                <div className="col-span-2">
                  <label className="block text-xs font-mono text-slate-300 mb-1">IP Address</label>
                  <input
                    type="text"
                    required
                    placeholder="192.168.1.100"
                    value={ipAddress}
                    onChange={(e) => setIpAddress(e.target.value)}
                    className="w-full bg-graphite-900 border border-graphite-700 rounded px-3 py-1.5 text-xs text-slate-200 font-mono focus:outline-none focus:border-cctv-amber"
                  />
                </div>
                <div>
                  <label className="block text-xs font-mono text-slate-300 mb-1">ONVIF Port</label>
                  <input
                    type="number"
                    value={onvifPort}
                    onChange={(e) => setOnvifPort(Number(e.target.value))}
                    className="w-full bg-graphite-900 border border-graphite-700 rounded px-2.5 py-1.5 text-xs text-slate-200 font-mono focus:outline-none focus:border-cctv-amber"
                  />
                </div>
                <div>
                  <label className="block text-xs font-mono text-slate-300 mb-1">RTSP Port</label>
                  <input
                    type="number"
                    value={rtspPort}
                    onChange={(e) => setRtspPort(Number(e.target.value))}
                    className="w-full bg-graphite-900 border border-graphite-700 rounded px-2.5 py-1.5 text-xs text-slate-200 font-mono focus:outline-none focus:border-cctv-amber"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-mono text-slate-300 mb-1">ONVIF Username</label>
                  <input
                    type="text"
                    placeholder="admin"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="w-full bg-graphite-900 border border-graphite-700 rounded px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cctv-amber"
                  />
                </div>
                <div>
                  <label className="block text-xs font-mono text-slate-300 mb-1">ONVIF Password</label>
                  <input
                    type="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full bg-graphite-900 border border-graphite-700 rounded px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cctv-amber"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-mono text-slate-300 mb-1">Recording Mode</label>
                <select
                  value={recordingMode}
                  onChange={(e) => setRecordingMode(e.target.value)}
                  className="w-full bg-graphite-900 border border-graphite-700 rounded px-3 py-1.5 text-xs text-slate-200 font-mono focus:outline-none focus:border-cctv-amber"
                >
                  <option value="CONTINUOUS">CONTINUOUS (24/7 fMP4 Recording)</option>
                  <option value="MOTION">MOTION (Scene Change Triggered Recording)</option>
                  <option value="OFF">LIVE ONLY (No Recording)</option>
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
                  disabled={saving}
                  className="px-4 py-1.5 rounded text-xs font-semibold bg-cctv-amber text-graphite-900 hover:bg-amber-400 disabled:opacity-50"
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
