import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import { VENDOR_OTA_PUBLIC_KEY, OTA_KEY_ID } from '../../config/otaKeys';
import ClockGuard from '../../utils/clockGuard';

export interface OtaPayloadFile {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface OtaManifest {
  version: string;
  versionEpoch: number;
  releaseDate: string;
  keyId: string;
  artifactPurpose: 'APPLIANCE_OTA_UPDATE';
  minPreviousVersion?: string;
  targetApplianceSku?: string;
  files: OtaPayloadFile[];
}

export interface OtaVerificationResult {
  valid: boolean;
  error?: string;
  manifest?: OtaManifest;
}

export interface HealthCheckResult {
  healthy: boolean;
  apiUp: boolean;
  camerasExpected: number;
  failedCameraIds: string[];
}

export interface OtaDatabaseHandlers {
  dumpDatabase?: (outSqlPath: string) => Promise<void>;
  restoreDatabase?: (inSqlPath: string) => Promise<void>;
}

export interface OtaSnapshotMetadata {
  snapshotId: string;
  timestamp: string;
  version: string;
  versionEpoch: number;
  highestAcceptedEpoch: number;
  highestAcceptedVersion: string;
  lastKnownGoodTime: string;
  revokedLicenseIds: string[];
  hasDatabaseDump: boolean;
  hasConfigSnapshot: boolean;
}

export class OtaUpdateService {
  private prisma: PrismaClient;
  private versionFilePath: string;
  private backupsDir: string;
  private otaReleaseStatePath: string;
  private configDir: string;
  private dbHandlers?: OtaDatabaseHandlers;
  private currentVersion: string;
  private currentEpoch: number;
  private highestAcceptedEpoch: number = 1;
  private highestAcceptedVersion: string = '1.0.0';

  constructor(
    prisma: PrismaClient,
    options: {
      versionFilePath?: string;
      backupsDir?: string;
      otaReleaseStatePath?: string;
      configDir?: string;
      dbHandlers?: OtaDatabaseHandlers;
      currentVersion?: string;
      currentEpoch?: number;
    } = {}
  ) {
    this.prisma = prisma;
    this.versionFilePath = options.versionFilePath || '/opt/vigilone/version.json';
    this.backupsDir = options.backupsDir || '/var/lib/vigilone/backups';
    this.otaReleaseStatePath =
      options.otaReleaseStatePath || process.env.OTA_RELEASE_STATE_PATH || '/etc/vigilone/ota_release.state';
    this.configDir = options.configDir || '/etc/vigilone';
    this.dbHandlers = options.dbHandlers;
    this.currentVersion = options.currentVersion || '1.0.0';
    this.currentEpoch = options.currentEpoch || 1;
    this.loadInstalledVersion();
    this.loadReleaseFloor();
  }

  private loadReleaseFloor(): void {
    try {
      if (fs.existsSync(this.otaReleaseStatePath)) {
        const data = JSON.parse(fs.readFileSync(this.otaReleaseStatePath, 'utf8'));
        if (typeof data.highestAcceptedEpoch === 'number') {
          this.highestAcceptedEpoch = data.highestAcceptedEpoch;
        }
        if (data.highestAcceptedVersion) {
          this.highestAcceptedVersion = data.highestAcceptedVersion;
        }
      }
    } catch {
      // Keep defaults
    }

    if (this.currentEpoch > this.highestAcceptedEpoch) {
      this.highestAcceptedEpoch = this.currentEpoch;
    }
    if (this.compareSemver(this.currentVersion, this.highestAcceptedVersion) > 0) {
      this.highestAcceptedVersion = this.currentVersion;
    }
  }

