import fs from 'fs';
import PDFDocument from 'pdfkit';
import { SigningMode } from '@prisma/client';

export interface BsaCertificateCameraInfo {
  cameraId: string;
  name?: string;
  model?: string;
  serialNumber?: string;
  segmentCount: number;
  segmentHashes?: string[];
}

export interface BsaCertificateOptions {
  evidenceId: string;
  tenantId: string;
  applianceIdentifier: string;
  applianceSignature?: string | null;
  evidenceMerkleRoot: string;
  startUtc: Date;
  endUtc: Date;
  cameras: BsaCertificateCameraInfo[];
  partAPartyName?: string;
  partAPartyDesignation?: string;
  partBExpertName?: string;
  partBExpertDesignation?: string;
  partBExpertOrganization?: string;
  signingMode?: SigningMode | string;
}

export interface Section63BsaCertificateRecord {
  complianceFramework: 'BHARATIYA_SAKSHYA_ADHINIYAM_2023_SEC_63';
  disclaimer: string;
  systemProvenanceNotice: string;
  applianceIdentifier: string;
  applianceSignature?: string;
  producedAtUtc: string;
  timeRange: {
    startUtc: string;
    endUtc: string;
  };
  hashAlgorithm: string;
  evidenceMerkleRoot: string;
  masterEvidenceHash: string; // Compatibility alias
  cameras: Array<{
    cameraId: string;
    name?: string;
    segmentCount: number;
    segmentHashes: string[];
  }>;
  signatoryMetadata?: {
    partAPartyName?: string;
    partAPartyDesignation?: string;
    partBExpertName?: string;
    partBExpertDesignation?: string;
    partBExpertOrganization?: string;
    signingMode: SigningMode | string;
  };
}

export class BsaCertificatePackageBuilder {
  public static readonly STATUTORY_DISCLAIMER =
    'This certificate package provides technical provenance, cryptographic Merkle tree references, and integrity verification data designed to support evidentiary submission under Section 63 of the Bharatiya Sakshya Adhiniyam, 2023. Software-generated cryptographic keys and appliance hashes certify machine-level non-tampering only and STRICTLY DO NOT substitute for statutory human certifications by the lawful custodian or qualified forensic expert. This system does not warrant or guarantee statutory or judicial admissibility.';

  public static readonly PROVENANCE_NOTICE =
    'The appliance Ed25519 digital signature certifies the technical provenance, chronological continuity, and immutable media hashes of this export. Statutory Schedule Part A and Part B declarations require independent human execution by authorized personnel.';

  /**
   * Builds the structured Section 63 BSA JSON record for manifest storage.
   */
  public static buildCertificateData(options: BsaCertificateOptions): Section63BsaCertificateRecord {
    return {
      complianceFramework: 'BHARATIYA_SAKSHYA_ADHINIYAM_2023_SEC_63',
      disclaimer: this.STATUTORY_DISCLAIMER,
      systemProvenanceNotice: this.PROVENANCE_NOTICE,
      applianceIdentifier: options.applianceIdentifier,
      applianceSignature: options.applianceSignature || undefined,
      producedAtUtc: new Date().toISOString(),
      timeRange: {
        startUtc: options.startUtc.toISOString(),
        endUtc: options.endUtc.toISOString(),
      },
      hashAlgorithm: 'SHA-256',
      evidenceMerkleRoot: options.evidenceMerkleRoot,
      masterEvidenceHash: options.evidenceMerkleRoot, // backward compatibility
      cameras: options.cameras.map((c) => ({
        cameraId: c.cameraId,
        name: c.name,
        segmentCount: c.segmentCount,
        segmentHashes: c.segmentHashes || [],
      })),
      signatoryMetadata: {
        partAPartyName: options.partAPartyName,
        partAPartyDesignation: options.partAPartyDesignation,
        partBExpertName: options.partBExpertName,
        partBExpertDesignation: options.partBExpertDesignation,
        partBExpertOrganization: options.partBExpertOrganization,
        signingMode: options.signingMode || SigningMode.IN_APP_DESIGNATED,
      },
    };
  }

