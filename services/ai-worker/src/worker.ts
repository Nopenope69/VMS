import { ModelLoader, LoadedModelArtifact, ModelRefusalError } from './modelLoader';
import { OnnxInferenceEngine, IInferenceEngine } from './inferenceEngine';
import { DetectionNormalizer } from './detectionNormalizer';
import { AuthenticatedInternalApiClient } from './apiClient';
import { WorkerHealthMonitor } from './health';
import {
  InferenceScheduler,
  InferenceTimeoutError,
  StaleFrameDroppedError,
  InferenceSchedulerOptions,
} from './inferenceScheduler';
import { MultiObjectTracker, MultiObjectTrackerConfig } from './tracker';
import { AiAdapterCore, AdapterError } from './adapter/adapterCore';
import { ModelCardV1 } from './adapter/contract';
import { eventTypeForClass } from './classMap';
import { MetricsRegistry } from './metrics';
import { cropToJpeg } from './cropExtractor';
import { describeColours, isMonochromeFrame } from './colourAttributes';
import { PoseEstimator, POSE_METHOD } from './poseEstimator';
import {
  ModelManifestRecord,
  NormalizedDetectionEvent,
  VideoFrame,
  FrameGeometry,
  InferenceSchedulerTelemetry,
} from './types';

export interface AiWorkerConfig {
  backendBaseUrl: string;
  internalSecret: string;
  workerId?: string;
  /** ai-adapter.v1 identity of this worker (provenance). */
  adapterId?: string;
  adapterVersion?: string;
  schedulerOptions?: InferenceSchedulerOptions;
  trackerConfig?: MultiObjectTrackerConfig;
  /** Concurrency limits of the shared adapter core (stream pipeline + /v1/infer). */
  maxInFlight?: number;
  maxQueued?: number;
  /** Attach a JPEG crop of each CONFIRMED detection for the backend crop store. Default OFF (AI_ATTACH_CROPS). */
  attachCrops?: boolean;
  /** Name the colours of each CONFIRMED detection (colourAttributes.ts). Default ON (AI_COLOUR_ATTRIBUTES). */
  colourAttributes?: boolean;
}

/** Pose runs on CONFIRMED person detections only, at most once per track per interval and N persons per frame. */
export interface PoseOptions {
  estimator: PoseEstimator;
  /** The pinned model that produced the keypoints (provenance, written into every pose). */
  model: { name: string; version: string; sha256: string };
  intervalMs?: number;
  maxPerFrame?: number;
}
export const DEFAULT_POSE_INTERVAL_MS = 500;
export const DEFAULT_POSE_MAX_PER_FRAME = 4;
const POSE_STATE_MAX = 5000;

export const AI_WORKER_ADAPTER_VERSION = '2.0.0-phase2';

export class AiWorker {
  private config: AiWorkerConfig;
  private engine: IInferenceEngine;
  private apiClient: AuthenticatedInternalApiClient;
  private healthMonitor: WorkerHealthMonitor;
  private scheduler: InferenceScheduler;
  private loadedModel?: LoadedModelArtifact;
  private trackers: Map<string, MultiObjectTracker> = new Map();
  private pose?: PoseOptions;
  private lastPoseAt = new Map<string, number>();
  public readonly core: AiAdapterCore;

  constructor(config: AiWorkerConfig, engine?: IInferenceEngine, metrics: MetricsRegistry = new MetricsRegistry()) {
    this.config = config;
    this.engine = engine || new OnnxInferenceEngine();
    this.apiClient = new AuthenticatedInternalApiClient({
      baseUrl: config.backendBaseUrl,
      internalSecret: config.internalSecret,
    });
    this.healthMonitor = new WorkerHealthMonitor(config.workerId);
    this.scheduler = new InferenceScheduler(config.schedulerOptions || { maxConcurrency: 2, timeoutMs: 1000 });
    this.core = new AiAdapterCore(
      this.engine,
      {
        adapterId: config.adapterId || config.workerId || 'vigilone-ai-worker',
        adapterVersion: config.adapterVersion || AI_WORKER_ADAPTER_VERSION,
        maxInFlight: config.maxInFlight ?? config.schedulerOptions?.maxConcurrency ?? 2,
        maxQueued: config.maxQueued ?? 4,
      },
      metrics
    );
  }

