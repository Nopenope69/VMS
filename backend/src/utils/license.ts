import crypto from 'crypto';
import { VENDOR_LICENSE_PUBLIC_KEY } from '../config/licenseKeys';

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
  kid?: string; // Key ID / version of signing authority
  isTrial?: boolean; // True for unsigned 30-day appliance evaluation trial
}

/**
 * The only terms an unsigned evaluation trial may carry; bootstrap writes exactly these (auth.routes.ts).
 * An unsigned claim is not evidence of anything, so a TRIAL_UNSIGNED artifact asking for more (a feature, a
 * camera, a tier, a longer or post-dated period) is refused rather than trusted.
 */
export const TRIAL_TERMS = { tier: 'BASIC' as LicenseTier, maxCameras: 4, features: ['EVIDENCE_EXPORT'], days: 30 };
const TRIAL_CLOCK_SKEW_MS = 5 * 60_000;

function trialProblem(claims: LicenseClaims, now: number): string | null {
  if (!claims.isTrial || !claims.licenseId || !claims.tenantId || typeof claims.maxCameras !== 'number') return 'Invalid unsigned trial claim structure';
  if (claims.tier !== TRIAL_TERMS.tier) return `Unsigned trial claims tier ${claims.tier}; a trial is ${TRIAL_TERMS.tier}`;
  if (!Number.isInteger(claims.maxCameras) || claims.maxCameras < 1 || claims.maxCameras > TRIAL_TERMS.maxCameras) {
    return `Unsigned trial claims ${claims.maxCameras} cameras; a trial allows ${TRIAL_TERMS.maxCameras}`;
  }
  const extra = (Array.isArray(claims.features) ? claims.features : [null]).filter((f) => !TRIAL_TERMS.features.includes(f as string));
  if (extra.length) return `Unsigned trial claims features outside the trial: ${extra.join(', ')}`;
  const issued = Date.parse(claims.issuedAt);
  const expires = claims.expiresAt ? Date.parse(claims.expiresAt) : NaN;
  if (Number.isNaN(issued) || Number.isNaN(expires)) return 'Unsigned trial needs valid issuedAt and expiresAt';
  if (issued > now + TRIAL_CLOCK_SKEW_MS) return 'Unsigned trial is issued in the future';
  if (expires - issued > TRIAL_TERMS.days * 86_400_000) return `Unsigned trial runs longer than ${TRIAL_TERMS.days} days`;
  return null;
}

/**
 * Keys trusted for licence artifacts: the vendor key, plus VIGILONE_LICENSE_TEST_PUBLIC_KEY under NODE_ENV=test
 * only, so browser tests against a running server can sign their own licence.
 */
function trustedLicenseKeys(): string[] {
  const testKey = setting('NODE_ENV') === 'test' ? setting('VIGILONE_LICENSE_TEST_PUBLIC_KEY') : undefined;
  return testKey ? [VENDOR_LICENSE_PUBLIC_KEY, testKey] : [VENDOR_LICENSE_PUBLIC_KEY];
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
 * Strictly for offline provisioning authority or test runners with explicit keys.
 * Appliance runtime MUST NOT contain private key material.
 */
export function signLicensePayload(
  claims: LicenseClaims,
  privateKeyPem: string
): { signedPayload: string; signatureEd25519: string } {
  if (!privateKeyPem) {
    throw new Error('FATAL: Private key PEM is strictly required for offline license signing.');
  }
  const canonical = canonicalizeJson(claims);
  // In Node crypto, crypto.sign(null, Buffer.from(canonical), privateKey) is used for Ed25519:
  const signature = crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKeyPem);
  return {
    signedPayload: canonical,
    signatureEd25519: signature.toString('hex'),
  };
}

/**
 * Verifies a license artifact against the embedded root vendor Ed25519 public key (or the given key).
 * Strictly offline verification. An unsigned trial is accepted only on the fixed TRIAL_TERMS.
 */
