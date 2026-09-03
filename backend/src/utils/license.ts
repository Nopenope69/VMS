import crypto from 'crypto';
import { VENDOR_LICENSE_PUBLIC_KEY, DEV_VENDOR_LICENSE_PRIVATE_KEY } from '../config/licenseKeys';

export type LicenseTier = 'BASIC' | 'PROFESSIONAL' | 'ENTERPRISE';

export interface LicenseClaims {
  licenseId: string;
  tenantId: string;
  tier: LicenseTier;
  maxCameras: number;
  features: string[];
  issuedAt: string; // ISO UTC
  expiresAt: string | null; // ISO UTC or null for perpetual
  installationId?: string;
  deviceBinding?: string;
}

export interface LicenseVerificationResult {
  valid: boolean;
  error?: string;
  claims?: LicenseClaims;
}

/**
 * Produces deterministic canonical JSON string for cryptographic signing.
 */
export function canonicalizeJson(obj: any): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map((item) => canonicalizeJson(item)).join(',')}]`;
  }
  const sortedKeys = Object.keys(obj).sort();
  const pairs = sortedKeys.map((k) => `"${k}":${canonicalizeJson(obj[k])}`);
  return `{${pairs.join(',')}}`;
}

/**
 * Signs a license payload using vendor Ed25519 private key.
 * (Run on provisioning authority or during initial bootstrap).
 */
export function signLicensePayload(
  claims: LicenseClaims,
  privateKeyPem: string = DEV_VENDOR_LICENSE_PRIVATE_KEY
): { signedPayload: string; signatureEd25519: string } {
  const canonical = canonicalizeJson(claims);
  const signer = crypto.createSign('SHA512'); // Ed25519 ignores the digest algorithm name and signs the raw payload
  // In Node crypto, crypto.sign(null, Buffer.from(canonical), privateKey) is used for Ed25519:
  const signature = crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKeyPem);
  return {
    signedPayload: canonical,
    signatureEd25519: signature.toString('hex'),
  };
}

/**
 * Verifies a license artifact against the embedded root vendor Ed25519 public key.
 * Strictly offline verification.
 */
export function verifyLicenseArtifact(
  signedPayload: string,
  signatureEd25519: string,
  publicKeyPem: string = VENDOR_LICENSE_PUBLIC_KEY
): LicenseVerificationResult {
  try {
    const isVerified = crypto.verify(
      null,
      Buffer.from(signedPayload, 'utf8'),
      publicKeyPem,
      Buffer.from(signatureEd25519, 'hex')
    );

    if (!isVerified) {
      return { valid: false, error: 'Cryptographic signature verification failed' };
    }

    const claims: LicenseClaims = JSON.parse(signedPayload);

    // Structural validations
    if (!claims.licenseId || !claims.tenantId || !claims.tier || typeof claims.maxCameras !== 'number') {
      return { valid: false, error: 'Malformed license payload structure' };
    }

    return { valid: true, claims };
  } catch (err: any) {
    return { valid: false, error: `License parsing failure: ${err.message}` };
  }
}

/**
 * Evaluates whether a verified license is currently active or expired.
 */
export function isLicenseActive(claims: LicenseClaims): { active: boolean; reason?: string } {
  if (claims.expiresAt) {
    const now = new Date();
    const expiry = new Date(claims.expiresAt);
    if (now > expiry) {
      return { active: false, reason: 'LICENSE_EXPIRED' };
    }
  }
  return { active: true };
}
