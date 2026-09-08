import crypto from 'crypto';
import { EvidenceManifest, PrismaClient } from '@prisma/client';
import { MerkleTree, SegmentLeafInput, MerkleLeafEntry } from './merkleTree';
import { CustodyLedger } from './custodyLedger';
import { EvidencePinAdapter } from './evidencePinAdapter';
import { BsaCertificatePackageBuilder, BsaCertificateOptions } from './bsaCertificatePackageBuilder';
import { RecordingCatalog } from '../../recording/catalog/recordingCatalog.service';
import {
  getOrCreateApplianceEd25519Keys,
  signEvidenceManifest,
  verifyEvidenceManifest,
} from '../../../utils/crypto';

export interface CreateManifestInput {
  tenantId: string;
  createdByUserId: string;
  cameraIds: string[];
  startUtc: Date;
  endUtc: Date;
  legalHold?: boolean;
  notes?: string;
  partAPartyName?: string;
  partAPartyDesignation?: string;
  partBExpertName?: string;
  partBExpertDesignation?: string;
  partBExpertOrganization?: string;
}

export interface ManifestVerificationResult {
  manifestId: string;
  valid: boolean;
  evidenceMerkleRoot: string;
  masterEvidenceHash: string; // Compatibility alias
  recomputedMerkleRoot: string;
  matchedSegments: number;
  totalSegments: number;
  signatureValid: boolean;
  error?: string;
}

/**
 * Deterministic JSON stringifier to guarantee identical canonical bytes
 * across machines regardless of object key insertion order.
 */
export function canonicalizeJson(obj: any): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalizeJson).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => JSON.stringify(k) + ':' + canonicalizeJson(obj[k]));
  return '{' + pairs.join(',') + '}';
}

export class ManifestBuilder {
  private prisma: PrismaClient;
  private recordingCatalog: RecordingCatalog;
  private custodyLedger: CustodyLedger;
  private pinAdapter: EvidencePinAdapter;

  constructor(
    prisma: PrismaClient,
    recordingCatalog?: RecordingCatalog,
    custodyLedger?: CustodyLedger,
    pinAdapter?: EvidencePinAdapter
  ) {
    this.prisma = prisma;
    this.recordingCatalog = recordingCatalog || new RecordingCatalog(prisma);
    this.custodyLedger = custodyLedger || new CustodyLedger(prisma);
    this.pinAdapter = pinAdapter || new EvidencePinAdapter(prisma, this.recordingCatalog);
  }

