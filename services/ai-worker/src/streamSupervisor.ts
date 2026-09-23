import { EventEmitter } from 'events';
import { StreamManager } from './streamManager';
import { ResourceGovernor } from './frameQueue';
import { AuthenticatedInternalApiClient } from './apiClient';
import { AiWorker } from './worker';
import {
  DiscoveredCamera,
  CameraStreamConfig,
  StreamTelemetry,
  VideoFrame,
} from './types';

export interface StreamSupervisorConfig {
  apiClient: AuthenticatedInternalApiClient;
  aiWorker: AiWorker;
  governor?: ResourceGovernor;
  rtspPort?: number;
  syncIntervalMs?: number;
  defaultStreamConfig?: Partial<CameraStreamConfig>;
}

/**
 * Stream Supervisor: Multi-Camera Frame Pipeline Coordinator.
 *
 * PIPELINE FLOW:
 * MediaMTX Loopback (127.0.0.1:8554)
 *   ↓ TCP
 * FFmpeg Filter Decimation (fps=1, aspect scale)
 *   ↓
 * FrameExtractor (memory-bounded)
 *   ↓
 * Per-Camera BoundedFrameQueue (capacity=10, drop-oldest)
 *   ↓
 * AiWorker.processFrame() (Step 1 decoupled interface)
 *   ↓
 * Authenticated Internal Ingestion API (/internal/detections)
 */
export class StreamSupervisor extends EventEmitter {
  private apiClient: AuthenticatedInternalApiClient;
  private aiWorker: AiWorker;
  private governor: ResourceGovernor;
  private rtspPort?: number;
  private syncIntervalMs: number;
  private defaultStreamConfig: Partial<CameraStreamConfig>;

  private streams: Map<string, StreamManager> = new Map();
  private syncTimer: NodeJS.Timeout | null = null;
  private isProcessingFrame: Map<string, boolean> = new Map();
  private isRunning: boolean = false;

  constructor(config: StreamSupervisorConfig) {
    super();
    this.apiClient = config.apiClient;
    this.aiWorker = config.aiWorker;
    this.governor = config.governor || new ResourceGovernor();
    this.rtspPort = config.rtspPort;
    this.syncIntervalMs = config.syncIntervalMs || 30000;
    this.defaultStreamConfig = config.defaultStreamConfig || {};
  }

  /**
   * Starts supervisor and background camera discovery sync loop.
   */
  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    // Initial sync
    await this.syncCameras().catch((err) => {
      this.emit('warn', `Initial camera discovery sync failed: ${err.message}`);
    });

    // Periodic discovery sync
    this.syncTimer = setInterval(() => {
      this.syncCameras().catch((err) => {
        this.emit('warn', `Periodic camera discovery sync failed: ${err.message}`);
      });
    }, this.syncIntervalMs);
  }

  /**
   * Discovers active cameras from the backend and reconciles running stream managers.
   */
  public async syncCameras(): Promise<DiscoveredCamera[]> {
    const discovered = await this.apiClient.fetchActiveCameras();
    const discoveredMap = new Map<string, DiscoveredCamera>();

    for (const cam of discovered) {
      discoveredMap.set(cam.id, cam);

      if (cam.isOnline && !this.streams.has(cam.id)) {
        if (this.governor.canAdmitStream(cam.id)) {
          this.startCameraStream(cam);
        } else {
          this.emit('warn', `Cannot admit camera '${cam.name}' (${cam.id}): Concurrency limit reached`);
        }
      } else if (!cam.isOnline && this.streams.has(cam.id)) {
        // Camera went offline; stop AI frame acquisition
        await this.stopCameraStream(cam.id);
      }
    }

    // Stop streams for cameras removed from backend
    for (const [cameraId] of this.streams) {
      if (!discoveredMap.has(cameraId)) {
        await this.stopCameraStream(cameraId);
      }
    }

    return discovered;
  }

  /**
   * Starts stream ingestion for an individual camera.
   */
  public startCameraStream(
    camera: DiscoveredCamera,
    customConfig?: Partial<CameraStreamConfig>
  ): StreamManager {
    if (this.streams.has(camera.id)) {
      return this.streams.get(camera.id)!;
    }

    const rawConfig: CameraStreamConfig = {
      cameraId: camera.id,
      tenantId: camera.tenantId,
      streamPath: camera.streamPath,
      ...this.defaultStreamConfig,
      ...(customConfig || {}),
    };

    const sanitizedConfig = this.governor.sanitizeStreamConfig(rawConfig);
    this.governor.registerStream(camera.id);

    const manager = new StreamManager({
      ...sanitizedConfig,
      rtspPort: this.rtspPort,
    });

    manager.on('frame', (frame: VideoFrame) => {
      this.handleIncomingFrame(frame);
    });

    manager.on('error', (err: Error) => {
      this.emit('streamError', { cameraId: camera.id, error: err.message });
    });

    this.streams.set(camera.id, manager);
    manager.start();

    return manager;
  }

  /**
   * Dispatches a frame to the AI Worker and pulls from the queue.
   */
  private async handleIncomingFrame(frame: VideoFrame): Promise<void> {
    const cameraId = frame.cameraId;

    // Check if inference is already busy processing a frame for this camera
    if (this.isProcessingFrame.get(cameraId)) {
      // Busy: Frame sits in bounded queue or will be dropped if queue fills
      return;
    }

    const manager = this.streams.get(cameraId);
    if (!manager) return;

    this.isProcessingFrame.set(cameraId, true);

    try {
      // Process frame through decoupled AI worker interface
      await this.aiWorker.processFrame(frame.data, {
        tenantId: frame.tenantId,
        cameraId: frame.cameraId,
        frameTimestamp: frame.sampledAt,
      });

      this.emit('frameProcessed', {
        cameraId: frame.cameraId,
        sequenceNumber: frame.sequenceNumber,
      });
    } catch (err: any) {
      // INVARIANT: AI inference errors are caught and logged; NEVER crash media stream
      this.emit('inferenceError', {
        cameraId: frame.cameraId,
        sequenceNumber: frame.sequenceNumber,
        error: err.message,
      });
    } finally {
      this.isProcessingFrame.set(cameraId, false);

      // Drain next frame if queued
      const nextFrame = manager.getQueue().dequeue();
      if (nextFrame) {
        setImmediate(() => this.handleIncomingFrame(nextFrame));
      }
    }
  }

  /**
   * Stops frame acquisition for a specific camera.
   */
  public async stopCameraStream(cameraId: string): Promise<void> {
    const manager = this.streams.get(cameraId);
    if (manager) {
      this.streams.delete(cameraId);
      this.governor.releaseStream(cameraId);
      await manager.stop();
    }
  }

  /**
   * Consolidated stream telemetry for all active camera streams.
   */
  public getConsolidatedTelemetry(): Record<string, StreamTelemetry> {
    const result: Record<string, StreamTelemetry> = {};
    for (const [cameraId, manager] of this.streams) {
      result[cameraId] = manager.getTelemetry();
    }
    return result;
  }

  public getStreamCount(): number {
    return this.streams.size;
  }

  public getStreamManager(cameraId: string): StreamManager | undefined {
    return this.streams.get(cameraId);
  }

  /**
   * Gracefully stops all active streams and terminates supervisor.
   */
  public async stopAll(): Promise<void> {
    this.isRunning = false;
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }

    const stopPromises: Promise<void>[] = [];
    for (const [cameraId, manager] of this.streams) {
      this.governor.releaseStream(cameraId);
      stopPromises.push(manager.stop());
    }

    this.streams.clear();
    await Promise.all(stopPromises);
  }
}
