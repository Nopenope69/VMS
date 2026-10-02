/**
 * Every backend setting that is not part of the boot configuration (config/env.ts) is declared here once:
 * its environment variable, type, limits, default and meaning. Code reads a setting with `setting(NAME)`,
 * never `process.env.NAME`.
 *
 * Values are read when asked for, not frozen at start-up, so tests and the operator CLI can change them.
 * A value that does not parse is an error naming the variable, never a silent fallback: the server checks
 * every setting at start-up (`settingProblems`) and refuses to start on a bad one, e.g. an interval of "5s"
 * that would otherwise become NaN, which Node runs as a 1 ms timer.
 *
 * Subsystems that take an `env` parameter and check their own variables (embedding, VLM, crop and archive
 * workers, the federation uplink, the alarm workflow, the go-live check) keep doing so; they are listed in
 * SELF_CHECKED_SETTINGS so the guard test knows where those reads live.
 */

export class SettingError extends Error {
  constructor(public readonly variable: string, message: string) {
    super(`${variable}: ${message}`);
    this.name = 'SettingError';
  }
}

type Env = Record<string, string | undefined>;

interface Spec<T> {
  parse: (raw: string, name: string) => T;
  default: T;
  doc: string;
}

const text = (doc: string, def: string): Spec<string> => ({ parse: (raw) => raw, default: def, doc });
const optionalText = (doc: string): Spec<string | undefined> => ({ parse: (raw) => raw, default: undefined, doc });

const integer = (doc: string, def: number, min: number, max = Number.MAX_SAFE_INTEGER): Spec<number> => ({
  parse: (raw, name) => {
    const n = Number(raw.trim());
    if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(n)) throw new SettingError(name, `must be a whole number, got '${raw}'`);
    if (n < min || n > max) throw new SettingError(name, `must be between ${min} and ${max}, got ${n}`);
    return n;
  },
  default: def,
  doc,
});

const flag = (doc: string): Spec<boolean> => ({
  parse: (raw, name) => {
    const v = raw.trim().toLowerCase();
    if (v === 'true') return true;
    if (v === 'false' || v === '') return false;
    throw new SettingError(name, `must be 'true' or 'false', got '${raw}'`);
  },
  default: false,
  doc,
});

