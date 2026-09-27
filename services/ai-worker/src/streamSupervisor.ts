import { EventEmitter } from 'events';
import { StreamManager } from './streamManager';
import { ResourceGovernor } from './frameQueue';
import { AuthenticatedInternalApiClient } from './apiClient';
import { AiWorker } from './worker';
import { MotionGate, MotionGateOptions } from './motionGate';
import { MetricsRegistry } from './metrics';
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
  metrics?: MetricsRegistry;
  /** P2.5 motion gating ('motion', default) or every sampled frame ('off'). */
  gateMode?: 'motion' | 'off';
  gateOptions?: MotionGateOptions;
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
  private readonly metrics: MetricsRegistry;
  private readonly gate: MotionGate;

  constructor(config: StreamSupervisorConfig) {
    super();
    this.apiClient = config.apiClient;
    this.aiWorker = config.aiWorker;
    this.governor = config.governor || new ResourceGovernor();
    this.rtspPort = config.rtspPort;
    this.syncIntervalMs = config.syncIntervalMs || 30000;
    this.defaultStreamConfig = config.defaultStreamConfig || {};
    this.metrics = config.metrics || new MetricsRegistry();
    this.gate = new MotionGate({ ...(config.gateOptions || {}), mode: config.gateMode ?? config.gateOptions?.mode ?? 'motion' });
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
    // Which cameras are armed by AI rules / show recent motion (P2.5). Optional in older backends.
    if (typeof (this.apiClient as any).fetchAiActivity === 'function') {
      try {
        this.gate.setActivity(await (this.apiClient as any).fetchAiActivity());
      } catch (err: any) {
        this.emit('warn', `AI activity poll failed (gating falls back to local motion): ${err.message}`);
      }
    }
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

    // StreamManager enqueues each decoded frame into the bounded per-camera queue and then emits
    // 'frame'. The queue is the only source of work: consuming the emitted frame as well would
    // infer the same frame twice.
    manager.on('frame', () => {
      this.metrics.inc('vigilone_ai_frames_sampled_total', 'Frames sampled from the loopback stream', { cameraId: camera.id });
      this.pump(camera.id);
    });

    manager.on('error', (err: Error) => {
      this.emit('streamError', { cameraId: camera.id, error: err.message });
    });

    manager.getQueue().on('drop', () => {
      this.metrics.inc('vigilone_ai_frames_dropped_total', 'Frames dropped before inference completed', { reason: 'queue_full' });
    });

    this.streams.set(camera.id, manager);
    manager.start();

    return manager;
  }

  /**
   * Takes the newest queued frame for a camera (older ones are stale), gates it, and infers.
   * One inference per camera at a time; the shared adapter core bounds global concurrency.
   */
  private pump(cameraId: string): void {
    if (this.isProcessingFrame.get(cameraId)) return;
    const manager = this.streams.get(cameraId);
    if (!manager) return;
    const queue = manager.getQueue();
    let frame = queue.dequeue();
    if (!frame) return;
    // Newest-frame preference: anything older than the latest queued frame is stale.
    let next = queue.dequeue();
    while (next) {
      this.metrics.inc('vigilone_ai_frames_dropped_total', 'Frames dropped before inference completed', { reason: 'stale' });
      frame = next;
      next = queue.dequeue();
    }

    const hasTracks =
      typeof (this.aiWorker as any).getTracker === 'function' &&
      (this.aiWorker as any).getTracker(cameraId).getTracks().some((t: any) => t.state !== 'TERMINATED');
    const decision = this.gate.decide(frame, !!hasTracks);
    this.metrics.inc('vigilone_ai_gate_decisions_total', 'Motion gate decisions', { outcome: decision.run ? 'run' : 'skip', reason: decision.reason });
    if (!decision.run) {
      this.metrics.inc('vigilone_ai_frames_dropped_total', 'Frames dropped before inference completed', { reason: decision.reason });
      return;
    }
    this.handleIncomingFrame(frame);
  }

  /**
   * Dispatches a frame to the AI Worker, then pulls the next frame from the queue.
   */
  private async handleIncomingFrame(frame: VideoFrame): Promise<void> {
    const cameraId = frame.cameraId;
    this.isProcessingFrame.set(cameraId, true);

    try {
      // Process frame through decoupled AI worker interface
      await this.aiWorker.processFrame(frame);
      this.metrics.inc('vigilone_ai_frames_inferred_total', 'Frames that went through inference', { cameraId });

      this.emit('frameProcessed', {
        cameraId: frame.cameraId,
        sequenceNumber: frame.sequenceNumber,
      });
    } catch (err: any) {
      // INVARIANT: AI inference errors are caught and logged; NEVER crash media stream
      this.metrics.inc('vigilone_ai_inference_errors_total', 'Inference errors in the stream pipeline', { cameraId });
      this.emit('inferenceError', {
        cameraId: frame.cameraId,
        sequenceNumber: frame.sequenceNumber,
        error: err.message,
      });
    } finally {
      this.isProcessingFrame.set(cameraId, false);
      if (this.streams.has(cameraId)) setImmediate(() => this.pump(cameraId));
    }
  }

  /** Prometheus text for per-camera pipeline state (appended to the adapter's /metrics). */
  public renderMetrics(): string {
    const lines: string[] = [
      '# HELP vigilone_ai_stream_state Camera frame-acquisition state (1 for the current state)',
      '# TYPE vigilone_ai_stream_state gauge',
    ];
    const q: string[] = ['# HELP vigilone_ai_queue_depth Frames waiting per camera', '# TYPE vigilone_ai_queue_depth gauge'];
    for (const [cameraId, manager] of this.streams) {
      const t = manager.getTelemetry();
      lines.push(`vigilone_ai_stream_state{cameraId="${cameraId}",state="${t.state}"} 1`);
      q.push(`vigilone_ai_queue_depth{cameraId="${cameraId}"} ${t.queueDepth}`);
    }
    return [...lines, ...q].join('\n') + '\n';
  }

  /**
   * Stops frame acquisition for a specific camera.
   */
  public async stopCameraStream(cameraId: string): Promise<void> {
    const manager = this.streams.get(cameraId);
    if (manager) {
      this.streams.delete(cameraId);
      this.governor.releaseStream(cameraId);
      this.gate.forget(cameraId);
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
