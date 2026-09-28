# Camera-native events (ONVIF, Hikvision, Dahua)

Status: **behind `VIGILONE_FEATURE_CAMERA_EVENTS` (off by default)**. Tested over real HTTP
against local protocol test doubles and fixtures written from the published formats; **not yet
run against a physical camera** (docs/STATUS.md, "Not verified").

## What it does

Many cameras run their own analytics (motion, line crossing, intrusion, tamper, face, ...).
VigilOne subscribes to those events and turns each start/stop transition into a
`CAMERA_ANALYTIC` event that automation rules can use (trigger type `CAMERA_ANALYTIC`, filter
`analyticTypes`, `protocols`). In events.v1 they are `system.camera_analytic`, never `ai.*`:
VigilOne did not run the model, has no provenance for it, and does not present camera output as
its own AI.

| Protocol | Endpoint | Auth | Keep-alive |
| --- | --- | --- | --- |
| `ONVIF_PULLPOINT` | device service `/onvif/device_service` -> event service from `GetCapabilities` -> `CreatePullPointSubscription`, `PullMessages` (10 s long-poll), `Renew`, `Unsubscribe` | WS-Security UsernameToken PasswordDigest (+ HTTP Digest if the camera asks) | every pull |
| `HIKVISION_ISAPI` | `GET /ISAPI/Event/notification/alertStream` (multipart/mixed) | HTTP Digest (MD5 / SHA-256) | `videoloss`/`inactive` alerts |
| `DAHUA_EVENT_MANAGER` | `GET /cgi-bin/eventManager.cgi?action=attach&codes=[All]&heartbeat=5` (multipart/x-mixed-replace) | HTTP Digest | `Heartbeat` parts |

Credentials come from the camera record (`encryptedAuth`); the host is the camera IP and its
ONVIF/HTTP port. Addresses the camera advertises (often its LAN address behind NAT) are rebased
onto the configured host.

## Normalised analytic types

`MOTION`, `LINE_CROSSING`, `INTRUSION`, `REGION_ENTRANCE`, `REGION_EXIT`, `LOITERING`, `TAMPER`,
`DEFOCUS`, `VIDEO_LOSS`, `SCENE_CHANGE`, `DIGITAL_INPUT`, `FACE`, `OBJECT_LEFT`, `OBJECT_REMOVED`,
`PERSON`, `VEHICLE`, `AUDIO`; anything unknown is `VENDOR_OTHER` with the vendor topic kept, never
guessed. Mapping tables: `backend/src/services/cameraEvents/{hikvision,dahua}.ts`,
`onvif/notifications.ts`.

## Behaviour

- **Transitions only.** Hikvision repeats "active" about once a second while a condition lasts;
  the manager emits one start and one stop. An "active" with no repeat for 10 s ends the
  condition silently (the next "active" is a new start). A stop with no known start is dropped.
  Instantaneous events (ONVIF `LineDetector/Crossed`, Dahua pulses) are de-duplicated within 1 s.
- ONVIF `PropertyOperation="Initialized"` messages (state at subscription time) are not events.
- **Event time** is the appliance receive time; the camera's own timestamp is kept as
  `cameraTimeUtc` when it sends one. Dahua's `UTC` field is not trusted (many firmwares put local
  time in it).
- **Supervision:** `CONNECTING -> RUNNING`; on disconnect `BACKOFF` (1 s doubling to 60 s);
  a permanent error (401/403/404, ONVIF `NotAuthorized`, no event service) sets `FAILED` with the
  error and stops retrying until an operator changes the source (Retry / Enable in the UI).
- Metrics: `vigilone_camera_events_total{protocol,analytic_type}`,
  `vigilone_camera_event_connects_total`, `vigilone_camera_event_disconnects_total{permanent}`,
  `vigilone_camera_event_parse_errors_total`, `vigilone_camera_event_sources_running`,
  `vigilone_camera_clock_skew_ms{source_id}`, `vigilone_camera_clock_drift_warnings_total`.
- Audit: `CAMERA_EVENT_SOURCE_CREATE|ENABLE|DISABLE|DELETE`.

## Camera clock (NTP) check

ONVIF sources call `GetSystemDateAndTime` before subscribing. The camera answers in **whole
seconds**, so the skew is only known to an interval `[C - t1, C + 1000 - t0]` (C camera time,
t0/t1 request/response on the appliance). VigilOne reports `DRIFT` when the whole interval is
beyond the threshold (100 ms), `UNDETERMINED` otherwise. Consequence, stated plainly: this check
**cannot confirm** that a camera is within 100 ms; it reliably flags cameras off by roughly a
second or more. The estimate (interval midpoint) is also used for the WS-Security `Created`
timestamp, because cameras reject tokens outside their replay window (a common cause of
`NotAuthorized` with correct credentials). Millisecond-level verification needs RTCP sender
reports from the RTSP session (docs/BACKLOG.md).

## Profile M metadata

`onvif/profileM.ts` parses `tt:MetadataStream` documents (frames, objects, boxes in ONVIF's
[-1,1] y-up space including `tt:Transformation`, class likelihoods) into top-left [0,1] boxes and
appends them to a JSONL archive (`<dir>/<cameraId>/<YYYY-MM-DD>.jsonl`, pruned by retention).
Capturing the RTSP metadata track live is not implemented yet (BACKLOG).

## API

`/api/v1/camera-events/sources` (GET with `CAMERA_VIEW`; POST / PATCH `{enabled}` / DELETE with
`CAMERA_CONFIG`). Answers 501 `FEATURE_DISABLED` while the flag is off.

## Tests

- `backend/src/__tests__/cameraEventParsers.test.ts`: RFC 7616 digest vectors, WS-Security digest
  vector (computed independently with Python hashlib), multipart parsing under every chunking,
  vendor fixtures, skew intervals, Profile M geometry, JSONL archive.
- `backend/src/__tests__/cameraEventsIntegration.test.ts`: the three clients over HTTP against
  test doubles (Digest verification, a camera clock 5 s ahead that enforces the token window,
  NAT-style advertised addresses), then the manager on the real database feeding the rule engine,
  FAILED on bad credentials without retry storms, and the flag gate.
- Fixtures: `backend/src/__tests__/fixtures/camera-events/` (hand-written, see its README).
