/**
 * DEMO-ONLY fixtures. Every reference to this module must sit behind `__DEMO_MODE__` so that
 * production builds (VITE_DEMO_MODE unset) tree-shake it out entirely. The production bundle is
 * grepped for these strings by backend/src/__tests__/frontendDemoHazards.test.ts.
 */
import type { CameraData } from '../components/CameraTile';

export interface DemoAlarmItem {
  id: string;
  title: string;
  description?: string | null;
  severity: string;
  state: 'ACTIVE' | 'ACKNOWLEDGED' | 'RESOLVED';
  cameraId: string | null;
  camera?: { id: string; name: string };
  eventId?: string | null;
  acknowledgedAt?: string | null;
  acknowledgedBy?: string | null;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
  resolutionNotes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export const DEMO_SAMPLE_CAMERAS: CameraData[] = [
  {
    id: 'demo-cam-01',
    name: 'Sector A — North Perimeter Gate',
    streamPath: 'live/north_gate',
    ipAddress: '192.168.10.101',
    hasPtz: true,
    recordingMode: 'CONTINUOUS',
    isOnline: true,
  },
  {
    id: 'demo-cam-02',
    name: 'Sector B — Terminal Concourse East',
    streamPath: 'live/concourse_east',
    ipAddress: '192.168.10.102',
    hasPtz: false,
    recordingMode: 'CONTINUOUS',
    isOnline: true,
  },
  {
    id: 'demo-cam-03',
    name: 'Sector C — Secure Evidence Vault',
    streamPath: 'live/vault_secure',
    ipAddress: '192.168.10.103',
    hasPtz: true,
    recordingMode: 'MOTION',
    isOnline: true,
  },
  {
    id: 'demo-cam-04',
    name: 'Sector D — Loading Dock Ingress',
    streamPath: 'live/loading_dock',
    ipAddress: '192.168.10.104',
    hasPtz: false,
    recordingMode: 'CONTINUOUS',
    isOnline: true,
  },
];

export const DEMO_ALARMS: DemoAlarmItem[] = [
  {
    id: 'demo-alm-01',
    title: 'Perimeter Intrusion Detected — North Gate 01',
    description: 'Thermal boundary tripwire violated outside authorized transit hours. Secondary optical motion confirmed.',
    severity: 'CRITICAL',
    state: 'ACTIVE',
    cameraId: 'demo-cam-1',
    camera: { id: 'demo-cam-1', name: 'North Gate - Perimeter 01' },
    createdAt: new Date(Date.now() - 1000 * 60 * 4).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 4).toISOString(),
  },
  {
    id: 'demo-alm-02',
    title: 'Lobby Fire Exit Door Held Open > 45s',
    description: 'Magnetic reed switch state open. Operator verification requested before auto-dispatch.',
    severity: 'WARNING',
    state: 'ACTIVE',
    cameraId: 'demo-cam-2',
    camera: { id: 'demo-cam-2', name: 'Main Concourse - Lobby West' },
    createdAt: new Date(Date.now() - 1000 * 60 * 14).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 14).toISOString(),
  },
  {
    id: 'demo-alm-03',
    title: 'Camera Signal Loss / RTSP Stream Timeout',
    description: 'Cargo Dock Bay 04 feed dropped. Reconnect attempts: 3/5. Inspect switch port 14.',
    severity: 'WARNING',
    state: 'ACKNOWLEDGED',
    cameraId: 'demo-cam-4',
    camera: { id: 'demo-cam-4', name: 'Cargo Dock - Loading Bay 04' },
    acknowledgedAt: new Date(Date.now() - 1000 * 60 * 25).toISOString(),
    acknowledgedBy: 'Alex Vance (Chief Security Officer)',
    createdAt: new Date(Date.now() - 1000 * 60 * 32).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 25).toISOString(),
  },
  {
    id: 'demo-alm-04',
    title: 'Server Vault Environmental Temp Spike (> 28°C)',
    description: 'Rack B-03 intake thermal sensor alert. CRAC unit failover triggered.',
    severity: 'INFO',
    state: 'RESOLVED',
    cameraId: 'demo-cam-3',
    camera: { id: 'demo-cam-3', name: 'Server Vault - High Sec 03' },
    acknowledgedAt: new Date(Date.now() - 1000 * 60 * 90).toISOString(),
    acknowledgedBy: 'Alex Vance (Chief Security Officer)',
    resolvedAt: new Date(Date.now() - 1000 * 60 * 45).toISOString(),
    resolvedBy: 'Alex Vance (Chief Security Officer)',
    resolutionNotes: 'Maintenance / Sensor Calibration Test — HVAC compressor reset complete.',
    createdAt: new Date(Date.now() - 1000 * 60 * 120).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 45).toISOString(),
  },
];

