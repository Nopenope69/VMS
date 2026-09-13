import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { OtaUpdateService, OtaManifest } from '../services/appliance/otaUpdate.service';
import { VENDOR_OTA_PUBLIC_KEY, OTA_KEY_ID } from '../config/otaKeys';
import { VENDOR_LICENSE_PUBLIC_KEY } from '../config/licenseKeys';
import ClockGuard from '../utils/clockGuard';

describe('Stage 4 Task 4.2: Signed OTA Updates & Monotonic Rollback', () => {
  let testDir: string;
  let otaPrivKeyPem: string;
  let otaPubKeyPem: string;
  let licensePrivKeyPem: string;
  let prismaMock: any;
  let otaService: OtaUpdateService;

  beforeAll(() => {
    // Generate isolated testing Ed25519 keypairs for OTA and License
    const otaKeys = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    otaPrivKeyPem = otaKeys.privateKey;
    otaPubKeyPem = otaKeys.publicKey;

    const licenseKeys = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    licensePrivKeyPem = licenseKeys.privateKey;
  });

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigilone-ota-test-'));
    const clockStatePath = path.join(testDir, 'clock_guard.state');
    ClockGuard.setStateFilePath(clockStatePath);
    ClockGuard.resetToEpoch();

    prismaMock = {
      camera: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'cam-1', streamPath: 'cam1' },
          { id: 'cam-2', streamPath: 'cam2' },
          { id: 'cam-3', streamPath: 'cam3' },
        ]),
      },
      revokedLicense: {
        findMany: jest.fn().mockResolvedValue([{ licenseId: 'revoked-lic-001' }]),
        upsert: jest.fn().mockResolvedValue({}),
      },
      alarm: {
        create: jest.fn().mockResolvedValue({ id: 'alarm-1' }),
      },
    };

    otaService = new OtaUpdateService(prismaMock as unknown as PrismaClient, {
      versionFilePath: path.join(testDir, 'version.json'),
      backupsDir: path.join(testDir, 'backups'),
      currentVersion: '1.0.0',
      currentEpoch: 1,
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('validates a legitimate signed OTA update bundle against OTA public key', () => {
    const payloadFile = path.join(testDir, 'app-bundle.tar.gz');
    fs.writeFileSync(payloadFile, 'dummy-release-binary-contents-1.1.0');
    const hash = otaService.computeFileSha256(payloadFile);

    const manifest: OtaManifest = {
      version: '1.1.0',
      versionEpoch: 1,
      releaseDate: new Date().toISOString(),
      keyId: OTA_KEY_ID,
      artifactPurpose: 'APPLIANCE_OTA_UPDATE',
      files: [{ path: 'app-bundle.tar.gz', sha256: hash, sizeBytes: 34 }],
    };

    const canonical = otaService.canonicalizeJson(manifest);
    const signature = crypto.sign(null, Buffer.from(canonical, 'utf8'), otaPrivKeyPem).toString('hex');

    // Verify manifest
    const res = otaService.verifyManifest(JSON.stringify(manifest), signature, otaPubKeyPem);
    expect(res.valid).toBe(true);
    expect(res.manifest?.version).toBe('1.1.0');

    // Verify payload files
    const payloadRes = otaService.verifyPayloadFiles(testDir, manifest);
    expect(payloadRes.valid).toBe(true);
  });

  it('rejects cross-trust domain confusion: bundle signed by license key or wrong purpose', () => {
    const manifestWrongPurpose: any = {
      version: '1.1.0',
      versionEpoch: 1,
      releaseDate: new Date().toISOString(),
      keyId: OTA_KEY_ID,
      artifactPurpose: 'COMMERCIAL_LICENSE', // Attempting cross-purpose attack!
      files: [],
    };

    const canonical = otaService.canonicalizeJson(manifestWrongPurpose);
    const signature = crypto.sign(null, Buffer.from(canonical, 'utf8'), licensePrivKeyPem).toString('hex');

    const res = otaService.verifyManifest(JSON.stringify(manifestWrongPurpose), signature, otaPubKeyPem);
    expect(res.valid).toBe(false);
    expect(res.error).toContain('OTA_SIGNATURE_PURPOSE_MISMATCH');
  });

  it('rejects OTA bundle if keyId does not match OTA_KEY_ID', () => {
    const manifestWrongKeyId: any = {
      version: '1.1.0',
      versionEpoch: 1,
      releaseDate: new Date().toISOString(),
      keyId: 'untrusted-vendor-key',
      artifactPurpose: 'APPLIANCE_OTA_UPDATE',
      files: [],
    };

    const canonical = otaService.canonicalizeJson(manifestWrongKeyId);
    const signature = crypto.sign(null, Buffer.from(canonical, 'utf8'), otaPrivKeyPem).toString('hex');

    const res = otaService.verifyManifest(JSON.stringify(manifestWrongKeyId), signature, otaPubKeyPem);
    expect(res.valid).toBe(false);
    expect(res.error).toContain('OTA_KEY_ID_MISMATCH');
  });

  it('rejects tampered payload content before extraction (PAYLOAD_HASH_MISMATCH)', () => {
    const payloadFile = path.join(testDir, 'service.tar.gz');
    fs.writeFileSync(payloadFile, 'original-payload');
    const hash = otaService.computeFileSha256(payloadFile);

    // Attacker modifies file on disk
    fs.writeFileSync(payloadFile, 'tampered-malicious-payload');

    const manifest: OtaManifest = {
      version: '1.1.0',
      versionEpoch: 1,
      releaseDate: new Date().toISOString(),
      keyId: OTA_KEY_ID,
      artifactPurpose: 'APPLIANCE_OTA_UPDATE',
      files: [{ path: 'service.tar.gz', sha256: hash, sizeBytes: 16 }],
    };

    const payloadRes = otaService.verifyPayloadFiles(testDir, manifest);
    expect(payloadRes.valid).toBe(false);
    expect(payloadRes.error).toContain('PAYLOAD_HASH_MISMATCH');
  });

  it('rejects path traversal attempts in manifest file list', () => {
    const manifest: OtaManifest = {
      version: '1.1.0',
      versionEpoch: 1,
      releaseDate: new Date().toISOString(),
      keyId: OTA_KEY_ID,
      artifactPurpose: 'APPLIANCE_OTA_UPDATE',
      files: [{ path: '../../etc/shadow', sha256: 'deadbeef', sizeBytes: 100 }],
    };

    const payloadRes = otaService.verifyPayloadFiles(testDir, manifest);
    expect(payloadRes.valid).toBe(false);
    expect(payloadRes.error).toContain('PATH_TRAVERSAL_DETECTED');
  });

  it('strictly enforces downgrade protection against lower epochs or versions', () => {
    // Current installed is version 1.0.0, epoch 1
    // 1. Lower epoch attempt
    const lowerEpochManifest: OtaManifest = {
      version: '2.0.0',
      versionEpoch: 0, // Lower epoch!
      releaseDate: new Date().toISOString(),
      keyId: OTA_KEY_ID,
      artifactPurpose: 'APPLIANCE_OTA_UPDATE',
      files: [],
    };
    const canonical1 = otaService.canonicalizeJson(lowerEpochManifest);
    const sig1 = crypto.sign(null, Buffer.from(canonical1, 'utf8'), otaPrivKeyPem).toString('hex');
    const res1 = otaService.verifyManifest(JSON.stringify(lowerEpochManifest), sig1, otaPubKeyPem);
    expect(res1.valid).toBe(false);
    expect(res1.error).toContain('DOWNGRADE_NOT_PERMITTED');

    // 2. Lower version within same epoch (e.g. 0.9.0 vs 1.0.0)
    const lowerVersionManifest: OtaManifest = {
      version: '0.9.0',
      versionEpoch: 1,
      releaseDate: new Date().toISOString(),
      keyId: OTA_KEY_ID,
      artifactPurpose: 'APPLIANCE_OTA_UPDATE',
      files: [],
    };
    const canonical2 = otaService.canonicalizeJson(lowerVersionManifest);
    const sig2 = crypto.sign(null, Buffer.from(canonical2, 'utf8'), otaPrivKeyPem).toString('hex');
    const res2 = otaService.verifyManifest(JSON.stringify(lowerVersionManifest), sig2, otaPubKeyPem);
    expect(res2.valid).toBe(false);
    expect(res2.error).toContain('DOWNGRADE_NOT_PERMITTED');
  });

  it('triggers automatic rollback when deep stream healthcheck fails', async () => {
    const snapshot = await otaService.createPreUpdateSnapshot();
    expect(snapshot.snapshotId).toBeDefined();

    // Mock failing deep healthcheck (cameras not streaming)
    const mockFailingCheck = jest.fn().mockResolvedValue({
      healthy: false,
      apiUp: true,
      camerasExpected: 3,
      failedCameraIds: ['cam-1', 'cam-2'], // 2 out of 3 failed > 5% threshold
    });

    await expect(
      otaService.verifyOtaHealthOrRollback(snapshot, {
        timeoutMs: 1500, // short timeout for test
        mockHealthCheck: mockFailingCheck,
      })
    ).rejects.toThrow('OTA_ROLLBACK_TRIGGERED');

    // Assert critical alarm created
    expect(prismaMock.alarm.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          alarmType: 'OTA_UPDATE_FAILED_ROLLBACK',
          severity: 'CRITICAL',
        }),
      })
    );
  });

  it('preserves monotonic security state (clock floor and revoked licenses) during rollback', async () => {
    // Current time at 2026-09-20
    const forwardTime = new Date('2026-09-20T12:00:00Z');
    ClockGuard.recordCheckpoint(forwardTime);

    // Snapshot was taken with a high-water mark
    const snapshot = {
      snapshotId: 'pre-ota-123',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      versionEpoch: 1,
      highestAcceptedEpoch: 1,
      highestAcceptedVersion: '1.0.0',
      lastKnownGoodTime: forwardTime.toISOString(),
      revokedLicenseIds: ['revoked-license-omega'],
      hasDatabaseDump: true,
      hasConfigSnapshot: true,
    };

    await otaService.triggerAutomaticRollback(snapshot, {
      reason: 'TEST_ROLLBACK',
      detail: {},
    });

    // Verify clock high-water mark did not regress
    const check = ClockGuard.checkClockSanity(new Date('2026-09-15T00:00:00Z'));
    expect(check.valid).toBe(false);
    expect(check.skewDetected).toBe(true);

    // Verify revoked licenses were restored/unioned in DB
    expect(prismaMock.revokedLicense.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { licenseId: 'revoked-license-omega' },
      })
    );
  });

  it('captures PostgreSQL dump + config in snapshot and restores database during rollback', async () => {
    let dumpedSql = '';
    let restoredSql = '';

    const customDbHandlers = {
      dumpDatabase: jest.fn().mockImplementation(async (outPath: string) => {
        dumpedSql = 'DUMP_DATA_TABLE_TENANTS_CAMERAS_USERS';
        fs.writeFileSync(outPath, dumpedSql, 'utf8');
      }),
      restoreDatabase: jest.fn().mockImplementation(async (inPath: string) => {
        restoredSql = fs.readFileSync(inPath, 'utf8');
      }),
    };

    const configDir = path.join(testDir, 'etc-vigilone');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'appliance_manifest.json'), JSON.stringify({ cameras: [] }), 'utf8');

    const serviceWithDb = new OtaUpdateService(prismaMock as unknown as PrismaClient, {
      versionFilePath: path.join(testDir, 'version.json'),
      backupsDir: path.join(testDir, 'backups'),
      configDir,
      dbHandlers: customDbHandlers,
      currentVersion: '1.0.0',
      currentEpoch: 1,
    });

    const snapshot = await serviceWithDb.createPreUpdateSnapshot();
    expect(snapshot.hasDatabaseDump).toBe(true);
    expect(snapshot.hasConfigSnapshot).toBe(true);
    expect(customDbHandlers.dumpDatabase).toHaveBeenCalled();

    // Trigger rollback
    await serviceWithDb.triggerAutomaticRollback(snapshot, {
      reason: 'FAILED_HEALTHCHECK_STREAM_DROP',
      detail: { dropped: 2 },
    });

    expect(customDbHandlers.restoreDatabase).toHaveBeenCalled();
    expect(restoredSql).toBe('DUMP_DATA_TABLE_TENANTS_CAMERAS_USERS');
  });

  it('strictly protects monotonic release floor from decreasing across rollback and rejects downgraded bundles', async () => {
    const otaReleaseStatePath = path.join(testDir, 'ota_release.state');

    const service = new OtaUpdateService(prismaMock as unknown as PrismaClient, {
      versionFilePath: path.join(testDir, 'version.json'),
      backupsDir: path.join(testDir, 'backups'),
      otaReleaseStatePath,
      currentVersion: '1.0.0',
      currentEpoch: 1,
    });

    // Advance release floor to epoch 3 (v3.0.0)
    service.recordReleaseFloor(3, '3.0.0');
    expect(service.getReleaseFloor().highestAcceptedEpoch).toBe(3);

    // Persisted state file check
    expect(fs.existsSync(otaReleaseStatePath)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(otaReleaseStatePath, 'utf8'));
    expect(persisted.highestAcceptedEpoch).toBe(3);

    // Rollback attempt or older snapshot restore must NEVER decrease the floor
    const olderSnapshot = {
      snapshotId: 'pre-ota-old',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      versionEpoch: 1,
      highestAcceptedEpoch: 1,
      highestAcceptedVersion: '1.0.0',
      lastKnownGoodTime: new Date().toISOString(),
      revokedLicenseIds: [],
      hasDatabaseDump: false,
      hasConfigSnapshot: false,
    };

    await service.triggerAutomaticRollback(olderSnapshot, {
      reason: 'TEST_ROLLBACK',
      detail: {},
    });

    // Floor remains 3!
    expect(service.getReleaseFloor().highestAcceptedEpoch).toBe(3);

    // Verify bundle with epoch 2 is rejected by monotonic floor
    const epoch2Manifest: OtaManifest = {
      version: '2.0.0',
      versionEpoch: 2,
      releaseDate: '2026-09-12T00:00:00Z',
      keyId: OTA_KEY_ID,
      artifactPurpose: 'APPLIANCE_OTA_UPDATE',
      files: [],
    };
    const canonical = service.canonicalizeJson(epoch2Manifest);
    const sig = crypto.sign(null, Buffer.from(canonical, 'utf8'), otaPrivKeyPem).toString('hex');
    const result = service.verifyManifest(JSON.stringify(epoch2Manifest), sig, otaPubKeyPem);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('DOWNGRADE_NOT_PERMITTED');
    expect(result.error).toContain('monotonic appliance release floor (3)');
  });
});
