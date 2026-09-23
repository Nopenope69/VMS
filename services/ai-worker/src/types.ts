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
  modelFormat: string;
}

export interface ModelManifestRecord {
  id: string;
  name: string;
  version: string;
  sha256: string;
  codeLicense: string;
  weightLicense: string;
  runtimeConfigJson: RuntimeConfig;
  isActive: boolean;
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
  attributesJson?: Record<string, any>;
  timestamp: string;
}

export interface WorkerHealthStatus {
  status: 'HEALTHY' | 'DEGRADED' | 'INITIALIZING';
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
}

export interface DiscoveredCamera {
  id: string;
  tenantId: string;
  name: string;
  streamPath: string;
  isOnline: boolean;
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
  letterbox?: boolean;
  queueCapacity?: number;
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
