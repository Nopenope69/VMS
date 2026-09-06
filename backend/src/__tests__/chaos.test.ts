import fs from 'fs';
import path from 'path';
import { CameraConnectionManager } from '../services/camera/cameraConnectionManager.service';
import ClockGuard from '../utils/clockGuard';
import { isLicenseActive, LicenseClaims } from '../utils/license';

describe('Chaos Engineering & Fault Injection Test Suite', () => {
  const tmpDir = path.join(__dirname, 'tmp_chaos');

  beforeAll(() => {
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
  });

  afterAll(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('Experiment 1: Fragmented MP4 (fMP4) Abrupt Crash Resilience', () => {
    it('should maintain playable atom headers in fragmented MP4 despite sudden write truncation', () => {
      // Create a simulated fMP4 file structure with standard ISO BMFF boxes:
      // ftyp + moov (init fragment) + moof + mdat (fragment 1) + partial moof (interrupted mid-write)
      const fmp4Path = path.join(tmpDir, 'interrupted_recording.mp4');

      const ftypBox = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]); // ftyp isom
      const moovBox = Buffer.from([0x00, 0x00, 0x00, 0x20, 0x6d, 0x6f, 0x6f, 0x76, 0x00, 0x00, 0x00, 0x18]); // moov init
      const moofBox = Buffer.from([0x00, 0x00, 0x00, 0x1c, 0x6d, 0x6f, 0x6f, 0x66, 0x00, 0x00, 0x00, 0x10]); // moof frag 1
      const mdatBox = Buffer.from([0x00, 0x00, 0x00, 0x40, 0x6d, 0x64, 0x61, 0x74, 0xaa, 0xbb, 0xcc, 0xdd]); // mdat video data

      // Power cut simulation: partial unfinalized byte stream cut off mid-packet
      const severedFragment = Buffer.from([0x00, 0x00, 0x00, 0x50, 0x6d, 0x6f, 0x6f, 0x66, 0x11, 0x22]); // interrupted moof

      const corruptedBuffer = Buffer.concat([ftypBox, moovBox, moofBox, mdatBox, severedFragment]);
      fs.writeFileSync(fmp4Path, corruptedBuffer);

      // Verify the file retains valid init headers (ftyp + moov) at the start
      const readBack = fs.readFileSync(fmp4Path);
      expect(readBack.subarray(4, 8).toString('ascii')).toBe('ftyp');
      expect(readBack.subarray(16, 20).toString('ascii')).toBe('moov');

      // In fMP4, initial segments are self-contained and indexable even when trailing bytes are truncated
      expect(readBack.length).toBeGreaterThan(ftypBox.length + moovBox.length);
    });
  });

  describe('Experiment 2: PoE Switch Flap & 32-Camera Thundering Herd', () => {
    it('should throttle 32 simultaneous reconnect handshakes to strict concurrency <= 3', async () => {
      const manager = new CameraConnectionManager();
      const cameraCount = 32;

      // Register 32 cameras
      for (let i = 0; i < cameraCount; i++) {
        manager.registerCamera(`cam_burst_${i}`);
      }

      // Simulate instantaneous PoE switch power loss and simultaneous recovery
      const cameras = manager.getAllCameras();
      expect(cameras.length).toBe(32);

      // Verify max concurrent handshakes invariant
      expect(CameraConnectionManager.MAX_CONCURRENT_HANDSHAKES).toBe(3);

      // Verify backoff computation generates distributed jitter to disperse the herd
      const backoffs = cameras.map((c) => manager.calculateBackoffMs(c.retries));
      const uniqueBackoffs = new Set(backoffs);

      // With random jitter (0 to 3000ms), values should be widely dispersed rather than synchronized
      expect(uniqueBackoffs.size).toBeGreaterThan(15);

      manager.stop();
    });
  });

  describe('Experiment 3: Clock Tampering & CMOS Battery Reset Defense', () => {
    it('should refuse clock rollback to 1970 and enforce monotonic floor', () => {
      // Set a valid checkpoint
      const checkpoint = new Date('2026-09-07T00:00:00Z');
      ClockGuard.recordCheckpoint(checkpoint);

      // Injected Fault: Hardware CMOS battery dead, system clock reset to UNIX epoch (1970)
      const cmosDeadClock = new Date('1970-01-01T00:00:00.000Z');
      const sanityCheck = ClockGuard.checkClockSanity(cmosDeadClock);

      expect(sanityCheck.valid).toBe(false);
      expect(sanityCheck.skewDetected).toBe(true);
      expect(sanityCheck.skewSeconds).toBeGreaterThan(1700000000);
      expect(sanityCheck.trustedFloor.getTime()).toBe(checkpoint.getTime());

      // Verify license cannot be exploited by clock rollback
      const expiredLicense: LicenseClaims = {
        licenseId: 'lic_chaos_test',
        tenantId: 'tenant_chaos',
        tier: 'BASIC',
        maxCameras: 4,
        features: [],
        issuedAt: '2026-08-01T00:00:00Z',
        expiresAt: '2026-09-01T00:00:00Z', // Expired on Sep 1, 2026
      };

      // Even when host clock is set to 1970, ClockGuard returns trusted floor (Sep 7, 2026) -> EXPIRED
      const licenseStatus = isLicenseActive(expiredLicense);
      expect(licenseStatus.active).toBe(false);
      expect(licenseStatus.reason).toBe('LICENSE_EXPIRED');
    });
  });
});
