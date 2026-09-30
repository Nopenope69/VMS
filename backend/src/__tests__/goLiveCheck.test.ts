/**
 * Go-live readiness check: every rule of evaluate() on a snapshot, and collectSnapshot() against the real
 * database (it must run and must fail loudly rather than guess when it cannot read something).
 */
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { collectSnapshot, evaluate, render, Snapshot } from '../ops/goLiveCheck';
import { FeatureFlag } from '../config/featureFlags';
import { KNOWN_DEV_ENCRYPTION_KEY } from '../config/env';
import { createTenantWithCamera } from './helpers/realDb';

const good = (): Snapshot => ({
  env: { NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(48), CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') },
  enabledFlags: [],
  bootstrapped: true,
  superAdmins: 1,
  activeUsers: 3,
  failedMigrations: [],
  auditChains: [{ tenantId: 't1', valid: true }],
  cameras: { total: 4, continuous: 4 },
  camerasWithoutRecentSegment: [],
  disk: { path: '/var/lib/vigilone/recordings', freeFraction: 0.6 },
  ntpSynchronized: true,
  modelExceptionsFile: null,
  haLeaseHolder: null,
});
const verdicts = (s: Snapshot) => Object.fromEntries(evaluate(s).map((r) => [r.id, r.verdict]));
const blocks = (s: Snapshot) => evaluate(s).filter((r) => r.verdict === 'BLOCK').map((r) => r.id);

describe('go-live check rules', () => {
  it('a correctly configured, recording, synchronised system has no blocking item; sign-offs stay MANUAL', () => {
    const r = evaluate(good());
    expect(r.filter((x) => x.verdict === 'BLOCK')).toEqual([]);
    expect(r.filter((x) => x.verdict === 'MANUAL').map((x) => x.id)).toEqual(
      expect.arrayContaining(['signoff.acceptance', 'signoff.dpdp', 'signoff.backup_restore', 'signoff.tls', 'signoff.handover'])
    );
    expect(render(r)).toMatch(/READY TO GO LIVE once the 5 manual sign-off\(s\) are done/);
  });

  it.each<[string, (s: Snapshot) => void, string]>([
    ['development mode', (s) => (s.env.NODE_ENV = 'development'), 'config.production'],
    ['a short JWT secret', (s) => (s.env.JWT_SECRET = 'short'), 'config.jwt_secret'],
    ['the published development JWT secret', (s) => (s.env.JWT_SECRET = 'vigilone_dev_jwt_signing_key_32bytes_min!'), 'config.jwt_secret'],
    ['the published development credential key', (s) => (s.env.CREDENTIAL_ENCRYPTION_KEY = KNOWN_DEV_ENCRYPTION_KEY), 'config.credential_key'],
    ['SSO on without a public https URL', (s) => (s.enabledFlags = [FeatureFlag.OIDC_SSO]), 'config.public_url'],
    ['a failed migration', (s) => (s.failedMigrations = ['20261007000000_phase8_sso']), 'db.migrations'],
    ['no first-run setup', (s) => ((s.bootstrapped = false), (s.superAdmins = 0)), 'system.bootstrapped'],
    ['a broken audit chain', (s) => (s.auditChains = [{ tenantId: 't1', valid: false, error: 'hash mismatch at 42' }]), 'audit.chain'],
    ['a continuous camera not recording', (s) => (s.camerasWithoutRecentSegment = ['Gate']), 'recording.recent'],
    ['under 5% disk', (s) => (s.disk = { path: '/rec', freeFraction: 0.03 }), 'storage.free'],
    ['an unsynchronised clock', (s) => (s.ntpSynchronized = false), 'clock.ntp'],
    ['TEST-ONLY model approvals', (s) => (s.modelExceptionsFile = { path: '/tmp/x.json', testOnly: true }), 'models.test_only_approvals'],
  ])('blocks go-live on %s', (_name, mutate, id) => {
    const s = good();
    mutate(s);
    expect(blocks(s)).toEqual([id]);
    expect(render(evaluate(s))).toMatch(/NOT READY: 1 blocking item/);
  });

  it('warns rather than blocks where a person can accept the risk', () => {
    const s = good();
    s.disk = { path: '/rec', freeFraction: 0.1 };
    s.cameras = { total: 0, continuous: 0 };
    s.env.VIGILONE_HA_NODE_ID = 'vms-a';
    s.enabledFlags = [FeatureFlag.DIO_RELAY, FeatureFlag.OBJECT_STORAGE_ARCHIVE];
    const v = verdicts(s);
    expect(v).toMatchObject({ 'storage.free': 'WARN', 'cameras.configured': 'WARN', 'ha.lease': 'WARN', 'feature.DIO_RELAY': 'WARN', 'feature.OBJECT_STORAGE_ARCHIVE': 'WARN' });
    expect(blocks(s)).toEqual([]);
    expect(evaluate(s).find((r) => r.id === 'feature.DIO_RELAY')!.detail).toMatch(/SIMULATED/);
  });

  it('an unknown clock state is a manual check, not a pass', () => {
    const s = good();
    s.ntpSynchronized = null;
    expect(verdicts(s)['clock.ntp']).toBe('MANUAL');
  });

  it('SSO with an https public URL passes', () => {
    const s = good();
    s.enabledFlags = [FeatureFlag.OIDC_SSO];
    s.env.VIGILONE_PUBLIC_URL = 'https://vms.example.com';
    expect(verdicts(s)['config.public_url']).toBe('PASS');
  });
});

describe('go-live snapshot (real database)', () => {
  const prisma = new PrismaClient();
  afterAll(() => prisma.$disconnect());

  it('reads the running system: migrations, audit chains, cameras without recent segments, disk', async () => {
    const { tenantId, cameraId } = await createTenantWithCamera(prisma, 'golive');
    const cam = await prisma.camera.findUnique({ where: { id: cameraId } });
    const s = await collectSnapshot(prisma, { NODE_ENV: 'test', RECORDINGS_DIR: '/tmp' });
    expect(s.failedMigrations).toEqual([]);
    expect(s.auditChains.find((c) => c.tenantId === tenantId)).toEqual({ tenantId, valid: true, error: undefined });
    expect(s.camerasWithoutRecentSegment).toContain(cam!.name); // a new continuous camera has recorded nothing
    expect(s.disk!.freeFraction).toBeGreaterThan(0);
    await prisma.recordingSegment.create({ data: { tenantId, cameraId, filePath: `/tmp/${crypto.randomUUID()}.mp4`, startTime: new Date(Date.now() - 120_000), endTime: new Date(Date.now() - 60_000), durationMs: 60_000, sizeBytes: BigInt(1), sha256Hash: 'a'.repeat(64), status: 'FINALIZED' } });
    const s2 = await collectSnapshot(prisma, { NODE_ENV: 'test', RECORDINGS_DIR: '/tmp' });
    expect(s2.camerasWithoutRecentSegment).not.toContain(cam!.name);
    await prisma.tenant.delete({ where: { id: tenantId } });
  });

  it('a missing recordings directory is reported, not guessed', async () => {
    const s = await collectSnapshot(prisma, { NODE_ENV: 'test', RECORDINGS_DIR: '/does/not/exist' });
    expect(s.disk).toBeNull();
    expect(evaluate({ ...s, env: { ...s.env } }).find((r) => r.id === 'storage.free')!.verdict).toBe('WARN');
  });
});
