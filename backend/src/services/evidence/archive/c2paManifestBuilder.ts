import crypto from 'crypto';
import { canonicalizeJson } from './canonicalJson';
import {
  getOrCreateApplianceEd25519Keys,
  signEvidenceManifest,
} from '../../../utils/crypto';

export interface C2paManifestInput {
  exportId: string;
  title?: string;
  format?: string; // default 'video/mp4'
  applianceIdentifier: string;
  tenantId: string;
  startUtc: Date | string;
  endUtc: Date | string;
  videoSha256: string;
  evidenceMerkleRoot: string;
  segmentCount: number;
  partAPartyName?: string;
  partAPartyDesignation?: string;
  partBExpertName?: string;
  custodyChainHeadHash?: string;
  aiProvenanceSummary?: { recordCount: number; unattributedCount?: number; models?: any[] };
  signingTime?: Date | string;
  privateKeyPem?: string;
  publicKeyPem?: string;
}

export interface C2paManifest {
  c2pa_version: '2.2';
  claim_generator: string; // 'VigilOne Edge VMS/1.0.0'
  claim_generator_info: Array<{ name: string; version: string }>;
  title: string;
  format: string;
  instance_id: string; // `urn:uuid:${exportId}`
  assertions: Array<{
    label: string;
    data: Record<string, any>;
  }>;
  signature_info: {
    alg: 'ed25519';
    issuer: string;
    publicKeyPem: string;
    time: string;
    signature: string;
  };
}

/**
 * Builds a canonical C2PA 2.2 manifest dictionary signed with the appliance Ed25519 private key.
 * Conforms to C2PA 2.2 specification with Section 63 BSA assertions and zero third-party dependencies.
 */
export function buildC2paManifest(input: C2paManifestInput): {
  manifestJson: string;
  manifestObj: C2paManifest;
} {
  const startDate = input.startUtc instanceof Date ? input.startUtc : new Date(input.startUtc);
  const endDate = input.endUtc instanceof Date ? input.endUtc : new Date(input.endUtc);
  const signingDate = input.signingTime
    ? (input.signingTime instanceof Date ? input.signingTime : new Date(input.signingTime))
    : new Date();

  const title = input.title || `VigilOne Evidentiary Export ${input.exportId}`;
  const format = input.format || 'video/mp4';
  const instanceId = input.exportId.startsWith('urn:uuid:')
    ? input.exportId
    : `urn:uuid:${input.exportId}`;

  // 1. Construct Standard C2PA Assertions
  const assertions: Array<{ label: string; data: Record<string, any> }> = [
    {
      label: 'c2pa.actions',
      data: {
        actions: [
          {
            action: 'c2pa.created',
            when: startDate.toISOString(),
            description: 'Footage recorded by edge camera',
            softwareAgent: 'VigilOne Media Plane',
          },
          {
            action: 'c2pa.packaged',
            when: signingDate.toISOString(),
            description: 'Cryptographically packaged for evidentiary export',
            softwareAgent: 'VigilOne Evidence Subsystem',
          },
        ],
      },
    },
    {
      label: 'c2pa.hash.data',
      data: {
        name: 'primary_media',
        alg: 'sha256',
        hash: input.videoSha256,
        pad: 0,
      },
    },
    {
      label: 'stds.schema-org.CreativeWork',
      data: {
        '@context': 'https://schema.org',
        '@type': 'VideoObject',
        name: title,
        contentUrl: 'video.mp4',
        dateCreated: startDate.toISOString(),
        dateModified: endDate.toISOString(),
        author: {
          '@type': 'Person',
          name: input.partAPartyName || 'System Operator',
        },
        producer: {
          '@type': 'Organization',
          name: 'VigilOne Edge Appliance',
          identifier: input.applianceIdentifier,
        },
      },
    },
    {
      label: 'in.gov.bsa.section63',
      data: {
        statute: 'Bharatiya Sakshya Adhiniyam, 2023 - Section 63',
        applianceIdentifier: input.applianceIdentifier,
        evidenceMerkleRoot: input.evidenceMerkleRoot,
        segmentCount: input.segmentCount,
        custodyChainHeadHash: input.custodyChainHeadHash || null,
        partAPartyName: input.partAPartyName || null,
        partAPartyDesignation: input.partAPartyDesignation || null,
        partBExpertName: input.partBExpertName || null,
      },
    },
  ];

  if (input.aiProvenanceSummary) {
    const aiData: Record<string, any> = {
      recordCount: input.aiProvenanceSummary.recordCount,
      models: input.aiProvenanceSummary.models || [],
    };
    if (input.aiProvenanceSummary.unattributedCount !== undefined) {
      aiData.unattributedCount = input.aiProvenanceSummary.unattributedCount;
    }
    assertions.push({
      label: 'c2pa.ai_provenance',
      data: aiData,
    });
  }

  // 2. Retrieve or supply appliance keys
  const keys = input.privateKeyPem && input.publicKeyPem
    ? { privateKeyPem: input.privateKeyPem, publicKeyPem: input.publicKeyPem }
    : getOrCreateApplianceEd25519Keys();
  const publicKeyPem = input.publicKeyPem || keys.publicKeyPem;
  const privateKeyPem = input.privateKeyPem || keys.privateKeyPem;

  // 3. Prepare claim dictionary without signature
  const claimWithoutSig = {
    c2pa_version: '2.2' as const,
    claim_generator: 'VigilOne Edge VMS/1.0.0',
    claim_generator_info: [
      {
        name: 'VigilOne Edge VMS',
        version: '1.0.0',
      },
    ],
    title,
    format,
    instance_id: instanceId,
    assertions,
    signature_info: {
      alg: 'ed25519' as const,
      issuer: input.applianceIdentifier,
      publicKeyPem,
      time: signingDate.toISOString(),
    },
  };

  const canonicalClaimString = canonicalizeJson(claimWithoutSig);
  const signature = signEvidenceManifest(canonicalClaimString, privateKeyPem);

  const manifestObj: C2paManifest = {
    ...claimWithoutSig,
    signature_info: {
      ...claimWithoutSig.signature_info,
      signature,
    },
  };

  const manifestJson = canonicalizeJson(manifestObj);
  return { manifestJson, manifestObj };
}

