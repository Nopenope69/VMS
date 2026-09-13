/**
 * Hardcoded root vendor Ed25519 public key embedded into the VigilOne edge appliance.
 * Used exclusively for offline verification of license artifacts.
 * The corresponding private key is held strictly by the vendor provisioning authority offline.
 * 
 * TRUST TRANSITION PROTOCOL:
 * If this keypair is ever rotated or suspected of compromise, field appliances MUST be updated
 * out-of-band via an authorized appliance update or manual re-provisioning of the trust anchor
 * (`vigilonectl license trust-anchor`). In accordance with commercial security requirements,
 * an appliance will NEVER accept a key rotation signed solely by an existing/compromised key.
 */
export const VENDOR_LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEApL6HN3oACds89gWXW50Wq6myTHm+ooFCa97SflUR1CI=
-----END PUBLIC KEY-----`;

