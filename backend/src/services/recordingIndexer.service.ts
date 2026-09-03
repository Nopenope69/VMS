import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import config from '../config/env';
import { FFmpegService } from './ffmpeg/ffmpeg.service';
import { computeFileSha256 } from '../utils/crypto';

export class RecordingIndexerService {
  private prisma: PrismaClient;
  private isScanning = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  start(intervalMs = 300000) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.scan().catch((err) => {
        console.error('[RecordingIndexer] Reconcile scan error:', err);
      });
    }, intervalMs);

    // Initial immediate scan
    this.scan().catch(() => {});
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Parses timestamp from MediaMTX recording filename:
   * e.g. "2026-09-04_01-30-00-123456.mp4"
   */
  private parseStartTimeFromFilename(filename: string, fileMtime: Date): Date {
    const match = filename.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
    if (match) {
      const [_, year, month, day, hour, min, sec] = match;
      return new Date(
        Date.UTC(
          parseInt(year, 10),
          parseInt(month, 10) - 1,
          parseInt(day, 10),
          parseInt(hour, 10),
          parseInt(min, 10),
          parseInt(sec, 10)
        )
      );
    }
    return fileMtime;
  }

  async scan(): Promise<number> {
    if (this.isScanning) return 0;
    this.isScanning = true;

    let indexedCount = 0;
    const recordingsRoot = config.RECORDINGS_DIR;
    const corruptedDir = path.join(recordingsRoot, 'corrupted');

    if (!fs.existsSync(recordingsRoot)) {
      this.isScanning = false;
      return 0;
    }

    if (!fs.existsSync(corruptedDir)) {
      fs.mkdirSync(corruptedDir, { recursive: true });
    }

    try {
      // Find all cameras in DB
      const cameras = await this.prisma.camera.findMany();
      const cameraMap = new Map(cameras.map((c) => [c.streamPath, c]));

      const entries = fs.readdirSync(recordingsRoot, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === 'corrupted' || entry.name === 'exports') {
          continue;
        }

        const streamPath = entry.name;
        const camera = cameraMap.get(streamPath);
        if (!camera) continue;

        const cameraDir = path.join(recordingsRoot, streamPath);
        const segmentFiles = fs
          .readdirSync(cameraDir)
          .filter((f) => f.endsWith('.mp4'))
          .sort();

        for (const file of segmentFiles) {
          const filePath = path.join(cameraDir, file);

          // Check if already indexed in database
          const existing = await this.prisma.recordingSegment.findUnique({
            where: { filePath },
          });

          if (existing) continue;

          // Check if file is still currently being written (e.g. mtime within last 2 seconds and not yet finalized)
          const stats = fs.statSync(filePath);
          const ageMs = Date.now() - stats.mtimeMs;

          // Probe file with ffprobe to determine integrity
          const probe = await FFmpegService.probe(filePath);

          if (!probe || probe.durationSeconds <= 0) {
            // If file is fresh (< 5s), it might just be the active segment being written. Skip for now.
            if (ageMs < 5000) {
              continue;
            }

            // Corrupted segment heuristic: file is older than 5s but unreadable
            console.warn(`[RecordingIndexer] Quarantine corrupt segment: ${filePath}`);
            const quarantinedPath = path.join(corruptedDir, `${streamPath}_${file}`);
            try {
              fs.renameSync(filePath, quarantinedPath);
              await this.prisma.event.create({
                data: {
                  cameraId: camera.id,
                  type: 'CORRUPTED_SEGMENT',
                  severity: 'WARNING',
                  title: 'Corrupted Recording Segment Quarantined',
                  description: `Segment ${file} failed ffprobe inspection and was moved to corrupted quarantine.`,
                  metadata: { originalPath: filePath, quarantinedPath, sizeBytes: stats.size },
                },
              });
            } catch (err) {
              console.error(`Failed to move corrupt file:`, err);
            }
            continue;
          }

          // Valid segment: compute start and end times
          const startTime = this.parseStartTimeFromFilename(file, stats.mtime);
          const durationMs = Math.round(probe.durationSeconds * 1000);
          const endTime = new Date(startTime.getTime() + durationMs);

          // Check for recording gap with the last finalized segment of this camera
          const lastSegment = await this.prisma.recordingSegment.findFirst({
            where: { cameraId: camera.id },
            orderBy: { endTime: 'desc' },
          });

          if (lastSegment && camera.recordingMode === 'CONTINUOUS') {
            const gapMs = startTime.getTime() - lastSegment.endTime.getTime();
            if (gapMs > 15000) {
              // Gap > 15 seconds in continuous recording mode
              await this.prisma.event.create({
                data: {
                  cameraId: camera.id,
                  type: 'RECORDING_GAP',
                  severity: 'WARNING',
                  title: 'Continuous Recording Gap Detected',
                  description: `Missing footage interval of ${Math.round(gapMs / 1000)} seconds detected between continuous segments.`,
                  startTime: lastSegment.endTime,
                  endTime: startTime,
                  metadata: {
                    previousSegmentId: lastSegment.id,
                    gapSeconds: Math.round(gapMs / 1000),
                  },
                },
              });
            }
          }

          // Compute SHA-256
          const sha256 = await computeFileSha256(filePath);

          await this.prisma.recordingSegment.create({
            data: {
              cameraId: camera.id,
              filePath,
              startTime,
              endTime,
              durationMs,
              sizeBytes: BigInt(stats.size),
              sha256Hash: sha256,
              codec: probe.videoCodec,
              width: probe.width,
              height: probe.height,
              fps: probe.fps,
              status: 'FINALIZED',
            },
          });

          indexedCount++;
        }
      }
    } finally {
      this.isScanning = false;
    }

    return indexedCount;
  }
}
