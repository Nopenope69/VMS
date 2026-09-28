/**
 * ai-adapter.v1: the stable contract between VigilOne and any AI runtime (in-process ONNX worker,
 * a separate ANPR container, an external analytics box). Models are swappable behind it.
 * Spec: docs/contracts/ai-adapter.v1.md. Contract test: src/__tests__/contracts/aiAdapter.v1.test.ts.
 *
 * Invariants encoded here:
 *  - a successful result always carries per-inference provenance (model id/name/version/sha256,
 *    runtime, inference id, frame timestamp);
 *  - an error result carries an explicit error code and no detections;
 *  - models declare code and weight licences, and only permissive licences are accepted;
 *  - AI failure is reported, never masked; it never touches recording or evidence.
 */
import { z } from 'zod';
import { Confidence, NonEmptyId, NormalizedBox, PermissiveLicense, Sha256Hex, UtcTimestamp } from './common';
import { AiProvenanceV1 } from './events.v1';

export const AI_ADAPTER_CONTRACT = 'ai-adapter.v1' as const;

export const AiTaskV1 = z.enum(['object_detection', 'plate_recognition', 'face_detection_for_redaction', 'embedding']);

export const ModelCardV1 = z
  .object({
    modelId: NonEmptyId,
    name: z.string().min(1),
    version: z.string().min(1),
    sha256: Sha256Hex,
    task: AiTaskV1,
    classes: z.array(z.string().min(1)).min(1),
    codeLicense: PermissiveLicense,
    weightsLicense: PermissiveLicense,
    /** Where the weights came from (URL or document reference), for licence audit. */
    weightsSource: z.string().min(1),
    runtime: z.enum(['onnxruntime', 'openvino']),
    input: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        colorSpace: z.enum(['RGB', 'BGR']),
        letterbox: z.boolean(),
      })
      .strict(),
    /** Published accuracy for this model on a named dataset, or null if not yet measured. */
    evaluation: z
      .object({
        dataset: z.string().min(1),
        metric: z.string().min(1),
        value: z.number().finite(),
        reportRef: z.string().min(1),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const AdapterDescriptorV1 = z
  .object({
    contract: z.literal(AI_ADAPTER_CONTRACT),
    adapterId: NonEmptyId,
    adapterVersion: z.string().min(1),
    tasks: z.array(AiTaskV1).min(1),
    models: z.array(ModelCardV1),
    /** Air-gapped deployments must reject adapters that call external endpoints. */
    requiresNetworkEgress: z.boolean(),
  })
  .strict()
  .superRefine((d, ctx) => {
    for (const [i, m] of d.models.entries()) {
      if (!d.tasks.includes(m.task)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['models', i, 'task'], message: `model task '${m.task}' is not declared by the adapter` });
      }
    }
  });

export const FrameRefV1 = z
  .object({
    cameraId: NonEmptyId,
    streamSessionId: NonEmptyId,
    sequenceNumber: z.number().int().nonnegative(),
    timestampUtc: UtcTimestamp,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    format: z.enum(['rgb24', 'bgr24', 'jpeg']),
    data: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('inline_base64'), value: z.string().min(1) }).strict(),
      z.object({ kind: z.literal('shared_memory'), key: z.string().min(1), byteLength: z.number().int().positive() }).strict(),
    ]),
  })
  .strict();

export const InferenceRequestV1 = z
  .object({
    contract: z.literal(AI_ADAPTER_CONTRACT),
    requestId: NonEmptyId,
    tenantId: NonEmptyId,
    task: AiTaskV1,
    modelId: NonEmptyId,
    frame: FrameRefV1,
    deadlineMs: z.number().int().positive().max(60000),
  })
  .strict();

export const DetectionV1 = z
  .object({
    objectClass: z.string().min(1),
    classId: z.number().int().nonnegative(),
    confidence: Confidence,
    bbox: NormalizedBox,
    trackId: NonEmptyId.optional(),
    /** Task-specific attributes, e.g. { plateText } for plate_recognition. */
    attributes: z.record(z.unknown()).optional(),
  })
  .strict();

export const AI_ADAPTER_ERROR_CODES = [
  'MODEL_NOT_LOADED',
  'MODEL_INTEGRITY_FAILED',
  'LICENSE_REJECTED',
  'UNSUPPORTED_TASK',
  'INVALID_FRAME',
  'DEADLINE_EXCEEDED',
  'RUNTIME_ERROR',
  'OVERLOADED',
] as const;

export const InferenceResultV1 = z.discriminatedUnion('status', [
  z
    .object({
      contract: z.literal(AI_ADAPTER_CONTRACT),
      status: z.literal('ok'),
      requestId: NonEmptyId,
      detections: z.array(DetectionV1),
      provenance: AiProvenanceV1,
      latencyMs: z.number().nonnegative(),
    })
    .strict(),
  z
    .object({
      contract: z.literal(AI_ADAPTER_CONTRACT),
      status: z.literal('error'),
      requestId: NonEmptyId,
      errorCode: z.enum(AI_ADAPTER_ERROR_CODES),
      message: z.string().min(1),
      retryable: z.boolean(),
    })
    .strict(),
]);

export const AdapterHealthV1 = z
  .object({
    contract: z.literal(AI_ADAPTER_CONTRACT),
    adapterId: NonEmptyId,
    status: z.enum(['READY', 'LOADING', 'DEGRADED', 'FAILED']),
    loadedModelIds: z.array(NonEmptyId),
    lastError: z.string().nullable(),
    observedAtUtc: UtcTimestamp,
  })
  .strict()
  .superRefine((h, ctx) => {
    if (h.status === 'READY' && h.loadedModelIds.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['loadedModelIds'], message: 'READY requires at least one loaded model' });
    }
    if (h.status === 'FAILED' && !h.lastError) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lastError'], message: 'FAILED requires lastError' });
    }
  });

export type ModelCardV1 = z.infer<typeof ModelCardV1>;
export type AdapterDescriptorV1 = z.infer<typeof AdapterDescriptorV1>;
export type InferenceRequestV1 = z.infer<typeof InferenceRequestV1>;
export type InferenceResultV1 = z.infer<typeof InferenceResultV1>;
export type DetectionV1 = z.infer<typeof DetectionV1>;
export type AdapterHealthV1 = z.infer<typeof AdapterHealthV1>;

/** COCO v1 classes mapped to events.v1 types (docs/contracts/ai-adapter.v1.md). */
export const DETECTION_CLASS_TO_EVENT_V1: Record<string, 'ai.person_detected' | 'ai.vehicle_detected'> = {
  person: 'ai.person_detected',
  bicycle: 'ai.vehicle_detected',
  motorcycle: 'ai.vehicle_detected',
  car: 'ai.vehicle_detected',
  bus: 'ai.vehicle_detected',
  truck: 'ai.vehicle_detected',
};
