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
}

export const AI_WORKER_ADAPTER_VERSION = '2.0.0-phase2';

export class AiWorker {
  private config: AiWorkerConfig;
  private engine: IInferenceEngine;
  private apiClient: AuthenticatedInternalApiClient;
  private healthMonitor: WorkerHealthMonitor;
  private scheduler: InferenceScheduler;
  private loadedModel?: LoadedModelArtifact;
  private trackers: Map<string, MultiObjectTracker> = new Map();
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
        for (const event of normalizedEvents) {
          if (event.trackId && firstSeen.has(event.trackId)) {
            event.trackFirstSeenAt = firstSeen.get(event.trackId)!.toISOString();
          }
          if (event.trackState === 'CONFIRMED') {
            await this.apiClient.submitDetection(event);
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
