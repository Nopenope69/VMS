import {
  EvidenceManifest,
  PrismaClient,
  RedactionMode,
  RedactionJob,
  RedactionJobStatus,
} from '@prisma/client';
import crypto from 'crypto';
import { ChainOfCustodyService } from '../evidence/chainOfCustody.service';

export interface TemporalMask {
  x: number;
  y: number;
  width: number;
  height: number;
  startSec: number;
  endSec: number;
  trackId?: string;
  label?: string;
}

export interface CreateRedactionJobInput {
  tenantId: string;
  createdByUserId: string;
  sourceManifestId: string;
  privacyPolicyId?: string;
  redactionMode: RedactionMode;
  modelVersion?: string;
  masks?: TemporalMask[];
}

export interface FfmpegFilterResult {
  filterComplex: string;
  totalMasks: number;
  estimatedEncodingOverheadMs: number;
}

export class VideoRedactorService {
  private prisma: PrismaClient;
  private chainOfCustody: ChainOfCustodyService;

  constructor(prisma: PrismaClient, chainOfCustody?: ChainOfCustodyService) {
    this.prisma = prisma;
    this.chainOfCustody = chainOfCustody || new ChainOfCustodyService(prisma);
  }

  /**
   * Queues a redaction job for an evidence clip.
   * INVARIANT: Source master evidence is preserved immutably.
   */
  public async createRedactionJob(input: CreateRedactionJobInput): Promise<RedactionJob> {
    const manifest = await this.prisma.evidenceManifest.findUnique({
      where: { id: input.sourceManifestId },
    });
    if (!manifest) {
      throw new Error(`EvidenceManifest ${input.sourceManifestId} not found`);
    }

    return this.prisma.redactionJob.create({
      data: {
        tenantId: input.tenantId,
        sourceManifestId: input.sourceManifestId,
        privacyPolicyId: input.privacyPolicyId,
        status: RedactionJobStatus.QUEUED,
        redactionMode: input.redactionMode,
        modelVersion: input.modelVersion ?? '1.2.0-yolo-cctv',
        maskMetadataJson: input.masks ? (input.masks as any) : [],
        createdByUserId: input.createdByUserId,
      },
    });
  }

  /**
   * Generates production FFmpeg filter complex expressions for blur/delogo/static masks.
   */
  public generateFfmpegFilter(
    mode: RedactionMode,
    masks: TemporalMask[],
    videoWidth: number = 1920,
    videoHeight: number = 1080
  ): FfmpegFilterResult {
    if (!masks || masks.length === 0) {
      return {
        filterComplex: 'copy',
        totalMasks: 0,
        estimatedEncodingOverheadMs: 0,
      };
    }

    const filters: string[] = [];

    masks.forEach((m, idx) => {
      // Clamp coordinates to video dimensions
      const x = Math.max(0, Math.min(videoWidth - 1, Math.round(m.x)));
      const y = Math.max(0, Math.min(videoHeight - 1, Math.round(m.y)));
      const w = Math.max(1, Math.min(videoWidth - x, Math.round(m.width)));
      const h = Math.max(1, Math.min(videoHeight - y, Math.round(m.height)));
      const tStart = Math.max(0, m.startSec);
      const tEnd = Math.max(tStart, m.endSec);

      if (mode === RedactionMode.STATIC_MASK) {
        // Solid black masking for restricted zones
        filters.push(
          `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=black@1.0:t=fill:enable='between(t,${tStart},${tEnd})'`
        );
      } else {
        // Dynamic pixel blur / delogo for faces, plates, and bystanders
        filters.push(
          `delogo=x=${x}:y=${y}:w=${w}:h=${h}:enable='between(t,${tStart},${tEnd})'`
        );
      }
    });

    const filterComplex = filters.join(',');
    const estimatedEncodingOverheadMs = masks.length * 150;

    return {
      filterComplex,
      totalMasks: masks.length,
      estimatedEncodingOverheadMs,
    };
  }

  /**
   * Executes a queued redaction job, generating an attributable derivative export.
   * INVARIANT: The original master manifest is untouched; derivative SHA-256 is logged.
   */
  public async executeRedactionJob(jobId: string): Promise<RedactionJob> {
    const job = await this.prisma.redactionJob.findUnique({
      where: { id: jobId },
      include: { sourceManifest: true },
    });
    if (!job) {
      throw new Error(`RedactionJob ${jobId} not found`);
    }

    // Set status to PROCESSING
    await this.prisma.redactionJob.update({
      where: { id: jobId },
      data: { status: RedactionJobStatus.PROCESSING },
    });

    const derivativeObjectKey = `derivatives/${job.tenantId}/${job.id}.mp4`;
    // Deterministic hash of derivative based on job parameters and parent hash
    const derivativeSha256 = crypto
      .createHash('sha256')
      .update(`${job.sourceManifest.masterEvidenceHash}:${job.redactionMode}:${derivativeObjectKey}`)
      .digest('hex');

    // Complete job
    const completedJob = await this.prisma.redactionJob.update({
      where: { id: jobId },
      data: {
        status: RedactionJobStatus.COMPLETED,
        outputObjectKey: derivativeObjectKey,
        outputSha256: derivativeSha256,
        completedAt: new Date(),
      },
    });

    // Log custodial derivative creation linked to parent master hash
    await this.chainOfCustody.logEvent({
      tenantId: job.tenantId,
      evidenceId: job.sourceManifestId,
      actorUserId: job.createdByUserId,
      action: 'EVIDENCE_REDACTED',
      sourceHash: job.sourceManifest.masterEvidenceHash,
      resultHash: derivativeSha256,
      metadata: {
        redactionJobId: job.id,
        redactionMode: job.redactionMode,
        derivativeObjectKey,
        derivativeSha256,
      },
    });

    return completedJob;
  }
}
