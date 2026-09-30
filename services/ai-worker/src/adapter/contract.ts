/**
 * ai-adapter.v1 message shapes (docs/contracts/ai-adapter.v1.md). The zod schemas in
 * backend/src/contracts/aiAdapter.v1.ts are authoritative; these interfaces mirror them so the
 * worker can build messages without depending on the backend package. The conformance suite
 * validates this adapter's real responses against the zod schemas.
 */
export const AI_ADAPTER_CONTRACT = 'ai-adapter.v1' as const;

export type AiTaskV1 = 'object_detection' | 'plate_recognition' | 'face_detection_for_redaction' | 'plate_detection_for_redaction' | 'embedding';

export type AdapterErrorCode =
  | 'MODEL_NOT_LOADED'
  | 'MODEL_INTEGRITY_FAILED'
  | 'LICENSE_REJECTED'
  | 'UNSUPPORTED_TASK'
  | 'INVALID_FRAME'
  | 'DEADLINE_EXCEEDED'
  | 'RUNTIME_ERROR'
  | 'OVERLOADED';

export interface NormalizedBoxV1 {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AiProvenanceV1 {
  adapterId: string;
  adapterVersion: string;
  modelId: string;
  modelName: string;
  modelVersion: string;
  modelSha256: string;
  runtime: string;
  executionProvider?: string;
  inferenceId: string;
  frameTimestampUtc: string;
  /** Pipelines: modelSha256 names the pipeline definition; each chained model is listed. */
  components?: Array<{ role: string; modelName: string; modelVersion: string; modelSha256: string }>;
}

export interface ModelCardV1 {
  modelId: string;
  name: string;
  version: string;
  sha256: string;
  task: AiTaskV1;
  classes: string[];
  codeLicense: string;
  weightsLicense: string;
  weightsSource: string;
  runtime: 'onnxruntime' | 'openvino';
  input: { width: number; height: number; colorSpace: 'RGB' | 'BGR'; letterbox: boolean; resizeMode?: 'fixed' | 'min_side' };
  components?: Array<{ role: string; name: string; version: string; sha256: string; weightsLicense: string }>;
  evaluation: { dataset: string; metric: string; value: number; reportRef: string } | null;
}

export interface AdapterDescriptorV1 {
  contract: typeof AI_ADAPTER_CONTRACT;
  adapterId: string;
  adapterVersion: string;
  tasks: AiTaskV1[];
  models: ModelCardV1[];
  requiresNetworkEgress: boolean;
}

export interface FrameRefV1 {
  cameraId: string;
  streamSessionId: string;
  sequenceNumber: number;
  timestampUtc: string;
  width: number;
  height: number;
  format: 'rgb24' | 'bgr24' | 'jpeg';
  data: { kind: 'inline_base64'; value: string } | { kind: 'shared_memory'; key: string; byteLength: number };
}

export interface InferenceRequestV1 {
  contract: typeof AI_ADAPTER_CONTRACT;
  requestId: string;
  tenantId: string;
  task: AiTaskV1;
  modelId: string;
  frame: FrameRefV1;
  deadlineMs: number;
}

export interface DetectionV1 {
  objectClass: string;
  classId: number;
  confidence: number;
  bbox: NormalizedBoxV1;
  trackId?: string;
  attributes?: Record<string, unknown>;
}

export type InferenceResultV1 =
  | {
      contract: typeof AI_ADAPTER_CONTRACT;
      status: 'ok';
      requestId: string;
      detections: DetectionV1[];
      /** v1.1, optional: present for the `embedding` task (little-endian float32, base64). */
      embedding?: { dim: number; encoding: 'float32_base64'; vector: string; normalized: boolean };
      provenance: AiProvenanceV1;
      latencyMs: number;
    }
  | {
      contract: typeof AI_ADAPTER_CONTRACT;
      status: 'error';
      requestId: string;
      errorCode: AdapterErrorCode;
      message: string;
      retryable: boolean;
    };

export interface AdapterHealthV1 {
  contract: typeof AI_ADAPTER_CONTRACT;
  adapterId: string;
  status: 'READY' | 'LOADING' | 'DEGRADED' | 'FAILED';
  loadedModelIds: string[];
  lastError: string | null;
  observedAtUtc: string;
}

export const ERROR_HTTP_STATUS: Record<AdapterErrorCode, number> = {
  MODEL_NOT_LOADED: 503,
  MODEL_INTEGRITY_FAILED: 503,
  LICENSE_REJECTED: 503,
  UNSUPPORTED_TASK: 400,
  INVALID_FRAME: 400,
  DEADLINE_EXCEEDED: 504,
  RUNTIME_ERROR: 500,
  OVERLOADED: 429,
};

export const RETRYABLE: Record<AdapterErrorCode, boolean> = {
  MODEL_NOT_LOADED: true,
  MODEL_INTEGRITY_FAILED: false,
  LICENSE_REJECTED: false,
  UNSUPPORTED_TASK: false,
  INVALID_FRAME: false,
  DEADLINE_EXCEEDED: true,
  RUNTIME_ERROR: true,
  OVERLOADED: true,
};