const httpUrl = (doc: string, def: string | undefined): Spec<string | undefined> => ({
  parse: (raw, name) => {
    let u: URL;
    try {
      u = new URL(raw.trim());
    } catch {
      throw new SettingError(name, `is not a URL: '${raw}'`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SettingError(name, `must be an http or https URL, got '${raw}'`);
    return raw.trim().replace(/\/+$/, '');
  },
  default: def,
  doc,
});

const nodeEnv: Spec<'development' | 'test' | 'production'> = {
  parse: (raw, name) => {
    if (raw === 'development' || raw === 'test' || raw === 'production') return raw;
    throw new SettingError(name, `must be development, test or production, got '${raw}'`);
  },
  default: 'development',
  doc: 'Run mode. production turns on secure cookies and refuses development secrets.',
};

export const SETTINGS = {
  NODE_ENV: nodeEnv,

  // Storage paths
  RECORDINGS_DIR: text('Root of the recordings volume.', '/recordings'),
  SNAPSHOTS_DIR: text('Alarm and plate snapshots.', '/recordings/snapshots'),
  EXPORTS_DIR: text('Evidence and redaction exports.', '/recordings/exports'),

  // Host state files (the appliance keeps these outside the database)
  APPLIANCE_MANIFEST_PATH: text('Control-plane manifest.', '/etc/vigilone/appliance_manifest.json'),
  LICENSE_MIRROR_PATH: text('Host mirror of the licence.', '/etc/vigilone/license.json'),
  PIN_STATE_MIRROR_PATH: text('Host mirror of evidence pins (read by retention outside the backend).', '/etc/vigilone/pinned_segments.state'),
  CLOCK_GUARD_STATE_PATH: text('Monotonic clock floor state.', '/etc/vigilone/clock_guard.state'),
  OTA_RELEASE_STATE_PATH: optionalText('OTA release state; default /etc/vigilone/ota_release.state (disaster recovery: next to its config).'),
  VIGILONE_VERSION_FILE: optionalText('Installed software version file; default: the OTA version file.'),
  VIGILONE_INSTALL_DIR: text('Install directory OTA updates are applied to.', '/opt/vigilone'),
  VIGILONE_MODEL_EXCEPTIONS: optionalText('Model licence exceptions file (default: the copy in the image).'),

  // Appliance identity
  APPLIANCE_ID: text('Appliance id in disaster-recovery bundles.', 'vigilone-edge-appliance-01'),
  APPLIANCE_HARDWARE_UUID: optionalText('Hardware UUID override for licence binding (default: read from DMI).'),
  APPLIANCE_MACHINE_ID: optionalText('Machine id override for licence binding (default: /etc/machine-id).'),

  // Intervals and limits
  DPDP_PURGE_INTERVAL_MS: integer('How often expired personal data is purged.', 3_600_000, 60_000, 86_400_000),
  DOOR_POLL_INTERVAL_MS: integer('How often door contacts are polled.', 500, 50, 60_000),
  CRASH_RECOVERY_ACTIVE_WRITE_GRACE_SECONDS: integer('Files modified this recently are treated as still being recorded; 0 turns the check off.', 120, 0, 86_400),
  REDACTION_MAX_CLIP_SECONDS: integer('Longest clip a redaction job accepts.', 1800, 1, 86_400),

  // High availability
  VIGILONE_HA_NODE_ID: optionalText('Turns high availability on: this node id competes for the leader lease.'),
  VIGILONE_HA_LEASE_TTL_MS: integer('Leader lease time to live.', 15_000, 1_000, 600_000),

  // Network and integrations
  VIGILONE_PUBLIC_URL: httpUrl('Address users open VigilOne at (required for SSO in production).', undefined),
  REDACTION_ADAPTER_URL: httpUrl('ai-adapter.v1 redaction-regions adapter.', 'http://127.0.0.1:7012'),
  COTURN_SECRET: text('Shared secret for TURN credentials.', 'vigilone_turn_secret_dev_38921'),
  COTURN_HOST: text('TURN server host.', 'turn.vigilone.internal'),
  COTURN_PORT: integer('TURN server port.', 3478, 1, 65_535),
  VIGILONE_AIR_GAPPED: flag('No internet: outbound notifications that need it are refused.'),
  ARCHIVE_ALLOW_INSECURE_ENDPOINT: flag('Allow an http (not https) object-storage endpoint, for a LAN MinIO.'),
  VIGILONE_HOST_NTP_SYNC: optionalText('Host clock sync state passed in by vigilonectl golive (yes / no).'),

  // Test only
  WHATSAPP_API_BASE_URL: optionalText('Test only: WhatsApp Cloud API base URL (honoured only when NODE_ENV=test).'),
  VIGILONE_ANPR_TEST_ENDPOINT: flag('Test only: exposes POST /anpr/detect (honoured only when NODE_ENV=test).'),
  VIGILONE_LICENSE_TEST_PUBLIC_KEY: optionalText('Test only: an extra Ed25519 public key (PEM) trusted for licence artifacts (honoured only when NODE_ENV=test).'),
} as const;

export type SettingName = keyof typeof SETTINGS;
export type SettingValue<K extends SettingName> = (typeof SETTINGS)[K] extends Spec<infer T> ? T : never;

/** The value of a setting: parsed from the environment, or its default when unset or empty. Throws SettingError. */
export function setting<K extends SettingName>(name: K, env: Env = process.env): SettingValue<K> {
  const spec = SETTINGS[name] as unknown as Spec<SettingValue<K>>;
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return spec.default;
  return spec.parse(raw, name);
}

/**
 * The parsed value when the variable is set, otherwise undefined. For the few settings that config/env.ts also
 * loads at boot (RECORDINGS_DIR, EXPORTS_DIR, COTURN_*): callers fall back to the boot config, which tests patch.
 */
export function settingIfSet<K extends SettingName>(name: K, env: Env = process.env): SettingValue<K> | undefined {
  const raw = env[name];
  return raw === undefined || raw.trim() === '' ? undefined : setting(name, env);
}

/** Every setting that is set but does not parse, as messages naming the variable. Empty when all are valid. */
export function settingProblems(env: Env = process.env): string[] {
  const problems: string[] = [];
  for (const name of Object.keys(SETTINGS) as SettingName[]) {
    try {
      setting(name, env);
    } catch (err: any) {
      problems.push(err.message);
    }
  }
  return problems;
}

/**
 * Variables read by subsystems that take an `env` parameter and validate it themselves; the guard test allows
 * their `process.env` defaults and nothing else.
 */
export const SELF_CHECKED_SETTINGS = [
  'services/search/embeddingWorkers.ts',
  'services/vlm/vlmWorkers.ts',
  'services/crops/cropWorkers.ts',
  'services/crops/cropCapture.service.ts',
  'services/storage/objectStorageArchive.service.ts',
  'services/federation/uplink.ts',
  'services/incident/workflow/alarmWorkflow.service.ts',
  'ops/goLiveCheck.ts',
] as const;
