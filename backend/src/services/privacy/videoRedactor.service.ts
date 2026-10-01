/**
 * Video redaction (P4.4): a derivative of one camera's footage from an evidence manifest, with faces
 * and/or plates (detected by the redaction adapter) and manual regions burnt in as opaque boxes.
 *
 * Order of work, every step failing closed with a RedactionError code:
 *   1. source: the manifest's segments for the camera; each file's SHA-256 must equal the hash the
 *      manifest recorded; concatenated by stream copy into a private work directory
 *   2. detection: frames sampled at sampleFps, sent to the adapter; provenance checked per result
 *   3. masks: planMasks() over the samples, plus manual masks
 *   4. render: ffmpeg re-encode with the mask filter (libx264, no audio)
 *   5. verify: output exists, is non-empty, decodes, same size and duration; up to five masks are
 *      checked in the decoded output to be opaque
 *   6. publish: atomic rename into EXPORTS_DIR/derivatives/<tenant>/<job>.mp4, SHA-256 of the real
 *      bytes, job COMPLETED, chain-of-custody EVIDENCE_REDACTED linking master and derivative hashes
 * The master evidence is never written.
 */
import { PrismaClient, RedactionJob, RedactionJobStatus, RedactionMode } from '@prisma/client';
import { execFile, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { ChainOfCustodyService } from '../evidence/chainOfCustody.service';
import { FFmpegService } from '../ffmpeg/ffmpeg.service';
import { MetricsService } from '../observability/metrics.service';
import { buildMaskFilter, planMasks, PlannedMask, SampledDetection } from './maskPlanner';
import { RedactionError } from './redactionErrors';
import { isFaceProcessingEnabled } from './dataProtection.service';
import { DetectorProvenance, RedactionRegionClient, RegionTask } from './redactionRegionClient';
import { setting } from '../../config/settings';

export { RedactionError } from './redactionErrors';

export const TemporalMaskSchema = z
  .object({
    x: z.number().min(0),
    y: z.number().min(0),
    width: z.number().positive(),
    height: z.number().positive(),
    startSec: z.number().min(0),
    endSec: z.number().min(0),
    label: z.string().max(64).optional(),
  })
  .strict()
  .refine((m) => m.endSec >= m.startSec, 'endSec must be >= startSec');
export type TemporalMask = z.infer<typeof TemporalMaskSchema>;

export type DetectKind = 'FACE' | 'LICENSE_PLATE';

export interface CreateRedactionJobInput {
  tenantId: string;
  createdByUserId: string;
  sourceManifestId: string;
  privacyPolicyId?: string;
  redactionMode: RedactionMode;
  cameraId?: string;
  /** Extra kinds to detect on top of the mode's own (e.g. plates in a FACE job). */
  detectKinds?: DetectKind[];
  sampleFps?: number;
  masks?: TemporalMask[];
}

export interface RenderRequest {
  sourcePath: string;
  filterScriptPath: string;
  outputPath: string;
}

/** Runs the render; must write outputPath or throw. Replaceable in tests. */
export type Renderer = (r: RenderRequest) => Promise<void>;

export interface VideoRedactorOptions {
  renderer?: Renderer;
  regionClient?: (prisma: PrismaClient) => RedactionRegionClient;
  exportsDir?: () => string;
  maxClipSeconds?: number;
}

const MODE_KINDS: Record<RedactionMode, DetectKind[] | null> = {
  FACE: ['FACE'],
  LICENSE_PLATE: ['LICENSE_PLATE'],
  STATIC_MASK: [],
  BYSTANDER: null, // needs a person detector wired for redaction: not implemented
};

const TASK_OF: Record<DetectKind, RegionTask> = { FACE: 'face_detection_for_redaction', LICENSE_PLATE: 'plate_detection_for_redaction' };

function runFfmpeg(args: string[], timeoutMs = 30 * 60 * 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err = (err + d.toString()).slice(-4000)));
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => {
      clearTimeout(t);
      reject(new RedactionError('REDACTION_FFMPEG_FAILED', e.message));
    });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve();
      else reject(new RedactionError('REDACTION_FFMPEG_FAILED', `ffmpeg exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

export const ffmpegRenderer: Renderer = ({ sourcePath, filterScriptPath, outputPath }) =>
  runFfmpeg(['-v', 'error', '-nostdin', '-y', '-i', sourcePath, '-filter_script:v', filterScriptPath, '-map', '0:v:0', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outputPath]);

export async function ffmpegVersion(): Promise<string | null> {
  return FFmpegService.version();
}

async function sha256File(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')));
  });
}

/** Mean luma of a region of one decoded frame (0..255). */
function regionLuma(file: string, t: number, m: { x: number; y: number; width: number; height: number }): Promise<number> {
  const inset = 2;
  const w = Math.max(1, m.width - 2 * inset);
  const h = Math.max(1, m.height - 2 * inset);
  return new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      ['-v', 'error', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-vf', `crop=${w}:${h}:${m.x + inset}:${m.y + inset},format=gray`, '-f', 'rawvideo', '-'],
      { encoding: 'buffer', maxBuffer: 64 << 20 },
      (e, out) => {
        if (e || !out || out.length === 0) return reject(new RedactionError('REDACTION_OUTPUT_INVALID', `cannot decode the output at t=${t.toFixed(3)}s`));
        let s = 0;
        for (const v of out as Buffer) s += v;
        resolve(s / (out as Buffer).length);
      }
    );
  });
}

export class VideoRedactorService {
  private chainOfCustody: ChainOfCustodyService;
  private renderer: Renderer;
  private makeClient: (prisma: PrismaClient) => RedactionRegionClient;
  private exportsDir: () => string;
  private maxClipSeconds: number;

  constructor(private prisma: PrismaClient, chainOfCustody?: ChainOfCustodyService, opts: VideoRedactorOptions = {}) {
    this.chainOfCustody = chainOfCustody || new ChainOfCustodyService(prisma);
    this.renderer = opts.renderer ?? ffmpegRenderer;
    this.makeClient = opts.regionClient ?? ((p) => new RedactionRegionClient(p, setting('REDACTION_ADAPTER_URL')!));
    this.exportsDir = opts.exportsDir ?? (() => setting('EXPORTS_DIR'));
    this.maxClipSeconds = opts.maxClipSeconds ?? setting('REDACTION_MAX_CLIP_SECONDS');
  }

  /** Queues a redaction job. The source manifest must belong to the tenant. */
  public async createRedactionJob(input: CreateRedactionJobInput): Promise<RedactionJob> {
    const manifest = await this.prisma.evidenceManifest.findUnique({ where: { id: input.sourceManifestId } });
    if (!manifest || manifest.tenantId !== input.tenantId) {
      throw new RedactionError('REDACTION_SOURCE_NOT_FOUND', `EvidenceManifest ${input.sourceManifestId} not found`, 404);
    }
    const modeKinds = MODE_KINDS[input.redactionMode];
    if (modeKinds === null) throw new RedactionError('REDACTION_MODE_UNSUPPORTED', `${input.redactionMode} redaction needs a person detector, which is not available`, 400);
    const detectKinds = [...new Set([...modeKinds, ...(input.detectKinds || [])])];
    if (detectKinds.includes('FACE') && !(await isFaceProcessingEnabled(this.prisma, input.tenantId))) {
      throw new RedactionError('REDACTION_FACE_PROCESSING_DISABLED', 'face processing is switched off for this tenant (DPDP settings); use manual masks or enable it', 403);
    }
    const masks = (input.masks || []).map((m) => TemporalMaskSchema.parse(m));
    if (detectKinds.length === 0 && masks.length === 0) {
      throw new RedactionError('REDACTION_MODE_UNSUPPORTED', 'nothing to redact: give masks or detection kinds', 400);
    }
    const cams = (Array.isArray(manifest.cameraIdsJson) ? manifest.cameraIdsJson : []) as string[];
    const cameraId = input.cameraId ?? (cams.length === 1 ? cams[0] : undefined);
    if (!cameraId || (cams.length && !cams.includes(cameraId))) {
      throw new RedactionError('REDACTION_CAMERA_REQUIRED', `the manifest covers cameras [${cams.join(', ')}]; name one of them`, 400);
    }
    const sampleFps = input.sampleFps ?? 4;
    if (!(sampleFps >= 0.5 && sampleFps <= 10)) throw new RedactionError('REDACTION_MODE_UNSUPPORTED', 'sampleFps must be between 0.5 and 10', 400);

    return this.prisma.redactionJob.create({
      data: {
        tenantId: input.tenantId,
        sourceManifestId: input.sourceManifestId,
        privacyPolicyId: input.privacyPolicyId,
        status: RedactionJobStatus.QUEUED,
        redactionMode: input.redactionMode,
        cameraId,
        detectKinds,
        sampleFps,
        maskMetadataJson: masks as any,
        createdByUserId: input.createdByUserId,
      },
    });
  }

  /** Executes a QUEUED job end to end; on any failure the job is FAILED with a code and nothing is published. */
  public async executeRedactionJob(jobId: string): Promise<RedactionJob> {
    const job = await this.prisma.redactionJob.findUnique({ where: { id: jobId }, include: { sourceManifest: true } });
    if (!job) throw new RedactionError('REDACTION_SOURCE_NOT_FOUND', `RedactionJob ${jobId} not found`, 404);
    if (job.status !== RedactionJobStatus.QUEUED) throw new RedactionError('REDACTION_INVALID_STATE', `job is ${job.status}, not QUEUED`, 409);
    const claimed = await this.prisma.redactionJob.updateMany({ where: { id: jobId, status: RedactionJobStatus.QUEUED }, data: { status: RedactionJobStatus.PROCESSING, startedAt: new Date() } });
    if (claimed.count !== 1) throw new RedactionError('REDACTION_INVALID_STATE', 'job was claimed by another runner', 409);

    const exportsDir = this.exportsDir();
    const tmpRoot = path.join(exportsDir, '.redaction-tmp');
    fs.mkdirSync(tmpRoot, { recursive: true });
    const work = fs.mkdtempSync(path.join(tmpRoot, `${job.id}-`));
    const derivativeObjectKey = `derivatives/${job.tenantId}/${job.id}.mp4`;
    const finalPath = path.join(exportsDir, derivativeObjectKey);
    const started = Date.now();
    let published = false;
    try {
      // 1. Source
      const source = await this.assembleSource(job, work);
      const probe = await FFmpegService.probe(source.path);
      if (!probe || !probe.width || !probe.height || !(probe.durationSeconds > 0)) throw new RedactionError('REDACTION_SOURCE_INTEGRITY_FAILED', 'the source footage cannot be decoded');
      if (probe.durationSeconds > this.maxClipSeconds) throw new RedactionError('REDACTION_CLIP_TOO_LONG', `${probe.durationSeconds.toFixed(0)} s exceeds ${this.maxClipSeconds} s`);

      // 2. Detection
      const kinds = (job.detectKinds || []) as ('FACE' | 'LICENSE_PLATE')[];
      // Re-checked at run time: the switch may have been turned off after the job was queued.
      if (kinds.includes('FACE') && !(await isFaceProcessingEnabled(this.prisma, job.tenantId))) {
        throw new RedactionError('REDACTION_FACE_PROCESSING_DISABLED', 'face processing was switched off for this tenant after the job was queued', 403);
      }
      const dets: SampledDetection[] = [];
      let detector: DetectorProvenance | null = null;
      let framesAnalysed = 0;
      if (kinds.length) {
        const client = this.makeClient(this.prisma);
        await client.connect(kinds.map((k) => TASK_OF[k]));
        const framesDir = path.join(work, 'frames');
        fs.mkdirSync(framesDir);
        await runFfmpeg(['-v', 'error', '-nostdin', '-i', source.path, '-vf', `fps=${job.sampleFps}`, '-q:v', '2', path.join(framesDir, '%06d.jpg')]);
        const frames = fs.readdirSync(framesDir).filter((f) => f.endsWith('.jpg')).sort();
        if (frames.length === 0) throw new RedactionError('REDACTION_SOURCE_INTEGRITY_FAILED', 'no frames could be sampled from the source');
        for (let i = 0; i < frames.length; i++) {
          const t = i / job.sampleFps;
          const jpeg = fs.readFileSync(path.join(framesDir, frames[i]));
          const ts = new Date(source.startUtc.getTime() + t * 1000).toISOString();
          for (const k of kinds) {
            for (const d of await client.detect(TASK_OF[k], jpeg, probe.width, probe.height, ts, i)) dets.push({ kind: d.kind, t, box: d.box, score: d.score });
          }
        }
        framesAnalysed = frames.length;
        detector = client.detectorProvenance;
        fs.rmSync(framesDir, { recursive: true, force: true });
      }

      // 3. Masks
      const planned = planMasks(dets, { fps: job.sampleFps, durationSec: probe.durationSeconds, frameWidth: probe.width, frameHeight: probe.height, margin: 0.15, mergeAreaFactor: 1.3 });
      const manual: PlannedMask[] = ((job.maskMetadataJson as any[]) || []).map((m) => ({
        kind: 'MANUAL',
        x: Math.floor(m.x),
        y: Math.floor(m.y),
        width: Math.ceil(m.width),
        height: Math.ceil(m.height),
        startSec: m.startSec,
        endSec: Math.min(m.endSec, probe.durationSeconds),
      }));
      const masks = [...planned, ...manual];
      const filter = buildMaskFilter(masks, probe.width, probe.height);
      const filterPath = path.join(work, 'masks.filter');
      fs.writeFileSync(filterPath, filter);

      // 4. Render
      const tmpOut = path.join(work, 'derivative.mp4');
      await this.renderer({ sourcePath: source.path, filterScriptPath: filterPath, outputPath: tmpOut });

      // 5. Verify
      if (!fs.existsSync(tmpOut)) throw new RedactionError('REDACTION_OUTPUT_MISSING', `Redaction output file was not produced: ${tmpOut}`);
      const size = fs.statSync(tmpOut).size;
      if (size === 0) throw new RedactionError('REDACTION_OUTPUT_MISSING', 'Redaction output file is empty');
      const outProbe = await FFmpegService.probe(tmpOut);
      if (!outProbe || outProbe.width !== probe.width || outProbe.height !== probe.height || Math.abs(outProbe.durationSeconds - probe.durationSeconds) > 1) {
        throw new RedactionError('REDACTION_OUTPUT_INVALID', `output ${outProbe ? `${outProbe.width}x${outProbe.height} ${outProbe.durationSeconds}s` : 'undecodable'} does not match the source ${probe.width}x${probe.height} ${probe.durationSeconds}s`);
      }
      const checks = masks.filter((m) => m.endSec - m.startSec >= 0.2 && m.width > 6 && m.height > 6).slice(0, 5);
      const maskChecks = [];
      for (const m of checks) {
        const t = (m.startSec + m.endSec) / 2;
        const luma = await regionLuma(tmpOut, t, m);
        maskChecks.push({ kind: m.kind, t: Number(t.toFixed(3)), meanLuma: Number(luma.toFixed(1)) });
        if (luma > 24) throw new RedactionError('REDACTION_MASK_NOT_APPLIED', `mask ${m.kind} at t=${t.toFixed(2)}s has mean luma ${luma.toFixed(1)} in the output`);
      }

      // 6. Publish
      fs.mkdirSync(path.dirname(finalPath), { recursive: true });
      fs.renameSync(tmpOut, finalPath);
      const derivativeSha256 = await sha256File(finalPath);
      const outputBytes = fs.statSync(finalPath).size;
      const count = (k: string) => masks.filter((m) => m.kind === k).length;
      const provenance = {
        source: { manifestId: job.sourceManifestId, masterEvidenceHash: job.sourceManifest.masterEvidenceHash, cameraId: job.cameraId, segments: source.segments, concatSha256: await sha256File(source.path) },
        detector,
        sampling: { fps: job.sampleFps, framesAnalysed },
        masks: { total: masks.length, face: count('FACE'), licensePlate: count('LICENSE_PLATE'), manual: count('MANUAL'), style: 'opaque_fill', checks: maskChecks },
        render: { tool: await ffmpegVersion(), filterSha256: crypto.createHash('sha256').update(filter).digest('hex'), video: 'libx264 veryfast crf20 yuv420p', audio: 'removed' },
      };
      const completed = await this.prisma.redactionJob.update({
        where: { id: jobId },
        data: {
          status: RedactionJobStatus.COMPLETED,
          outputObjectKey: derivativeObjectKey,
          outputSha256: derivativeSha256,
          outputBytes: BigInt(outputBytes),
          maskCount: masks.length,
          modelVersion: detector ? `${detector.modelName}@${detector.modelVersion}` : null,
          provenanceJson: provenance as any,
          completedAt: new Date(),
          error: null,
          errorCode: null,
        },
      });
      await this.chainOfCustody.logEvent({
        tenantId: job.tenantId,
        evidenceId: job.sourceManifestId,
        actorUserId: job.createdByUserId,
        action: 'EVIDENCE_REDACTED',
        sourceHash: job.sourceManifest.masterEvidenceHash,
        resultHash: derivativeSha256,
        metadata: { redactionJobId: job.id, redactionMode: job.redactionMode, derivativeObjectKey, derivativeSha256, outputBytes, provenance },
      });
      published = true;
      MetricsService.incCounter('vigilone_redaction_jobs_total', 'Redaction jobs by outcome', { outcome: 'completed' });
      MetricsService.setGauge('vigilone_redaction_last_job_seconds', 'Duration of the last completed redaction job', undefined, (Date.now() - started) / 1000);
      return completed;
    } catch (err: any) {
      const code = err instanceof RedactionError ? err.code : 'REDACTION_FFMPEG_FAILED';
      // Nothing counts as published unless both the job row and the custody event were written.
      if (!published) fs.rmSync(finalPath, { force: true });
      await this.prisma.redactionJob.update({
        where: { id: jobId },
        data: { status: RedactionJobStatus.FAILED, errorCode: code, error: String(err.message || err).slice(0, 2000), completedAt: new Date(), outputObjectKey: null, outputSha256: null, outputBytes: null },
      });
      MetricsService.incCounter('vigilone_redaction_jobs_total', 'Redaction jobs by outcome', { outcome: 'failed', code });
      throw err instanceof RedactionError ? err : new RedactionError(code, err.message || String(err));
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  /** The manifest's segments for the job's camera, hash-checked against the manifest and concatenated. */
  private async assembleSource(job: RedactionJob & { sourceManifest: { segmentManifestJson: any; startUtc: Date } }, work: string) {
    const leaves = ((job.sourceManifest.segmentManifestJson as any[]) || []).filter((l) => l && l.cameraId === job.cameraId);
    if (leaves.length === 0) throw new RedactionError('REDACTION_SOURCE_NOT_FOUND', `the manifest holds no segments for camera ${job.cameraId}`);
    const rows = await this.prisma.recordingSegment.findMany({ where: { id: { in: leaves.map((l) => l.segmentId) } }, select: { id: true, filePath: true } });
    const byId = new Map(rows.map((r) => [r.id, r.filePath]));
    const ordered = [...leaves].sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc));
    const segments: Array<{ segmentId: string; sha256: string }> = [];
    for (const l of ordered) {
      const file = byId.get(l.segmentId);
      if (!file || !fs.existsSync(file)) throw new RedactionError('REDACTION_SOURCE_NOT_FOUND', `segment ${l.segmentId} is missing on disk`);
      const got = await sha256File(file);
      if (got !== l.mediaSha256) throw new RedactionError('REDACTION_SOURCE_INTEGRITY_FAILED', `segment ${l.segmentId} has SHA-256 ${got}, the manifest recorded ${l.mediaSha256}`);
      segments.push({ segmentId: l.segmentId, sha256: got });
    }
    const out = path.join(work, 'source.mp4');
    try {
      await FFmpegService.concatSegments(ordered.map((l) => byId.get(l.segmentId)!), out, 'STREAM_COPY');
    } catch (e: any) {
      throw new RedactionError('REDACTION_FFMPEG_FAILED', `concatenating the source failed: ${e.message}`);
    }
    return { path: out, segments, startUtc: new Date(ordered[0].startUtc) };
  }
}
