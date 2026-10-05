# Per-camera health

`GET /api/v1/cameras/health` (all cameras of the caller's tenant) and `GET /api/v1/cameras/:id/health` (one).
Permission `CAMERA_VIEW`. Read-only: it writes nothing and does not touch recording.

Code: `backend/src/services/camera/cameraHealth.ts` (pure rules), `cameraHealth.service.ts` (reads), routes in
`camera.routes.ts`.

## States

| State | Meaning |
| --- | --- |
| `NOT_MONITORED` | The camera is not watched by the stream and recording watchdogs |
| `UNKNOWN` | Monitored, but the stream watchdog has never reported on it |
| `DOWN` | Stream not seen within the 90 s liveness window, or the recorder is in `ERROR` |
| `DEGRADED` | Reachable but not recording as configured: recorder not running when it should be, degraded recording mode, a degraded stream measurement, or no new segment for longer than two segment lengths plus a minute |
| `HEALTHY` | None of the above |

Every response lists the `reasons` behind a state, plus the stream, recorder, recording and last-measurement facts they
came from. `DOWN` outranks `DEGRADED`.

## What it is built from

Existing records only: `Camera.lastSeenAt` (stamped by the stream watchdog), the desired and observed recorder state and
last recorder error, effective versus configured recording mode and its degradation reason, the newest
`RecordingSegment`, and the newest `StreamDiagnostic`. The segment length comes from `RECORD_SEGMENT_DURATION`
(10 minutes if unreadable).

## Not included, on purpose

- **Reconnect or retry counts.** Nothing records them today, so none are shown. Adding them means the watchdog or
  recorder must persist a counter first.
- **A stored lifecycle state machine** (pending, loading, failed, retrying as in Viseron). The state is derived on each
  request; nothing is stored that could go stale.
- A node that is not running the stream watchdog will show cameras as `DOWN` after 90 s (existing liveness rule), not as
  healthy on an old reading.

## Checked

Unit tests for the rules and the service (`cameraHealth.test.ts`, `cameraHealthService.test.ts`, 29 tests including
tenant scoping and read-only behaviour). The HTTP routes were type-checked but not exercised over HTTP: no HTTP test
harness exists in this repository.
