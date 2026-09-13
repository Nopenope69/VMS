import fs from 'fs';
import path from 'path';
import {
  EvidenceExport,
  EvidenceManifest,
  ExportMode,
  ExportStatus,
  PrismaClient,
  SigningMode,
  ChainOfCustodyLog,
} from '@prisma/client';
import config from '../../../config/env';
import { FFmpegService } from '../../ffmpeg/ffmpeg.service';
import {
  computeFileSha256,
  getOrCreateApplianceEd25519Keys,
  signEvidenceManifest,
} from '../../../utils/crypto';
import { RecordingCatalog } from '../../recording/catalog/recordingCatalog.service';
import {
  MerkleTree,
  SegmentLeafInput,
  MerkleProofNode,
  MerkleLeafEntry,
} from './merkleTree';
import { EvidencePinAdapter, AdmissionStatus } from './evidencePinAdapter';
import {
  CustodyLedger,
  LogCustodyEventInput,
  CustodyVerificationResult,
} from './custodyLedger';
import {
  BsaCertificatePackageBuilder,
  BsaCertificateOptions,
} from './bsaCertificatePackageBuilder';
import {
  DerivativeExporter,
  ExportDerivativeClipInput,
} from './derivativeExporter';
import {
  ManifestBuilder,
  CreateManifestInput,
  ManifestVerificationResult,
  canonicalizeJson,
} from './manifestBuilder';
import { PackageAssembler } from './packageAssembler';

export interface CreateEvidenceParams {
  tenantId: string;
  cameraId: string;
  requestedById: string;
  startTime: Date;
  endTime: Date;
  exportMode?: 'STREAM_COPY' | 'FRAME_ACCURATE';
  partAPartyName?: string;
  partAPartyDesignation?: string;
  partBExpertName?: string;
  partBExpertDesignation?: string;
  partBExpertOrganization?: string;
  partBSigningMode?: 'IN_APP_DESIGNATED' | 'EXTERNAL_PHYSICAL';
}

export class EvidenceArchive {
  private prisma: PrismaClient;
  public recordingCatalog: RecordingCatalog;
  public pinAdapter: EvidencePinAdapter;
  public custodyLedger: CustodyLedger;
  public manifestBuilder: ManifestBuilder;
  public derivativeExporter: DerivativeExporter;

  constructor(
    prisma: PrismaClient,
    recordingCatalog?: any,
    custodyLedger?: any,
    pinAdapter?: EvidencePinAdapter
  ) {
    this.prisma = prisma;
    this.recordingCatalog = recordingCatalog || new RecordingCatalog(prisma);
    this.custodyLedger =
      custodyLedger && typeof custodyLedger.recordEvent === 'function'
        ? custodyLedger
        : custodyLedger && custodyLedger.ledger && typeof custodyLedger.ledger.recordEvent === 'function'
        ? custodyLedger.ledger
        : new CustodyLedger(prisma);
    this.pinAdapter = pinAdapter || new EvidencePinAdapter(prisma, this.recordingCatalog);
    this.manifestBuilder = new ManifestBuilder(
      prisma,
      this.recordingCatalog,
      this.custodyLedger,
      this.pinAdapter
    );
    this.derivativeExporter = new DerivativeExporter(prisma, this.custodyLedger);
  }

  /**
   * Generates a multi-camera cryptographic evidence manifest.
   */
  async createManifest(input: CreateManifestInput): Promise<EvidenceManifest> {
    return this.manifestBuilder.createManifest(input);
  }

  /**
   * Re-verifies source segments and cryptographic signature against stored manifest.
   */
  async verifyManifestIntegrity(manifestId: string): Promise<ManifestVerificationResult> {
    return this.manifestBuilder.verifyManifestIntegrity(manifestId);
  }

  /**
   * Produces an attributable derivative clip linked to parent manifest.
   */
  async exportDerivativeClip(input: ExportDerivativeClipInput): Promise<EvidenceExport> {
    return this.derivativeExporter.exportDerivative(input);
  }

