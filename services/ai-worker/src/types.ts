export interface RuntimeConfig {
  runtime: string;
  runtimeVersion?: string;
  executionProvider?: string;
  executionProviderVersion?: string;
  inputWidth: number;
  inputHeight: number;
  colorSpace: 'RGB' | 'BGR' | 'GRAY' | string;
  normalization?: {
    type: string;
    value?: number | number[];
    mean?: number[];
    std?: number[];
  };
  letterbox?: boolean;
  /** Where the letterbox padding goes. YOLOX's official preprocessing pads bottom/right ('top-left'). */
  padPosition?: PadPosition;
  /** Grey level (0..255) of letterbox padding. YOLOX trains with 114. Defaults to 0. */
  padValue?: number;
  modelFormat: string;
}

export type PadPosition = 'center' | 'top-left';

export interface ModelManifestRecord {
  id: string;
  name: string;
  version: string;
  sha256: string;
  codeLicense: string;
  weightLicense: string;
  runtimeConfigJson: RuntimeConfig;
  thresholdsJson?: ModelThresholds;
  classesJson?: ModelClassMapping;
  modelSignatureJson?: ModelSignature;
  nmsConfigJson?: ModelNmsConfig;
  isActive: boolean;
  /** Present when the manifest comes from the backend registry (P2.6 provenance). */
  weightsSource?: string | null;
}

export interface RawDetection {
  classId: number;
  label: string;
  confidence: number;
  box: {
    x: number; // Normalized [0..1]
    y: number;
    width: number;
    height: number;
  };
}

export type TrackState =
  | 'TENTATIVE'
  | 'CONFIRMED'
  | 'LOST'
  | 'TERMINATED';

export interface TrackedObject {
  trackId: string;
  classId: number;
  label: string;
  state: TrackState;
  box: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  centroid: {
    x: number;
    y: number;
  };
  velocity: {
    vx: number;
    vy: number;
  };
  trajectory: Array<{
    x: number;
    y: number;
    timestamp: Date;
  }>;
  hits: number;
  consecutiveHits: number;
  lostFrames: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface NormalizedDetectionEvent {
  tenantId: string;
  cameraId: string;
  modelManifestId: string;
  inferenceId: string;
  type: string;
  confidence: number;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  centroid?: {
    x: number;
    y: number;
  };
  trackId?: string;
  trackState?: TrackState;
  velocity?: {
    vx: number;
    vy: number;
  };
  attributesJson?: Record<string, any>;
  timestamp: string;
}

export interface WorkerHealthStatus {
  status: 'HEALTHY' | 'DEGRADED' | 'INITIALIZING' | 'ERROR';
  workerId: string;
  uptimeSeconds: number;
  loadedModel?: {
    id: string;
    name: string;
    version: string;
    sha256: string;
    verified: boolean;
  };
  inferenceCount: number;
  lastError?: string;
}

export interface DiscoveredCamera {
  id: string;
  tenantId: string;
  name: string;
  streamPath: string;
  isOnline: boolean;
}

export interface FrameGeometry {
  sourceWidth: number;
  sourceHeight: number;
  modelWidth: number;
  modelHeight: number;
  scale: number;
  padX: number;
  padY: number;
  /** Integer size of the source image inside the model canvas (after scaling, before padding). */
  scaledWidth?: number;
  scaledHeight?: number;
  letterbox?: boolean;
  padPosition?: PadPosition;
}

export interface VideoFrame {
  cameraId: string;
  tenantId: string;
  streamPath: string;
  streamSessionId: string;
  sequenceNumber: number;
  sampledAt: Date;
  receivedAt: Date;
  width: number;
  height: number;
  channels: number;
  data: Buffer;
  geometry: FrameGeometry;
}

export type StreamLifecycleState =
  | 'DISCOVERED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'RUNNING'
  | 'DISCONNECTED'
  | 'BACKOFF'
  | 'STOPPING'
  | 'STOPPED'
  | 'FAILED';

export interface CameraStreamConfig {
  cameraId: string;
  tenantId: string;
  streamPath: string;
  fps?: number;
  width?: number;
  height?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  letterbox?: boolean;
  padPosition?: PadPosition;
  /** Grey level of letterbox padding (YOLOX: 114). */
  padValue?: number;
  queueCapacity?: number;
  probeTimeoutMs?: number;
}

export interface StreamTelemetry {
  cameraId: string;
  state: StreamLifecycleState;
  lastSampledAt?: Date;
  lastError?: string;
  reconnectCount: number;
  queueDepth: number;
  droppedFrames: number;
  processedFrames: number;
}

export interface ResourceLimits {
  maxConcurrentStreams: number;
  maxFps: number;
  maxWidth: number;
  maxHeight: number;
}

export interface ModelTensorSignature {
  name: string;
  shape: number[];
  dtype: 'float32' | 'int64' | string;
  format?: string;
}

/**
 * How the raw output tensor(s) are turned into boxes.
 * - 'generic': already-decoded boxes, one row per candidate (SignatureDecoder).
 * - 'yolox': raw anchor-free grid outputs [1, N, 5 + C]; needs grid/stride decode, score = obj * cls.
 * - 'rfdetr': set prediction; `dets` [1, Q, 4] normalized cxcywh and `labels` [1, Q, C] logits (sigmoid).
 */
export type ModelDecoderKind = 'generic' | 'yolox' | 'rfdetr';

export interface ModelSignature {
  input: ModelTensorSignature;
  output: ModelTensorSignature;
  coordinateFormat: 'cxcywh' | 'xywh' | 'xyxy';
  hasObjectness: boolean;
  classCount: number;
  decoder?: ModelDecoderKind;
  /** YOLOX: feature-map strides, in output order. Default [8, 16, 32]. */
  strides?: number[];
  /** RF-DETR: name of the logits output (the boxes output is `output.name`). */
  logitsOutputName?: string;
  /** RF-DETR: exported class slot that is background (null = none). */
  backgroundClassId?: number | null;
}

export interface ModelClassMapping {
  [classIndex: string]: string;
}

export interface ModelThresholds {
  [className: string]: number;
}

export interface ModelNmsConfig {
  iouThreshold: number;
}

export interface InferenceSchedulerTelemetry {
  inferenceCount: number;
  successCount: number;
  errorCount: number;
  timeoutCount: number;
  droppedStaleCount: number;
  avgInferenceMs: number;
  maxInferenceMs: number;
  activeConcurrent: number;
}
