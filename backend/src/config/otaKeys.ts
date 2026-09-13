/**
 * Hardcoded root vendor Ed25519 OTA public key embedded into the VigilOne edge appliance.
 * Used exclusively for offline cryptographic verification of signed appliance update bundles.
 *
 * DUAL TRUST DOMAIN MANDATE:
 * This key belongs strictly to the OTA / Software Supply Chain trust domain.
 * It is completely distinct from the commercial licensing key (`VENDOR_LICENSE_PUBLIC_KEY`).
 * Compromise of one trust domain must never authorize artifacts in the other.
 *
 * The corresponding private key is held strictly offline by the vendor build authority.
 * Private key material MUST NEVER enter the appliance runtime, repository, or production containers.
 */

export const OTA_KEY_ID = 'vigilone-ota-2026-v1';

export const VENDOR_OTA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAW/FGHJAxgB4gic+oMQUczq9D0JAiEjHbWo9fGqdMhZI=
-----END PUBLIC KEY-----`;
