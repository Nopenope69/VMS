/**
 * VLM second-opinion worker (Phase 5 Wave C). Every VLM_VERIFY_INTERVAL_MS it verifies the adapter, then asks
 * the model about recent alarms that have none yet from that model:
 *
 *  - the alarm must name its triggering detection (canonical event provenance -> DetectionEvent), and that
 *    detection must have an object class the model checks. No recorded link, no question: nothing is guessed.
 *  - the image is the detection's snapshot (the full frame, under an allowed snapshot root) or, when that is
 *    gone, its stored object crop, checked against its SHA-256. The SHA-256 of what was sent is stored.
 *  - only alarms newer than VLM_MAX_ALARM_AGE_MS (default 1 h) are considered: a late opinion helps no one.
 *
 * The answer is ADVISORY. This service writes only VlmVerification rows; it never reads or changes an alarm's
 * state, severity or notifications. It keeps no copy of the image.
 */
import crypto from 'crypto';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
import { MetricsService } from '../observability/metrics.service';
import { CropStore } from '../crops/cropStore';
import { cropsRoot, resolveSnapshot } from '../crops/cropCapture.service';
import { VlmAdapterClient, VlmError } from './vlmAdapterClient';

const METRIC = 'vigilone_vlm_verifications_total';
const HELP = 'Alarm second-opinion attempts by outcome';
const BATCH = 10;
const MAX_ATTEMPTS = 3;
const LOG_EVERY_MS = 60_000;
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface VerifyRunResult {
  stored: number;
  answers: { yes: number; no: number; unclear: number };
  noDetection: number;
  unsupportedClass: number;
  noImage: number;
  failed: number;
  adapterProblem: string | null;
}

/** A JPEG as-is; any other image format ffmpeg reads is converted. Throws if it cannot be read. */
function asJpeg(file: string): Buffer {
  const b = fs.readFileSync(file);
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) return b;
  return execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-q:v', '2', '-f', 'mjpeg', '-'], { maxBuffer: 64 << 20 });
}

