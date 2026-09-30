/**
 * Off-site archive of recording segments to S3-compatible object storage (Phase 6).
 *
 *  - What: finalized RecordingSegments of tenants whose archive is enabled. Jobs are created by a scan (and by
 *    an administrator for one segment id); the file path always comes from the recording index, never from a
 *    caller, so nothing outside the recordings can be uploaded.
 *  - When: in the tenant's off-peak window, except segments pinned as evidence (an active EvidencePin), which
 *    go first and at any time.
 *  - How: the object key is content-addressed (archive/<tenant>/<camera>/<sha256>.fmp4). The file's SHA-256 is
 *    checked against the index before upload, the upload is signed with that SHA-256 (the store refuses a body
 *    that differs) and carries it as metadata, and a HEAD afterwards must show the same size and SHA-256 before
 *    the job is COMPLETED. An object already there with the same SHA-256 is not uploaded again.
 *  - Failure: an attempt that fails is retried up to maxAttempts, then FAILED with the reason. Nothing is
 *    deleted locally by this service; local retention is unchanged.
 */
import crypto from 'crypto';
import fs from 'fs';
import { PrismaClient, ArchiveJobStatus } from '@prisma/client';
import { decryptCredential } from '../../utils/crypto';
import { HeadResult, S3Client, S3Config } from './s3Client';
import { MetricsService } from '../observability/metrics.service';

export interface ArchiveStore {
  head(key: string): Promise<HeadResult | null>;
  putFile(key: string, file: string, sha256: string, sizeBytes: number, opts?: { bandwidthKbps?: number }): Promise<void>;
}

export interface UploadResult {
  jobId: string;
  objectKey: string;
  sha256Checksum: string;
  skippedDuplicate: boolean;
  status: 'COMPLETED' | 'FAILED' | 'DEFERRED' | 'RETRY';
  error?: string;
}

const METRIC = 'vigilone_archive_jobs_total';
const HELP = 'Off-site archive job outcomes';

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/** Builds the S3 client from a tenant's stored configuration (credentials decrypted here, never returned). */
export function storeFromConfig(cfg: { endpoint: string | null; region: string; bucket: string; accessKeyEncrypted: string; secretKeyEncrypted: string }): ArchiveStore {
  let accessKeyId: string;
  let secretAccessKey: string;
  try {
    accessKeyId = decryptCredential(cfg.accessKeyEncrypted);
    secretAccessKey = decryptCredential(cfg.secretKeyEncrypted);
  } catch {
    throw new Error('the stored object-storage credentials cannot be decrypted; enter them again');
  }
  const s3: S3Config = { endpoint: cfg.endpoint, region: cfg.region, bucket: cfg.bucket, accessKeyId, secretAccessKey };
  return new S3Client(s3);
}

