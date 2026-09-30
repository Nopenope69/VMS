# VigilOne AI adapter SDK (ai-adapter.v1)

This package lets you build an AI adapter that VigilOne can use: your detector, plate reader or embedding
model behind the `ai-adapter.v1` HTTP contract (`docs/contracts/ai-adapter.v1.md`).

**Status:** version 0.1.0. It is **private and unpublished**: the repository has no licence yet, and the
owner has to choose one before the SDK can be published.

## What you write, what the SDK guarantees

You write the model call. The SDK serves `/v1/descriptor`, `/v1/health`, `/v1/infer` and, when you provide
`embedText`, `/v1/embed-text`. It also guarantees the following, whatever your code does:

* **Checked answers.** Every answer is validated against the contract before it is sent. If your model
  returns something invalid, the SDK sends `RUNTIME_ERROR` instead of a bad success. Examples: a class that is
  not in your model card, a box outside the frame, a NaN confidence, a zero embedding.
* **Provenance.** The SDK fills it in from your model card: model hash, adapter, a fresh inference id, and
  the frame's own timestamp.
* **Frame checks.** It checks the byte length of `rgb24`/`bgr24` frames and the JPEG signature, and refuses
  shared-memory frames.
* **Deadlines.** Your model receives an `AbortSignal`. The SDK answers with `DEADLINE_EXCEEDED` (504) when the
  deadline passes, even if your model blocks the event loop.
* **Bounded concurrency.** Beyond `maxInFlight` running requests and `maxQueued` waiting ones, it answers
  `OVERLOADED` (429 with `Retry-After`). A request that timed out keeps its slot until your code actually
  returns.
* **Health.** Health reports `LOADING` until every `load()` resolves, `READY` after that, and `FAILED` with
  the error if a load fails. `verifyFileSha256()` checks your weights before you load them.

```ts
import { createAdapter, verifyFileSha256, AdapterError } from '@vigilone/ai-adapter-sdk';

const adapter = createAdapter({
  adapterId: 'acme-detector',
  adapterVersion: '1.0.0',
  maxInFlight: 1,
  models: [{
    card: { modelId: 'acme-v3', name: 'acme', version: '3', sha256: '<sha256 of the weights>', task: 'object_detection',
            classes: ['person', 'car'], codeLicense: 'Apache-2.0', weightsLicense: 'Apache-2.0',
            weightsSource: 'https://…', runtime: 'onnxruntime',
            input: { width: 640, height: 640, colorSpace: 'RGB', letterbox: true }, evaluation: null },
    async load() { /* verifyFileSha256(path, sha256), create the session */ },
    async infer(frame, { signal }) {
      // frame.data: rgb24 / bgr24 pixels (width * height * 3 bytes) or a JPEG
      return { detections: [{ objectClass: 'person', classId: 0, confidence: 0.91, bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.6 } }] };
    },
  }],
});
adapter.listen(7020);
```

Licences: the code and weights licences must be MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause or ISC. VigilOne
does not run anything else, and the schema cannot represent it. `evaluation` stays `null` until you have a real
evaluation report.

## Checking your adapter

```
npx vigilone-adapter-conformance --url http://127.0.0.1:7020
```

This runs the same black-box checks that VigilOne runs against its own worker: schemas, provenance, errors,
deadline, burst behaviour and air-gap. An adapter is conformant when all of them pass.

## Example: a real detector

`src/examples/yoloxTiny.ts` wraps YOLOX-tiny (Apache-2.0, Megvii) with onnxruntime-node in about a hundred
lines. Its tests check two things:
* over HTTP, its detections match the official YOLOX Python post-processing on the repository's golden
  images (same classes, box IoU at least 0.98, confidence within 0.002);
* it passes the conformance kit.

```
scripts/models/fetch-model.sh yolox-tiny
cd sdk/ai-adapter && npm run build && node dist/examples/yoloxTiny.js ../../.cache/models/yolox_tiny.onnx 7020
```

## Development

* `src/contract/` is a generated copy of `backend/src/contracts`. Update it with `npm run sync-contract`.
  `npm run check-contract` and the tests fail if the copy drifts from the backend.
* `npm test` uses the backend's Jest toolchain, as the ai-worker does. `VIGILONE_REQUIRE_MODEL_TESTS=1` makes
  the example test fail rather than skip when the model file is missing.
