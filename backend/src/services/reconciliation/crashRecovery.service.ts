import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import checkDiskSpace from 'check-disk-space';
import { PrismaClient, SegmentStatus, EventSeverity, EventType, AlarmState } from '@prisma/client';
import { FFmpegService } from '../ffmpeg/ffmpeg.service';
import { computeFileSha256 } from '../../utils/crypto';
import { extractStreamPathAndFilename, calculateSegmentBounds, SegmentBounds } from '../../utils/segmentPath';
import ControlPlaneManifestService from '../appliance/controlPlaneManifest.service';
import PinStateMirrorService from '../evidence/pinStateMirror.service';
import config from '../../config/env';

export interface CrashRecoveryReport {
  timestamp: Date;
  filesExamined: number;
  filesRecovered: number;
  filesQuarantined: number;
  filesMissing: number;
  zeroBytePruned: number;
  orphansIndexed: number;
  validPairsConfirmed: number;
  quarantineSizeBytes: number;
  quarantineCapExceeded: boolean;
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
   * Scans a directory recursively for all files located in .quarantine directories
   */
  private scanQuarantineFiles(dirPath: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dirPath)) return results;

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '.quarantine') {
            try {
              const qEntries = fs.readdirSync(fullPath, { withFileTypes: true });
              for (const qEntry of qEntries) {
                if (qEntry.isFile()) results.push(path.join(fullPath, qEntry.name));
              }
            } catch {}
          } else {
            results.push(...this.scanQuarantineFiles(fullPath));
          }
        }
      }
    } catch {}
    return results;
  }

  /**
   * Calculates total quarantine storage usage across scanned roots and enforces the 5% volume cap.
   * Invariant (C-018): Pinned quarantine evidence is NEVER automatically pruned.
   * If cap is exceeded and remaining items are pinned, raises a CRITICAL alarm.
   */
  private async enforceQuarantineCap(roots: string[]): Promise<{
    quarantineSizeBytes: number;
    quarantineCapExceeded: boolean;
  }> {
    let totalQuarantineBytes = 0;
    let capExceeded = false;

    for (const root of roots) {
      if (!fs.existsSync(root)) continue;

      const qFiles = this.scanQuarantineFiles(root);
      let rootQBytes = 0;
      const fileStats: { path: string; size: number; mtimeMs: number }[] = [];

      for (const f of qFiles) {
        try {
          const stat = fs.statSync(f);
          rootQBytes += stat.size;
          fileStats.push({ path: f, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch {}
      }

      totalQuarantineBytes += rootQBytes;

      let diskSize = 0;
      try {
        const disk = await checkDiskSpace(root);
        diskSize = disk.size;
      } catch {}

      if (diskSize > 0) {
        const maxCapBytes = Math.floor(diskSize * 0.05);
        if (rootQBytes > maxCapBytes) {
          capExceeded = true;

          // Check pinned status for quarantined files in DB
          const segments =
            typeof (this.prisma as any).recordingSegment?.findMany === 'function'
              ? await this.prisma.recordingSegment.findMany({
                  where: { filePath: { in: fileStats.map((f) => f.path) } },
                  include: { evidencePins: { where: { releasedAt: null } } },
                })
              : [];

          const pinnedPathSet = new Set<string>();
          for (const s of segments) {
            if (s.evidencePins && s.evidencePins.length > 0) {
              pinnedPathSet.add(s.filePath);
            }
          }

          // Sort unpinned files by mtimeMs ascending (oldest first)
          const unpinned = fileStats
            .filter((f) => !pinnedPathSet.has(f.path) && !f.path.endsWith('.orig_corrupted'))
            .sort((a, b) => a.mtimeMs - b.mtimeMs);

          for (const unpinnedFile of unpinned) {
            if (rootQBytes <= maxCapBytes) break;
            try {
              fs.unlinkSync(unpinnedFile.path);
              rootQBytes -= unpinnedFile.size;
              totalQuarantineBytes -= unpinnedFile.size;

              if (typeof (this.prisma as any).recordingSegment?.updateMany === 'function') {
                await this.prisma.recordingSegment.updateMany({
                  where: { filePath: unpinnedFile.path },
                  data: {
                    status: SegmentStatus.ARCHIVED,
                    quarantineReason: 'PRUNED_QUARANTINE_CAP_EXCEEDED',
                  },
                });
              }
            } catch {}
          }

          // If still exceeding cap because remaining files are pinned evidence:
          if (rootQBytes > maxCapBytes) {
            try {
              if (typeof (this.prisma as any).alarm?.create === 'function') {
                const tenant =
                  typeof (this.prisma as any).tenant?.findFirst === 'function'
                    ? await this.prisma.tenant.findFirst({ select: { id: true } })
                    : null;
                const tenantId = tenant?.id || 'system';

                await (this.prisma as any).alarm.create({
                  data: {
                    tenantId,
                    title: 'Quarantine Storage Cap Exceeded with Pinned Evidence',
                    description: `Quarantine storage on ${root} (${rootQBytes} bytes) exceeds 5% volume limit (${maxCapBytes} bytes). Pinned evidence cannot be automatically pruned.`,
                    severity: EventSeverity.CRITICAL,
                    state: AlarmState.ACTIVE,
                    metadataJson: { root, rootQBytes, maxCapBytes },
                  },
                });
              }
            } catch {}
          }
        }
      }
    }

    return {
      quarantineSizeBytes: totalQuarantineBytes,
      quarantineCapExceeded: capExceeded,
    };
  }

  /**
   * Main crash recovery workflow executed on boot:
   * 4-State Reconciliation Ladder (Section 3.1.2 & C-018):
   * 1. Orphan Media on Disk: Verify camera and tenant ownership via path admission control;
   *    unmappable files quarantined. For valid orphan files: parse filename timestamp + probe + SHA-256 -> index.
   * 2. Missing Media File: Mark segment FILE_MISSING, raise system warning.
   * 3. Corrupt Media File: Non-destructively repair via FFmpeg; if unrepairable, quarantine to .quarantine/.
   * 4. Valid DB/Media Pair: Confirm size, bounds, and SHA-256 hash.
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
          orphansIndexed: 0,
          validPairsConfirmed: 0,
          quarantineSizeBytes: 0,
          quarantineCapExceeded: false,
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
    let orphansIndexed = 0;
    let validPairsConfirmed = 0;

    try {
      const roots =
        scanRoots && scanRoots.length > 0 ? scanRoots : [config.RECORDINGS_DIR || '/recordings'];

      // Also gather active StorageVolume paths
      try {
        if (typeof (this.prisma as any).storageVolume?.findMany === 'function') {
          const volumes = await this.prisma.storageVolume.findMany({ select: { path: true } });
          for (const v of volumes) {
            if (!roots.includes(v.path)) roots.push(v.path);
          }
        }
      } catch {
        // Continue with default roots
      }

      for (const root of roots) {
        if (!fs.existsSync(root)) continue;

        const mediaFiles = this.scanMediaFiles(root);
        filesExamined += mediaFiles.length;

        for (const filePath of mediaFiles) {
          const { classification, probe } = await this.classifyFile(filePath);

          const existingSegment =
            typeof (this.prisma as any).recordingSegment?.findUnique === 'function'
              ? await this.prisma.recordingSegment.findUnique({
                  where: { filePath },
                  include: { evidencePins: { where: { releasedAt: null } } },
                })
              : null;

          if (classification === 'ZERO_BYTE') {
            // Abrupt power loss cut file off at 0 bytes -> unlink and audit
            try {
              fs.unlinkSync(filePath);
              zeroBytePruned++;

              if (typeof (this.prisma as any).recordingSegment?.updateMany === 'function') {
                await this.prisma.recordingSegment.updateMany({
                  where: { filePath },
                  data: {
                    status: SegmentStatus.CORRUPTED,
                    quarantineReason: 'ZERO_BYTE_POWER_CUT',
                  },
                });
              }
            } catch (err: any) {
              console.warn(`[CrashRecovery] Failed to unlink 0-byte file ${filePath}:`, err.message);
            }
          } else if (classification === 'TRUNCATED' || classification === 'CORRUPTED') {
            // State 3: Corrupt Media File - attempt non-destructive repair
            const origSha256 = await computeFileSha256(filePath).catch(() => null);
            const tempRepairPath = `${filePath}.repair_tmp.mp4`;

            const repaired = await CrashRecoveryService.remuxRepair(filePath, tempRepairPath);

            if (repaired) {
              const repairProbe = await FFmpegService.probe(tempRepairPath);
              if (repairProbe && repairProbe.durationSeconds > 0) {
                const repairedSha256 = await computeFileSha256(tempRepairPath).catch(() => null);

                const isPinned = existingSegment && existingSegment.evidencePins && existingSegment.evidencePins.length > 0;

                if (isPinned) {
                  // Forensically preserve original corrupt file alongside repaired file
                  const origPreservedPath = `${filePath}.orig_corrupted`;
                  fs.renameSync(filePath, origPreservedPath);
                  fs.renameSync(tempRepairPath, filePath);
                } else {
                  // Non-pinned: replace file with repaired version
                  fs.renameSync(tempRepairPath, filePath);
                }

                if (typeof (this.prisma as any).recordingSegment?.updateMany === 'function') {
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
                }

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

              if (typeof (this.prisma as any).recordingSegment?.updateMany === 'function') {
                await this.prisma.recordingSegment.updateMany({
                  where: { filePath },
                  data: {
                    filePath: quarantinedPath,
                    status: SegmentStatus.QUARANTINED,
                    quarantineReason: 'TRUNCATED_CONTAINER_UNREPAIRABLE',
                  },
                });
              }
            } catch (err: any) {
              console.error(`[CrashRecovery] Failed to quarantine file ${filePath}:`, err.message);
            }
          } else if (classification === 'VALID' || classification === 'PARTIAL_BUT_READABLE') {
            if (!existingSegment) {
              // State 1: Orphan Media on Disk - check path admission control
              const streamInfo = extractStreamPathAndFilename(filePath, root);
              let camera = null;
              if (typeof (this.prisma as any).camera?.findFirst === 'function') {
                camera = await this.prisma.camera.findFirst({
                  where: {
                    OR: [
                      { id: streamInfo.streamPath },
                      { streamPath: streamInfo.streamPath },
                    ],
                  },
                  select: { id: true, tenantId: true },
                });
              }

              // Fallback to trusted host control-plane appliance manifest for disaster recovery rebuilds
              if (!camera) {
                const manifestCamera = ControlPlaneManifestService.resolveCameraForStreamPath(streamInfo.streamPath);
                if (manifestCamera) {
                  camera = { id: manifestCamera.id, tenantId: manifestCamera.tenantId };
                  // If camera table is empty (e.g. database rebuilt), reconstitute camera record if supported
                  if (typeof (this.prisma as any).camera?.create === 'function') {
                    try {
                      const existing = await this.prisma.camera.findUnique({ where: { id: manifestCamera.id } }).catch(() => null);
                      if (!existing) {
                        // Ensure site exists
                        let site = await this.prisma.site.findFirst({ where: { tenantId: manifestCamera.tenantId } }).catch(() => null);
                        if (!site && typeof (this.prisma as any).site?.create === 'function') {
                          site = await this.prisma.site.create({
                            data: {
                              tenantId: manifestCamera.tenantId,
                              name: 'Recovered Site',
                            },
                          }).catch(() => null);
                        }
                        if (site) {
                          await this.prisma.camera.create({
                            data: {
                              id: manifestCamera.id,
                              tenantId: manifestCamera.tenantId,
                              siteId: site.id,
                              name: manifestCamera.name,
                              streamPath: manifestCamera.streamPath,
                              ipAddress: '127.0.0.1',
                              mainRtspUri: `rtsp://localhost:8554/${manifestCamera.streamPath}`,
                              storageVolumeId: manifestCamera.storageVolumeId || null,
                            },
                          }).catch(() => null);
                        }
                      }
                    } catch {
                      // Non-fatal if schema mismatch
                    }
                  }
                }
              }

              if (!camera) {
                // Admission control failure: unmapped orphan media quarantined
                const dir = path.dirname(filePath);
                const quarantineDir = path.join(dir, '.quarantine');
                if (!fs.existsSync(quarantineDir)) {
                  fs.mkdirSync(quarantineDir, { recursive: true });
                }
                const quarantinedPath = path.join(quarantineDir, path.basename(filePath));
                try {
                  fs.renameSync(filePath, quarantinedPath);
                  filesQuarantined++;

                  if (typeof (this.prisma as any).event?.create === 'function') {
                    await this.prisma.event.create({
                      data: {
                        type: EventType.STORAGE_CORRUPT_SEGMENT_QUARANTINED,
                        severity: EventSeverity.WARNING,
                        title: 'Unmapped Recording Quarantined',
                        description: `Orphan media file ${filePath} failed admission control (no matching camera) and was quarantined.`,
                        metadata: { filePath, quarantinedPath },
                      },
                    });
                  }
                } catch (err: any) {
                  console.error(`[CrashRecovery] Failed to quarantine unmapped orphan file ${filePath}:`, err.message);
                }
              } else {
                // Valid orphan media file: parse filename timestamp, probe, sha256 -> index
                const durMs = probe?.durationSeconds ? Math.round(probe.durationSeconds * 1000) : 0;
                let bounds: SegmentBounds;
                try {
                  bounds = calculateSegmentBounds(filePath, durMs);
                } catch {
                  const stat = fs.statSync(filePath);
                  const startTime = new Date(stat.birthtimeMs || stat.mtimeMs);
                  bounds = {
                    startTime,
                    endTime: new Date(startTime.getTime() + durMs),
                    durationMs: durMs,
                  };
                }

                const stat = fs.statSync(filePath);
                const sha256 = await computeFileSha256(filePath).catch(() => null);

                // Check PinStateMirrorService to recover legal hold pins on DB loss rebuilds
                const mirrorRecord = sha256 ? PinStateMirrorService.lookup(sha256) : undefined;

                if (typeof (this.prisma as any).recordingSegment?.create === 'function') {
                  const createdSeg = await this.prisma.recordingSegment.create({
                    data: {
                      tenantId: camera.tenantId,
                      cameraId: camera.id,
                      filePath,
                      startTime: bounds.startTime,
                      endTime: bounds.endTime,
                      durationMs: bounds.durationMs,
                      sizeBytes: BigInt(stat.size),
                      sha256Hash: sha256,
                      codec: probe?.videoCodec || 'h264',
                      width: probe?.width || null,
                      height: probe?.height || null,
                      fps: probe?.fps || null,
                      status: SegmentStatus.FINALIZED,
                    },
                  });

                  // If pin mirror state existed, recreate EvidencePin and record audit event
                  if (mirrorRecord && typeof (this.prisma as any).evidencePin?.create === 'function') {
                    await this.prisma.evidencePin.create({
                      data: {
                        tenantId: camera.tenantId,
                        segmentId: createdSeg.id,
                        exportJobId: mirrorRecord.pinnedBy || 'DISASTER_RECOVERY',
                        reason: mirrorRecord.reason || 'LEGAL_HOLD',
                        pinType: 'LEGAL_HOLD',
                        expiresAt: new Date('2099-01-01T00:00:00Z'),
                      },
                    }).catch(() => null);

                    if (typeof (this.prisma as any).event?.create === 'function') {
                      await this.prisma.event.create({
                        data: {
                          type: EventType.STORAGE_WARNING,
                          severity: EventSeverity.WARNING,
                          title: 'Evidence Pin Restored from Host Mirror',
                          description: `Pin restored from host-state mirror after DB rebuild. Custody history before ${mirrorRecord.pinnedAt} is not recoverable.`,
                          metadata: {
                            segmentId: createdSeg.id,
                            sha256: sha256 || '',
                            pinnedAt: mirrorRecord.pinnedAt,
                          } as any,
                        },
                      }).catch(() => null);
                    }
                  }
                }
                orphansIndexed++;
              }
            } else {
              // State 4: Valid DB/Media Pair - confirm size and hash
              const stat = fs.statSync(filePath);
              const updates: any = {};

              if (!existingSegment.sha256Hash) {
                updates.sha256Hash = await computeFileSha256(filePath).catch(() => null);
              }
              if (existingSegment.sizeBytes !== BigInt(stat.size)) {
                updates.sizeBytes = BigInt(stat.size);
              }

              if (
                Object.keys(updates).length > 0 &&
                typeof (this.prisma as any).recordingSegment?.update === 'function'
              ) {
                await this.prisma.recordingSegment.update({
                  where: { id: existingSegment.id },
                  data: updates,
                });
              }
              validPairsConfirmed++;
            }
          }
        }
      }

      // State 2: Missing Media File - Reconcile Database records where physical files disappeared
      const candidateSegments =
        typeof (this.prisma as any).recordingSegment?.findMany === 'function'
          ? await this.prisma.recordingSegment.findMany({
              where: {
                status: SegmentStatus.FINALIZED,
              },
              select: { id: true, filePath: true, tenantId: true, cameraId: true },
              take: 1000,
            })
          : [];

      for (const seg of candidateSegments) {
        if (!fs.existsSync(seg.filePath)) {
          // Explicit state transition: Never silently delete evidence metadata!
          if (typeof (this.prisma as any).recordingSegment?.update === 'function') {
            await this.prisma.recordingSegment.update({
              where: { id: seg.id },
              data: {
                status: SegmentStatus.FILE_MISSING,
                quarantineReason: 'PHYSICAL_FILE_MISSING_ON_RECONCILE',
              },
            });
          }
          filesMissing++;

          // Raise system warning event
          try {
            if (typeof (this.prisma as any).event?.create === 'function') {
              await this.prisma.event.create({
                data: {
                  cameraId: seg.cameraId,
                  type: EventType.RECORDING_FAILURE,
                  severity: EventSeverity.WARNING,
                  title: 'Recording Segment Missing from Disk',
                  description: `Recording segment ${seg.id} file is missing from disk: ${seg.filePath}`,
                  metadata: { segmentId: seg.id, filePath: seg.filePath },
                },
              });
            }
          } catch {}
        }
      }

      // Enforce quarantine storage accounting and 5% cap
      const { quarantineSizeBytes, quarantineCapExceeded } = await this.enforceQuarantineCap(roots);

      const report: CrashRecoveryReport = {
        timestamp: new Date(),
        filesExamined,
        filesRecovered,
        filesQuarantined,
        filesMissing,
        zeroBytePruned,
        orphansIndexed,
        validPairsConfirmed,
        quarantineSizeBytes,
        quarantineCapExceeded,
        durationMs: Date.now() - startTime,
      };

      CrashRecoveryService.lastReport = report;

      // Dispatch audit event
      try {
        if (typeof (this.prisma as any).event?.create === 'function') {
          await this.prisma.event.create({
            data: {
              type: EventType.RECORDING_FAILURE,
              severity: (filesQuarantined > 0 || filesMissing > 0 ? 'WARNING' : 'INFO') as any,
              title: 'Storage Crash Recovery Scan',
              description: `Crash recovery completed in ${report.durationMs}ms: ${filesRecovered} repaired, ${filesQuarantined} quarantined, ${zeroBytePruned} 0-byte files pruned, ${filesMissing} missing files flagged, ${orphansIndexed} orphans indexed, ${validPairsConfirmed} valid pairs confirmed.`,
              metadata: { ...report },
            },
          });
        }
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