  private lastCropLog = 0;

  /**
   * Adds a JPEG crop to the event. Never throws: a crop is an extra, and a failure here must not
   * stop the detection from being submitted. Failures are counted and logged (once a minute).
   */
  /** Frame-wide saturation check; a failure counts as colour (the per-detection naming then reports it). */
  private monochrome(frame: Buffer, geometry: FrameGeometry): boolean {
    try {
      return isMonochromeFrame(frame, geometry);
    } catch {
      return false;
    }
  }

  /** Adds `attributesJson.colour`. A failure is counted and the detection is still sent without it. */
  private attachColours(event: NormalizedDetectionEvent, frame: Buffer, geometry: FrameGeometry, monochrome: boolean): void {
    const counter = 'vigilone_ai_colour_attributes_total';
    const help = 'Colour attributes named for confirmed detections, by outcome';
    try {
      const colour = event.boundingBox ? describeColours(frame, geometry, event.boundingBox, event.objectClass, monochrome) : null;
      if (!colour) {
        this.core.metrics.inc(counter, help, { outcome: 'not_applicable' });
        return;
      }
      event.attributesJson = { ...(event.attributesJson || {}), colour };
      this.core.metrics.inc(counter, help, { outcome: colour.monochrome ? 'monochrome' : 'named' });
    } catch (err: any) {
      this.core.metrics.inc(counter, help, { outcome: 'failed' });
      console.warn(`[AiWorker] colour attributes failed for ${event.cameraId}: ${err?.message || err}`);
    }
  }

  private async attachCrop(event: NormalizedDetectionEvent, frame: Buffer, geometry: FrameGeometry): Promise<void> {
    const counter = 'vigilone_ai_crops_attached_total';
    const help = 'Detection crops attached for the backend crop store, by outcome';
    try {
      const jpeg = await cropToJpeg(frame, geometry, event.boundingBox);
      if (!jpeg) {
        this.core.metrics.inc(counter, help, { outcome: 'too_small' });
        return;
      }
      event.cropJpegBase64 = jpeg.toString('base64');
      this.core.metrics.inc(counter, help, { outcome: 'attached' });
    } catch (err: any) {
      this.core.metrics.inc(counter, help, { outcome: 'failed' });
      if (Date.now() - this.lastCropLog >= 60_000) {
        this.lastCropLog = Date.now();
        console.error(`[AiWorker] crop attach failed for ${event.objectClass ?? 'object'} on ${event.cameraId}; the detection is sent without it: ${err?.message || err}`);
      }
    }
  }

  /** Turns on body pose for CONFIRMED person detections (off until called). */
  public setPoseEstimator(opts: PoseOptions | undefined): void {
    this.pose = opts;
    this.lastPoseAt.clear();
  }

  /**
   * Adds `attributesJson.pose`: 17 keypoints [x, y, score] normalised to the source image, with the model that made
   * them. Never throws: a failure is counted and the detection is still sent without a pose.
   */
  private async attachPose(event: NormalizedDetectionEvent, frame: Buffer, geometry: FrameGeometry, budget: { left: number }, nowMs: number): Promise<void> {
    const pose = this.pose;
    if (!pose || event.objectClass !== 'person' || !event.trackId || !event.boundingBox) return;
    const counter = 'vigilone_ai_pose_total';
    const help = 'Body poses estimated for confirmed person detections, by outcome';
    const key = `${event.cameraId}|${event.trackId}`;
    const last = this.lastPoseAt.get(key);
    if (last !== undefined && nowMs - last < (pose.intervalMs ?? DEFAULT_POSE_INTERVAL_MS)) {
      this.core.metrics.inc(counter, help, { outcome: 'skipped_interval' });
      return;
    }
    if (budget.left <= 0) {
      this.core.metrics.inc(counter, help, { outcome: 'skipped_busy' });
      return;
    }
    budget.left--;
    try {
      const r = await pose.estimator.estimate(frame, geometry, event.boundingBox);
      if (!r) {
        this.core.metrics.inc(counter, help, { outcome: 'too_small' });
        return;
      }
      this.lastPoseAt.set(key, nowMs);
      if (this.lastPoseAt.size > POSE_STATE_MAX) {
        for (const k of this.lastPoseAt.keys()) {
          this.lastPoseAt.delete(k);
          if (this.lastPoseAt.size <= POSE_STATE_MAX / 2) break;
        }
      }
      const r4 = (n: number) => Math.round(n * 10000) / 10000;
      event.attributesJson = {
        ...(event.attributesJson || {}),
        pose: {
          method: POSE_METHOD,
          model: pose.model,
          meanScore: r4(r.meanScore),
          keypoints: r.keypoints.map((k) => [r4(k.x), r4(k.y), r4(k.score)]),
        },
      };
      this.core.metrics.inc(counter, help, { outcome: 'estimated' });
    } catch (err: any) {
      this.core.metrics.inc(counter, help, { outcome: 'failed' });
      console.warn(`[AiWorker] pose failed for ${event.cameraId}: ${err?.message || err}`);
    }
  }