/**
 * Validates a C2PA 2.2 manifest dictionary or canonical JSON string:
 * - c2pa_version === '2.2'
 * - non-empty claim_generator
 * - required assertions ('c2pa.actions', 'c2pa.hash.data', 'in.gov.bsa.section63')
 * - re-verifies Ed25519 signature over canonical claim reconstructed without signature_info.signature
 */
export function verifyC2paManifest(
  manifestJsonOrObj: string | C2paManifest,
  trustedPublicKeyPem?: string
): { valid: boolean; reason?: string } {
  let manifest: C2paManifest;
  if (typeof manifestJsonOrObj === 'string') {
    try {
      manifest = JSON.parse(manifestJsonOrObj);
    } catch (err: any) {
      return { valid: false, reason: `Failed to parse manifest JSON: ${err?.message || err}` };
    }
  } else {
    manifest = manifestJsonOrObj;
  }

  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, reason: 'Manifest is not an object' };
  }

  if (manifest.c2pa_version !== '2.2') {
    return { valid: false, reason: `Unsupported c2pa_version: ${manifest.c2pa_version}, expected 2.2` };
  }

  if (!manifest.claim_generator || typeof manifest.claim_generator !== 'string') {
    return { valid: false, reason: 'Missing or invalid claim_generator' };
  }

  if (!Array.isArray(manifest.assertions)) {
    return { valid: false, reason: 'Missing assertions array' };
  }

  const assertionsByLabel = new Map<string, any>(
    manifest.assertions.map((a) => [a.label, a.data])
  );

  if (!assertionsByLabel.has('c2pa.actions')) {
    return { valid: false, reason: 'Missing required assertion: c2pa.actions' };
  }
  const actionsData = assertionsByLabel.get('c2pa.actions');
  if (!actionsData || !Array.isArray(actionsData.actions) || actionsData.actions.length === 0) {
    return { valid: false, reason: 'c2pa.actions must contain an actions array' };
  }

  if (!assertionsByLabel.has('c2pa.hash.data')) {
    return { valid: false, reason: 'Missing required assertion: c2pa.hash.data' };
  }
  const hashData = assertionsByLabel.get('c2pa.hash.data');
  if (!hashData || !hashData.hash || typeof hashData.hash !== 'string') {
    return { valid: false, reason: 'c2pa.hash.data missing hash' };
  }

  if (!assertionsByLabel.has('in.gov.bsa.section63')) {
    return { valid: false, reason: 'Missing required assertion: in.gov.bsa.section63' };
  }
  const bsaData = assertionsByLabel.get('in.gov.bsa.section63');
  if (!bsaData || !bsaData.evidenceMerkleRoot || !bsaData.applianceIdentifier) {
    return { valid: false, reason: 'in.gov.bsa.section63 missing required fields' };
  }

  if (!manifest.signature_info || typeof manifest.signature_info !== 'object') {
    return { valid: false, reason: 'Missing signature_info' };
  }
  if (manifest.signature_info.alg !== 'ed25519') {
    return { valid: false, reason: `Unsupported signature algorithm: ${manifest.signature_info.alg}` };
  }

  const sig = manifest.signature_info.signature;
  if (!sig || typeof sig !== 'string') {
    return { valid: false, reason: 'Missing or empty signature_info.signature' };
  }

  const effectivePubKey = trustedPublicKeyPem || manifest.signature_info.publicKeyPem;
  if (!effectivePubKey) {
    return { valid: false, reason: 'No public key available for verification' };
  }

  if (trustedPublicKeyPem && manifest.signature_info.publicKeyPem) {
    // Normalize both keys to prevent whitespace/newline formatting differences
    const norm = (k: string) => k.replace(/\r\n/g, '\n').trim();
    if (norm(trustedPublicKeyPem) !== norm(manifest.signature_info.publicKeyPem)) {
      return { valid: false, reason: 'Manifest public key does not match trusted public key' };
    }
  }

  // Reconstruct unsigned canonical claim
  const { signature: _sig, ...sigInfoWithoutSig } = manifest.signature_info;
  const unsignedClaim = {
    ...manifest,
    signature_info: sigInfoWithoutSig,
  };
  const canonicalClaim = canonicalizeJson(unsignedClaim);

  let verified = false;
  // Try hex decoding first if 128-char hex
  if (/^[0-9a-fA-F]{128}$/.test(sig)) {
    try {
      verified = crypto.verify(
        null,
        Buffer.from(canonicalClaim, 'utf8'),
        effectivePubKey,
        Buffer.from(sig, 'hex')
      );
    } catch (_) {}
  }
  // Try base64 decoding
  if (!verified) {
    try {
      verified = crypto.verify(
        null,
        Buffer.from(canonicalClaim, 'utf8'),
        effectivePubKey,
        Buffer.from(sig, 'base64')
      );
    } catch (_) {}
  }
  // Fallback try hex if not attempted
  if (!verified) {
    try {
      verified = crypto.verify(
        null,
        Buffer.from(canonicalClaim, 'utf8'),
        effectivePubKey,
        Buffer.from(sig, 'hex')
      );
    } catch (_) {}
  }

  if (!verified) {
    return { valid: false, reason: 'Ed25519 signature verification failed' };
  }

  return { valid: true };
}
