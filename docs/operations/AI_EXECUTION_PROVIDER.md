# AI execution provider and CPU settings

Applies to the detector worker (`services/ai-worker/src/inferenceEngine.ts`, `executionProvider.ts`).

## What is actually available

The `onnxruntime-node` 1.30.0 package used here ships **CPU binaries only** (Linux x64 and arm64 contain
`libonnxruntime` and the Node binding, no OpenVINO, CUDA or TensorRT provider library). Its typed provider options also
list no OpenVINO entry, so `device_type` or `cache_dir` cannot be passed through this binding. No image in this
repository installs OpenVINO. **No hardware acceleration is shipped or claimed.** Real OpenVINO or GPU use would need a
separately built runtime and measured results on the reference hardware first.

## Behaviour

A manifest may name `cpu`, `openvino`, `cuda` or `dml`. If the named provider cannot start (checked against the real
binary on 5 Oct 2026: `openvino` and `cuda` both fail to load), the worker:

- runs the model on **CPU** and logs a warning,
- reports `executionProvider: "cpu"` in provenance and the model audit trail, never the requested one,
- exposes the reason as `executionProviderFallback` in `getRuntimeInfo()`.

Before this change the same situation made the model fail to load.

## Settings (all optional)

| Variable | Values | Effect |
| --- | --- | --- |
| `AI_EP_FALLBACK` | `cpu` (default), `none` | `none` refuses to load instead of falling back |
| `AI_ORT_INTRA_OP_THREADS` | integer 1 to 256 | Caps inference threads so detection cannot starve recording. Unset = ONNX Runtime default |
| `AI_ORT_GRAPH_OPT` | `disabled`, `basic`, `extended`, `layout`, `all` | Graph optimisation level. Unset = default |

Invalid values stop the worker at load with a named error. A CPU failure is never retried or hidden.

Not covered: the ANPR, embedding and redaction sessions (`anpr/ortSession.ts` and similar) still use CPU directly.
The thread and optimisation settings have not been benchmarked here; measure on the reference hardware before
choosing values.
