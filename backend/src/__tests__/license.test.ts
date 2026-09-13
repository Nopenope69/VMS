import crypto from 'crypto';
import {
  signLicensePayload,
  verifyLicenseArtifact,
  isLicenseActive,
  LicenseClaims,
} from '../utils/license';
import { VENDOR_LICENSE_PUBLIC_KEY } from '../config/licenseKeys';

describe('Ed25519 Commercial Licensing Engine', () => {
  // Ephemeral test keypair simulating offline provisioning authority
  const testKeyPair = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const validClaims: LicenseClaims = {
    licenseId: 'lic_test_001',
    tenantId: 'tenant_omega',
    tier: 'PROFESSIONAL',
    maxCameras: 8,
    features: ['EVIDENCE_EXPORT', 'ADVANCED_PTZ'],
    issuedAt: new Date().toISOString(),
    expiresAt: null, // Perpetual
    kid: 'test-authority-v1',
  };

  it('should sign and verify valid Ed25519 license artifact offline', () => {
    const artifact = signLicensePayload(validClaims, testKeyPair.privateKey);
    expect(artifact.signedPayload).toBeDefined();
    expect(artifact.signatureEd25519).toHaveLength(128); // 64 bytes in hex

    const result = verifyLicenseArtifact(artifact.signedPayload, artifact.signatureEd25519, testKeyPair.publicKey);
    expect(result.valid).toBe(true);
    expect(result.claims?.licenseId).toBe('lic_test_001');
    expect(result.claims?.tier).toBe('PROFESSIONAL');
    expect(result.claims?.maxCameras).toBe(8);
  });

  it('should reject tampered license payload', () => {
    const artifact = signLicensePayload(validClaims, testKeyPair.privateKey);
    // Tamper with maxCameras to elevate quota from 8 to 999
    const tamperedPayload = artifact.signedPayload.replace('"maxCameras":8', '"maxCameras":999');

    const result = verifyLicenseArtifact(tamperedPayload, artifact.signatureEd25519, testKeyPair.publicKey);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Cryptographic signature verification failed');
  });

  it('should reject signature forged with an untrusted keypair against embedded public key', () => {
    const forgedKeyPair = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const forgedArtifact = signLicensePayload(validClaims, forgedKeyPair.privateKey);

    // Default verify uses embedded root VENDOR_LICENSE_PUBLIC_KEY
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

    const artifact = signLicensePayload(expiredClaims, testKeyPair.privateKey);
    const result = verifyLicenseArtifact(artifact.signedPayload, artifact.signatureEd25519, testKeyPair.publicKey);
    expect(result.valid).toBe(true);

    const activeCheck = isLicenseActive(result.claims!);
    expect(activeCheck.active).toBe(false);
    expect(activeCheck.reason).toBe('LICENSE_EXPIRED');
  });

  it('should confirm perpetual license with null expiresAt is always active', () => {
    const activeCheck = isLicenseActive(validClaims);
    expect(activeCheck.active).toBe(true);
  });

  it('should verify valid 30-day unsigned evaluation trial', () => {
    const futureDate = new Date(Date.now() + 30 * 86400000).toISOString();
    const trialClaims: LicenseClaims = {
      licenseId: 'lic_trial_test',
      tenantId: 'tenant_trial',
      tier: 'BASIC',
      maxCameras: 4,
      features: ['EVIDENCE_EXPORT'],
      issuedAt: new Date().toISOString(),
      expiresAt: futureDate,
      isTrial: true,
    };

    const result = verifyLicenseArtifact(JSON.stringify(trialClaims), 'TRIAL_UNSIGNED');
    expect(result.valid).toBe(true);
    expect(result.claims?.isTrial).toBe(true);

    const activeCheck = isLicenseActive(result.claims!);
    expect(activeCheck.active).toBe(true);
  });

  it('should reject invalid or forged unsigned trial claims', () => {
    // Missing isTrial: true
    const forgedTrialClaims = {
      licenseId: 'lic_forged_trial',
      tenantId: 'tenant_trial',
      tier: 'ENTERPRISE',
      maxCameras: 999,
      features: ['EVIDENCE_EXPORT', 'ANPR'],
    };

    const result = verifyLicenseArtifact(JSON.stringify(forgedTrialClaims), 'TRIAL_UNSIGNED');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid unsigned trial claim');
  });
});
