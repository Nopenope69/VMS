import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import ClockGuard from '../../utils/clockGuard';
import PinStateMirrorService from '../evidence/pinStateMirror.service';
import ControlPlaneManifestService from './controlPlaneManifest.service';
import { CrashRecoveryService } from '../reconciliation/crashRecovery.service';

export interface DisasterRecoveryMetadata {
  backupId: string;
  createdAt: string;
  version: string;
  lastKnownGoodTime: string;
  hasLicenseMirror: boolean;
  hasPinStateMirror: boolean;
  hasManifest: boolean;
}

export class DisasterRecoveryService {
  private prisma: PrismaClient;
  private configDir: string;
  private crashRecovery: CrashRecoveryService;

  constructor(prisma: PrismaClient, configDir: string = '/etc/vigilone') {
    this.prisma = prisma;
    this.configDir = configDir;
    this.crashRecovery = new CrashRecoveryService(prisma);
  }

  /**
   * Scenario A: Restores a cold backup snapshot and enforces monotonic security state.
   */
  public async restoreSecurityMonotonicState(backupDir: string): Promise<{
    lastKnownGoodTimeRestored: string;
    pinsRestored: number;
    manifestRestored: boolean;
    licenseRestored: boolean;
    otaFloorRestored: boolean;
  }> {
    let lastKnownGoodTimeRestored = '';
    let pinsRestored = 0;
    let manifestRestored = false;
    let licenseRestored = false;

    // 1. ClockGuard: Monotonic max(current, backup)
    const backupClockState = path.join(backupDir, 'clock_guard.state');
    if (fs.existsSync(backupClockState)) {
      const raw = fs.readFileSync(backupClockState, 'utf8').trim();
      const backupTime = new Date(raw);
      if (!isNaN(backupTime.getTime())) {
        ClockGuard.recordCheckpoint(backupTime);
        lastKnownGoodTimeRestored = ClockGuard.getSanitizedTimeForLicense().toISOString();
      }
    }

    // 2. Pin State Mirror
    const backupPinState = path.join(backupDir, 'pinned_segments.state');
    if (fs.existsSync(backupPinState)) {
      try {
        const backupData = JSON.parse(fs.readFileSync(backupPinState, 'utf8'));
        if (backupData.pins) {
          for (const [sha, pin] of Object.entries(backupData.pins)) {
            PinStateMirrorService.recordPin(pin as any);
            pinsRestored++;
          }
        }
      } catch (err: any) {
        console.warn(`[DisasterRecovery] Failed to restore pin state: ${err.message}`);
      }
    }

    // 3. Control-Plane Manifest
    const backupManifest = path.join(backupDir, 'appliance_manifest.json');
    if (fs.existsSync(backupManifest)) {
      try {
        const manifestData = fs.readFileSync(backupManifest, 'utf8');
        const dest = ControlPlaneManifestService.getManifestPath();
        fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
        fs.writeFileSync(dest, manifestData, { mode: 0o600 });
        manifestRestored = true;
      } catch (err: any) {
        console.warn(`[DisasterRecovery] Failed to restore appliance manifest: ${err.message}`);
      }
    }

    // 4. Commercial License Mirror
    const backupLicense = path.join(backupDir, 'license.json');
    if (fs.existsSync(backupLicense)) {
      try {
        const dest = path.join(this.configDir, 'license.json');
        fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
        fs.copyFileSync(backupLicense, dest);
        licenseRestored = true;
      } catch (err: any) {
        console.warn(`[DisasterRecovery] Failed to restore license: ${err.message}`);
      }
    }

    // 5. Monotonic OTA Release Floor: max(live, backup)
    let otaFloorRestored = false;
    const backupOtaFloor = path.join(backupDir, 'ota_release.state');
    if (fs.existsSync(backupOtaFloor)) {
      try {
        const otaData = JSON.parse(fs.readFileSync(backupOtaFloor, 'utf8'));
        const liveOtaPath = process.env.OTA_RELEASE_STATE_PATH || path.join(this.configDir, 'ota_release.state');
        let currentEpoch = 1;
        let currentVersion = '1.0.0';
        if (fs.existsSync(liveOtaPath)) {
          const liveData = JSON.parse(fs.readFileSync(liveOtaPath, 'utf8'));
          if (typeof liveData.highestAcceptedEpoch === 'number') currentEpoch = liveData.highestAcceptedEpoch;
          if (liveData.highestAcceptedVersion) currentVersion = liveData.highestAcceptedVersion;
        }
        const maxEpoch = Math.max(currentEpoch, otaData.highestAcceptedEpoch || 1);
        const maxVersion = maxEpoch > currentEpoch ? (otaData.highestAcceptedVersion || '1.0.0') : currentVersion;
        fs.mkdirSync(path.dirname(liveOtaPath), { recursive: true, mode: 0o700 });
        fs.writeFileSync(
          liveOtaPath,
          JSON.stringify(
            {
              highestAcceptedEpoch: maxEpoch,
              highestAcceptedVersion: maxVersion,
              updatedAt: new Date().toISOString(),
            },
            null,
            2
          ),
          { mode: 0o600 }
        );
        otaFloorRestored = true;
      } catch (err: any) {
        console.warn(`[DisasterRecovery] Failed to restore OTA release floor: ${err.message}`);
      }
    }

    return {
      lastKnownGoodTimeRestored,
      pinsRestored,
      manifestRestored,
      licenseRestored,
      otaFloorRestored,
    };
  }

  /**
   * Scenario B: Reconstructs the database catalog directly from surviving physical recordings
   * on disk using the trusted control-plane manifest and host pin-state mirror.
   */
  public async reconstructFromSurvivingMedia(recordingsRoot: string): Promise<any> {
    // Run crash recovery 4-state ladder against the recordings directory
    const report = await this.crashRecovery.recoverStorage([recordingsRoot]);
    return report;
  }
}

export default DisasterRecoveryService;