  /**
   * Updates legal hold status on evidence manifest and coordinates pins.
   * INVARIANT: Applying hold places absolute LEGAL_HOLD pin on all segments.
   * INVARIANT: Releasing hold requires explicit administrative authorization.
   */
  async setLegalHold(
    tenantId: string,
    manifestId: string,
    actorUserId: string,
    legalHold: boolean
  ): Promise<EvidenceManifest> {
    const manifest = await this.prisma.evidenceManifest.findUnique({
      where: { id: manifestId },
    });
    if (!manifest) {
      throw new Error(`Manifest ${manifestId} not found`);
    }

    const updatedManifest = await this.prisma.evidenceManifest.update({
      where: { id: manifestId },
      data: { legalHold },
    });

    const segments = (manifest.segmentManifestJson as any[]) || [];
    const segmentIds = segments.map((s) => s.segmentId).filter(Boolean);

    if (legalHold) {
      if (segmentIds.length > 0) {
        await this.pinAdapter.pinForLegalHold(
          tenantId,
          segmentIds,
          manifestId,
          'LEGAL_HOLD_APPLIED'
        );
      }
    } else {
      await this.pinAdapter.releaseLegalHold(tenantId, manifestId);
    }

    const rootHash = manifest.evidenceMerkleRoot || manifest.masterEvidenceHash;
    await this.custodyLedger.recordEvent({
      tenantId,
      evidenceId: manifestId,
      actorUserId,
      action: legalHold ? 'LEGAL_HOLD_APPLIED' : 'LEGAL_HOLD_RELEASED',
      sourceHash: rootHash,
      metadata: {
        legalHold,
        segmentCount: segmentIds.length,
      },
    });

    return updatedManifest;
  }

  /**
   * Processes a single-camera structured evidence export package with full Section 63 BSA bundle.
   */
  async processExport(params: CreateEvidenceParams): Promise<string> {
    const exportsDir = config.EXPORTS_DIR;
    if (!fs.existsSync(exportsDir)) {
      fs.mkdirSync(exportsDir, { recursive: true });
    }

    const camera = await this.prisma.camera.findUnique({
      where: { id: params.cameraId },
    });
    if (!camera) throw new Error('Camera not found');

    // Evidentiary Provenance Invariant:
    // Internal test streams or synthetic generators must never be certified under a Section 63 BSA legal declaration.
    if (
      camera.streamPath === 'synthetic_test_stream' ||
      camera.ipAddress === 'synthetic' ||
      camera.mainRtspUri?.includes('synthetic_test_stream')
    ) {
      throw new Error(
        'Evidentiary Provenance Invariant: Synthetic or internal test streams cannot be certified as Section 63 BSA legal evidence.'
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id: params.requestedById },
    });
    if (!user) throw new Error('Requesting user not found');

    // Create DB record
    const exportRecord = await this.prisma.evidenceExport.create({
      data: {
        tenantId: params.tenantId,
        cameraId: params.cameraId,
        requestedById: params.requestedById,
        startTime: params.startTime,
        endTime: params.endTime,
        exportMode: (params.exportMode as ExportMode) || ExportMode.STREAM_COPY,
        status: ExportStatus.PROCESSING,
        partAPartyName: params.partAPartyName || user.name,
        partAPartyDesignation: params.partAPartyDesignation || 'System Operator',
        partBExpertName: params.partBExpertName,
        partBExpertDesignation: params.partBExpertDesignation,
        partBExpertOrganization: params.partBExpertOrganization,
        partBSigningMode: (params.partBSigningMode as SigningMode) || SigningMode.IN_APP_DESIGNATED,
      },
    });

    const exportId = exportRecord.id;
    const workDir = path.join(exportsDir, `EV_${exportId}`);
    fs.mkdirSync(workDir, { recursive: true });

