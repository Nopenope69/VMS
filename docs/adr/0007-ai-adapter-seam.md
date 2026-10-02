# 0007: One ai-adapter.v1 seam on each side

## Status
Accepted (2026-10-01). Item 3 of the architecture review.

## Context
The rules of ai-adapter.v1 were written out once per adapter on both sides of the seam.

* **Backend.** Three clients (embedding, redaction regions, VLM second opinion; 402 lines in all) each had
  their own copy of:
  * the health and descriptor probes;
  * the model-registry check;
  * request posting and result validation;
  * the check that the result names the verified model.

  They had already drifted. The redaction client did not check that a result answered its own request. The
  VLM client threw a raw JSON error on a non-JSON health reply.
* **Worker.** Four pipeline cores (ANPR, redaction, embedding, VLM) each had their own copy of:
  * the request id echo;
  * validation, task and model checks;
  * the busy limit (OVERLOADED);
  * the deadline rule;
  * error results;
  * health, descriptor, and the license and component provenance.

  Their metrics had drifted too: ANPR and redaction never counted error outcomes.

## Decision
* **Backend:** `services/ai/aiAdapterClient.ts` (`AiAdapterClient`) is the one connection to an adapter:
  `probe(tasks)`, `registeredCard(prisma, descriptor, task)` and `call(path, body, model?)`.
  * Each caller keeps its own error type and codes through a `fail(kind, message)` hook, so `EmbeddingError`,
    `VlmError` and `RedactionError`, and the callers' handling of them, do not change.
  * Task-specific checks of a result stay with the caller: the embedding dimension, the VLM target class,
    the region classes and the redaction provenance.
* **Worker:** `adapter/pipelineAdapterCore.ts` (`PipelineAdapterCore`) holds the contract rules for every model
  pipeline. Each pipeline adapter supplies its model card, its runtime label and its model call.
  * Every failure is counted once in `vigilone_ai_inferences_total`, including those from the camera LPR
    path that calls `AnprAdapterCore.recognize()` directly.
  * The object-detection core (`adapterCore.ts`) keeps its own queue, which the camera stream pipeline shares.

## Not done, and why
The review proposed running the worker's pipelines as models behind the SDK's `createAdapter` server. That was
not done, for three reasons:

* The SDK's `ModelOutput` has no `verification` (VLM answers) and no component provenance.
* The SDK has no liveness hook (the VLM is FAILED when its llama.cpp sidecar dies, ADR 0005).
* The worker image does not ship the SDK.

Closing those gaps is a change to the published SDK interface and deserves its own decision. (2026-10-02: the
owner chose to do it as a separate piece of work, not in the Bucket 7 housekeeping.) Until then, the
worker's base class and the SDK server enforce the same rules in two places. CI runs the conformance kit
against the SDK server and against the worker's object-detection adapter. The pipeline adapters are covered by
their own adapter tests (stub and real-model), not by the kit.

## Consequences
* The backend client and the worker base can each be tested once. The existing adapter tests, both stub-based
  and real-model, pass unmodified.
* Two small behaviour changes, both stricter or more accurate:
  * the redaction client now refuses a result that answers a different request id;
  * ANPR and redaction now count their error outcomes in the metrics.
