import { ModelLoader, LoadedModelArtifact } from './modelLoader';
import { OnnxInferenceEngine, IInferenceEngine } from './inferenceEngine';
import { DetectionNormalizer } from './detectionNormalizer';
import { AuthenticatedInternalApiClient } from './apiClient';
import { WorkerHealthMonitor } from './health';
import { ModelManifestRecord, NormalizedDetectionEvent } from './types';

export interface AiWorkerConfig {
  backendBaseUrl: string;
  internalSecret: string;
  workerId?: string;
}

export class AiWorker {
  private config: AiWorkerConfig;
  private engine: IInferenceEngine;
  private apiClient: AuthenticatedInternalApiClient;
  private healthMonitor: WorkerHealthMonitor;
  private loadedModel?: LoadedModelArtifact;

  constructor(config: AiWorkerConfig, engine?: IInferenceEngine) {
    this.config = config;
    this.engine = engine || new OnnxInferenceEngine();
    this.apiClient = new AuthenticatedInternalApiClient({
      baseUrl: config.backendBaseUrl,
      internalSecret: config.internalSecret,
    });
    this.healthMonitor = new WorkerHealthMonitor(config.workerId);
  }

  /**
   * Initializes worker by loading model artifact, verifying SHA-256 and runtime config.
   */
  public async initializeModel(manifest: ModelManifestRecord, artifactPath: string): Promise<void> {
    // 1. Model loader with authentic SHA-256 and runtime config verification
    const loaded = await ModelLoader.loadAndVerify(manifest, artifactPath);
    this.loadedModel = loaded;

    // 2. Load weights into inference engine
    await this.engine.load(loaded.buffer, manifest.runtimeConfigJson);

    // 3. Update health status
    this.healthMonitor.recordModelLoaded(manifest, loaded.verified);
  }

  /**
   * Executes inference on a frame/static image, normalizes detections, and submits
   * to the authenticated internal backend API.
   */
  public async processFrame(
    frameData: Buffer | Float32Array,
    context: {
      tenantId: string;
      cameraId: string;
      frameTimestamp?: Date;
    }
  ): Promise<NormalizedDetectionEvent[]> {
    if (!this.loadedModel || !this.engine.isLoaded()) {
      throw new Error('Worker cannot process frame: Model not loaded or verified');
    }

    // Run inference
    const rawDetections = await this.engine.infer(
      frameData,
      this.loadedModel.manifest.runtimeConfigJson.inputWidth,
      this.loadedModel.manifest.runtimeConfigJson.inputHeight
    );

    this.healthMonitor.incrementInference();

    // Normalize each detection
    const normalizedEvents: NormalizedDetectionEvent[] = rawDetections.map((raw) =>
      DetectionNormalizer.normalize(raw, {
        tenantId: context.tenantId,
        cameraId: context.cameraId,
        modelManifestId: this.loadedModel!.manifest.id,
        frameTimestamp: context.frameTimestamp,
      })
    );

    // Transmit normalized events to backend internal API
    for (const event of normalizedEvents) {
      await this.apiClient.submitDetection(event);
    }

    return normalizedEvents;
  }

  public getHealth() {
    return this.healthMonitor.getStatus();
  }
}