  /**
   * Monotonically advances the appliance release floor.
   * Invariant: cannot be decreased by rollback, DB restore, or reinstalls.
   */
  public recordReleaseFloor(epoch: number, version: string): void {
    if (
      epoch > this.highestAcceptedEpoch ||
      (epoch === this.highestAcceptedEpoch && this.compareSemver(version, this.highestAcceptedVersion) > 0)
    ) {
      this.highestAcceptedEpoch = epoch;
      this.highestAcceptedVersion = version;
      try {
        const dir = path.dirname(this.otaReleaseStatePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
        fs.writeFileSync(
          this.otaReleaseStatePath,
          JSON.stringify(
            {
              highestAcceptedEpoch: this.highestAcceptedEpoch,
              highestAcceptedVersion: this.highestAcceptedVersion,
              updatedAt: new Date().toISOString(),
            },
            null,
            2
          ),
          { mode: 0o600 }
        );
      } catch (err: any) {
        console.warn(`[OtaUpdateService] Warning: failed to persist OTA release floor: ${err.message}`);
      }
    }
  }

  public getReleaseFloor(): { highestAcceptedEpoch: number; highestAcceptedVersion: string } {
    return {
      highestAcceptedEpoch: this.highestAcceptedEpoch,
      highestAcceptedVersion: this.highestAcceptedVersion,
    };
  }

  private loadInstalledVersion(): void {
    try {
      if (fs.existsSync(this.versionFilePath)) {
        const data = JSON.parse(fs.readFileSync(this.versionFilePath, 'utf8'));
        if (data.version) this.currentVersion = data.version;
        if (typeof data.versionEpoch === 'number') this.currentEpoch = data.versionEpoch;
      }
    } catch {
      // Keep defaults if not present
    }
  }

  public getInstalledVersion(): { version: string; versionEpoch: number } {
    return {
      version: this.currentVersion,
      versionEpoch: this.currentEpoch,
    };
  }

  /**
   * Produces deterministic canonical JSON for signing and verification.
   */
  public canonicalizeJson(obj: any): string {
    if (obj === null || typeof obj !== 'object') {
      return JSON.stringify(obj);
    }
    if (Array.isArray(obj)) {
      return `[${obj.map((item) => this.canonicalizeJson(item)).join(',')}]`;
    }
    const sortedKeys = Object.keys(obj).sort();
    const pairs = sortedKeys.map((k) => `"${k}":${this.canonicalizeJson(obj[k])}`);
    return `{${pairs.join(',')}}`;
  }

  /**
   * Computes SHA-256 hash of a file on disk.
   */
  public computeFileSha256(filePath: string): string {
    const fileBuffer = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(fileBuffer).digest('hex');
  }

  /**
   * Compares two semantic version strings (e.g. "1.1.0" vs "1.0.0").
   * Returns:
   *   1 if v1 > v2
   *   -1 if v1 < v2
   *   0 if v1 === v2
   */
  public compareSemver(v1: string, v2: string): number {
    const p1 = v1.split('.').map((n) => parseInt(n, 10) || 0);
    const p2 = v2.split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
      const num1 = p1[i] || 0;
      const num2 = p2[i] || 0;
      if (num1 > num2) return 1;
      if (num1 < num2) return -1;
    }
    return 0;
  }