  /**
   * Generates a pre-populated PDF certificate containing Part A (Party in-charge)
   * and Part B (Technical Expert) with appliance provenance details.
   */
  public static generatePdf(outputPath: string, options: BsaCertificateOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 45, size: 'A4' });
      const stream = fs.createWriteStream(outputPath);

      doc.pipe(stream);

      // Header Banner
      doc.fontSize(16).font('Helvetica-Bold').text('CERTIFICATE UNDER SECTION 63', { align: 'center' });
      doc.fontSize(12).font('Helvetica').text('Bharatiya Sakshya Adhiniyam, 2023 (BSA)', { align: 'center' });
      doc.fontSize(9).font('Helvetica-Oblique').text('Technical Provenance & Statutory Declarations', { align: 'center' });
      doc.moveDown(1);

      // System Machine Provenance Section
      doc.fontSize(11).font('Helvetica-Bold').text('1. APPLIANCE TECHNICAL PROVENANCE & INTEGRITY', { underline: true });
      doc.fontSize(8).font('Helvetica-Oblique').text('(Automated System Attestation - Certifies Cryptographic Integrity Only)', { indent: 10 });
      doc.moveDown(0.5);

      const provItems: [string, string][] = [
        ['Evidence Archive ID', options.evidenceId],
        ['Appliance Identifier', options.applianceIdentifier],
        ['Evidence Merkle Root', options.evidenceMerkleRoot],
        ['Start UTC', options.startUtc.toISOString()],
        ['End UTC', options.endUtc.toISOString()],
        ['Appliance Ed25519 Provenance Signature', options.applianceSignature ? `${options.applianceSignature.substring(0, 48)}...` : 'PENDING_FINALIZATION'],
      ];

      for (const [k, v] of provItems) {
        doc.font('Helvetica-Bold').fontSize(9).text(`${k}: `, { continued: true, indent: 10 });
        doc.font('Helvetica').fontSize(9).text(v);
      }

      doc.moveDown(0.5);
      doc.fontSize(8).font('Helvetica-Oblique').text(this.PROVENANCE_NOTICE, { indent: 10 });
      doc.moveDown(1);

      // Schedule Part A: Party In-Charge
      doc.fontSize(11).font('Helvetica-Bold').text('2. SCHEDULE - PART A (Party In-Charge of Device/System)', { underline: true });
      doc.fontSize(8).font('Helvetica-Oblique').text('(To be completed by the Lawful Custodian / Party operating the computer system)', { indent: 10 });
      doc.moveDown(0.5);

      const partAName = options.partAPartyName || '_________________________________';
      const partADesig = options.partAPartyDesignation || '_________________________________';

      doc.fontSize(9).font('Helvetica').text(
        `I, ${partAName}, holding the designation of ${partADesig}, hereby certify that the electronic records and video streams captured from the surveillance cameras detailed herein were recorded by computer systems and cameras under my lawful control and management in the ordinary course of operations. To my knowledge, the devices operated normally without security compromise.`,
        { indent: 10, align: 'justify' }
      );

      doc.moveDown(1.5);
      doc.text('Signature: _________________________________', { align: 'right' });
      doc.text(`Name: ${options.partAPartyName || '_________________________________'}`, { align: 'right' });
      doc.text('Date & Official Seal: ______________________', { align: 'right' });

      doc.moveDown(1);

      // Schedule Part B: Technical Expert
      doc.fontSize(11).font('Helvetica-Bold').text('3. SCHEDULE - PART B (Technical / Forensic Expert)', { underline: true });
      doc.fontSize(8).font('Helvetica-Oblique').text('(To be completed by Technical Expert or Forensic Custodian)', { indent: 10 });
      doc.moveDown(0.5);

      const partBName = options.partBExpertName || '_________________________________';
      const partBDesig = options.partBExpertDesignation || '_________________________________';
      const partBOrg = options.partBExpertOrganization || '_________________________________';

      doc.fontSize(9).font('Helvetica').text(
        `I, ${partBName}, holding designation ${partBDesig}, associated with ${partBOrg}, having examined the electronic surveillance recording system and verified the SHA-256 Merkle root (${options.evidenceMerkleRoot.substring(0, 24)}...), hereby certify the technical authenticity and unbroken cryptographic lineage of the media.`,
        { indent: 10, align: 'justify' }
      );

      doc.moveDown(1.5);
      doc.text('Expert Signature: __________________________', { align: 'right' });
      doc.text(`Expert Name: ${options.partBExpertName || '_________________________________'}`, { align: 'right' });
      doc.text('Date & Lab/Agency Seal: ____________________', { align: 'right' });

      // Statutory Disclaimer footer
      doc.moveDown(1.5);
      doc.fontSize(7).font('Helvetica-Oblique').text(this.STATUTORY_DISCLAIMER, { align: 'center' });

      doc.end();
      stream.on('finish', resolve);
      stream.on('error', reject);
    });
  }
}
