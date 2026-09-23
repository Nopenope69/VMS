import { ModelLoader, LoadedModelArtifact } from './modelLoader';
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
  schedulerOptions?: InferenceSchedulerOptions;
}

export class AiWorker {
  private config: AiWorkerConfig;
  private engine: IInferenceEngine;
  private apiClient: AuthenticatedInternalApiClient;
  private healthMonitor: WorkerHealthMonitor;
  private scheduler: InferenceScheduler;
  private loadedModel?: LoadedModelArtifact;

  constructor(config: AiWorkerConfig, engine?: IInferenceEngine) {
    this.config = config;
    this.engine = engine || new OnnxInferenceEngine();
    this.apiClient = new AuthenticatedInternalApiClient({
      baseUrl: config.backendBaseUrl,
      internalSecret: config.internalSecret,
    });
    this.healthMonitor = new WorkerHealthMonitor(config.workerId);
    this.scheduler = new InferenceScheduler(config.schedulerOptions || { maxConcurrency: 2, timeoutMs: 1000 });
  }

  /**
   * Initializes worker by loading model artifact, verifying SHA-256 and runtime config.
   */
  public async initializeModel(manifest: ModelManifestRecord, artifactPath: string): Promise<void> {
    try {
      // 1. Model loader with authentic SHA-256 and runtime config verification
      const loaded = await ModelLoader.loadAndVerify(manifest, artifactPath);
      this.loadedModel = loaded;

      // 2. Load weights and verify signature / execution provider into inference engine
      await this.engine.load(loaded.buffer, manifest.runtimeConfigJson, manifest);

      // 3. Update health status
      this.healthMonitor.recordModelLoaded(manifest, loaded.verified);
    } catch (err: any) {
      this.healthMonitor.recordError(err.message);
      throw err;
    }
  }

  /**
   * Executes governed inference on a video frame or buffer.
   *
   * STRICT INVARIANTS:
   * 1. Mandatory FrameGeometry: Rejects frames without geometry without guessing.
   * 2. Bounded Concurrency & Deadline: Scheduled via InferenceScheduler (max 2 concurrent, 1000ms deadline).
   * 3. Newest-Frame Preference: Stale frames are superseded cleanly.
   * 4. Idempotent Ingestion: Sends normalized events to backend POST /internal/detections.
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
    if (!this.loadedModel || !this.engine.isLoaded()) {
      throw new Error('Worker cannot process frame: Model not loaded or verified');
    }

    let frameData: Buffer | Float32Array;
    let cameraId: string;
    let tenantId: string;
    let sequenceNumber: number;
    let frameTimestamp: Date | undefined;
    let geometry: FrameGeometry | undefined;

    // Detect if input is a structured VideoFrame
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
      cameraId = context?.cameraId || 'unknown-cam';
      tenantId = context?.tenantId || 'unknown-tenant';
      sequenceNumber = context?.sequenceNumber || 1;
      frameTimestamp = context?.frameTimestamp;
      geometry = context?.geometry;
    }

    // MANDATORY GEOMETRY CHECK: Never guess coordinates
    if (!geometry) {
      throw new Error('Worker cannot process frame: Mandatory FrameGeometry is missing or inconsistent.');
    }

    try {
      return await this.scheduler.schedule(cameraId, sequenceNumber, async () => {
        // Run inference with coordinate reversal
        const rawDetections = await this.engine.infer(frameData, {
          imageWidth: this.loadedModel!.manifest.runtimeConfigJson.inputWidth,
          imageHeight: this.loadedModel!.manifest.runtimeConfigJson.inputHeight,
          geometry,
        });

        this.healthMonitor.incrementInference();

        // Normalize each detection
        const normalizedEvents: NormalizedDetectionEvent[] = rawDetections.map((raw) =>
          DetectionNormalizer.normalize(raw, {
            tenantId,
            cameraId,
            modelManifestId: this.loadedModel!.manifest.id,
            frameTimestamp,
          })
        );

        // Transmit normalized events to backend internal API
        for (const event of normalizedEvents) {
          await this.apiClient.submitDetection(event);
        }

        return normalizedEvents;
      });
    } catch (err: any) {
      if (err instanceof InferenceTimeoutError || err instanceof StaleFrameDroppedError) {
        // Handled cleanly by scheduler; frame is dropped without crashing or corrupting evidence plane
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