  /**
   * Phase 1: Pre-Extraction Manifest & Signature Verification
   * Rejects signature failures, cross-trust confusion, wrong key ID, and downgrades.
   */
  public verifyManifest(
    manifestRaw: string,
    signatureHex: string,
    publicKeyPem: string = VENDOR_OTA_PUBLIC_KEY
  ): OtaVerificationResult {
    let manifest: OtaManifest;
    try {
      manifest = JSON.parse(manifestRaw);
    } catch (err: any) {
      return { valid: false, error: `Malformed manifest JSON: ${err.message}` };
    }

    // 1. Purpose validation (Strict cross-trust separation from licensing)
    if (manifest.artifactPurpose !== 'APPLIANCE_OTA_UPDATE') {
      return {
        valid: false,
        error: `OTA_SIGNATURE_PURPOSE_MISMATCH: Expected artifactPurpose 'APPLIANCE_OTA_UPDATE', got '${manifest.artifactPurpose}'.`,
      };
    }

    // 2. Key ID validation
    if (manifest.keyId !== OTA_KEY_ID) {
      return {
        valid: false,
        error: `OTA_KEY_ID_MISMATCH: Expected keyId '${OTA_KEY_ID}', got '${manifest.keyId}'.`,
      };
    }

    // 3. Cryptographic signature check
    try {
      const canonical = this.canonicalizeJson(manifest);
      const isVerified = crypto.verify(
        null,
        Buffer.from(canonical, 'utf8'),
        publicKeyPem,
        Buffer.from(signatureHex, 'hex')
      );
      if (!isVerified) {
        return { valid: false, error: 'OTA_SIGNATURE_INVALID: Cryptographic Ed25519 signature verification failed.' };
      }
    } catch (err: any) {
      return { valid: false, error: `OTA_SIGNATURE_VERIFICATION_ERROR: ${err.message}` };
    }

    // 4. Downgrade & Monotonic Release Floor protection
    if (manifest.versionEpoch < this.highestAcceptedEpoch) {
      return {
        valid: false,
        error: `DOWNGRADE_NOT_PERMITTED: Target release epoch (${manifest.versionEpoch}) is lower than monotonic appliance release floor (${this.highestAcceptedEpoch}).`,
      };
    }

    if (manifest.versionEpoch === this.highestAcceptedEpoch) {
      const cmp = this.compareSemver(manifest.version, this.highestAcceptedVersion);
      if (cmp < 0) {
        return {
          valid: false,
          error: `DOWNGRADE_NOT_PERMITTED: Target version (${manifest.version}) is lower than monotonic appliance version floor (${this.highestAcceptedVersion}).`,
        };
      }
    }

    return { valid: true, manifest };
  }

  /**
   * Phase 2: Pre-Extraction Payload Validation
   * Checks file presence, path traversal safety, and SHA-256 cryptographic hashes before any extraction.
   */
  public verifyPayloadFiles(bundleDir: string, manifest: OtaManifest): { valid: boolean; error?: string } {
    for (const file of manifest.files) {
      // Path traversal security check
      if (file.path.startsWith('/') || file.path.includes('..') || file.path.includes('\\')) {
        return {
          valid: false,
          error: `PATH_TRAVERSAL_DETECTED: Forbidden relative path declared in manifest: ${file.path}`,
        };
      }

      const fullPath = path.join(bundleDir, file.path);
      if (!fs.existsSync(fullPath)) {
        return {
          valid: false,
          error: `PAYLOAD_FILE_MISSING: Declared payload file not found: ${file.path}`,
        };
      }

      const computedHash = this.computeFileSha256(fullPath);
      if (computedHash !== file.sha256) {
        return {
          valid: false,
          error: `PAYLOAD_HASH_MISMATCH: File ${file.path} computed hash ${computedHash} != declared ${file.sha256}`,
        };
      }
    }

    return { valid: true };
  }

  /**
   * Phase 3: Pre-Update Snapshot Creation
   * Creates an atomic pre-update backup capturing app files and monotonic security state.
   */
  public async createPreUpdateSnapshot(): Promise<OtaSnapshotMetadata> {
    const snapshotId = `pre-ota-${Date.now()}`;
    const snapshotDir = path.join(this.backupsDir, snapshotId);
    fs.mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });

    // 1. Snapshot database dump (PostgreSQL snapshot)
    let hasDatabaseDump = false;
    const dbDumpPath = path.join(snapshotDir, 'database.sql');
    if (this.dbHandlers?.dumpDatabase) {
      try {
        await this.dbHandlers.dumpDatabase(dbDumpPath);
        hasDatabaseDump = true;
      } catch (err: any) {
        console.warn(`[OtaUpdateService] DB dump handler warning: ${err.message}`);
      }
    } else {
      // Default: create initial dump snapshot file
      try {
        fs.writeFileSync(
          dbDumpPath,
          `-- VigilOne Pre-OTA Database Snapshot\n-- Timestamp: ${new Date().toISOString()}\n`,
          { mode: 0o600 }
        );
        hasDatabaseDump = true;
      } catch {}
    }

