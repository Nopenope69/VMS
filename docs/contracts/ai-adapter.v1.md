# ai-adapter.v1: AI Adapter Contract

Status: v1 draft. Schema: `backend/src/contracts/aiAdapter.v1.ts`. The Phase 2 (P2.1) work
implements it; this document fixes the contract first so models and runtimes stay swappable.

## Scope

Any AI runtime behind VigilOne speaks this contract: the in-process ONNX worker
(`services/ai-worker`), a separate ANPR container, or an external analytics box. VigilOne never
depends on a model directly.

## Messages

- **`AdapterDescriptorV1`**: `adapterId`, `adapterVersion`, `tasks[]`
  (`object_detection`, `plate_recognition`, `face_detection_for_redaction`, `embedding`,
  `vlm_verification`, `query_rewrite`),
  `models[]` (model cards), `requiresNetworkEgress` (air-gapped deployments must reject `true`).
- **`ModelCardV1`**: `modelId`, `name`, `version`, `sha256`, `task`, `classes[]`,
  `codeLicense`, `weightsLicense`, `weightsSource`, `runtime` (`onnxruntime` \| `openvino`),
  `input` (`width`, `height`, `colorSpace`, `letterbox`), `evaluation` (published metric with a
  report reference, or `null` until measured).
- **`InferenceRequestV1`**: `requestId`, `tenantId`, `task`, `modelId`, `frame`
  (`cameraId`, `streamSessionId`, `sequenceNumber`, `timestampUtc`, `width`, `height`, `format`,
  `data` as inline base64 or a shared-memory reference), `deadlineMs` (at most 60000).
- **`InferenceResultV1`**: discriminated on `status`.
  - `ok`: `detections[]` (`objectClass`, `classId`, `confidence`, normalized `bbox`, `trackId?`,
    `attributes?`), **`provenance`** (the events.v1 AI provenance block), `latencyMs`.
  - `ok` for the `embedding` task (v1.1, additive and optional): the result also carries
    `embedding` = `{ dim, encoding: 'float32_base64', vector, normalized }` (little-endian float32
    array, base64) and `detections` is empty. A consumer checks that the decoded length is
    `dim * 4` bytes and that `dim` is a size it stores, rejects NaN, infinity and a zero vector, and
    normalises the vector itself. Existing v1 adapters and consumers are unaffected: the field is
    optional and ignored by anything that does not use it. The request for an embedding is an
    ordinary `InferenceRequestV1` with `task: 'embedding'` and a `jpeg` frame (a crop).
  - Text embedding (v1.1, additive and optional): `POST /v1/embed-text` with
    `TextEmbeddingRequestV1` = `{ contract, requestId, tenantId, modelId, text (1 to 512 characters),
    deadlineMs }`. The answer is an ordinary `ok` result with `embedding` set, empty `detections` and
    provenance naming the same model that embeds images, so the two vectors are comparable. An adapter
    without a text tower answers 404. Errors use the same codes and HTTP statuses as `/v1/infer`.
  - `vlm_verification` (v1.1, additive and optional): the request carries `vlmQuery: { targetClass }` (a
    lower-case class name the adapter lists in its model card's `classes`; no free-text prompt) and a `jpeg`
    frame; `vlmQuery` is refused on any other task and required on this one. The `ok` result carries
    `verification: { targetClass, answer: yes | no | unclear, reason, promptSha256 }` and empty
    `detections`. The answer is advisory: a consumer must never change an alarm because of it. A model card
    may name `llama.cpp` as its runtime.
  - Text rewrite (v1.2, additive and optional; task `query_rewrite`): `POST /v1/rewrite-text` with
    `TextRewriteRequestV1` = `{ contract, requestId, tenantId, modelId, text (1 to 512 characters),
    vocabulary? (at most 64 place names, each at most 60 characters), deadlineMs }`. The `ok` result carries
    `rewrite: { text, promptSha256 }` (the request in plain English, keeping the place names as given in
    `vocabulary`) and empty `detections`; provenance names the rewrite model. The rewrite is only text for the
    consumer's own rules to read: it never sets a search filter by itself, and VigilOne keeps what its rules
    read in the original request when the two disagree. An adapter without a rewrite model answers 404;
    `/v1/infer` on `query_rewrite` answers `UNSUPPORTED_TASK`. Errors use the same codes and HTTP statuses as
    `/v1/infer`.
  - `error`: `errorCode` (`MODEL_NOT_LOADED`, `MODEL_INTEGRITY_FAILED`, `LICENSE_REJECTED`,
    `UNSUPPORTED_TASK`, `INVALID_FRAME`, `DEADLINE_EXCEEDED`, `RUNTIME_ERROR`, `OVERLOADED`),
    `message`, `retryable`. An error never carries detections.
- **`AdapterHealthV1`**: `status` (`READY` needs at least one loaded model; `FAILED` needs
  `lastError`), `loadedModelIds[]`, `observedAtUtc`.

## Invariants

1. No success without provenance. A result that cannot state the model hash and inference id is
   an error, not an empty success.
2. Licences: code and weights licences must be one of MIT, Apache-2.0, BSD-2-Clause,
   BSD-3-Clause, ISC. AGPL, GPL, CC-BY-NC and proprietary weights are not representable. This
   complements `npm run check:model-licenses`.
3. AI failure is isolated: adapters never write recordings or evidence, and an adapter crash or
   timeout must not affect recording (PROJECT_STATE.md section 2).
4. Accuracy is published, not asserted: `evaluation` stays `null` until a real evaluation report
   exists (Phase 2 exit gate).

## Mapping to events.v1

`DETECTION_CLASS_TO_EVENT_V1`: `person` to `ai.person_detected`; `bicycle`, `motorcycle`, `car`,
`bus`, `truck` to `ai.vehicle_detected`. The result's `provenance` is copied into the event
unchanged. Other classes are not emitted as events in v1.

## Relationship to the current ai-worker

`services/ai-worker` posts `NormalizedDetectionEvent` to `POST /internal/detections` with a
`modelManifestId` and `inferenceId`. That is a subset of this contract (it lacks the full
provenance block and the error channel). Migrating the worker to `InferenceResultV1` is P2.1 work
(see `docs/BACKLOG.md`).
