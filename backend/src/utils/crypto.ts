import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import config from '../config/env';

/**
 * Encrypts arbitrary plaintext (e.g. camera credentials) using AES-256-GCM.
 * Output is a self-contained base64 string: IV (12 bytes) + AuthTag (16 bytes) + Ciphertext.
 */
export function encryptCredential(plaintext: string, base64Key = config.CREDENTIAL_ENCRYPTION_KEY): string {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) {
    throw new Error('Encryption key must be exactly 32 bytes (256 bits)');
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const combined = Buffer.concat([iv, authTag, encrypted]);
  return combined.toString('base64');
}

/**
 * Decrypts an AES-256-GCM encrypted base64 payload.
 */
export function decryptCredential(encryptedBase64: string, base64Key = config.CREDENTIAL_ENCRYPTION_KEY): string {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) {
    throw new Error('Encryption key must be exactly 32 bytes (256 bits)');
  }

  const combined = Buffer.from(encryptedBase64, 'base64');
  if (combined.length < 28) {
    throw new Error('Invalid ciphertext: buffer too short for IV and AuthTag');
  }

  const iv = combined.subarray(0, 12);
  const authTag = combined.subarray(12, 28);
  const ciphertext = combined.subarray(28);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Computes SHA-256 hash of a file on disk using streaming I/O.
 */
export async function computeFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);

    stream.on('error', (err) => reject(err));
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Ed25519 Key Management & Manifest Signing for Section 63 BSA Evidence.
 */
const APPLIANCE_KEY_DIR = process.env.NODE_ENV === 'test' ? '/tmp/vigilone_test_keys' : '/etc/vigilone';
const ED25519_PRIV_PATH = path.join(APPLIANCE_KEY_DIR, 'appliance_ed25519.key');
const ED25519_PUB_PATH = path.join(APPLIANCE_KEY_DIR, 'appliance_ed25519.pub');

export interface ApplianceKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

export function getOrCreateApplianceEd25519Keys(): ApplianceKeyPair {
  if (!fs.existsSync(APPLIANCE_KEY_DIR)) {
    fs.mkdirSync(APPLIANCE_KEY_DIR, { recursive: true });
  }

  if (fs.existsSync(ED25519_PRIV_PATH) && fs.existsSync(ED25519_PUB_PATH)) {
    const privateKeyPem = fs.readFileSync(ED25519_PRIV_PATH, 'utf8');
    const publicKeyPem = fs.readFileSync(ED25519_PUB_PATH, 'utf8');
    return { publicKeyPem, privateKeyPem };
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  fs.writeFileSync(ED25519_PRIV_PATH, privateKey, { mode: 0o600 });
  fs.writeFileSync(ED25519_PUB_PATH, publicKey, { mode: 0o644 });

  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

/**
 * Signs a canonical UTF-8 JSON manifest string using the appliance's Ed25519 private key.
 */
export function signEvidenceManifest(canonicalManifestJson: string, privateKeyPem?: string): string {
  const privKey = privateKeyPem || getOrCreateApplianceEd25519Keys().privateKeyPem;
  const signatureBuffer = crypto.sign(null, Buffer.from(canonicalManifestJson, 'utf8'), privKey);
  return signatureBuffer.toString('base64');
}

/**
 * Verifies an Ed25519 signature against the canonical manifest string and public key.
 */
export function verifyEvidenceManifest(
  canonicalManifestJson: string,
  signatureBase64: string,
  publicKeyPem?: string
): boolean {
  try {
    const pubKey = publicKeyPem || getOrCreateApplianceEd25519Keys().publicKeyPem;
    return crypto.verify(
      null,
      Buffer.from(canonicalManifestJson, 'utf8'),
      pubKey,
      Buffer.from(signatureBase64, 'base64')
    );
  } catch {
    return false;
  }
}
