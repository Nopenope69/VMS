/**
 * config/settings.ts is the one declaration of the backend's settings. These tests pin that a bad value is an
 * error naming the variable (never NaN or a silent fallback), that the server refuses to start on one, and that
 * no code outside the allowed places reads process.env directly.
 */
import fs from 'fs';
import path from 'path';
import { SETTINGS, SELF_CHECKED_SETTINGS, SettingError, setting, settingProblems } from '../config/settings';
import { envSchema } from '../config/env';

describe('settings', () => {
  it('every default is valid, so an empty environment has no problems', () => {
    expect(settingProblems({})).toEqual([]);
    expect(setting('DOOR_POLL_INTERVAL_MS', {})).toBe(500);
    expect(setting('VIGILONE_AIR_GAPPED', {})).toBe(false);
    expect(setting('VIGILONE_PUBLIC_URL', {})).toBeUndefined();
  });

  it('parses valid values', () => {
    expect(setting('DOOR_POLL_INTERVAL_MS', { DOOR_POLL_INTERVAL_MS: ' 250 ' })).toBe(250);
    expect(setting('VIGILONE_AIR_GAPPED', { VIGILONE_AIR_GAPPED: 'TRUE' })).toBe(true);
    expect(setting('VIGILONE_PUBLIC_URL', { VIGILONE_PUBLIC_URL: 'https://vms.example.in/' })).toBe('https://vms.example.in');
    expect(setting('CRASH_RECOVERY_ACTIVE_WRITE_GRACE_SECONDS', { CRASH_RECOVERY_ACTIVE_WRITE_GRACE_SECONDS: '0' })).toBe(0);
  });

  it.each([
    ['DOOR_POLL_INTERVAL_MS', '5s', /whole number/],
    ['DOOR_POLL_INTERVAL_MS', '1.5', /whole number/],
    ['DOOR_POLL_INTERVAL_MS', '10', /between 50 and 60000/],
    ['DPDP_PURGE_INTERVAL_MS', '-1', /whole number/],
    ['VIGILONE_HA_LEASE_TTL_MS', 'fifteen seconds', /whole number/],
    ['COTURN_PORT', '70000', /between 1 and 65535/],
    ['VIGILONE_AIR_GAPPED', 'yes', /'true' or 'false'/],
    ['VIGILONE_PUBLIC_URL', 'vms.example.in', /not a URL/],
    ['REDACTION_ADAPTER_URL', 'ftp://adapter', /http or https/],
    ['NODE_ENV', 'prod', /development, test or production/],
  ] as const)('refuses %s=%s, naming the variable', (name, raw, re) => {
    expect(() => setting(name, { [name]: raw })).toThrow(SettingError);
    expect(() => setting(name, { [name]: raw })).toThrow(new RegExp(`^${name}: `));
    expect(() => setting(name, { [name]: raw })).toThrow(re);
    expect(settingProblems({ [name]: raw })).toEqual([expect.stringMatching(new RegExp(`^${name}: `))]);
  });

  it('has one reader per setting: the boot configuration does not declare the settings this module owns', () => {
    const boot = Object.keys(envSchema.shape);
    for (const name of ['RECORDINGS_DIR', 'EXPORTS_DIR', 'COTURN_SECRET', 'COTURN_HOST', 'COTURN_PORT']) {
      expect([name, boot.includes(name)]).toEqual([name, false]);
      expect(name in SETTINGS).toBe(true);
    }
  });

  it('reads the environment when called, so a changed directory takes effect without a restart of the module', () => {
    expect(setting('EXPORTS_DIR', { EXPORTS_DIR: '/x' })).toBe('/x');
    expect(setting('EXPORTS_DIR', { EXPORTS_DIR: '  ' })).toBe('/recordings/exports');
  });

  it('documents every setting', () => {
    for (const [name, spec] of Object.entries(SETTINGS)) expect([name, spec.doc.length > 10]).toEqual([name, true]);
  });

  it('server.ts refuses to start on an invalid setting (static check; server.ts listens when imported)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');
    expect(src).toMatch(/const badSettings = settingProblems\(\);\s*if \(badSettings\.length > 0\) \{[\s\S]*?process\.exit\(1\);/);
  });

  it('no code reads process.env outside the allowed places', () => {
    const root = path.resolve(__dirname, '..');
    const allowedAnywhere = new Set(['config/env.ts', 'config/featureFlags.ts', 'config/settings.ts', 'scripts/auditSecrets.ts', 'scripts/mintLicense.ts']);
    // Lists variable names to redact them from a diagnostic bundle; reads no setting.
    const allowedLines: Record<string, RegExp> = { 'services/system/appliance.service.ts': /Object\.entries\(process\.env\)/ };
    const selfChecked = new Set<string>(SELF_CHECKED_SETTINGS);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        const rel = path.relative(root, full).split(path.sep).join('/');
        if (e.isDirectory()) {
          if (rel !== '__tests__') walk(full);
        } else if (rel.endsWith('.ts') && !allowedAnywhere.has(rel)) {
          fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
            if (!line.includes('process.env')) return;
            if (selfChecked.has(rel) && /=\s*process\.env\b(?!\.)/.test(line)) return; // `env = process.env` default parameter
            if (allowedLines[rel]?.test(line)) return;
            offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
          });
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