  public getApiClient(): AuthenticatedInternalApiClient {
    return this.apiClient;
  }

  /**
   * Retrieves or initializes the isolated MultiObjectTracker for a specific camera.
   */
  public getTracker(cameraId: string): MultiObjectTracker {
    let tracker = this.trackers.get(cameraId);
    if (!tracker) {
      tracker = new MultiObjectTracker(this.config.trackerConfig);
      this.trackers.set(cameraId, tracker);
    }
    return tracker;
  }

  /**
   * Initializes worker by loading model artifact, verifying licence, SHA-256 and runtime config.
   * Any refusal leaves the adapter FAILED (no inference) and is rethrown for reporting.
   */
  public async initializeModel(
    manifest: ModelManifestRecord,
    artifactPath: string,
    evaluation: ModelCardV1['evaluation'] = null
  ): Promise<void> {
    try {
      const loaded = await ModelLoader.loadAndVerify(manifest, artifactPath);
      await this.engine.load(loaded.buffer, manifest.runtimeConfigJson, manifest);
      this.loadedModel = loaded;
      this.core.setModel({ manifest, evaluation });
      this.healthMonitor.recordModelLoaded(manifest, loaded.verified);
    } catch (err: any) {
      this.loadedModel = undefined;
      this.core.fail(err instanceof ModelRefusalError ? `${err.code}: ${err.message}` : err.message);
      this.healthMonitor.recordError(err.message);
      throw err;
    }
  }

