import archiver from 'archiver';
import fs from 'fs';
import path from 'path';
import { computeFileSha256, getOrCreateApplianceEd25519Keys } from '../../../utils/crypto';
import { canonicalizeJson } from './manifestBuilder';
import { buildC2paManifest, C2paManifestInput } from './c2paManifestBuilder';

export interface EvidenceArtifactRecord {
  path: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  role: 'PRIMARY_MEDIA' | 'CUSTODY_LEDGER' | 'STATUTORY_CERTIFICATE' | 'TRUST_ANCHOR_PUBLIC_KEY' | 'METADATA' | 'AI_PROVENANCE' | 'DERIVATION_RECORD' | 'EXPLANATIONS' | 'INCIDENT_SUMMARIES' | 'SEGMENT_SEALS' | 'C2PA_MANIFEST';
}

export interface AssemblePackageOptions {
  exportId: string;
  targetZipPath: string;
  videoFilePath?: string;
  manifestData: any;
  applianceSignature: string;
  certificatePdfPath?: string;
  custodyHistory?: any[];
  c2paInput?: C2paManifestInput;
  /** Further files bound into the manifest's artifacts table (P4.5: ai_provenance.json, derivation.json). */
  extraArtifacts?: Array<{ sourcePath: string; path: string; mediaType: string; role: EvidenceArtifactRecord['role'] }>;
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
      let videoSha256 = '';
      if (options.videoFilePath) {
        if (!fs.existsSync(options.videoFilePath)) {
          throw new Error(
            `Missing evidence media file: specified video file does not exist on disk (${options.videoFilePath})`
          );
        }
        const destVideoPath = path.join(workDir, 'video.mp4');
        fs.copyFileSync(options.videoFilePath, destVideoPath);
        const videoStat = fs.statSync(destVideoPath);
        videoSha256 = await computeFileSha256(destVideoPath);
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

      // 4b. Extra artifacts (AI provenance, derivation record)
      for (const x of options.extraArtifacts || []) {
        if (!fs.existsSync(x.sourcePath)) throw new Error(`Missing evidence artifact: ${x.sourcePath}`);
        const dest = path.join(workDir, x.path);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(x.sourcePath, dest);
        artifactEntries.push({ path: x.path, mediaType: x.mediaType, byteLength: fs.statSync(dest).size, sha256: await computeFileSha256(dest), role: x.role });
      }

      // 4c. Generate C2PA manifest (c2pa_manifest.json)
      if ((videoSha256 || options.videoFilePath || fs.existsSync(path.join(workDir, 'video.mp4'))) && options.manifestData) {
        const destVideoPath = path.join(workDir, 'video.mp4');
        const vSha = videoSha256 || (fs.existsSync(destVideoPath) ? await computeFileSha256(destVideoPath) : (options.manifestData.videoChecksumSha256 || ''));
        const tenantId = options.manifestData.tenantId || '';
        const applianceId = options.manifestData.applianceIdentifier || `VIGILONE-EDGE-${(tenantId || 'DEFAULT').substring(0, 8).toUpperCase()}`;
        const segmentCount = options.manifestData.leafCount ?? (options.manifestData.leaves ? options.manifestData.leaves.length : (options.manifestData.cameras ? options.manifestData.cameras.reduce((acc: number, c: any) => acc + (c.segmentCount || 0), 0) : (options.manifestData.segmentCount ?? 0)));

        const c2paInput: C2paManifestInput = {
          exportId: options.exportId,
          applianceIdentifier: applianceId,
          tenantId,
          startUtc: options.manifestData.timeRange?.startUtc || options.manifestData.timeWindow?.startUtc || options.manifestData.startUtc || new Date(),
          endUtc: options.manifestData.timeRange?.endUtc || options.manifestData.timeWindow?.endUtc || options.manifestData.endUtc || new Date(),
          videoSha256: vSha,
          evidenceMerkleRoot: options.manifestData.evidenceMerkleRoot || '',
          segmentCount,
          partAPartyName: options.manifestData.bsaCertificate?.partAPartyName || options.manifestData.bsaSection63Details?.partAParty?.name || options.manifestData.partAPartyName,
          partAPartyDesignation: options.manifestData.bsaCertificate?.partAPartyDesignation || options.manifestData.bsaSection63Details?.partAParty?.designation || options.manifestData.partAPartyDesignation,
          partBExpertName: options.manifestData.bsaCertificate?.partBExpertName || options.manifestData.bsaSection63Details?.partBExpert?.name || options.manifestData.partBExpertName,
          custodyChainHeadHash: options.manifestData.custodyChainHeadHash || options.manifestData.custodySummary?.headHash,
          aiProvenanceSummary: options.manifestData.aiProvenance,
          ...(options.c2paInput || {}),
        };
        if (!c2paInput.videoSha256) c2paInput.videoSha256 = vSha;
        if (!c2paInput.exportId) c2paInput.exportId = options.exportId;

        const { manifestJson } = buildC2paManifest(c2paInput);
        const c2paPath = path.join(workDir, 'c2pa_manifest.json');
        fs.writeFileSync(c2paPath, manifestJson, 'utf8');
        const c2paStat = fs.statSync(c2paPath);
        const c2paSha256 = await computeFileSha256(c2paPath);
        const c2paArtifact: EvidenceArtifactRecord = {
          path: 'c2pa_manifest.json',
          mediaType: 'application/json',
          byteLength: c2paStat.size,
          sha256: c2paSha256,
          role: 'C2PA_MANIFEST',
        };
        artifactEntries.push(c2paArtifact);
        if (options.manifestData?.artifacts && !options.manifestData.artifacts.some((a: any) => a.path === 'c2pa_manifest.json')) {
          options.manifestData.artifacts.push(c2paArtifact);
        }
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
