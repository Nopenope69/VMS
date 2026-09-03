import ClockGuard from '../utils/clockGuard';
import { isLicenseActive, LicenseClaims } from '../utils/license';

describe('ClockGuard Monotonic Floor & License Anti-Rollback', () => {
  it('should accept a valid progressive system clock', () => {
    const now = new Date('2026-09-04T12:00:00Z');
    const result = ClockGuard.checkClockSanity(now);

    expect(result.valid).toBe(true);
    expect(result.skewDetected).toBe(false);
  });

  it('should detect clock rollback to 1970 (CMOS battery death) or past date', () => {
    // Record a known checkpoint in 2026
    ClockGuard.recordCheckpoint(new Date('2026-09-04T00:00:00Z'));

    // Simulate clock reset to 1970
    const batteryDeadTime = new Date('1970-01-01T00:00:00Z');
    const result = ClockGuard.checkClockSanity(batteryDeadTime);

    expect(result.valid).toBe(false);
    expect(result.skewDetected).toBe(true);
    expect(result.skewSeconds).toBeGreaterThan(1000000);
    expect(result.trustedFloor.getFullYear()).toBe(2026);
  });

  it('should prevent license expiration bypass via manual clock rollback', () => {
    // A license that expired yesterday
    const expiredLicense: LicenseClaims = {
      licenseId: 'lic_expired_test',
      tenantId: 'tenant_01',
      tier: 'ENTERPRISE',
      maxCameras: 16,
      features: ['ALL'],
      issuedAt: '2026-08-01T00:00:00Z',
      expiresAt: '2026-09-01T00:00:00Z', // Expired on Sep 1, 2026
    };

    // Ensure checkpoint is beyond expiration (today Sep 4, 2026)
    ClockGuard.recordCheckpoint(new Date('2026-09-04T00:00:00Z'));

    // Even if system time was rolled back to August 2026:
    // ClockGuard enforces the trusted floor (Sep 4, 2026), correctly catching expiration!
    const status = isLicenseActive(expiredLicense);
    expect(status.active).toBe(false);
    expect(status.reason).toBe('LICENSE_EXPIRED');
  });
});