  /**
   * Executes governed inference on a video frame or buffer.
   *
   * STRICT INVARIANTS:
   * 1. Mandatory FrameGeometry: Rejects frames without geometry without guessing.
   * 2. Newest-frame preference per camera (InferenceScheduler) and bounded concurrency with
   *    deadlines in the shared adapter core.
   * 3. Every detection carries per-inference provenance; only v1 classes are tracked.
   * 4. Idempotent Ingestion: Sends CONFIRMED tracks to backend POST /internal/detections.
   */
  public async processFrame(
    frameOrData: VideoFrame | Buffer | Float32Array,
    context?: {
      tenantId?: string;
      cameraId?: string;
      sequenceNumber?: number;
      frameTimestamp?: Date;
      geometry?: FrameGeometry;
    }
  ): Promise<NormalizedDetectionEvent[]> {
    if (!this.loadedModel || !this.engine.isLoaded() || !this.core.getModel()) {
      throw new Error('Worker cannot process frame: Model not loaded or verified');
    }

    let frameData: Buffer | Float32Array;
    let cameraId: string;
    let tenantId: string;
    let sequenceNumber: number;
    let frameTimestamp: Date;
    let geometry: FrameGeometry | undefined;

    if ('data' in (frameOrData as any) && 'geometry' in (frameOrData as any)) {
      const vf = frameOrData as VideoFrame;
      frameData = vf.data;
      cameraId = vf.cameraId;
      tenantId = vf.tenantId;
      sequenceNumber = vf.sequenceNumber;
      frameTimestamp = vf.sampledAt;
      geometry = vf.geometry;
    } else {
      frameData = frameOrData as Buffer | Float32Array;
      if (!context?.cameraId || !context?.tenantId) {
        throw new Error('Worker cannot process frame: cameraId and tenantId are required');
      }
      cameraId = context.cameraId;
      tenantId = context.tenantId;
      sequenceNumber = context.sequenceNumber || 1;
      frameTimestamp = context.frameTimestamp || new Date();
      geometry = context.geometry;
    }

    // MANDATORY GEOMETRY CHECK: Never guess coordinates
    if (!geometry) {
      throw new Error('Worker cannot process frame: Mandatory FrameGeometry is missing or inconsistent.');
    }
    if (!(frameData instanceof Buffer)) {
      throw new Error('Worker cannot process frame: the stream pipeline delivers RGB24 buffers');
    }

    try {
      return await this.scheduler.schedule(cameraId, sequenceNumber, async () => {
        const result = await this.core.detect(
          frameData as Buffer,
          geometry!,
          frameTimestamp.toISOString(),
          this.scheduler.timeoutMs
        );
        this.healthMonitor.incrementInference();

        const normalizedEvents: NormalizedDetectionEvent[] = result.detections.map((raw) => {
          const ev = DetectionNormalizer.normalize(raw, {
            tenantId,
            cameraId,
            modelManifestId: this.loadedModel!.manifest.id,
            frameTimestamp,
          });
          const cls = raw.objectClass as any;
          ev.type = eventTypeForClass(cls);
          ev.objectClass = cls;
          // One inference, many detections: each row gets its own id (DB idempotency key) while
          // provenance keeps the id of the inference that produced it.
          ev.provenance = { ...result.provenance };
          ev.attributesJson = { ...(ev.attributesJson || {}), inferenceLatencyMs: result.latencyMs };
          return ev;
        });

        const tracker = this.getTracker(cameraId);
        tracker.trackDetections(normalizedEvents, frameTimestamp);
        const firstSeen = new Map(tracker.getTracks().map((t) => [t.trackId, t.firstSeenAt]));

        // Transmit ONLY CONFIRMED tracks to backend internal API
        let monochrome: boolean | undefined; // computed once per frame, only if a detection needs it
        const poseBudget = { left: this.pose?.maxPerFrame ?? DEFAULT_POSE_MAX_PER_FRAME };
        for (const event of normalizedEvents) {
          if (event.trackId && firstSeen.has(event.trackId)) {
            event.trackFirstSeenAt = firstSeen.get(event.trackId)!.toISOString();
          }
          if (event.trackState === 'CONFIRMED') {
            if (this.config.attachCrops === true) await this.attachCrop(event, frameData as Buffer, geometry!);
            if (this.config.colourAttributes !== false) {
              if (monochrome === undefined) monochrome = this.monochrome(frameData as Buffer, geometry!);
              this.attachColours(event, frameData as Buffer, geometry!, monochrome);
            }
            await this.attachPose(event, frameData as Buffer, geometry!, poseBudget, frameTimestamp.getTime());
            await this.apiClient.submitDetection(event);
            delete event.cropJpegBase64; // the returned events stay small
            this.core.metrics.inc('vigilone_ai_detections_submitted_total', 'Confirmed-track detections sent to the backend', { objectClass: event.objectClass || 'unknown' });
          }
        }

        return normalizedEvents;
      });
    } catch (err: any) {
      if (
        err instanceof InferenceTimeoutError ||
        err instanceof StaleFrameDroppedError ||
        (err instanceof AdapterError && (err.code === 'DEADLINE_EXCEEDED' || err.code === 'OVERLOADED'))
      ) {
        // Frame dropped cleanly (counted in metrics); the evidence plane is untouched.
        this.core.metrics.inc('vigilone_ai_frames_dropped_total', 'Frames dropped before inference completed', {
          reason: err instanceof StaleFrameDroppedError ? 'stale' : err instanceof AdapterError ? err.code.toLowerCase() : 'timeout',
        });
        return [];
      }
      throw err;
    }
  }

  public getHealth() {
    return this.healthMonitor.getStatus();
  }

  public getSchedulerTelemetry(): InferenceSchedulerTelemetry {
    return this.scheduler.getTelemetry();
  }
}
