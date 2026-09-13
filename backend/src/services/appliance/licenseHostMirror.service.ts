import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { verifyLicenseArtifact, isLicenseActive } from '../../utils/license';

export interface LicenseMirrorPayload {
  signedPayload: string;
  signatureEd25519: string;
  mirroredAt?: string;
}

export class LicenseHostMirrorService {
  private static defaultPath: string = process.env.LICENSE_MIRROR_PATH || '/etc/vigilone/license.json';

  public static setDefaultPath(newPath: string) {
    this.defaultPath = newPath;
  }

  public static getDefaultPath(): string {
    return this.defaultPath;
  }

  /**
   * Persists the active commercial license artifact to the host filesystem with mode 0o600.
   */
  public static saveLicenseMirror(
    payload: { signedPayload: string; signatureEd25519: string },
    targetPath?: string
  ): void {
    const dest = targetPath || this.defaultPath;
    try {
      const dir = path.dirname(dest);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const mirrorData: LicenseMirrorPayload = {
        signedPayload: payload.signedPayload,
        signatureEd25519: payload.signatureEd25519,
        mirroredAt: new Date().toISOString(),
      };

      const tmpPath = `${dest}.tmp.${Date.now()}`;
      fs.writeFileSync(tmpPath, JSON.stringify(mirrorData, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
      fs.renameSync(tmpPath, dest);

      try {
        fs.chmodSync(dest, 0o600);
      } catch {
        // Non-fatal on filesystems lacking POSIX permissions
      }
    } catch (err: any) {
      console.warn(`[LicenseHostMirror] Failed to write license mirror to ${dest}:`, err.message);
    }
  }

  /**
   * Loads the mirrored license artifact from the host filesystem.
   */
  public static loadLicenseMirror(targetPath?: string): LicenseMirrorPayload | null {
    const src = targetPath || this.defaultPath;
    try {
      if (!fs.existsSync(src)) {
        return null;
      }
      const raw = fs.readFileSync(src, 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data.signedPayload === 'string' && typeof data.signatureEd25519 === 'string') {
        return data as LicenseMirrorPayload;
      }
    } catch (err: any) {
      console.warn(`[LicenseHostMirror] Failed to load license mirror from ${src}:`, err.message);
    }
    return null;
  }

  /**
   * Reconciles the database license table against the host mirror.
   * If the database has no licenses (e.g. after catastrophic database loss or factory rebuild),
   * auto-ingests the verified host mirror into the database.
   */
  public static async reconcileLicenseFromHost(
    prisma: PrismaClient,
    targetPath?: string
  ): Promise<{ restored: boolean; licenseId?: string; error?: string }> {
    try {
      const existingLicense = await prisma.license.findFirst();
      if (existingLicense) {
        return { restored: false };
      }

      const mirror = this.loadLicenseMirror(targetPath);
      if (!mirror) {
        return { restored: false };
      }

      // Verify cryptographic integrity of mirror artifact
      const verification = verifyLicenseArtifact(mirror.signedPayload, mirror.signatureEd25519);
      if (!verification.valid || !verification.claims) {
        return {
          restored: false,
          error: `License host mirror verification failed: ${verification.error}`,
        };
      }

      const claims = verification.claims;
      const activeCheck = isLicenseActive(claims);
      if (!activeCheck.active) {
        return {
          restored: false,
          error: `License host mirror is inactive: ${activeCheck.reason}`,
        };
      }

      // Ingest license into database
      const created = await prisma.license.create({
        data: {
          tenantId: claims.tenantId,
          licenseId: claims.licenseId,
          tier: claims.tier,
          maxCameras: claims.maxCameras,
          features: claims.features,
          expiresAt: claims.expiresAt ? new Date(claims.expiresAt) : null,
          signedPayload: mirror.signedPayload,
          signatureEd25519: mirror.signatureEd25519,
          installationId: claims.installationId,
          deviceBinding: claims.deviceBinding,
        },
      });

      console.info(
        `[LicenseHostMirror] Successfully auto-restored license ${claims.licenseId} (${claims.tier}) from host mirror.`
      );

      return { restored: true, licenseId: created.licenseId };
    } catch (err: any) {
      console.error(`[LicenseHostMirror] Failed to auto-restore license from host mirror:`, err.message);
      return { restored: false, error: err.message };
    }
  }
}

export default LicenseHostMirrorService;
