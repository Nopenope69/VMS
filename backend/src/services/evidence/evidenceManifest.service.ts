import {
  EvidenceExport,
  EvidenceManifest,
  PrismaClient,
  SigningMode,
} from '@prisma/client';
import {
  EvidenceArchive,
  CreateManifestInput,
  ManifestVerificationResult,
  ExportDerivativeClipInput,
} from './archive';

export { CreateManifestInput, ManifestVerificationResult };
export type ExportDerivativeInput = ExportDerivativeClipInput;

export interface Section63BsaCertificateData {
  complianceFramework: 'BHARATIYA_SAKSHYA_ADHINIYAM_2023_SEC_63';
  disclaimer: string;
  applianceIdentifier: string;
  producedAtUtc: string;
  timeRange: {
    startUtc: string;
    endUtc: string;
  };
  hashAlgorithm: string;
  masterEvidenceHash: string;
  cameras: Array<{
    cameraId: string;
    name?: string;
    segmentCount: number;
    segmentHashes: string[];
  }>;
  signatoryMetadata?: {
    partAPartyName?: string;
    partAPartyDesignation?: string;
    signingMode: SigningMode;
  };
}

/**
 * Backward compatibility facade delegating directly to authoritative EvidenceArchive deep module.
 * @deprecated Use EvidenceArchive from services/evidence/archive directly.
 */
export class EvidenceManifestService {
  private archive: EvidenceArchive;

  constructor(
    prisma: PrismaClient,
    recordingCatalog?: any,
    chainOfCustody?: any
  ) {
    this.archive = new EvidenceArchive(
      prisma,
      recordingCatalog,
      chainOfCustody?.custodyLedger || (chainOfCustody as any)
    );
  }

  public async createManifest(input: CreateManifestInput): Promise<EvidenceManifest> {
    return this.archive.createManifest(input);
  }

  public async verifyManifestIntegrity(manifestId: string): Promise<ManifestVerificationResult> {
    return this.archive.verifyManifestIntegrity(manifestId);
  }

  public async exportDerivativeClip(input: ExportDerivativeClipInput): Promise<EvidenceExport> {
    return this.archive.exportDerivativeClip(input);
  }

  public async setLegalHold(
    tenantId: string,
    manifestId: string,
    actorUserId: string,
    legalHold: boolean
  ): Promise<EvidenceManifest> {
    return this.archive.setLegalHold(tenantId, manifestId, actorUserId, legalHold);
  }
}

export default EvidenceManifestService;