export class VlmVerifier {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly attempts = new Map<string, number>();
  /** Alarms that cannot be asked about (no detection, class, or image); not re-read every run. */
  private readonly unaskable = new Set<string>();
  private readonly lastLogged = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly client: VlmAdapterClient,
    private readonly maxAlarmAgeMs = 3_600_000,
    private readonly storeFn: () => CropStore = () => new CropStore(cropsRoot())
  ) {}

  private log(key: string, message: string) {
    const now = Date.now();
    if (now - (this.lastLogged.get(key) ?? 0) < LOG_EVERY_MS) return;
    this.lastLogged.set(key, now);
    console.error(`[VlmVerifier] ${message}`);
  }

  private count(outcome: string) {
    MetricsService.incCounter(METRIC, HELP, { outcome });
  }

  /** The detection that raised the alarm, by the inferenceId its canonical event recorded; null if none. */
  private async detectionFor(alarm: { tenantId: string; canonicalEvent: { provenanceJson: unknown } | null }) {
    const prov = alarm.canonicalEvent?.provenanceJson;
    const inferenceId = isObject(prov) && typeof prov.inferenceId === 'string' ? prov.inferenceId : null;
    if (!inferenceId) return null;
    return this.prisma.detectionEvent.findFirst({ where: { tenantId: alarm.tenantId, inferenceId }, include: { objectCrops: true } });
  }

  private image(d: { snapshotPath: string | null; objectCrops: Array<{ relativePath: string; sha256: string }> }): { bytes: Buffer; source: 'SNAPSHOT' | 'CROP' } | null {
    if (d.snapshotPath) {
      try {
        return { bytes: asJpeg(resolveSnapshot(d.snapshotPath)), source: 'SNAPSHOT' };
      } catch {
        /* purged or outside the allowed roots: try the crop */
      }
    }
    const crop = d.objectCrops[0];
    if (crop) {
      const bytes = this.storeFn().readVerified(crop.relativePath, crop.sha256); // throws on a hash mismatch
      if (bytes) return { bytes, source: 'CROP' };
    }
    return null;
  }

  async runOnce(now: Date = new Date()): Promise<VerifyRunResult> {
    const r: VerifyRunResult = { stored: 0, answers: { yes: 0, no: 0, unclear: 0 }, noDetection: 0, unsupportedClass: 0, noImage: 0, failed: 0, adapterProblem: null };
    if (this.running) return r;
    this.running = true;
    try {
      let model;
      try {
        model = await this.client.connect();
      } catch (e: any) {
        r.adapterProblem = e.message;
        this.count('adapter_unavailable');
        this.log('connect', `VLM adapter not usable, nothing verified this run: ${e.message}`);
        return r;
      }
      const alarms = await this.prisma.alarm.findMany({
        where: {
          triggeredAt: { gte: new Date(now.getTime() - this.maxAlarmAgeMs) },
          canonicalEventId: { not: null },
          vlmVerifications: { none: { modelSha256: model.sha256 } },
          id: { notIn: [...this.unaskable, ...[...this.attempts].filter(([, n]) => n >= MAX_ATTEMPTS).map(([id]) => id)] },
        },
        include: { canonicalEvent: { select: { provenanceJson: true } } },
        orderBy: { triggeredAt: 'desc' }, // newest first: the operator is most likely looking at it now
        take: BATCH,
      });
      for (const alarm of alarms) {
        const d = await this.detectionFor(alarm);
        if (!d) {
          r.noDetection++;
          this.unaskable.add(alarm.id);
          this.count('no_detection');
          continue;
        }
        const targetClass = (d.objectClass || '').toLowerCase();
        if (!this.client.targetClasses.includes(targetClass)) {
          r.unsupportedClass++;
          this.unaskable.add(alarm.id);
          this.count('unsupported_class');
          continue;
        }
        let img;
        try {
          img = this.image(d);
        } catch (e: any) {
          r.failed++;
          this.unaskable.add(alarm.id);
          this.count('image_integrity_failed');
          this.log(`img-${alarm.id}`, `alarm ${alarm.id}: stored crop failed its integrity check, not sent: ${e.message}`);
          continue;
        }
        if (!img) {
          r.noImage++;
          this.unaskable.add(alarm.id);
          this.count('no_image');
          continue;
        }
        try {
          const v = await this.client.verify(img.bytes, targetClass, d.timestamp.toISOString());
          await this.prisma.vlmVerification.create({
            data: {
              tenantId: alarm.tenantId,
              alarmId: alarm.id,
              cameraId: alarm.cameraId,
              detectionEventId: d.id,
              imageSource: img.source,
              imageSha256: sha(img.bytes),
              targetClass,
              answer: v.answer,
              reason: v.reason,
              promptSha256: v.promptSha256,
              modelName: v.model.name,
              modelVersion: v.model.version,
              modelSha256: v.model.sha256,
              adapterId: v.adapterId,
              inferenceId: v.inferenceId,
              provenanceJson: v.provenance as any,
              latencyMs: v.latencyMs,
            },
          });
          r.stored++;
          r.answers[v.answer]++;
          this.count(`answer_${v.answer}`);
        } catch (e: any) {
          if (e?.code === 'P2002') continue; // another run stored it first
          r.failed++;
          this.attempts.set(alarm.id, (this.attempts.get(alarm.id) ?? 0) + 1);
          this.count('failed');
          this.log(`fail-${e?.code ?? 'x'}`, `alarm ${alarm.id}: ${e.message}`);
          if (e instanceof VlmError && e.code !== 'VLM_BAD_INPUT') break; // the adapter is the problem: stop this run
        }
      }
      return r;
    } finally {
      this.running = false;
    }
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce().catch((e) => this.log('run', `run failed: ${e.message}`)), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