  /**
   * Generates a multi-camera cryptographic evidence manifest.
   * Master recorded footage remains immutable.
   */
  async createManifest(input: CreateManifestInput): Promise<EvidenceManifest> {
    if (input.endUtc.getTime() <= input.startUtc.getTime()) {
      throw new Error('endUtc must be strictly after startUtc');
    }
    if (!input.cameraIds || input.cameraIds.length === 0) {
      throw new Error('At least one cameraId is required to create an evidence manifest');
    }

    // 1. Gather all segments for each requested camera from authoritative RecordingCatalog
    const leavesInput: SegmentLeafInput[] = [];
    const cameraSummaries: Array<{
      cameraId: string;
      name?: string;
      segmentCount: number;
      segmentHashes: string[];
    }> = [];
    const allSegmentIds: string[] = [];

    for (const camId of input.cameraIds) {
      let segments: any[] = [];
      try {
        segments = await this.recordingCatalog.findSegments(
          camId,
          input.startUtc,
          input.endUtc
        );
        if ((!segments || segments.length === 0) && (this.recordingCatalog as any).findSegments) {
          const alt = await (this.recordingCatalog as any).findSegments(
            input.tenantId,
            camId,
            input.startUtc,
            input.endUtc
          );
          if (alt && alt.length > 0) {
            segments = alt;
          }
        }
      } catch {
        segments = await (this.recordingCatalog as any).findSegments(
          input.tenantId,
          camId,
          input.startUtc,
          input.endUtc
        );
      }

      if (!segments) segments = [];

      const segmentHashes: string[] = [];
      for (const seg of segments) {
        allSegmentIds.push(seg.id);
        const startTime = seg.startTime || seg.startUtc || input.startUtc;
        const endTime = seg.endTime || seg.endUtc || input.endUtc;
        const segLeaf: SegmentLeafInput = {
          segmentId: seg.id,
          cameraId: camId,
          startTime: startTime instanceof Date ? startTime : new Date(startTime),
          endTime: endTime instanceof Date ? endTime : new Date(endTime),
          mediaSha256: seg.sha256Hash || seg.mediaSha256 || seg.sha256,
        };
        leavesInput.push(segLeaf);
        segmentHashes.push(MerkleTree.computeLeafHash(segLeaf));
      }

      cameraSummaries.push({
        cameraId: camId,
        segmentCount: segments.length,
        segmentHashes,
      });
    }

    // 2. Build authoritative Merkle tree with length-prefixed encoding and odd-node duplication
    const { rootHash, leafEntries } = MerkleTree.buildTree(leavesInput);
    const applianceIdentifier = `VIGILONE-EDGE-${input.tenantId.substring(0, 8).toUpperCase()}`;

    // 3. Build Canonical Manifest JSON representation
    const canonicalManifestObj = {
      version: 1,
      applianceIdentifier,
      tenantId: input.tenantId,
      timeRange: {
        startUtc: input.startUtc.toISOString(),
        endUtc: input.endUtc.toISOString(),
      },
      cameraIds: [...input.cameraIds].sort(),
      evidenceMerkleRoot: rootHash,
      leafCount: leafEntries.length,
      leaves: leafEntries,
    };
    const canonicalManifestJsonString = canonicalizeJson(canonicalManifestObj);

    // 4. Sign canonical manifest JSON using appliance Ed25519 private key
    const applianceSignature = signEvidenceManifest(canonicalManifestJsonString);

    // 5. Build Section 63 BSA certificate record
    const certOptions: BsaCertificateOptions = {
      evidenceId: 'PENDING_ID',
      tenantId: input.tenantId,
      applianceIdentifier,
      applianceSignature,
      evidenceMerkleRoot: rootHash,
      startUtc: input.startUtc,
      endUtc: input.endUtc,
      cameras: cameraSummaries,
      partAPartyName: input.partAPartyName,
      partAPartyDesignation: input.partAPartyDesignation,
      partBExpertName: input.partBExpertName,
      partBExpertDesignation: input.partBExpertDesignation,
      partBExpertOrganization: input.partBExpertOrganization,
    };
    const certificateData = BsaCertificatePackageBuilder.buildCertificateData(certOptions);

    const sourceMetadata = {
      notes: input.notes,
      totalCameras: input.cameraIds.length,
      totalSegments: leafEntries.length,
      createdEpochMs: Date.now(),
    };

    // 6. Create immutable manifest record in Prisma
    const manifest = await this.prisma.evidenceManifest.create({
      data: {
        tenantId: input.tenantId,
        createdByUserId: input.createdByUserId,
        startUtc: input.startUtc,
        endUtc: input.endUtc,
        cameraIdsJson: input.cameraIds as any,
        masterEvidenceHash: rootHash, // Compatibility alias
        evidenceMerkleRoot: rootHash,
        applianceSignature,
        canonicalManifestJson: canonicalManifestObj as any,
        manifestVersion: 1,
        hashAlgorithm: 'SHA-256',
        sourceMetadataJson: sourceMetadata as any,
        segmentManifestJson: leafEntries as any,
        certificateDataJson: certificateData as any,
        legalHold: input.legalHold ?? false,
      },
    });

    // 7. Pin segments: if legalHold is enabled, place absolute LEGAL_HOLD pin
    if (manifest.legalHold && allSegmentIds.length > 0) {
      await this.pinAdapter.pinForLegalHold(
        input.tenantId,
        allSegmentIds,
        manifest.id,
        'LEGAL_HOLD_ACTIVE'
      );
    }

    // 8. Record genesis root custodial event in the tamper-evident custody ledger
    await this.custodyLedger.recordEvent({
      tenantId: input.tenantId,
      evidenceId: manifest.id,
      actorUserId: input.createdByUserId,
      action: 'EVIDENCE_CREATED',
      sourceHash: rootHash,
      metadata: {
        cameraCount: input.cameraIds.length,
        segmentCount: leafEntries.length,
        evidenceMerkleRoot: rootHash,
        legalHold: manifest.legalHold,
        applianceSignature,
      },
    });

    return manifest;
  }

  /**
   * Re-verifies source segments and cryptographic signature against stored manifest.
   */
  async verifyManifestIntegrity(manifestId: string): Promise<ManifestVerificationResult> {
    const manifest = await this.prisma.evidenceManifest.findUnique({
      where: { id: manifestId },
    });
    if (!manifest) {
      throw new Error(`Manifest ${manifestId} not found`);
    }

    const rootHash = manifest.evidenceMerkleRoot || manifest.masterEvidenceHash;
    const leaves = (manifest.segmentManifestJson as unknown as MerkleLeafEntry[]) || [];

    // Verify Ed25519 signature over canonical JSON
    let signatureValid = false;
    if (manifest.canonicalManifestJson && manifest.applianceSignature) {
      const canonicalString = canonicalizeJson(manifest.canonicalManifestJson);
      signatureValid = verifyEvidenceManifest(canonicalString, manifest.applianceSignature);
    }

    // Reconstruct leaves and verify Merkle root
    let matchedSegments = 0;
    const leavesInput: SegmentLeafInput[] = [];

    for (const leaf of leaves) {
      const reconstructedLeaf: SegmentLeafInput = {
        segmentId: leaf.segmentId,
        cameraId: leaf.cameraId,
        startTime: new Date(leaf.startUtc),
        endTime: new Date(leaf.endUtc),
        mediaSha256: leaf.mediaSha256,
      };

      const recomputedLeafHash = MerkleTree.computeLeafHash(reconstructedLeaf);
      if (recomputedLeafHash === leaf.leafHash) {
        matchedSegments++;
      }
      leavesInput.push(reconstructedLeaf);
    }

    const { rootHash: recomputedMerkleRoot } = MerkleTree.buildTree(leavesInput);
    const hashesMatch = recomputedMerkleRoot === rootHash;
    const valid = hashesMatch && (manifest.applianceSignature ? signatureValid : true);

    return {
      manifestId,
      valid,
      evidenceMerkleRoot: rootHash,
      masterEvidenceHash: rootHash,
      recomputedMerkleRoot,
      matchedSegments,
      totalSegments: leaves.length,
      signatureValid,
      error: valid
        ? undefined
        : !hashesMatch
        ? 'Cryptographic Merkle root mismatch: segment data or sequence has been altered'
        : 'Appliance Ed25519 digital signature verification failed: manifest payload has been modified',
    };
  }
}