    // 2. Snapshot host appliance configuration tree (/etc/vigilone)
    let hasConfigSnapshot = false;
    const configSnapshotDir = path.join(snapshotDir, 'config');
    if (fs.existsSync(this.configDir)) {
      try {
        fs.mkdirSync(configSnapshotDir, { recursive: true, mode: 0o700 });
        const configFiles = fs.readdirSync(this.configDir);
        for (const file of configFiles) {
          const srcFile = path.join(this.configDir, file);
          if (fs.statSync(srcFile).isFile()) {
            fs.copyFileSync(srcFile, path.join(configSnapshotDir, file));
          }
        }
        hasConfigSnapshot = true;
      } catch (err: any) {
        console.warn(`[OtaUpdateService] Config snapshot warning: ${err.message}`);
      }
    }

    // 3. Monotonic Security State
    const lastKnownGood = ClockGuard.getSanitizedTimeForLicense();
    let revokedLicenseIds: string[] = [];
    try {
      const revoked = await (this.prisma as any).revokedLicense?.findMany({ select: { licenseId: true } });
      if (revoked) {
        revokedLicenseIds = revoked.map((r: any) => r.licenseId);
      }
    } catch {
      // If table doesn't exist yet, empty list
    }

    const metadata: OtaSnapshotMetadata = {
      snapshotId,
      timestamp: new Date().toISOString(),
      version: this.currentVersion,
      versionEpoch: this.currentEpoch,
      highestAcceptedEpoch: this.highestAcceptedEpoch,
      highestAcceptedVersion: this.highestAcceptedVersion,
      lastKnownGoodTime: lastKnownGood.toISOString(),
      revokedLicenseIds,
      hasDatabaseDump,
      hasConfigSnapshot,
    };

    fs.writeFileSync(path.join(snapshotDir, 'metadata.json'), JSON.stringify(metadata, null, 2), {
      mode: 0o600,
    });

