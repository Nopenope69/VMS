import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { PrismaClient, SegmentStatus, EventSeverity } from '@prisma/client';
import { FFmpegService } from '../ffmpeg/ffmpeg.service';
import { computeFileSha256 } from '../../utils/crypto';
import config from '../../config/env';

export interface CrashRecoveryReport {
  timestamp: Date;
  filesExamined: number;
  filesRecovered: number;
  filesQuarantined: number;
  filesMissing: number;
  zeroBytePruned: number;
  durationMs: number;
}

export type MediaClassification =
  | 'VALID'
  | 'PARTIAL_BUT_READABLE'
  | 'TRUNCATED'
  | 'CORRUPTED'
  | 'ZERO_BYTE';

export class CrashRecoveryService {
  private prisma: PrismaClient;
  private static lastReport: CrashRecoveryReport | null = null;
  private isRecovering = false;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  public static getLastReport(): CrashRecoveryReport | null {
    return this.lastReport;
  }

  /**
   * Fast FFmpeg remux repair using -err_detect ignore_err and stream copy
   */
  private static async remuxRepair(inputPath: string, outputPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      const args = [
        '-y',
        '-err_detect',
        'ignore_err',
        '-i',
        inputPath,
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        outputPath,
      ];

      const proc = spawn('ffmpeg', args);
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
  }

  /**
   * Evaluates and classifies a recorded media file
   */
  async classifyFile(filePath: string): Promise<{
    classification: MediaClassification;
    probe: any | null;
  }> {
    if (!fs.existsSync(filePath)) {
      return { classification: 'CORRUPTED', probe: null };
    }

    const stat = fs.statSync(filePath);
    if (stat.size === 0) {
      return { classification: 'ZERO_BYTE', probe: null };
    }

    const probe = await FFmpegService.probe(filePath);
    if (probe && probe.durationSeconds > 0) {
      return { classification: 'VALID', probe };
    }

    if (probe && probe.videoCodec) {
      return { classification: 'PARTIAL_BUT_READABLE', probe };
    }

    return { classification: 'TRUNCATED', probe: null };
  }

