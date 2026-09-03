import crypto from 'crypto';

/**
 * Hardcoded root vendor Ed25519 public key embedded into the VigilOne edge appliance.
 * Used exclusively for offline verification of license artifacts.
 * The corresponding private key is held strictly by the vendor provisioning authority.
 */
export const VENDOR_LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAg8b3513BZIx+uMKTgnUGCrB4iIjSX9yuE2/h8+fRMy4=
-----END PUBLIC KEY-----`;

/**
 * Development & testing fallback private key (matches VENDOR_LICENSE_PUBLIC_KEY above).
 * In production builds, this private key is NEVER shipped with the appliance.
 */
export const DEV_VENDOR_LICENSE_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIIgkrDm5dXvkls58oYR4EW+Qhb338Hzuy/IQP2qT9zMY
-----END PRIVATE KEY-----`;

export function generateVendorEd25519KeyPair() {
  return crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}