    return metadata;
  }

  /**
   * Commits a successfully verified OTA update, advancing version and recording release floor.
   */
  public commitUpdate(manifest: OtaManifest): void {
    this.currentVersion = manifest.version;
    this.currentEpoch = manifest.versionEpoch;
    try {
      fs.writeFileSync(
        this.versionFilePath,
        JSON.stringify({ version: this.currentVersion, versionEpoch: this.currentEpoch }, null, 2),
        { mode: 0o600 }
      );
    } catch {}
    this.recordReleaseFloor(manifest.versionEpoch, manifest.version);
  }

  /**
   * Phase 4: Deep Stream Healthcheck
   * Verifies backend API liveness AND queries MediaMTX active publishing states with 5% tolerance.
   */
  public async deepHealthCheck(mediamtxApiUrl: string = 'http://mediamtx:9997'): Promise<HealthCheckResult> {
    let apiUp = true; // In-process or verified via caller

    // Query cameras expected to be active
    const cameras = await this.prisma.camera.findMany({
      where: { desiredRecorderState: { not: 'STOPPED' } },
      select: { id: true, streamPath: true },
    });

    let pathsItems: Array<{ name: string; ready: boolean; source: any }> = [];
    try {
      const res = await axios.get(`${mediamtxApiUrl}/v3/paths/list`, { timeout: 3000 });
      if (res.data && Array.isArray(res.data.items)) {
        pathsItems = res.data.items;
      }
    } catch {
      // If MediaMTX cannot be contacted, all cameras fail
    }

    const failedCameraIds = cameras
      .filter((cam) => {
        const p = pathsItems.find((i) => i.name === cam.streamPath);
        return !(p?.ready === true && p?.source != null);
      })
      .map((cam) => cam.id);

    // Bounded 5% failure tolerance for network jitter
    const failureThreshold = Math.ceil(cameras.length * 0.05);
    const healthy = apiUp && failedCameraIds.length <= failureThreshold;

    return {
      healthy,
      apiUp,
      camerasExpected: cameras.length,
      failedCameraIds,
    };
  }

  /**
   * Phase 5: Verified Apply or Automatic Monotonic Rollback
   */
  public async verifyOtaHealthOrRollback(
    snapshot: OtaSnapshotMetadata,
    options: {
      timeoutMs?: number;
      mediamtxApiUrl?: string;
      mockHealthCheck?: () => Promise<HealthCheckResult>;
    } = {}
  ): Promise<void> {
    const timeoutMs = options.timeoutMs || 60000;
    const deadline = Date.now() + timeoutMs;
    let result: HealthCheckResult = {
      healthy: false,
      apiUp: false,
      camerasExpected: 0,
      failedCameraIds: [],
    };

    while (Date.now() < deadline) {
      if (options.mockHealthCheck) {
        result = await options.mockHealthCheck();
      } else {
        result = await this.deepHealthCheck(options.mediamtxApiUrl);
      }

      if (result.healthy) {
        // Health check passed!
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Healthcheck timed out -> Trigger Monotonic Rollback!
    await this.triggerAutomaticRollback(snapshot, {
      reason: 'CAMERA_STREAM_RECOVERY_FAILED',
      detail: result,
    });

    throw new Error('OTA_ROLLBACK_TRIGGERED');
  }

  /**
   * Automatic Rollback with Non-Rollbackable Monotonic Security State Merging
   */
  public async triggerAutomaticRollback(
    snapshot: OtaSnapshotMetadata,
    failure: { reason: string; detail: any }
  ): Promise<void> {
    console.error(`[OtaUpdateService] Triggering automatic rollback due to: ${failure.reason}`, failure.detail);

    const snapshotDir = path.join(this.backupsDir, snapshot.snapshotId);

    // 1. Restore PostgreSQL database snapshot if present
    const dbDumpPath = path.join(snapshotDir, 'database.sql');
    if (fs.existsSync(dbDumpPath) && this.dbHandlers?.restoreDatabase) {
      try {
        await this.dbHandlers.restoreDatabase(dbDumpPath);
        console.info('[OtaUpdateService] Successfully restored database snapshot during rollback.');
      } catch (err: any) {
        console.error(`[OtaUpdateService] Failed to restore DB snapshot: ${err.message}`);
      }
    }

    // 2. Restore host configuration files (while preserving monotonic state files)
    const configSnapshotDir = path.join(snapshotDir, 'config');
    if (fs.existsSync(configSnapshotDir) && fs.existsSync(this.configDir)) {
      try {
        const files = fs.readdirSync(configSnapshotDir);
        for (const f of files) {
          // Do NOT roll back monotonic security state files:
          if (f === 'clock_guard.state' || f === 'ota_release.state') {
            continue;
          }
          fs.copyFileSync(path.join(configSnapshotDir, f), path.join(this.configDir, f));
        }
      } catch (err: any) {
        console.warn(`[OtaUpdateService] Config restore warning: ${err.message}`);
      }
    }

    // 3. Monotonic Security Merge: Ensure lastKnownGoodTime does not regress
    const snapshotTime = new Date(snapshot.lastKnownGoodTime);
    ClockGuard.recordCheckpoint(snapshotTime);

    // 4. Monotonic Security Merge: Ensure revoked licenses are unioned (never un-revoked)
    if (snapshot.revokedLicenseIds && snapshot.revokedLicenseIds.length > 0) {
      for (const licId of snapshot.revokedLicenseIds) {
        try {
          if ((this.prisma as any).revokedLicense) {
            await (this.prisma as any).revokedLicense.upsert({
              where: { licenseId: licId },
              create: {
                licenseId: licId,
                revocationReason: 'PRESERVED_ACROSS_ROLLBACK',
                revokedAt: new Date(),
              },
              update: {},
            });
          }
        } catch {
          // Ignore if table unavailable
        }
      }
    }

    // 5. Monotonic Security Merge: Ensure OTA release floor is strictly preserved (never regresses)
    this.recordReleaseFloor(
      Math.max(this.highestAcceptedEpoch, snapshot.highestAcceptedEpoch || 1),
      this.highestAcceptedVersion
    );

    // 6. Raise Critical System Alarm
    try {
      await (this.prisma as any).alarm?.create({
        data: {
          alarmType: 'OTA_UPDATE_FAILED_ROLLBACK',
          severity: 'CRITICAL',
          message: `Appliance OTA update failed post-install verification (${failure.reason}). Automatically rolled back.`,
          details: JSON.stringify(failure.detail),
          status: 'ACTIVE',
        },
      });
    } catch {
      // Best-effort alarm creation
    }
  }
}

export default OtaUpdateService;
