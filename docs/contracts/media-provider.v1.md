# media-provider.v1

Status: v1. Schema and wrapper: `backend/src/contracts/mediaProvider.v1.ts`
(`MediaProviderV1Adapter` wraps the existing `IMediaProvider` / `MediaMTXProvider`).

## Interface

| Operation | Input | Output |
| --- | --- | --- |
| `createOrUpdateStream` | `StreamPathConfigV1`: `path`, `sourceRtspUrl` (`rtsp://` or `rtsps://`), `record` | void; throws on engine error |
| `deleteStream` | `path` | void; throws on engine error |
| `getStreamStatus` | `path` | `StreamStatusV1` |
| `setRecording` | `cameraId`, `enabled` | void; throws on engine error |

`path` must match `^[A-Za-z0-9_\-./]{1,128}$`, may not start with `/` and may not contain `..`.
Invalid input is rejected before it reaches the engine.

## StreamStatusV1

`path`, `state`, `readersCount`, `tracks`, `bytesReceived`, `observedAtUtc`.

| state | Meaning |
| --- | --- |
| `READY` | Engine reports the path is publishing. |
| `NOT_READY` | Path exists but is not publishing. |
| `NOT_FOUND` | The engine answered, but the path does not exist. Telemetry fields are `null`. |
| `ENGINE_UNAVAILABLE` | The media engine could not be reached or did not return a usable response. Telemetry fields are `null`. |

## Invariants

- One RTSP pull per camera (PROJECT_STATE.md section 2): consumers (live view, recording, AI)
  read from the engine's path, never from the camera directly.
- A provider never reports telemetry it did not observe.
