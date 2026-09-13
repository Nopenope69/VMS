import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { OTA_KEY_ID } from '../config/otaKeys';
import { OtaManifest } from '../services/appliance/otaUpdate.service';

/**
 * Offline Vendor OTA Packaging and Signing CLI Tool.
 * Assembles release payload files, computes SHA-256 hashes, builds canonical manifest,
 * and cryptographically signs with vendor Ed25519 OTA private key.
 *
 * NOTE: Strictly for offline build pipelines. OTA private keys MUST NEVER enter the appliance.
 */

export function buildAndSignOtaBundle(
  version: string,
  versionEpoch: number,
  payloadDir: string,
  privateKeyPem: string,
  outputDir: string
): { manifest: OtaManifest; signatureHex: string } {
  if (!fs.existsSync(payloadDir)) {
    throw new Error(`Payload directory does not exist: ${payloadDir}`);
  }

  const filesList: Array<{ path: string; sha256: string; sizeBytes: number }> = [];
  const entries = fs.readdirSync(payloadDir);

  for (const entry of entries) {
    const fullPath = path.join(payloadDir, entry);
    const stat = fs.statSync(fullPath);
    if (stat.isFile()) {
      const content = fs.readFileSync(fullPath);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      filesList.push({
        path: entry,
        sha256: hash,
        sizeBytes: stat.size,
      });
    }
  }

  const manifest: OtaManifest = {
    version,
    versionEpoch,
    releaseDate: new Date().toISOString(),
    keyId: OTA_KEY_ID,
    artifactPurpose: 'APPLIANCE_OTA_UPDATE',
    files: filesList,
  };

  // Canonicalize JSON
  const sortedKeys = Object.keys(manifest).sort();
  const pairs = sortedKeys.map((k) => `"${k}":${JSON.stringify((manifest as any)[k])}`);
  const canonical = `{${pairs.join(',')}}`;

  const signature = crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKeyPem);
  const signatureHex = signature.toString('hex');

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(path.join(outputDir, 'manifest.sig'), signatureHex, 'utf8');

  return { manifest, signatureHex };
}
