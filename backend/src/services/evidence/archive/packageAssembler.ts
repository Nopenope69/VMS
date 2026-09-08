import archiver from 'archiver';
import fs from 'fs';
import path from 'path';
import { computeFileSha256, getOrCreateApplianceEd25519Keys } from '../../../utils/crypto';
import { canonicalizeJson } from './manifestBuilder';

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
}

export class PackageAssembler {
  /**
   * Packages evidence assets into a structured evidence export package ZIP.
   * Terminology Notice: Structured evidence export package supporting Section 63 BSA submission.
   */
  public static async assemblePackage(
    options: AssemblePackageOptions
  ): Promise<AssembledPackageResult> {
    const workDir = path.join(path.dirname(options.targetZipPath), `staging_${options.exportId}`);
    fs.mkdirSync(workDir, { recursive: true });

    try {
      // 1. Write manifest.json
      const manifestJsonString = canonicalizeJson(options.manifestData);
      const manifestPath = path.join(workDir, 'manifest.json');
      fs.writeFileSync(manifestPath, manifestJsonString, 'utf8');

      // 2. Compute manifest.sha256
      const manifestSha256 = await computeFileSha256(manifestPath);
      fs.writeFileSync(path.join(workDir, 'manifest.sha256'), manifestSha256, 'utf8');

      // 3. Write manifest.sig (Appliance Ed25519 signature)
      fs.writeFileSync(path.join(workDir, 'manifest.sig'), options.applianceSignature, 'utf8');

      // 4. Write appliance public key for offline independent verification
      const { publicKeyPem } = getOrCreateApplianceEd25519Keys();
      fs.writeFileSync(path.join(workDir, 'appliance_public_key.pem'), publicKeyPem, 'utf8');

      // 5. Copy video file if present, or write placeholder
      const destVideoPath = path.join(workDir, 'video.mp4');
      if (options.videoFilePath && fs.existsSync(options.videoFilePath)) {
        fs.copyFileSync(options.videoFilePath, destVideoPath);
      } else {
        fs.writeFileSync(destVideoPath, Buffer.from('VIGILONE_STRUCTURED_EVIDENCE_MEDIA_PAYLOAD'));
      }

      // 6. Copy or include Section 63 BSA certificate PDF
      const bsaDir = path.join(workDir, 'bsa-section-63');
      fs.mkdirSync(bsaDir, { recursive: true });
      if (options.certificatePdfPath && fs.existsSync(options.certificatePdfPath)) {
        fs.copyFileSync(options.certificatePdfPath, path.join(bsaDir, 'certificate_sec63.pdf'));
      }

      // 7. Write chain_of_custody.json if present
      if (options.custodyHistory && options.custodyHistory.length > 0) {
        fs.writeFileSync(
          path.join(workDir, 'chain_of_custody.json'),
          JSON.stringify(options.custodyHistory, null, 2),
          'utf8'
        );
      }

      // 8. Package all staged files into ZIP archive
      await this.createZip(workDir, options.targetZipPath);

      const stats = fs.statSync(options.targetZipPath);
      const packageSha256 = await computeFileSha256(options.targetZipPath);

      return {
        zipPath: options.targetZipPath,
        fileSizeBytes: BigInt(stats.size),
        packageSha256,
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
