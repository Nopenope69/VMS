import http from 'http';
import { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import {
  ALL_FEATURE_FLAGS,
  FEATURE_DISABLED_CODE,
  FEATURE_FLAGS,
  FeatureFlag,
  getFeatureFlagStates,
  isFeatureEnabled,
  renderFeatureFlagMarkdownTable,
} from '../config/featureFlags';

describe('Feature flags: typed registry', () => {
  it('defaults every flag to OFF', () => {
    const states = getFeatureFlagStates({});
    for (const flag of ALL_FEATURE_FLAGS) {
      expect(states[flag]).toBe(false);
    }
  });

  it('covers the subsystems the plan requires to be gated', () => {
    expect([...ALL_FEATURE_FLAGS].sort()).toEqual(
      [
        'ANPR',
        'CAMERA_EVENTS',
        'DIO_RELAY',
        'EXPLANATIONS',
        'FEDERATION',
        'FLOORPLANS',
        'OBJECT_CROPS',
        'OBJECT_STORAGE_ARCHIVE',
        'OIDC_SSO',
        'REDACTION',
        'SEMANTIC_SEARCH',
        'SMART_SEARCH',
      ].sort()
    );
  });

  it('only enables on explicit truthy values', () => {
    const env = FEATURE_FLAGS[FeatureFlag.ANPR].envVar;
    expect(isFeatureEnabled(FeatureFlag.ANPR, { [env]: 'true' })).toBe(true);
    expect(isFeatureEnabled(FeatureFlag.ANPR, { [env]: ' ON ' })).toBe(true);
    expect(isFeatureEnabled(FeatureFlag.ANPR, { [env]: '1' })).toBe(true);
    expect(isFeatureEnabled(FeatureFlag.ANPR, { [env]: 'false' })).toBe(false);
    expect(isFeatureEnabled(FeatureFlag.ANPR, { [env]: '' })).toBe(false);
    expect(isFeatureEnabled(FeatureFlag.ANPR, { [env]: 'enabled-ish' })).toBe(false);
  });

  it('renders a README table row per flag', () => {
    const table = renderFeatureFlagMarkdownTable();
    for (const flag of ALL_FEATURE_FLAGS) {
      expect(table).toContain(FEATURE_FLAGS[flag].envVar);
    }
  });
});

describe('Feature flags: real HTTP routing table (app.ts)', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    // Import after setup.ts has populated env; app.ts starts no workers and opens no DB connection.
    const app = (await import('../app')).default;
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const flag of ALL_FEATURE_FLAGS) {
      delete process.env[FEATURE_FLAGS[flag].envVar];
    }
  });

  const gatedProbes: Array<[FeatureFlag, string, string]> = [
    [FeatureFlag.ANPR, 'GET', '/api/v1/anpr/observations'],
    [FeatureFlag.SMART_SEARCH, 'GET', '/api/v1/search/plates'],
    [FeatureFlag.FEDERATION, 'POST', '/api/v1/federation/pairing-token'],
    [FeatureFlag.DIO_RELAY, 'GET', '/api/v1/relays'],
    [FeatureFlag.OBJECT_STORAGE_ARCHIVE, 'GET', '/api/v1/archive/config'],
    [FeatureFlag.OIDC_SSO, 'GET', '/api/v1/sso/providers'],
    [FeatureFlag.REDACTION, 'POST', '/api/v1/privacy/jobs'],
    [FeatureFlag.FLOORPLANS, 'GET', '/api/v1/floorplans'],
    [FeatureFlag.OBJECT_CROPS, 'GET', '/api/v1/crop-policy/any-site'],
  ];

  it.each(gatedProbes)('%s off: %s %s answers 501 FEATURE_DISABLED', async (flag, method, path) => {
    delete process.env[FEATURE_FLAGS[flag].envVar];
    const res = await fetch(`${baseUrl}${path}`, { method });
    expect(res.status).toBe(501);
    const body: any = await res.json();
    expect(body.code).toBe(FEATURE_DISABLED_CODE);
    expect(body.feature).toBe(flag);
    expect(body.enableWith).toBe(`${FEATURE_FLAGS[flag].envVar}=true`);
  });

  it.each(gatedProbes)('%s on: %s %s reaches the real router (auth gate, not 501)', async (flag, method, path) => {
    process.env[FEATURE_FLAGS[flag].envVar] = 'true';
    try {
      const res = await fetch(`${baseUrl}${path}`, { method });
      expect(res.status).not.toBe(501);
      // No bearer token supplied: the real router's auth middleware must reject it.
      expect(res.status).toBe(401);
    } finally {
      delete process.env[FEATURE_FLAGS[flag].envVar];
    }
  });

  it('privacy policies stay reachable when REDACTION is off (only redaction jobs are gated)', async () => {
    const res = await fetch(`${baseUrl}/api/v1/privacy/policies`);
    expect(res.status).toBe(401);
  });

  it('GET /api/v1/features requires authentication', async () => {
    const res = await fetch(`${baseUrl}/api/v1/features`);
    expect(res.status).toBe(401);
  });

  it('GET /api/v1/features rejects a token whose user cannot be resolved', async () => {
    const token = jwt.sign({ id: 'no-such-user', type: 'ACCESS' }, process.env.JWT_SECRET as string);
    const res = await fetch(`${baseUrl}/api/v1/features`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
  });
});
