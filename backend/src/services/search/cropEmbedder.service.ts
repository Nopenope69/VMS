/**
 * Crop embedder (Phase 5, P5.3): turns stored crops into embeddings by calling an embedding adapter.
 * Runs only behind VIGILONE_FEATURE_SEMANTIC_SEARCH (default OFF) and needs EMBEDDING_ADAPTER_URL.
 *
 * Per run: verify the adapter (health, descriptor, registered active model), then embed the oldest
 * unexpired crops that have no embedding from that model. For each crop:
 *  - the bytes are read from the crop store and checked against the recorded SHA-256 (a mismatch is an
 *    integrity fault: logged loudly, never embedded);
 *  - a PERSON crop is embedded only while its site still has person crops enabled (the switch can be turned
 *    off after capture; nothing new is derived from a person crop once it is);
 *  - an embedding the store refuses, or a crop that keeps failing, is counted and logged, and after
 *    MAX_ATTEMPTS the crop is set aside for this process so it cannot block the queue.
 * An unreachable or unverified adapter stops the run and is reported; nothing is guessed or stored.
 * Embedding never touches recording, and a failure here never affects crop capture or detection.
 */
import { PrismaClient } from '@prisma/client';
import { MetricsService } from '../observability/metrics.service';
import { CropStore } from '../crops/cropStore';
import { cropsRoot } from '../crops/cropCapture.service';
import { EmbeddingAdapterClient } from './embeddingAdapterClient';
import { EmbeddingError, storeEmbedding } from './cropEmbeddingStore';

const METRIC = 'vigilone_crop_embeddings_total';
const HELP = 'Crop embedding attempts by outcome';
export const MAX_ATTEMPTS = 3;
const POLICY_DEFER_MS = 10 * 60_000;
const LOG_EVERY_MS = 60_000;

export interface EmbedRunResult {
  stored: number;
  failed: number;
  skippedPersonPolicy: number;
  missingFile: number;
  corrupt: number;
  adapterProblem: string | null;
}

export class CropEmbedder {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly attempts = new Map<string, number>();
  private readonly deferred = new Map<string, number>();
  private readonly lastLogged = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly client: Pick<EmbeddingAdapterClient, 'connect' | 'embed'>,
    private readonly store: () => CropStore = () => new CropStore(cropsRoot()),
    private readonly batchSize = 20
  ) {}

  private log(key: string, message: string): void {
    const now = Date.now();
    if (now - (this.lastLogged.get(key) ?? 0) < LOG_EVERY_MS) return;
    this.lastLogged.set(key, now);
    console.error(`[Embedder] ${message}`);
  }

  private fail(cropId: string, outcome: string, message: string): void {
    this.attempts.set(cropId, (this.attempts.get(cropId) ?? 0) + 1);
    MetricsService.incCounter(METRIC, HELP, { outcome });
    this.log(`${outcome}:${cropId}`, `crop ${cropId}: ${message}`);
  }

  /** One pass. Never throws. */
  async runOnce(now: Date = new Date()): Promise<EmbedRunResult> {
    const r: EmbedRunResult = { stored: 0, failed: 0, skippedPersonPolicy: 0, missingFile: 0, corrupt: 0, adapterProblem: null };
    if (this.running) return r;
    this.running = true;
    try {
      let model;
      try {
        model = await this.client.connect();
      } catch (e: any) {
        r.adapterProblem = String(e?.message || e);
        MetricsService.incCounter(METRIC, HELP, { outcome: 'adapter_unavailable' });
        this.log('adapter', `embedding adapter not usable, nothing embedded this run: ${r.adapterProblem}`);
        return r;
      }
      for (const [id, until] of this.deferred) if (until <= now.getTime()) this.deferred.delete(id);
      const setAside = [...this.attempts].filter(([, n]) => n >= MAX_ATTEMPTS).map(([id]) => id);
      const skip = [...setAside, ...this.deferred.keys()];
      const crops = await this.prisma.objectCrop.findMany({
        where: { expiresAt: { gt: now }, embeddings: { none: { modelSha256: model.sha256 } }, ...(skip.length ? { id: { notIn: skip } } : {}) },
        orderBy: { capturedAt: 'asc' },
        take: this.batchSize,
        include: { camera: { select: { siteId: true } } },
      });
      const store = this.store();
      for (const crop of crops) {
        if (crop.cropClass === 'PERSON') {
          const policy = await this.prisma.siteCropPolicy.findUnique({ where: { siteId: crop.camera.siteId } });
          if (!policy?.personCropsEnabled) {
            this.deferred.set(crop.id, now.getTime() + POLICY_DEFER_MS);
            r.skippedPersonPolicy++;
            MetricsService.incCounter(METRIC, HELP, { outcome: 'skipped_person_policy' });
            continue;
          }
        }
        let bytes: Buffer | null;
        try {
          bytes = store.readVerified(crop.relativePath, crop.sha256);
        } catch (e: any) {
          this.attempts.set(crop.id, MAX_ATTEMPTS); // an integrity fault is not retried
          r.corrupt++;
          MetricsService.incCounter(METRIC, HELP, { outcome: 'corrupt' });
          this.log(`corrupt:${crop.id}`, `crop ${crop.id} failed its integrity check and is not embedded: ${e?.message || e}`);
          continue;
        }
        if (!bytes) {
          this.attempts.set(crop.id, MAX_ATTEMPTS);
          r.missingFile++;
          MetricsService.incCounter(METRIC, HELP, { outcome: 'missing_file' });
          this.log(`missing:${crop.id}`, `crop ${crop.id} has a row but no file; it is not embedded`);
          continue;
        }
        try {
          const e = await this.client.embed(bytes, crop.capturedAt.toISOString());
          const out = await storeEmbedding(this.prisma, { tenantId: crop.tenantId, cropId: crop.id, model: e.model, adapterId: e.adapterId, inferenceId: e.inferenceId, vector: e.vector });
          if (out.created) {
            r.stored++;
            MetricsService.incCounter(METRIC, HELP, { outcome: 'stored' });
          }
        } catch (err: any) {
          if (err instanceof EmbeddingError && err.code === 'EMBEDDING_ADAPTER_UNAVAILABLE') {
            r.adapterProblem = err.message;
            MetricsService.incCounter(METRIC, HELP, { outcome: 'adapter_unavailable' });
            this.log('adapter', `embedding adapter failed mid-run, stopping this run: ${err.message}`);
            break;
          }
          r.failed++;
          this.fail(crop.id, 'failed', `${err instanceof EmbeddingError ? err.code : 'ERROR'}: ${err?.message || err}`);
        }
      }
    } catch (e: any) {
      r.adapterProblem = r.adapterProblem ?? String(e?.message || e);
      MetricsService.incCounter(METRIC, HELP, { outcome: 'run_error' });
      this.log('run', `embedder run failed: ${e?.message || e}`);
    } finally {
      this.running = false;
    }
    return r;
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), intervalMs);
    void this.runOnce();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
