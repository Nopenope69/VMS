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

## The worker on the SDK (2026-10-03)
The review proposed running the worker's pipelines as models behind the SDK's `createAdapter` server. At first
that was not done, for three reasons: the SDK's `ModelOutput` had no `verification` (VLM answers) and no
component provenance; the SDK had no liveness hook (the VLM is FAILED when its llama.cpp sidecar dies, ADR
0005); and the worker image did not ship the SDK. The owner chose to close those gaps as their own piece of
work (2026-10-02). They are now closed:

* **SDK 0.2.0, additive.** The contract rules moved out of the HTTP server into `sdk/ai-adapter/src/core.ts`
  (`createAdapterCore`); `createAdapter` is that core plus HTTP. New on a model: `failure()` (liveness),
  `provenanceComponents` (added to the card's components, which provenance now always lists), `tasks` (a
  model serving more than one task, e.g. faces and plates). New on `ModelOutput`: `verification`. New on the
  adapter: `tasks` and `loadFailure` (an adapter whose models could not be built), `onOutcome` (metrics),
  `run()` and `provenance()` for work outside a request (the camera LPR path). The core also refuses frames
  over 3840x2160, a `vlmQuery` on any task but `vlm_verification`, a target class not in the card, and a VLM
  answer for another class. Health is DEGRADED (HTTP 200) while every slot is busy.
* **The worker ships the SDK.** `services/ai-worker/src/sdk/` is a generated copy of the SDK core and the
  contract it needs (`npm run sync-sdk`; CI runs `npm run check-sdk`, so it cannot drift), the same way the SDK
  carries a copy of the backend contract. `zod` is now a worker dependency. A copy rather than an npm link,
  because the worker image is built from its own package and lock file.
* **The pipelines run on it.** `PipelineAdapterCore` is now a thin layer: it builds the SDK model from the
  pipeline (card, runtime, components, liveness, model call) and counts outcomes in the worker's metrics. The
  copies of validation, deadlines, concurrency, provenance and error results in the worker are gone.

Still separate: the object-detection core (`adapterCore.ts`) keeps its own queue, which the camera stream
pipeline shares; the worker keeps its own HTTP layer (`httpServer.ts`, with `/metrics` and `X-Contract`).

Behaviour changes for the pipeline adapters, all stricter: every result is validated against the contract
schemas before it is returned; an all-zero embedding is refused; the deadline now also aborts the wait (the
answer is `DEADLINE_EXCEEDED` when the deadline passes, not when the model finally returns); the embedding
`normalized` flag is computed instead of always `false`; the request id echoed for an unreadable body is
`invalid-<uuid>`. CI runs the conformance kit against the SDK server and the worker's object-detection adapter;
the pipeline adapters are covered by their own adapter tests (stub and real-model) and the SDK core tests.

## Consequences
* The backend client and the worker base can each be tested once. The existing adapter tests, both stub-based
  and real-model, pass unmodified.
* Two small behaviour changes, both stricter or more accurate:
  * the redaction client now refuses a result that answers a different request id;
  * ANPR and redaction now count their error outcomes in the metrics.
