import fs from 'fs';
import path from 'path';
import { PrismaClient, SegmentStatus, JobStatus } from '@prisma/client';
import { generate64CameraTopology, CameraWorkloadProfile } from '../config/soakTopology';
import { formatSegmentFilename, calculateSegmentBounds } from '../utils/segmentPath';
import { computeFileSha256 } from '../utils/crypto';
import config from '../config/env';

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface SoakCycleMetrics {
  cycleNumber: number;
  totalCameras: number;
  segmentsCreated: number;
  segmentsIndexed: number;
  zeroByteFiles: number;
  footageLossGaps: number;
  averageWorkerLatencyMs: number;
  quarantinedSegments: number;
  storageUsageBytes: number;
}

export class SoakTestHarness {
  private prisma: PrismaClient;
  private topology: CameraWorkloadProfile[];
  private baseDir: string;

  constructor(prisma: PrismaClient, baseDir?: string) {
    this.prisma = prisma;
    this.topology = generate64CameraTopology();
    this.baseDir = baseDir || config.RECORDINGS_DIR || '/var/lib/vigilone/recordings';
  }

  /**
   * Generates a genuine fragmented MP4 file with moof/mdat atoms using FFmpeg
   */
  public async generateRealFmp4Segment(filePath: string, durationSec = 2): Promise<void> {
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi',
      '-i', `testsrc=duration=${durationSec}:size=320x240:rate=10`,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-f', 'mp4',
      '-movflags', '+empty_moov+default_base_moof+frag_keyframe',
      filePath,
    ]);
  }

  /**
   * Initializes 64 cameras from topology into database
   */
  async provisionCameras(tenantId: string, siteId?: string): Promise<number> {
    let created = 0;
    let targetSiteId = siteId;
    if (!targetSiteId && typeof (this.prisma as any).site?.findFirst === 'function') {
      const defaultSite = await this.prisma.site.findFirst({ where: { tenantId } });
      if (defaultSite) {
        targetSiteId = defaultSite.id;
      } else if (typeof (this.prisma as any).site?.create === 'function') {
        const createdSite = await this.prisma.site.create({
          data: { tenantId, name: 'Primary Soak Test Facility' },
        });
        targetSiteId = createdSite.id;
      }
    }
    targetSiteId = targetSiteId || `site-${tenantId}`;

    for (let index = 0; index < this.topology.length; index++) {
      const cam = this.topology[index];
      const existing = await this.prisma.camera.findFirst({
        where: { OR: [{ id: cam.id }, { streamPath: cam.streamPath }] },
      });

      if (!existing) {
        await this.prisma.camera.create({
          data: {
            id: cam.id,
            tenantId,
            siteId: targetSiteId,
            ipAddress: `192.168.10.${(index % 250) + 1}`,
            name: cam.name,
            streamPath: cam.streamPath,
            desiredRecorderState: 'RUNNING',
            mainRtspUri: `rtsp://mock-camera-feed:554/${cam.streamPath}`,
            manufacturer: cam.manufacturer,
            model: cam.model,
            firmwareVersion: cam.firmwareVersion,
          },
        });
        created++;
      }
    }
    return created;
  }

  /**
   * Simulates a synchronized recording segment generation cycle across cameras.
   * Can use synthetic payloads for pure scale simulation or real FFmpeg fMP4 generation.
   */
  async simulateSegmentCycle(
    cycleIndex: number,
    timestampUtc: Date,
    segmentDurationSec = 600,
    options?: { useRealFmp4?: boolean; cameraSubset?: number }
  ): Promise<SoakCycleMetrics> {
    let segmentsCreated = 0;
    let segmentsIndexed = 0;
    let zeroByteFiles = 0;
    let footageLossGaps = 0;
    let totalWorkerLatencyMs = 0;
    let storageUsageBytes = 0;

    const durationMs = segmentDurationSec * 1000;
    const targetCams = options?.cameraSubset
      ? this.topology.slice(0, options.cameraSubset)
      : this.topology;

    for (const cam of targetCams) {
      const camDir = path.join(this.baseDir, cam.streamPath);
      if (!fs.existsSync(camDir)) {
        fs.mkdirSync(camDir, { recursive: true });
      }

      const filename = formatSegmentFilename(timestampUtc, 'mp4');
      const filePath = path.join(camDir, filename);

      if (options?.useRealFmp4) {
        // Generate real fragmented MP4 using FFmpeg with explicit moof/mdat atoms
        await this.generateRealFmp4Segment(filePath, Math.min(segmentDurationSec, 2));
      } else {
        // Fast synthetic test payload
        const mockPayload = Buffer.from(
          `VIGILONE_64_SOAK_STREAM_COHORT_${cam.cohort}_CAM_${cam.id}_CYCLE_${cycleIndex}`
        );
        fs.writeFileSync(filePath, mockPayload);
      }
      segmentsCreated++;

      const stat = fs.statSync(filePath);
      if (stat.size === 0) {
        zeroByteFiles++;
        continue;
      }
      storageUsageBytes += stat.size;

      const workerStart = Date.now();
      const bounds = calculateSegmentBounds(filePath, durationMs);
      const sha256 = await computeFileSha256(filePath);

      // Index segment
      const cameraRecord = await this.prisma.camera.findFirst({
        where: { streamPath: cam.streamPath },
        select: { id: true, tenantId: true },
      });

      if (cameraRecord) {
        await this.prisma.recordingSegment.upsert({
          where: { filePath },
          update: {
            status: SegmentStatus.FINALIZED,
            sizeBytes: BigInt(stat.size),
            sha256Hash: sha256,
          },
          create: {
            tenantId: cameraRecord.tenantId,
            cameraId: cameraRecord.id,
            filePath,
            startTime: bounds.startTime,
            endTime: bounds.endTime,
            durationMs: bounds.durationMs,
            sizeBytes: BigInt(stat.size),
            sha256Hash: sha256,
            codec: cam.codec,
            status: SegmentStatus.FINALIZED,
          },
        });
        segmentsIndexed++;
      } else {
        footageLossGaps++;
      }

      totalWorkerLatencyMs += Date.now() - workerStart;
    }

    return {
      cycleNumber: cycleIndex,
      totalCameras: this.topology.length,
      segmentsCreated,
      segmentsIndexed,
      zeroByteFiles,
      footageLossGaps,
      averageWorkerLatencyMs: this.topology.length > 0 ? totalWorkerLatencyMs / this.topology.length : 0,
      quarantinedSegments: 0,
      storageUsageBytes,
    };
  }
}

export default SoakTestHarness;