export class ObjectStorageArchiveService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly storeFactory: (cfg: Parameters<typeof storeFromConfig>[0]) => ArchiveStore = storeFromConfig
  ) {}

  /** Whether `now` is inside the off-peak window [start, end] in UTC (a window may cross midnight). */
  public isOffPeakNow(startUtc: string, endUtc: string, now: Date = new Date()): boolean {
    const currentMins = now.getUTCHours() * 60 + now.getUTCMinutes();
    const [startH, startM] = startUtc.split(':').map(Number);
    const [endH, endM] = endUtc.split(':').map(Number);
    const startTotal = startH * 60 + startM;
    const endTotal = endH * 60 + endM;
    if (startTotal <= endTotal) return currentMins >= startTotal && currentMins <= endTotal;
    return currentMins >= startTotal || currentMins <= endTotal; // midnight crossover, e.g. 23:00 to 05:00
  }

  /** Queues one indexed, finalized segment of this tenant. Pinned evidence is queued with priority. */
  public async queueSegment(tenantId: string, segmentId: string, priority = false) {
    const seg = await this.prisma.recordingSegment.findUnique({ where: { id: segmentId } });
    if (!seg || seg.tenantId !== tenantId) throw Object.assign(new Error('segment not found'), { statusCode: 404 });
    if (seg.status !== 'FINALIZED' || !seg.sha256Hash) throw Object.assign(new Error(`segment is ${seg.status}${seg.sha256Hash ? '' : ' without a SHA-256'}; only finalized, hashed segments are archived`), { statusCode: 409 });
    const pinned = (await this.prisma.evidencePin.count({ where: { segmentId, releasedAt: null, expiresAt: { gt: new Date() } } })) > 0;
    const objectKey = `archive/${tenantId}/${seg.cameraId}/${seg.sha256Hash}.fmp4`;
    return this.prisma.archiveJob.upsert({
      where: { tenantId_segmentPath: { tenantId, segmentPath: seg.filePath } },
      create: { tenantId, segmentPath: seg.filePath, sha256Checksum: seg.sha256Hash, sizeBytes: seg.sizeBytes, objectKey, priority: priority || pinned, status: ArchiveJobStatus.QUEUED },
      update: { priority: priority || pinned },
    });
  }

  /**
   * Queues finalized segments of archive-enabled tenants that have no job yet, and raises the priority of queued
   * jobs whose segment has since been pinned. Returns how many jobs were created.
   */
  public async scan(limit = 500): Promise<number> {
    const tenants = await this.prisma.objectStorageConfig.findMany({ where: { enabled: true }, select: { tenantId: true } });
    let created = 0;
    for (const { tenantId } of tenants) {
      const segs = await this.prisma.$queryRaw<Array<{ id: string; filePath: string; cameraId: string; sha256Hash: string; sizeBytes: bigint; pinned: boolean }>>`
        SELECT s."id", s."filePath", s."cameraId", s."sha256Hash", s."sizeBytes",
               EXISTS (SELECT 1 FROM "EvidencePin" p WHERE p."segmentId" = s."id" AND p."releasedAt" IS NULL AND p."expiresAt" > now()) AS "pinned"
        FROM "RecordingSegment" s
        WHERE s."tenantId" = ${tenantId} AND s."status" = 'FINALIZED' AND s."sha256Hash" IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM "ArchiveJob" j WHERE j."tenantId" = ${tenantId} AND j."segmentPath" = s."filePath")
        ORDER BY 6 DESC, s."startTime" ASC
        LIMIT ${limit}`;
      if (segs.length) {
        const r = await this.prisma.archiveJob.createMany({
          data: segs.map((s) => ({ tenantId, segmentPath: s.filePath, sha256Checksum: s.sha256Hash, sizeBytes: s.sizeBytes, objectKey: `archive/${tenantId}/${s.cameraId}/${s.sha256Hash}.fmp4`, priority: s.pinned, status: ArchiveJobStatus.QUEUED })),
          skipDuplicates: true,
        });
        created += r.count;
      }
      await this.prisma.$executeRaw`
        UPDATE "ArchiveJob" j SET "priority" = true
        FROM "RecordingSegment" s
        WHERE j."tenantId" = ${tenantId} AND j."status" = 'QUEUED' AND j."priority" = false AND s."filePath" = j."segmentPath"
          AND EXISTS (SELECT 1 FROM "EvidencePin" p WHERE p."segmentId" = s."id" AND p."releasedAt" IS NULL AND p."expiresAt" > now())`;
    }
    return created;
  }

  private async outcome(jobId: string, attempts: number, maxAttempts: number, error: string): Promise<'FAILED' | 'RETRY'> {
    const final = attempts >= maxAttempts;
    await this.prisma.archiveJob.update({ where: { id: jobId }, data: { status: final ? ArchiveJobStatus.FAILED : ArchiveJobStatus.QUEUED, error: error.slice(0, 1000) } });
    MetricsService.incCounter(METRIC, HELP, { outcome: final ? 'failed' : 'retry' });
    return final ? 'FAILED' : 'RETRY';
  }

  /** Processes one job. Outside the off-peak window a non-priority job is DEFERRED (left QUEUED). */
  public async processArchiveJob(jobId: string, now: Date = new Date()): Promise<UploadResult> {
    const job = await this.prisma.archiveJob.findUnique({ where: { id: jobId }, include: { tenant: { include: { objectStorageConfig: true } } } });
    if (!job) throw new Error(`Archive job ${jobId} not found`);
    const base = { jobId, objectKey: job.objectKey, sha256Checksum: job.sha256Checksum, skippedDuplicate: false };
    const config = job.tenant.objectStorageConfig;
    if (!config || !config.enabled) throw new Error('Object storage archival is not configured or disabled for this tenant');
    if (job.status === ArchiveJobStatus.COMPLETED) return { ...base, status: 'COMPLETED' };

    if (!job.priority && !this.isOffPeakNow(config.offPeakStartUtc, config.offPeakEndUtc, now)) {
      return { ...base, status: 'DEFERRED', error: 'outside the off-peak window (only pinned evidence is archived now)' };
    }
    const attempts = job.attempts + 1;
    await this.prisma.archiveJob.update({ where: { id: jobId }, data: { status: ArchiveJobStatus.UPLOADING, attempts } });
    try {
      const store = this.storeFactory(config);
      // The local file must still be the file that was indexed.
      if (!fs.existsSync(job.segmentPath)) throw new Error('the segment file is gone locally (retention or removal)');
      const actual = await sha256File(job.segmentPath);
      if (actual !== job.sha256Checksum) {
        await this.prisma.archiveJob.update({ where: { id: jobId }, data: { status: ArchiveJobStatus.FAILED, error: `the local file's SHA-256 ${actual} does not match the index (${job.sha256Checksum}); not uploaded` } });
        MetricsService.incCounter(METRIC, HELP, { outcome: 'corrupt' });
        return { ...base, status: 'FAILED', error: 'SHA-256 checksum verification failed before upload' };
      }
      const size = Number(job.sizeBytes);
      const existing = await store.head(job.objectKey);
      let skippedDuplicate = false;
      if (existing && existing.sha256 === job.sha256Checksum && existing.sizeBytes === size) {
        skippedDuplicate = true;
      } else {
        await store.putFile(job.objectKey, job.segmentPath, job.sha256Checksum, size, { bandwidthKbps: config.bandwidthLimitKbps });
        const check = await store.head(job.objectKey);
        if (!check || check.sha256 !== job.sha256Checksum || check.sizeBytes !== size) {
          throw new Error(`after upload the store reports ${check ? `${check.sizeBytes} bytes, SHA-256 ${check.sha256}` : 'no object'}; expected ${size} bytes, ${job.sha256Checksum}`);
        }
      }
      await this.prisma.archiveJob.update({ where: { id: jobId }, data: { status: ArchiveJobStatus.COMPLETED, uploadedAt: new Date(), error: null } });
      MetricsService.incCounter(METRIC, HELP, { outcome: skippedDuplicate ? 'already_stored' : 'uploaded' });
      return { ...base, skippedDuplicate, status: 'COMPLETED' };
    } catch (e: any) {
      const status = await this.outcome(jobId, attempts, job.maxAttempts, e.message || String(e));
      return { ...base, status, error: e.message };
    }
  }

  /** Runs queued jobs, pinned evidence first. Returns the outcomes. */
  public async runPending(now: Date = new Date(), limit = 20): Promise<UploadResult[]> {
    const jobs = await this.prisma.archiveJob.findMany({
      where: { status: ArchiveJobStatus.QUEUED, tenant: { objectStorageConfig: { enabled: true } } },
      orderBy: [{ priority: 'desc' }, { queuedAt: 'asc' }],
      take: limit,
      select: { id: true },
    });
    const out: UploadResult[] = [];
    for (const j of jobs) out.push(await this.processArchiveJob(j.id, now));
    return out;
  }
}

/** Background archive worker (flag OBJECT_STORAGE_ARCHIVE). An invalid interval refuses to start. */
export class ArchiveWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  constructor(private readonly service: ObjectStorageArchiveService) {}
  async runOnce(now = new Date()) {
    if (this.running) return null;
    this.running = true;
    try {
      const queued = await this.service.scan();
      const results = await this.service.runPending(now);
      return { queued, results };
    } finally {
      this.running = false;
    }
  }
  start(intervalMs: number) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce().catch((e) => console.error(`[Archive] run failed: ${e.message}`)), intervalMs);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export function archiveIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ARCHIVE_INTERVAL_MS;
  if (raw === undefined || raw.trim() === '') return 60_000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1000) throw new Error(`ARCHIVE_INTERVAL_MS must be a whole number of at least 1000 milliseconds, got "${raw}"`);
  return n;
}