export function verifyLicenseArtifact(
  signedPayload: string,
  signatureEd25519: string,
  publicKeyPem?: string,
  now: number = Date.now()
): LicenseVerificationResult {
  try {
    if (signatureEd25519 === 'TRIAL_UNSIGNED') {
      const claims: LicenseClaims = JSON.parse(signedPayload);
      const problem = trialProblem(claims, now);
      return problem ? { valid: false, error: problem } : { valid: true, claims };
    }

    const signature = Buffer.from(signatureEd25519, 'hex');
    const isVerified = (publicKeyPem ? [publicKeyPem] : trustedLicenseKeys()).some((key) =>
      crypto.verify(null, Buffer.from(signedPayload, 'utf8'), key, signature)
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

import fs from 'fs';
import ClockGuard from './clockGuard';
import { setting } from '../config/settings';

export interface HardwareBindingInfo {
  dmiUuid: string | null;
  machineId: string | null;
  fingerprint: string;
}

/**
 * Retrieves the host appliance hardware identifiers.
 * Primary: DMI board UUID (/sys/class/dmi/id/product_uuid)
 * Secondary: System machine-id (/etc/machine-id or /var/lib/dbus/machine-id)
 * Also supports environment variable overrides for testing or containerized deployments.
 */
export function getApplianceHardwareFingerprint(): HardwareBindingInfo {
  let dmiUuid: string | null = setting('APPLIANCE_HARDWARE_UUID') || null;
  let machineId: string | null = setting('APPLIANCE_MACHINE_ID') || null;

  if (!dmiUuid) {
    try {
      if (fs.existsSync('/sys/class/dmi/id/product_uuid')) {
        dmiUuid = fs.readFileSync('/sys/class/dmi/id/product_uuid', 'utf8').trim();
      }
    } catch {
      // Non-fatal if unreadable or not on Linux sysfs
    }
  }

  if (!machineId) {
    try {
      if (fs.existsSync('/etc/machine-id')) {
        machineId = fs.readFileSync('/etc/machine-id', 'utf8').trim();
      } else if (fs.existsSync('/var/lib/dbus/machine-id')) {
        machineId = fs.readFileSync('/var/lib/dbus/machine-id', 'utf8').trim();
      }
    } catch {
      // Non-fatal
    }
  }

  // Fallback defaults for dev / non-Linux host test runners when env vars are unset
  if (!dmiUuid && !machineId) {
    dmiUuid = 'dev-dmi-uuid-default-0001';
    machineId = 'dev-machine-id-default-0001';
  }

  const rawString = `${dmiUuid || 'none'}:${machineId || 'none'}`;
  const fingerprint = crypto.createHash('sha256').update(rawString).digest('hex');

  return { dmiUuid, machineId, fingerprint };
}

/**
 * Validates whether the given claims match the host hardware binding.
 */
export function verifyHardwareBinding(
  claims: LicenseClaims,
  currentHardwareBinding?: string
): { valid: boolean; reason?: string } {
  if (!claims.deviceBinding) {
    return { valid: true };
  }

  const hw = getApplianceHardwareFingerprint();
  const binding = currentHardwareBinding || hw.fingerprint;

  const matches =
    claims.deviceBinding === binding ||
    claims.deviceBinding === hw.fingerprint ||
    (hw.dmiUuid && claims.deviceBinding === hw.dmiUuid);

  if (!matches) {
    return {
      valid: false,
      reason: `HARDWARE_BINDING_MISMATCH: License locked to device '${claims.deviceBinding}', but appliance fingerprint is '${binding}'.`,
    };
  }

  return { valid: true };
}

/**
 * Evaluates whether a verified license is currently active or expired.
 * Incorporates ClockGuard to prevent CMOS battery resets (1970) or clock rollback attacks,
 * and validates hardware binding locks if deviceBinding claim is present.
 */
export function isLicenseActive(
  claims: LicenseClaims,
  currentHardwareBinding?: string
): { active: boolean; reason?: string } {
  if (claims.expiresAt) {
    const issuedAt = claims.issuedAt ? new Date(claims.issuedAt) : null;
    const sanitizedTime = ClockGuard.getSanitizedTimeForLicense(issuedAt);
    const expiry = new Date(claims.expiresAt);
    if (sanitizedTime > expiry) {
      return { active: false, reason: 'LICENSE_EXPIRED' };
    }
  }

  if (claims.deviceBinding) {
    const hwCheck = verifyHardwareBinding(claims, currentHardwareBinding);
    if (!hwCheck.valid) {
      return { active: false, reason: hwCheck.reason };
    }
  }

  return { active: true };
}