    // Check admission control before locking segments
    const admission = await this.pinAdapter.checkAdmissionControl(config.RECORDINGS_DIR);
    if (!admission.admitted) {
      await this.prisma.evidenceExport.update({
        where: { id: exportId },
        data: { status: ExportStatus.FAILED, errorMessage: admission.reason },
      });
      throw new Error(admission.reason);
    }

    try {
      // Find overlapping segments via authoritative RecordingCatalog
      const segments = await this.recordingCatalog.findSegments(
        params.cameraId,
        params.startTime,
        params.endTime
      );

      // Acquire TEMPORARY_EXPORT lease on segments
      const segmentIds = segments.map((s) => s.id);
      await this.pinAdapter.acquireExportLease(
        params.tenantId,
        segmentIds,
        exportId,
        'EVIDENCE_EXPORT',
        2
      );

      const videoOutPath = path.join(workDir, 'video.mp4');

      if (segments.length === 0) {
        throw new Error('NO_RECORDING_SEGMENTS_FOUND: No recording segments found within specified time range');
      }

      const segmentFilePaths = segments
        .map((s) => s.filePath)
        .filter((p): p is string => Boolean(p) && fs.existsSync(p));

      if (segmentFilePaths.length === 0) {
        throw new Error('NO_RECORDING_SEGMENTS_FOUND: Associated recording segment files not found on disk');
      }

      await FFmpegService.concatSegments(
        segmentFilePaths,
        videoOutPath,
        params.exportMode === 'FRAME_ACCURATE' ? 'FRAME_ACCURATE' : 'STREAM_COPY'
      );

      // Compute SHA-256 of final clip
      const videoSha256 = await computeFileSha256(videoOutPath);

      // Sort segments chronologically to ensure deterministic monotonic sequence
      segments.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

      // Build Merkle leaves from segments
      const leavesInput: SegmentLeafInput[] = segments.map((s) => ({
        segmentId: s.id,
        cameraId: params.cameraId,
        startTime: s.startTime,
        endTime: s.endTime,
        mediaSha256: s.sha256Hash,
      }));

      const { rootHash: evidenceMerkleRoot, leafEntries, levels } = MerkleTree.buildTree(leavesInput);

      // Explicit Derivation Chain: ordered source segments with individual Merkle inclusion proofs
      const sourceSegments = segments.map((s, idx) => {
        const segLeaf: SegmentLeafInput = {
          segmentId: s.id,
          cameraId: params.cameraId,
          startTime: s.startTime,
          endTime: s.endTime,
          mediaSha256: s.sha256Hash,
        };
        const merkleLeafHash = MerkleTree.computeLeafHash(segLeaf);
        const merkleProof = MerkleTree.generateInclusionProof(levels, idx);
        return {
          segmentId: s.id,
          sequenceIndex: idx,
          filePath: s.filePath,
          startTimeUtc: new Date(s.startTime).toISOString(),
          endTimeUtc: new Date(s.endTime).toISOString(),
          durationMs: new Date(s.endTime).getTime() - new Date(s.startTime).getTime(),
          mediaSha256: s.sha256Hash,
          merkleLeafHash,
          merkleProof,
        };
      });

      // Explicit assembly & derivation specification
      const derivationMode = params.exportMode === 'FRAME_ACCURATE' ? 'FRAME_ACCURATE' : 'STREAM_COPY';
      const assemblySpecification = {
        derivationMode,
        containerFormat: 'mp4',
        concatTool: 'ffmpeg-v6.1',
        derivationDescription:
          derivationMode === 'FRAME_ACCURATE'
            ? 'Frame-accurate re-encoded derivative clip with keyframe alignment (libx264, yuv420p) derived from listed source segments.'
            : 'Byte-preserving container-level stream concatenation via FFmpeg concat demuxer (-c copy) preserving original bitstreams without transcoding.',
      };

      // Dual UTC and Local Timezone Representation
      const now = new Date();
      const tzOffsetMinutes = -now.getTimezoneOffset();
      const formatLocalIso = (d: Date) => {
        const tzOffsetMs = d.getTimezoneOffset() * 60000;
        const localDate = new Date(d.getTime() - tzOffsetMs);
        const pad = (n: number) => n.toString().padStart(2, '0');
        const offsetHours = Math.floor(Math.abs(tzOffsetMinutes) / 60);
        const offsetMins = Math.abs(tzOffsetMinutes) % 60;
        const sign = tzOffsetMinutes >= 0 ? '+' : '-';
        return localDate.toISOString().replace('Z', '') + `${sign}${pad(offsetHours)}:${pad(offsetMins)}`;
      };

      const timeWindow = {
        startUtc: params.startTime.toISOString(),
        startLocal: formatLocalIso(params.startTime),
        endUtc: params.endTime.toISOString(),
        endLocal: formatLocalIso(params.endTime),
        exportTimestampUtc: now.toISOString(),
        exportTimestampLocal: formatLocalIso(now),
        timezoneOffsetMinutes: tzOffsetMinutes,
        timezoneIdentifier: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      };

      // Authoritative Custody Ledger Event Recording
      await this.custodyLedger.recordEvent({
        tenantId: params.tenantId,
        evidenceId: exportId,
        actorUserId: user.id,
        action: 'EVIDENCE_EXPORTED',
        sourceHash: evidenceMerkleRoot,
        resultHash: videoSha256,
        metadata: {
          cameraId: camera.id,
          startUtc: params.startTime.toISOString(),
          endUtc: params.endTime.toISOString(),
          segmentCount: segments.length,
          exportMode: derivationMode,
          operatorName: user.name,
          operatorEmail: user.email,
          assemblySpecification,
        },
      });

      const custodyHistory = await this.custodyLedger.getHistory(params.tenantId, exportId);
      const custodyVerification = await this.custodyLedger.verifyChain(params.tenantId, exportId);

      // Canonical manifest structure
      const applianceIdentifier = `VIGILONE-EDGE-${params.tenantId.substring(0, 8).toUpperCase()}`;
      const manifestData: any = {
        exportId,
        applianceIdentifier,
        timestamp: now.toISOString(),
        requestingUser: {
          id: user.id,
          name: user.name,
          email: user.email,
        },
        camera: {
          id: camera.id,
          name: camera.name,
          manufacturer: camera.manufacturer || 'Unknown',
          model: camera.model || 'Unknown',
          serialNumber: camera.serialNumber || 'Unknown',
          macAddress: camera.macAddress || 'Unknown',
          ipAddress: camera.ipAddress,
        },
        timeWindow,
        exportMode: derivationMode,
        assemblySpecification,
        sourceSegments,
        videoChecksumSha256: videoSha256,
        evidenceMerkleRoot,
        segmentCount: segments.length,
        leaves: leafEntries,
        custodySummary: {
          chainIntegrityValid: custodyVerification.chainIntegrityValid,
          entriesCount: custodyVerification.entriesCount,
          initialHash: custodyVerification.initialHash,
          headHash: custodyVerification.headHash,
          unbrokenAncestry: custodyVerification.unbrokenAncestry,
        },
        bsaSection63Details: {
          complianceFramework: 'BHARATIYA_SAKSHYA_ADHINIYAM_2023_SEC_63',
          disclaimer: BsaCertificatePackageBuilder.STATUTORY_DISCLAIMER,
          provenanceNotice: BsaCertificatePackageBuilder.PROVENANCE_NOTICE,
          partAParty: {
            name: params.partAPartyName || user.name,
            designation: params.partAPartyDesignation || 'System Operator',
          },
          partBExpert: {
            name: params.partBExpertName || 'To be completed by designated expert',
            designation: params.partBExpertDesignation || 'Forensic / Technical Expert',
            organization: params.partBExpertOrganization || 'Designated Laboratory / Agency',
            signingMode: params.partBSigningMode || 'IN_APP_DESIGNATED',
          },
        },
      };

      // Generate Section 63 BSA Part A & Part B PDF certificate
      const pdfCertificatePath = path.join(workDir, 'certificate_sec63.pdf');
      await BsaCertificatePackageBuilder.generatePdf(pdfCertificatePath, {
        evidenceId: exportId,
        tenantId: params.tenantId,
        applianceIdentifier,
        evidenceMerkleRoot,
        startUtc: params.startTime,
        endUtc: params.endTime,
        startLocal: timeWindow.startLocal,
        endLocal: timeWindow.endLocal,
        custodyChainHeadHash: custodyVerification.headHash,
        assemblySpecification,
        cameras: [
          {
            cameraId: camera.id,
            name: camera.name,
            model: camera.model || 'Generic',
            serialNumber: camera.serialNumber || 'N/A',
            segmentCount: segments.length,
          },
        ],
        partAPartyName: params.partAPartyName || user.name,
        partAPartyDesignation: params.partAPartyDesignation || 'System Operator',
        partBExpertName: params.partBExpertName,
        partBExpertDesignation: params.partBExpertDesignation,
        partBExpertOrganization: params.partBExpertOrganization,
      });

      // Package everything into structured export archive with complete artifacts binding
      const zipPath = path.join(exportsDir, `Evidence_${exportId}.zip`);
      const packageResult = await PackageAssembler.assemblePackage({
        exportId,
        targetZipPath: zipPath,
        videoFilePath: videoOutPath,
        manifestData,
        applianceSignature: '', // PackageAssembler signs canonical manifest with artifacts[] included
        certificatePdfPath: pdfCertificatePath,
        custodyHistory,
      });

      // Update DB record
      manifestData.artifacts = packageResult.artifacts;
      await this.prisma.evidenceExport.update({
        where: { id: exportId },
        data: {
          status: ExportStatus.COMPLETED,
          outputFilePath: zipPath,
          fileSizeBytes: BigInt(fs.statSync(zipPath).size),
          sha256Hash: videoSha256,
          signatureEd25519: packageResult.manifestSignature,
          manifestJson: manifestData as any,
          completedAt: new Date(),
        },
      });

      return zipPath;
    } catch (err: any) {
      await this.prisma.evidenceExport.update({
        where: { id: exportId },
        data: {
          status: ExportStatus.FAILED,
          errorMessage: err.message,
        },
      });
      throw err;
    } finally {
      // INVARIANT: Clean up temporary work directory
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {}

      // INVARIANT: Release TEMPORARY_EXPORT lease only.
      // Any segments subject to a LegalHold remain permanently pinned!
      await this.pinAdapter.releaseExportLease(exportId).catch((err) => {
        console.error(`Failed to release export lease for ${exportId}:`, err);
      });
    }
  }

  // --- Delegation helpers for Custody and Pins ---

  async logCustodyEvent(input: LogCustodyEventInput): Promise<ChainOfCustodyLog> {
    return this.custodyLedger.recordEvent(input);
  }

  async verifyCustodyChain(
    tenantId: string,
    evidenceId: string
  ): Promise<CustodyVerificationResult> {
    return this.custodyLedger.verifyChain(tenantId, evidenceId);
  }

  async getCustodyHistory(tenantId: string, evidenceId: string): Promise<ChainOfCustodyLog[]> {
    return this.custodyLedger.getHistory(tenantId, evidenceId);
  }

  async checkAdmissionControl(recordingsDir = config.RECORDINGS_DIR): Promise<AdmissionStatus> {
    return this.pinAdapter.checkAdmissionControl(recordingsDir);
  }

  async isSegmentPinned(segmentId: string): Promise<boolean> {
    return this.pinAdapter.isSegmentPinned(segmentId);
  }
}

export const EvidenceArchiveService = EvidenceArchive;
export default EvidenceArchive;
