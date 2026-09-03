import {
  signLicensePayload,
  verifyLicenseArtifact,
  isLicenseActive,
  LicenseClaims,
} from '../utils/license';
import { generateVendorEd25519KeyPair } from '../config/licenseKeys';

describe('Ed25519 Commercial Licensing Engine', () => {
  const validClaims: LicenseClaims = {
    licenseId: 'lic_test_001',
    tenantId: 'tenant_omega',
    tier: 'PROFESSIONAL',
    maxCameras: 8,
    features: ['EVIDENCE_EXPORT', 'ADVANCED_PTZ'],
    issuedAt: new Date().toISOString(),
    expiresAt: null, // Perpetual
  };

  it('should sign and verify valid Ed25519 license artifact offline', () => {
    const artifact = signLicensePayload(validClaims);
    expect(artifact.signedPayload).toBeDefined();
    expect(artifact.signatureEd25519).toHaveLength(128); // 64 bytes in hex

    const result = verifyLicenseArtifact(artifact.signedPayload, artifact.signatureEd25519);
    expect(result.valid).toBe(true);
    expect(result.claims?.licenseId).toBe('lic_test_001');
    expect(result.claims?.tier).toBe('PROFESSIONAL');
    expect(result.claims?.maxCameras).toBe(8);
  });

  it('should reject tampered license payload', () => {
    const artifact = signLicensePayload(validClaims);
    // Tamper with maxCameras to elevate quota from 8 to 999
    const tamperedPayload = artifact.signedPayload.replace('"maxCameras":8', '"maxCameras":999');

    const result = verifyLicenseArtifact(tamperedPayload, artifact.signatureEd25519);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Cryptographic signature verification failed');
  });

  it('should reject signature forged with an arbitrary keypair', () => {
    const forgedKeyPair = generateVendorEd25519KeyPair();
    const forgedArtifact = signLicensePayload(validClaims, forgedKeyPair.privateKey);

    const result = verifyLicenseArtifact(forgedArtifact.signedPayload, forgedArtifact.signatureEd25519);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Cryptographic signature verification failed');
  });

  it('should correctly detect expired subscription license', () => {
    const pastDate = new Date(Date.now() - 3600000).toISOString();
    const expiredClaims: LicenseClaims = {
      ...validClaims,
      expiresAt: pastDate,
    };

    const artifact = signLicensePayload(expiredClaims);
    const result = verifyLicenseArtifact(artifact.signedPayload, artifact.signatureEd25519);
    expect(result.valid).toBe(true);

    const activeCheck = isLicenseActive(result.claims!);
    expect(activeCheck.active).toBe(false);
    expect(activeCheck.reason).toBe('LICENSE_EXPIRED');
  });

  it('should confirm perpetual license with null expiresAt is always active', () => {
    const activeCheck = isLicenseActive(validClaims);
    expect(activeCheck.active).toBe(true);
  });
});
