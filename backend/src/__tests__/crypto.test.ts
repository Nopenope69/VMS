import fs from 'fs';
import path from 'path';
import {
  encryptCredential,
  decryptCredential,
  computeFileSha256,
  signEvidenceManifest,
  verifyEvidenceManifest,
  getOrCreateApplianceEd25519Keys,
} from '../utils/crypto';

describe('Cryptographic Utilities', () => {
  const testKeyBase64 = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');

  it('should encrypt and decrypt camera credentials via AES-256-GCM', () => {
    const rawCredentials = JSON.stringify({ username: 'admin', password: 'CameraSecretPassword123!' });
    const encrypted = encryptCredential(rawCredentials, testKeyBase64);

    expect(encrypted).not.toEqual(rawCredentials);
    expect(typeof encrypted).toBe('string');

    const decrypted = decryptCredential(encrypted, testKeyBase64);
    expect(decrypted).toEqual(rawCredentials);
    const parsed = JSON.parse(decrypted);
    expect(parsed.username).toBe('admin');
    expect(parsed.password).toBe('CameraSecretPassword123!');
  });

  it('should fail decryption when ciphertext is tampered with', () => {
    const rawCredentials = 'mySecretPassword';
    const encrypted = encryptCredential(rawCredentials, testKeyBase64);

    // Tamper with base64 payload
    const buf = Buffer.from(encrypted, 'base64');
    buf[buf.length - 1] ^= 0xff; // flip last bit
    const tamperedBase64 = buf.toString('base64');

    expect(() => decryptCredential(tamperedBase64, testKeyBase64)).toThrow();
  });

  it('should compute valid SHA-256 hash of a file', async () => {
    const tempFile = path.join('/tmp', `test_sha256_${Date.now()}.txt`);
    fs.writeFileSync(tempFile, 'VigilOne CCTV Evidence Integrity Test Data');

    const hash = await computeFileSha256(tempFile);
    expect(hash).toHaveLength(64); // 64 hex chars = 256 bits

    // Known SHA-256 of "VigilOne CCTV Evidence Integrity Test Data"
    expect(hash).toMatch(/^[a-f0-9]{64}$/);

    fs.unlinkSync(tempFile);
  });

  it('should sign and verify canonical manifest using Ed25519 appliance keys', () => {
    const manifest = JSON.stringify({
      exportId: 'EV-TEST-001',
      camera: 'Main Gate',
      timestamp: '2026-09-04T01:00:00Z',
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });

    const keys = getOrCreateApplianceEd25519Keys();
    const signature = signEvidenceManifest(manifest, keys.privateKeyPem);
    expect(typeof signature).toBe('string');

    const isValid = verifyEvidenceManifest(manifest, signature, keys.publicKeyPem);
    expect(isValid).toBe(true);

    const isTamperedValid = verifyEvidenceManifest(manifest + 'tampered', signature, keys.publicKeyPem);
    expect(isTamperedValid).toBe(false);
  });
});
