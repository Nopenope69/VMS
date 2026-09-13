import archiver from 'archiver';
import fs from 'fs';
import path from 'path';
import { computeFileSha256, getOrCreateApplianceEd25519Keys } from '../../../utils/crypto';
import { canonicalizeJson } from './manifestBuilder';

export interface EvidenceArtifactRecord {
  path: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  role: 'PRIMARY_MEDIA' | 'CUSTODY_LEDGER' | 'STATUTORY_CERTIFICATE' | 'TRUST_ANCHOR_PUBLIC_KEY' | 'METADATA';
}

export interface AssemblePackageOptions {
  exportId: string;
  targetZipPath: string;
  videoFilePath?: string;
  manifestData: any;
  applianceSignature: string;
  certificatePdfPath?: string;
  custodyHistory?: any[];
}

export interface AssembledPackageResult {
  zipPath: string;
  fileSizeBytes: bigint;
  packageSha256: string;
  artifacts: EvidenceArtifactRecord[];
  manifestSignature: string;
}

export class PackageAssembler {
  /**
   * Packages evidence assets into a structured evidence export package ZIP.
   * Cryptographically binds all material artifacts (media, custody, certificate, public key)
   * into the signed manifest.
   */
  public static async assemblePackage(
    options: AssemblePackageOptions
  ): Promise<AssembledPackageResult> {
    const workDir = path.join(path.dirname(options.targetZipPath), `staging_${options.exportId}`);
    fs.mkdirSync(workDir, { recursive: true });

    try {
      const artifactEntries: EvidenceArtifactRecord[] = [];

      // 1. Stage and hash appliance public key
      const { publicKeyPem } = getOrCreateApplianceEd25519Keys();
      const pubKeyPath = path.join(workDir, 'appliance_public_key.pem');
      fs.writeFileSync(pubKeyPath, publicKeyPem, 'utf8');
      const pubKeyStat = fs.statSync(pubKeyPath);
      const pubKeySha256 = await computeFileSha256(pubKeyPath);
      artifactEntries.push({
        path: 'appliance_public_key.pem',
        mediaType: 'application/x-pem-file',
        byteLength: pubKeyStat.size,
        sha256: pubKeySha256,
        role: 'TRUST_ANCHOR_PUBLIC_KEY',
      });

      // 2. Stage and hash video file if provided (fail closed if missing - C-012)
      if (options.videoFilePath) {
        if (!fs.existsSync(options.videoFilePath)) {
          throw new Error(
            `Missing evidence media file: specified video file does not exist on disk (${options.videoFilePath})`
          );
        }
        const destVideoPath = path.join(workDir, 'video.mp4');
        fs.copyFileSync(options.videoFilePath, destVideoPath);
        const videoStat = fs.statSync(destVideoPath);
        const videoSha256 = await computeFileSha256(destVideoPath);
        artifactEntries.push({
          path: 'video.mp4',
          mediaType: 'video/mp4',
          byteLength: videoStat.size,
          sha256: videoSha256,
          role: 'PRIMARY_MEDIA',
        });
      }

      // 3. Stage and hash Section 63 BSA certificate PDF
      if (options.certificatePdfPath && fs.existsSync(options.certificatePdfPath)) {
        const bsaDir = path.join(workDir, 'bsa-section-63');
        fs.mkdirSync(bsaDir, { recursive: true });
        const destPdfPath = path.join(bsaDir, 'certificate_sec63.pdf');
        fs.copyFileSync(options.certificatePdfPath, destPdfPath);
        const pdfStat = fs.statSync(destPdfPath);
        const pdfSha256 = await computeFileSha256(destPdfPath);
        artifactEntries.push({
          path: 'bsa-section-63/certificate_sec63.pdf',
          mediaType: 'application/pdf',
          byteLength: pdfStat.size,
          sha256: pdfSha256,
          role: 'STATUTORY_CERTIFICATE',
        });
      }

      // 4. Stage and hash chain_of_custody.json if present
      if (options.custodyHistory && options.custodyHistory.length > 0) {
        const custodyPath = path.join(workDir, 'chain_of_custody.json');
        fs.writeFileSync(
          custodyPath,
          JSON.stringify(options.custodyHistory, null, 2),
          'utf8'
        );
        const custodyStat = fs.statSync(custodyPath);
        const custodySha256 = await computeFileSha256(custodyPath);
        artifactEntries.push({
          path: 'chain_of_custody.json',
          mediaType: 'application/json',
          byteLength: custodyStat.size,
          sha256: custodySha256,
          role: 'CUSTODY_LEDGER',
        });
      }

      // 5. Build canonical manifest incorporating the complete artifacts table
      const manifestToSave: any = {
        ...options.manifestData,
        artifacts: options.manifestData?.artifacts || artifactEntries,
      };
      const manifestJsonString = canonicalizeJson(manifestToSave);
      const manifestPath = path.join(workDir, 'manifest.json');
      fs.writeFileSync(manifestPath, manifestJsonString, 'utf8');

      // 6. Compute manifest.sha256
      const manifestSha256 = await computeFileSha256(manifestPath);
      fs.writeFileSync(path.join(workDir, 'manifest.sha256'), manifestSha256, 'utf8');

      // 7. Write manifest.sig
      // If caller pre-computed signature with artifacts present, preserve it; otherwise sign the final manifest
      const finalSignature =
        options.manifestData?.artifacts && options.applianceSignature
          ? options.applianceSignature
          : (await import('../../../utils/crypto')).signEvidenceManifest(manifestJsonString);
      fs.writeFileSync(path.join(workDir, 'manifest.sig'), finalSignature, 'utf8');

      // 8. Package all staged files into ZIP archive
      await this.createZip(workDir, options.targetZipPath);

      const stats = fs.statSync(options.targetZipPath);
      const packageSha256 = await computeFileSha256(options.targetZipPath);

      return {
        zipPath: options.targetZipPath,
        fileSizeBytes: BigInt(stats.size),
        packageSha256,
        artifacts: artifactEntries,
        manifestSignature: finalSignature,
      };
    } finally {
      // Clean up temporary staging folder
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {}
    }
  }

  private static createZip(sourceDir: string, zipFilePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipFilePath);
      const archive = archiver('zip', { zlib: { level: 6 } });

      output.on('close', resolve);
      archive.on('error', reject);

      archive.pipe(output);
      archive.directory(sourceDir, false);
      archive.finalize();
    });
  }
}
