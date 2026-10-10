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
import { Confidence, NonEmptyId, NormalizedBox, PermissiveLicense, PermissiveLicenseExpression, Sha256Hex, UtcTimestamp } from './common';
import { AiProvenanceV1 } from './events.v1';

export const AI_ADAPTER_CONTRACT = 'ai-adapter.v1' as const;

export const AiTaskV1 = z.enum(['object_detection', 'plate_recognition', 'face_detection_for_redaction', 'plate_detection_for_redaction', 'embedding', 'vlm_verification', 'query_rewrite', 'rule_draft']);

export const ModelCardV1 = z
  .object({
    modelId: NonEmptyId,
    name: z.string().min(1),
    version: z.string().min(1),
    sha256: Sha256Hex,
    task: AiTaskV1,
    classes: z.array(z.string().min(1)).min(1),
    codeLicense: PermissiveLicenseExpression,
    weightsLicense: PermissiveLicenseExpression,
    /** Where the weights came from (URL or document reference), for licence audit. */
    weightsSource: z.string().min(1),
    runtime: z.enum(['onnxruntime', 'openvino', 'llama.cpp']),
    input: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        colorSpace: z.enum(['RGB', 'BGR']),
        letterbox: z.boolean(),
        /** 'fixed' (default): frames are resized to width x height. 'min_side': the shorter side is
         *  scaled to width (= height) and both sides rounded to multiples of 32 (text detection). */
        resizeMode: z.enum(['fixed', 'min_side']).optional(),
      })
      .strict(),
    /** Pipelines: the models the adapter chains, each with its own artefact hash and licence. */
    components: z
      .array(z.object({ role: z.string().min(1), name: z.string().min(1), version: z.string().min(1), sha256: Sha256Hex, weightsLicense: PermissiveLicense }).strict())
      .max(8)
      .optional(),
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
    /** v1.1, optional: required for `vlm_verification`, refused for every other task (by the adapter). */
    vlmQuery: z.lazy(() => VlmQueryV1).optional(),
  })
  .strict();

/**
 * v1.1 (additive, optional): the question a `vlm_verification` request asks. The adapter builds the
 * prompt itself from a fixed, versioned template; the caller only names the object class to check,
 * which must be one the adapter lists. No free-text prompt crosses the contract.
 */
export const VlmQueryV1 = z
  .object({
    targetClass: z.string().regex(/^[a-z][a-z_ ]{0,39}$/),
  })
  .strict();
export type VlmQueryV1 = z.infer<typeof VlmQueryV1>;

/**
 * v1.1 (additive, optional): what a `vlm_verification` result carries. `answer` is whether the model sees
 * the target class in the frame. Advisory only: consumers must never change an alarm because of it.
 */
export const VerificationV1 = z
  .object({
    targetClass: z.string().min(1),
    answer: z.enum(['yes', 'no', 'unclear']),
    reason: z.string().max(400),
    /** SHA-256 of the exact prompt sent to the model (template version, question, generation settings). */
    promptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type VerificationV1 = z.infer<typeof VerificationV1>;

/**
 * v1.1 (additive, optional): a text embedding request, `POST /v1/embed-text`. The answer is an ordinary
 * ok InferenceResultV1 with `embedding` set and empty `detections`, its provenance naming the same model
 * that embeds images, so a text vector and a crop vector are comparable. An adapter without a text tower
 * answers 404. Text is at most 512 characters.
 */
export const TextEmbeddingRequestV1 = z
  .object({
    contract: z.literal(AI_ADAPTER_CONTRACT),
    requestId: NonEmptyId,
    tenantId: NonEmptyId,
    modelId: NonEmptyId,
    text: z.string().min(1).max(512),
    deadlineMs: z.number().int().positive().max(60000),
  })
  .strict();
export type TextEmbeddingRequestV1 = z.infer<typeof TextEmbeddingRequestV1>;

/**
 * v1.2 (additive, optional): a plain-language search request rewritten into plain English, `POST /v1/rewrite-text`,
 * served only by a `query_rewrite` model (an adapter without one answers 404). The adapter builds the prompt from a
 * fixed, versioned template; the caller gives only the request and, optionally, the site's camera and zone names
 * so the model can use them. The answer is an ordinary ok InferenceResultV1 with `rewrite` set and empty
 * `detections`. VigilOne's own rules then read the English text; the model never sets search filters itself.
 */
export const TextRewriteRequestV1 = z
  .object({
    contract: z.literal(AI_ADAPTER_CONTRACT),
    requestId: NonEmptyId,
    tenantId: NonEmptyId,
    modelId: NonEmptyId,
    text: z.string().min(1).max(512),
    vocabulary: z.array(z.string().min(1).max(60)).max(64).optional(),
    deadlineMs: z.number().int().positive().max(60000),
  })
  .strict();
export type TextRewriteRequestV1 = z.infer<typeof TextRewriteRequestV1>;

export const RewriteV1 = z
  .object({
    text: z.string().min(1).max(512),
    /** SHA-256 of the exact prompt (template version, instructions, vocabulary, generation settings). */
    promptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type RewriteV1 = z.infer<typeof RewriteV1>;

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

/**
 * v1.1 (additive, optional): the vector an `embedding` task returns. `detections` stays present (empty).
 * The vector is little-endian float32, base64. A consumer checks that the decoded length is dim * 4 bytes
 * and that dim is the size it stores; a producer never sends NaN or infinity.
 */
export const EmbeddingV1 = z
  .object({
    dim: z.number().int().positive().max(4096),
    encoding: z.literal('float32_base64'),
    vector: z.string().min(1),
    /** True when the adapter already scaled the vector to unit length. Consumers normalise regardless. */
    normalized: z.boolean(),
  })
  .strict();
export type EmbeddingV1 = z.infer<typeof EmbeddingV1>;

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
      /** v1.1, optional: present for the `embedding` task. */
      embedding: EmbeddingV1.optional(),
      /** v1.1, optional: present for the `vlm_verification` task. */
      verification: VerificationV1.optional(),
      /** v1.2, optional: present for a `POST /v1/rewrite-text` answer. */
      rewrite: RewriteV1.optional(),
      /** optional: present for a `POST /v1/extract-rule-intent` answer. */
      ruleIntent: z.object({ ir: z.record(z.any()), promptSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
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
