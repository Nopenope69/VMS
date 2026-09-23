import { PrismaClient, RedactionMode, RedactionJob, RedactionJobStatus } from '@prisma/client';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
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
        modelVersion: input.modelVersion,
        maskMetadataJson: input.masks ? (input.masks as any) : [],
        createdByUserId: input.createdByUserId,
      },
    });
  }

  public generateFfmpegFilter(
    mode: RedactionMode,
    masks: TemporalMask[],
    videoWidth: number = 1920,
    videoHeight: number = 1080
  ): FfmpegFilterResult {
    if (!masks || masks.length === 0) {
      return { filterComplex: 'copy', totalMasks: 0, estimatedEncodingOverheadMs: 0 };
    }

    const filters: string[] = [];
    masks.forEach((m) => {
      const x = Math.max(0, Math.min(videoWidth - 1, Math.round(m.x)));
      const y = Math.max(0, Math.min(videoHeight - 1, Math.round(m.y)));
      const w = Math.max(1, Math.min(videoWidth - x, Math.round(m.width)));
      const h = Math.max(1, Math.min(videoHeight - y, Math.round(m.height)));
      const tStart = Math.max(0, m.startSec);
      const tEnd = Math.max(tStart, m.endSec);

      filters.push(
        mode === RedactionMode.STATIC_MASK
          ? `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=black@1.0:t=fill:enable='between(t,${tStart},${tEnd})'`
          : `delogo=x=${x}:y=${y}:w=${w}:h=${h}:enable='between(t,${tStart},${tEnd})'`
      );
    });

    return {
      filterComplex: filters.join(','),
      totalMasks: masks.length,
      estimatedEncodingOverheadMs: masks.length * 150,
    };
  }

  /**
   * Executes a queued redaction job and records derivative lineage.
   *
   * The FFmpeg redaction worker is not wired into this service yet. Until it is,
   * this method deliberately fails closed. A hash is calculated only from the
   * output file produced by that worker; it is never derived from job metadata.
   */
  public async executeRedactionJob(jobId: string): Promise<RedactionJob> {
    const job = await this.prisma.redactionJob.findUnique({
      where: { id: jobId },
      include: { sourceManifest: true },
    });
    if (!job) {
      throw new Error(`RedactionJob ${jobId} not found`);
    }

    await this.prisma.redactionJob.update({
      where: { id: jobId },
      data: { status: RedactionJobStatus.PROCESSING },
    });

    // EXPORTS_DIR is the same recording/export volume used by the backend
    // container. Do not resolve derivatives relative to the process cwd.
    const outputPath = path.join(
      process.env.EXPORTS_DIR || '/recordings/exports',
      'derivatives',
      job.tenantId,
      `${job.id}.mp4`
    );
    const derivativeObjectKey = `derivatives/${job.tenantId}/${job.id}.mp4`;

    if (!fs.existsSync(outputPath)) {
      const error = `Redaction output file was not produced: ${outputPath}`;
      await this.prisma.redactionJob.update({
        where: { id: jobId },
        data: { status: RedactionJobStatus.FAILED, errorMessage: error },
      });
      throw new Error(error);
    }

    const derivativeSha256 = await this.hashFile(outputPath);
    const completedJob = await this.prisma.redactionJob.update({
      where: { id: jobId },
      data: {
        status: RedactionJobStatus.COMPLETED,
        outputObjectKey: derivativeObjectKey,
        outputSha256: derivativeSha256,
        completedAt: new Date(),
      },
    });

    await this.chainOfCustody.logEvent({
      tenantId: job.tenantId,
      evidenceId: job.sourceManifestId,
      actorUserId: job.createdByUserId,
      action: 'EVIDENCE_REDACTED',
      sourceHash: job.sourceManifest.masterEvidenceHash,
      resultHash: derivativeSha256,
      metadata: { redactionJobId: job.id, redactionMode: job.redactionMode, derivativeObjectKey, derivativeSha256 },
    });

    return completedJob;
  }

  private hashFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('error', reject);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }
}