  /**
   * Scans a directory recursively for .mp4 and .fmp4 files
   */
  private scanMediaFiles(dirPath: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dirPath)) return results;

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '.quarantine') {
          results.push(...this.scanMediaFiles(fullPath));
        }
      } else if (entry.isFile() && (entry.name.endsWith('.mp4') || entry.name.endsWith('.fmp4'))) {
        results.push(fullPath);
      }
    }
    return results;
  }

  /**
   * Main crash recovery workflow executed on boot:
   * 1. Evaluates all physical media files across configured volumes.
   * 2. Prunes zero-byte files created by abrupt power cuts.
   * 3. Non-destructively repairs truncated segments; preserves originals if pinned.
   * 4. Quarantines unrecoverable media to .quarantine/.
   * 5. Reconciles database records whose physical files are missing (marks FILE_MISSING).
   */
  async recoverStorage(scanRoots?: string[]): Promise<CrashRecoveryReport> {
    if (this.isRecovering) {
      return (
        CrashRecoveryService.lastReport || {
          timestamp: new Date(),
          filesExamined: 0,
          filesRecovered: 0,
          filesQuarantined: 0,
          filesMissing: 0,
          zeroBytePruned: 0,
          durationMs: 0,
        }
      );
    }
    this.isRecovering = true;
    const startTime = Date.now();

    let filesExamined = 0;
    let filesRecovered = 0;
    let filesQuarantined = 0;
    let filesMissing = 0;
    let zeroBytePruned = 0;

    try {
      const roots = scanRoots && scanRoots.length > 0 ? scanRoots : [config.RECORDINGS_DIR || '/recordings'];

      // Also gather active StorageVolume paths
      try {
        const volumes = await this.prisma.storageVolume.findMany({ select: { path: true } });
        for (const v of volumes) {
          if (!roots.includes(v.path)) roots.push(v.path);
        }
      } catch {
        // Continue with default roots
      }

      for (const root of roots) {
        if (!fs.existsSync(root)) continue;

        const mediaFiles = this.scanMediaFiles(root);
        filesExamined += mediaFiles.length;

        for (const filePath of mediaFiles) {
          const { classification } = await this.classifyFile(filePath);

          if (classification === 'ZERO_BYTE') {
            // Abrupt power loss cut file off at 0 bytes -> unlink and audit
            try {
              fs.unlinkSync(filePath);
              zeroBytePruned++;

              await this.prisma.recordingSegment.updateMany({
                where: { filePath },
                data: {
                  status: SegmentStatus.CORRUPTED,
                  quarantineReason: 'ZERO_BYTE_POWER_CUT',
                },
              });
            } catch (err: any) {
              console.warn(`[CrashRecovery] Failed to unlink 0-byte file ${filePath}:`, err.message);
            }
          } else if (classification === 'TRUNCATED' || classification === 'CORRUPTED') {
            // Attempt non-destructive repair
            const origSha256 = await computeFileSha256(filePath).catch(() => null);
            const tempRepairPath = `${filePath}.repair_tmp.mp4`;

            const repaired = await CrashRecoveryService.remuxRepair(filePath, tempRepairPath);

            if (repaired) {
              const repairProbe = await FFmpegService.probe(tempRepairPath);
              if (repairProbe && repairProbe.durationSeconds > 0) {
                const repairedSha256 = await computeFileSha256(tempRepairPath).catch(() => null);

                // Check if existing segment is pinned
                const existingSegment = await this.prisma.recordingSegment.findUnique({
                  where: { filePath },
                  include: { evidencePins: { where: { releasedAt: null } } },
                });

                const isPinned = existingSegment && existingSegment.evidencePins.length > 0;

                if (isPinned) {
                  // Forensically preserve original corrupt file alongside repaired file
                  const origPreservedPath = `${filePath}.orig_corrupted`;
                  fs.renameSync(filePath, origPreservedPath);
                  fs.renameSync(tempRepairPath, filePath);
                } else {
                  // Non-pinned: replace file with repaired version
                  fs.renameSync(tempRepairPath, filePath);
                }

                await this.prisma.recordingSegment.updateMany({
                  where: { filePath },
                  data: {
                    status: SegmentStatus.FINALIZED,
                    originalSha256: origSha256,
                    repairedSha256: repairedSha256,
                    repairedAt: new Date(),
                    durationMs: Math.round(repairProbe.durationSeconds * 1000),
                  },
                });

                filesRecovered++;
                continue;
              }
            }

            // Repair failed or produced invalid container -> Quarantine
            if (fs.existsSync(tempRepairPath)) {
              try {
                fs.unlinkSync(tempRepairPath);
              } catch {}
            }

            const dir = path.dirname(filePath);
            const quarantineDir = path.join(dir, '.quarantine');
            if (!fs.existsSync(quarantineDir)) {
              fs.mkdirSync(quarantineDir, { recursive: true });
            }

            const quarantinedPath = path.join(quarantineDir, path.basename(filePath));
            try {
              fs.renameSync(filePath, quarantinedPath);
              filesQuarantined++;

              await this.prisma.recordingSegment.updateMany({
                where: { filePath },
                data: {
                  filePath: quarantinedPath,
                  status: SegmentStatus.QUARANTINED,
                  quarantineReason: 'TRUNCATED_CONTAINER_UNREPAIRABLE',
                },
              });
            } catch (err: any) {
              console.error(`[CrashRecovery] Failed to quarantine file ${filePath}:`, err.message);
            }
          }
        }
      }

      // Reconcile Database records where physical files disappeared
      const candidateSegments = await this.prisma.recordingSegment.findMany({
        where: {
          status: SegmentStatus.FINALIZED,
        },
        select: { id: true, filePath: true },
        take: 1000,
      });

      for (const seg of candidateSegments) {
        if (!fs.existsSync(seg.filePath)) {
          // Explicit state transition: Never silently delete evidence metadata!
          await this.prisma.recordingSegment.update({
            where: { id: seg.id },
            data: {
              status: SegmentStatus.FILE_MISSING,
              quarantineReason: 'PHYSICAL_FILE_MISSING_ON_RECONCILE',
            },
          });
          filesMissing++;
        }
      }

      const report: CrashRecoveryReport = {
        timestamp: new Date(),
        filesExamined,
        filesRecovered,
        filesQuarantined,
        filesMissing,
        zeroBytePruned,
        durationMs: Date.now() - startTime,
      };

      CrashRecoveryService.lastReport = report;

      // Dispatch audit event
      try {
        await this.prisma.event.create({
          data: {
            type: 'RECORDING_FAILURE',
            severity: (filesQuarantined > 0 || filesMissing > 0 ? 'WARNING' : 'INFO') as any,
            title: 'Storage Crash Recovery Scan',
            description: `Crash recovery completed in ${report.durationMs}ms: ${filesRecovered} repaired, ${filesQuarantined} quarantined, ${zeroBytePruned} 0-byte files pruned, ${filesMissing} missing files flagged.`,
            metadata: { ...report },
          },
        });
      } catch (err: any) {
        console.warn('[CrashRecovery] Failed to log recovery event:', err.message);
      }

      return report;
    } finally {
      this.isRecovering = false;
    }
  }
}

export default CrashRecoveryService;
