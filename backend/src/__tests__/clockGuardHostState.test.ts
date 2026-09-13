import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import ClockGuard from '../utils/clockGuard';
import {
  signLicensePayload,
  verifyLicenseArtifact,
  isLicenseActive,
  getApplianceHardwareFingerprint,
  verifyHardwareBinding,
  LicenseClaims,
} from '../utils/license';
import LicenseHostMirrorService from '../services/appliance/licenseHostMirror.service';

describe('Stage 4 Task 4.4: ClockGuard Host State Protection & Hardware Binding', () => {
  const testDir = path.join(__dirname, 'temp_clockguard_test');
  const statePath = path.join(testDir, 'clock_guard.state');
  const licenseMirrorPath = path.join(testDir, 'license.json');

  // Ephemeral test Ed25519 keypair
  let privateKeyPem: string;
  let publicKeyPem: string;

  beforeAll(() => {
    const keyPair = crypto.generateKeyPairSync('ed25519');
    privateKeyPem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  });

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });

    ClockGuard.setStateFilePath(statePath);
    ClockGuard.resetToEpoch();
    LicenseHostMirrorService.setDefaultPath(licenseMirrorPath);
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('ClockGuard Monotonic State & Anti-Rollback', () => {
    it('persists monotonic checkpoint with 0o600 file permissions and reloads correctly', () => {
      const checkpoint1 = new Date('2026-09-15T10:00:00Z');
      ClockGuard.recordCheckpoint(checkpoint1);

      expect(fs.existsSync(statePath)).toBe(true);
      const content = fs.readFileSync(statePath, 'utf8').trim();
      expect(content).toBe(checkpoint1.toISOString());

      if (process.platform !== 'win32') {
        const stats = fs.statSync(statePath);
        const mode = stats.mode & 0o777;
        expect(mode).toBe(0o600);
      }

      // Reload into a fresh ClockGuard instance
      ClockGuard.setStateFilePath(statePath);
      expect(ClockGuard.getLastKnownGoodTime().toISOString()).toBe(checkpoint1.toISOString());
    });

    it('strictly prevents backward regression when merging older backup timestamps', () => {
      const liveFloor = new Date('2026-09-25T12:00:00Z');
      ClockGuard.recordCheckpoint(liveFloor);

      // Attempt to merge an older backup from 2026-09-10
      const olderBackupFloor = new Date('2026-09-10T00:00:00Z');
      const result1 = ClockGuard.mergeBackupFloor(olderBackupFloor);
      expect(result1.getTime()).toBe(liveFloor.getTime());
      expect(ClockGuard.getLastKnownGoodTime().getTime()).toBe(liveFloor.getTime());

      // Merging a newer timestamp advances the floor
      const newerFloor = new Date('2026-09-28T15:00:00Z');
      const result2 = ClockGuard.mergeBackupFloor(newerFloor);
      expect(result2.getTime()).toBe(newerFloor.getTime());
      expect(ClockGuard.getLastKnownGoodTime().getTime()).toBe(newerFloor.getTime());
    });

    it('detects clock rollback (e.g. CMOS battery reset or manual date rewind) and clamps evaluation', () => {
      const checkpoint = new Date('2026-09-20T12:00:00Z');
      ClockGuard.recordCheckpoint(checkpoint);

      // Operator winds clock back 30 days to 2026-08-20
      const woundBackDate = new Date('2026-08-20T12:00:00Z');
      const sanityCheck = ClockGuard.checkClockSanity(woundBackDate);

      expect(sanityCheck.valid).toBe(false);
      expect(sanityCheck.skewDetected).toBe(true);
      expect(sanityCheck.skewSeconds).toBeGreaterThan(2500000); // ~31 days in seconds
      expect(sanityCheck.trustedFloor.toISOString()).toBe(checkpoint.toISOString());
    });

    it('prevents license expiration bypass when clock is rolled back', () => {
      // System was at 2026-09-20
      const liveTime = new Date('2026-09-20T12:00:00Z');
      ClockGuard.recordCheckpoint(liveTime);

      // License expired on 2026-09-15
      const expiredClaims: LicenseClaims = {
        licenseId: 'lic-expired-001',
        tenantId: 'tenant-dr',
        tier: 'ENTERPRISE',
        maxCameras: 16,
        features: ['EVIDENCE_EXPORT'],
        issuedAt: '2026-09-01T00:00:00Z',
        expiresAt: '2026-09-15T00:00:00Z',
      };

      // Attacker attempts to wind system clock back to 2026-09-05 (when license was still valid)
      // ClockGuard getSanitizedTimeForLicense enforces the trusted floor (2026-09-20),
      // so license remains expired regardless of bogus host clock
      const activeCheck = isLicenseActive(expiredClaims);
      expect(activeCheck.active).toBe(false);
      expect(activeCheck.reason).toBe('LICENSE_EXPIRED');
    });
  });

  describe('Hardware Binding (DMI Board UUID + Machine-ID)', () => {
    it('retrieves hardware fingerprint incorporating DMI UUID and machine-id', () => {
      process.env.APPLIANCE_HARDWARE_UUID = 'dmi-test-uuid-11223344';
      process.env.APPLIANCE_MACHINE_ID = 'machine-id-test-55667788';

      const hw = getApplianceHardwareFingerprint();
      expect(hw.dmiUuid).toBe('dmi-test-uuid-11223344');
      expect(hw.machineId).toBe('machine-id-test-55667788');

      const expectedRaw = 'dmi-test-uuid-11223344:machine-id-test-55667788';
      const expectedFingerprint = crypto.createHash('sha256').update(expectedRaw).digest('hex');
      expect(hw.fingerprint).toBe(expectedFingerprint);

      delete process.env.APPLIANCE_HARDWARE_UUID;
      delete process.env.APPLIANCE_MACHINE_ID;
    });

    it('authenticates license bound to matching appliance hardware', () => {
      process.env.APPLIANCE_HARDWARE_UUID = 'appliance-board-uuid-42';
      process.env.APPLIANCE_MACHINE_ID = 'appliance-machine-id-99';

      const hw = getApplianceHardwareFingerprint();

      const claims: LicenseClaims = {
        licenseId: 'lic-hw-bound-01',
        tenantId: 'tenant-facility-1',
        tier: 'ENTERPRISE',
        maxCameras: 32,
        features: ['EVIDENCE_EXPORT'],
        issuedAt: new Date().toISOString(),
        expiresAt: null, // Perpetual
        deviceBinding: hw.fingerprint,
      };

      const verification = verifyHardwareBinding(claims);
      expect(verification.valid).toBe(true);

      const activeCheck = isLicenseActive(claims);
      expect(activeCheck.active).toBe(true);

      delete process.env.APPLIANCE_HARDWARE_UUID;
      delete process.env.APPLIANCE_MACHINE_ID;
    });

    it('rejects license if hardware binding does not match (tamper / unauthorized migration)', () => {
      process.env.APPLIANCE_HARDWARE_UUID = 'genuine-appliance-uuid-1';
      process.env.APPLIANCE_MACHINE_ID = 'genuine-machine-id-1';

      // License was issued for a different machine
      const claims: LicenseClaims = {
        licenseId: 'lic-hw-bound-stolen',
        tenantId: 'tenant-facility-1',
        tier: 'ENTERPRISE',
        maxCameras: 32,
        features: ['EVIDENCE_EXPORT'],
        issuedAt: new Date().toISOString(),
        expiresAt: null,
        deviceBinding: 'foreign-appliance-fingerprint-99999',
      };

      const verification = verifyHardwareBinding(claims);
      expect(verification.valid).toBe(false);
      expect(verification.reason).toContain('HARDWARE_BINDING_MISMATCH');

      const activeCheck = isLicenseActive(claims);
      expect(activeCheck.active).toBe(false);
      expect(activeCheck.reason).toContain('HARDWARE_BINDING_MISMATCH');

      delete process.env.APPLIANCE_HARDWARE_UUID;
      delete process.env.APPLIANCE_MACHINE_ID;
    });
  });

  describe('Commercial License Host Mirroring & Database Rebuild Reconciliation', () => {
    it('saves license artifact to host mirror with mode 0o600 and loads accurately', () => {
      const claims: LicenseClaims = {
        licenseId: 'lic-mirror-001',
        tenantId: 'tenant-mirror',
        tier: 'ENTERPRISE',
        maxCameras: 16,
        features: ['EVIDENCE_EXPORT'],
        issuedAt: new Date().toISOString(),
        expiresAt: null,
      };

      const artifact = signLicensePayload(claims, privateKeyPem);
      LicenseHostMirrorService.saveLicenseMirror(artifact, licenseMirrorPath);

      expect(fs.existsSync(licenseMirrorPath)).toBe(true);

      if (process.platform !== 'win32') {
        const stats = fs.statSync(licenseMirrorPath);
        const mode = stats.mode & 0o777;
        expect(mode).toBe(0o600);
      }

      const loaded = LicenseHostMirrorService.loadLicenseMirror(licenseMirrorPath);
      expect(loaded).toBeDefined();
      expect(loaded?.signedPayload).toBe(artifact.signedPayload);
      expect(loaded?.signatureEd25519).toBe(artifact.signatureEd25519);
    });

    it('auto-reconciles license into clean database on startup after catastrophic DB wipe', async () => {
      const claims: LicenseClaims = {
        licenseId: 'lic-rebuild-001',
        tenantId: 'tenant-dr',
        tier: 'ENTERPRISE',
        maxCameras: 32,
        features: ['EVIDENCE_EXPORT', 'ADVANCED_PTZ'],
        issuedAt: new Date().toISOString(),
        expiresAt: null,
      };

      // Sign with the test keypair, but verifyLicenseArtifact in test uses embedded root key.
      // So let's mock verifyLicenseArtifact for this test or sign with test key and mock verify.
      const artifact = signLicensePayload(claims, privateKeyPem);
      LicenseHostMirrorService.saveLicenseMirror(artifact, licenseMirrorPath);

      const dbLicenseStore: any[] = [];
      const mockPrisma = {
        license: {
          findFirst: jest.fn().mockImplementation(async () => dbLicenseStore[0] || null),
          create: jest.fn().mockImplementation(async (args: any) => {
            const row = { id: 'lic-db-1', ...args.data };
            dbLicenseStore.push(row);
            return row;
          }),
        },
      } as unknown as PrismaClient;

      // Mock verifyLicenseArtifact so test key is accepted
      const licenseUtils = require('../utils/license');
      jest.spyOn(licenseUtils, 'verifyLicenseArtifact').mockReturnValue({
        valid: true,
        claims,
      });

      const result = await LicenseHostMirrorService.reconcileLicenseFromHost(mockPrisma, licenseMirrorPath);

      expect(result.restored).toBe(true);
      expect(result.licenseId).toBe('lic-rebuild-001');
      expect(dbLicenseStore.length).toBe(1);
      expect(dbLicenseStore[0].licenseId).toBe('lic-rebuild-001');
      expect(dbLicenseStore[0].maxCameras).toBe(32);

      // Second run: database already has a license, should not duplicate
      const secondRun = await LicenseHostMirrorService.reconcileLicenseFromHost(mockPrisma, licenseMirrorPath);
      expect(secondRun.restored).toBe(false);
      expect(dbLicenseStore.length).toBe(1);
    });
  });
});