export const DEMO_EVENTS: any[] = [
  {
    id: 'demo-evt-01',
    eventType: 'MOTION_DETECTION',
    severity: 'CRITICAL',
    title: 'Fast Motion in Restricted Zone',
    description: 'Bounding box detected speed exceeding threshold (2.4m/s)',
    acknowledged: false,
    cameraId: 'demo-cam-1',
    camera: { id: 'demo-cam-1', name: 'North Gate - Perimeter 01' },
    timestamp: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
  },
  {
    id: 'demo-evt-02',
    eventType: 'DOOR_ACCESS_DENIED',
    severity: 'WARNING',
    title: 'Badge Read Failure / Invalid PIN',
    description: 'Badge ID #8492 attempted access to Vault Door B',
    acknowledged: false,
    cameraId: 'demo-cam-3',
    camera: { id: 'demo-cam-3', name: 'Server Vault - High Sec 03' },
    timestamp: new Date(Date.now() - 1000 * 60 * 18).toISOString(),
  },
  {
    id: 'demo-evt-03',
    eventType: 'TAMPER_DETECTED',
    severity: 'WARNING',
    title: 'Camera Optical Occlusion / Defocus',
    description: 'Lens contrast score dropped below 15% threshold',
    acknowledged: true,
    acknowledgedAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
    acknowledgedBy: 'Alex Vance',
    cameraId: 'demo-cam-4',
    camera: { id: 'demo-cam-4', name: 'Cargo Dock - Loading Bay 04' },
    timestamp: new Date(Date.now() - 1000 * 60 * 35).toISOString(),
  },
  {
    id: 'demo-evt-04',
    eventType: 'SYSTEM_AUDIT',
    severity: 'INFO',
    title: 'Scheduled NTP Clock Synchronization',
    description: 'Time drift corrected: +12ms relative to pool.ntp.org',
    acknowledged: true,
    acknowledgedAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
    acknowledgedBy: 'SYSTEM',
    timestamp: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
  },
];

export const DEMO_USER = {
  id: 'demo-super-admin',
  name: 'Alex Vance (Chief Security Officer)',
  email: 'admin@vigilone.local',
  role: 'SUPER_ADMIN',
  tenantId: 'demo-tenant-hq',
  tenant: {
    id: 'demo-tenant-hq',
    name: 'Metro Transit Command Facility',
  },
};

/** Not a JWT. The backend rejects it; demo mode only renders the UI shell. */
export const DEMO_TOKEN = 'demo-jwt-token-preview-mode';

/**
 * Demo-only form prefill. Deliberately NOT a real default: the appliance installer generates a
 * random SETUP_TOKEN, so this prefill cannot bootstrap a production appliance.
 */
export const DEMO_FORM_PREFILL = {
  facilityName: 'Metro Transit Command Facility',
  adminName: 'Alex Vance (Chief Security Officer)',
  email: 'admin@vigilone.local',
  password: 'DemoOnly-Change-Me-1!',
  setupToken: 'demo-mode-setup-token-not-valid-in-production',
};
