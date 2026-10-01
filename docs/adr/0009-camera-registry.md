# 0009: The camera registry owns camera lookup, onboarding and removal

## Status
Accepted (2026-10-01). Item 5 of the architecture review.

## Context
`camera.routes.ts` was 837 lines: 24 handlers, each with its own Prisma queries.

* **Tenant checks.** 15 handlers repeated the same camera lookup. Six handlers had none, and a real-database
  reproduction against the old routes showed that an admin of another tenant got HTTP 200, and the change went
  through, on:
  * zone update and zone **delete**;
  * the zone point test;
  * guard tour stop and tour **delete**;
  * the diagnostic live probe.

  Tour start checked the camera but not that the tour belonged to it.
* **Onboarding.** It stored the camera before creating its media path. When the media engine refused the
  stream, the row stayed behind and a retry created a duplicate camera.
* **Invented results.**
  * With no measurement, the diagnostic endpoint (and the modal) showed an invented healthy stream: 25 fps,
    1080p, "OPTIMAL".
  * A preset the camera refused to save was stored anyway, with a made-up token.

## Decision
`services/camera/cameraRegistry.ts` (`CameraRegistry`, built once in the composition root) is the only way the
camera routes reach a camera:

* `require`, `requirePreset`, `requireTour` and `requireZone` check the tenant (and, for sub-resources, the
  camera) in one place. Another tenant's camera, preset, tour or zone is "not found" (404).
* `onboard` is all or nothing: if the media engine refuses the stream, the camera row is removed and the call
  fails with 502. A guessed RTSP URI (ONVIF probe failed) is returned and audited as a warning.
* `remove` and `list` are the other two operations; `onvifCredentials` replaces three copies of the credential
  decryption.

The routes parse requests and shape responses only (434 lines).

* With no measurement, `GET /:id/diagnostic` returns `diagnostic: null`, and the modal says so.
* A refused `SetPreset` is a 502, and no preset is stored.

## Finding, not changed
`Camera.isOnline` is set to true at onboarding and nothing ever updates it. The stream watchdog, the recording
watchdog and the recording scheduler select cameras on it, so it works as "monitored". Setting it to false at
onboarding would stop scheduled recording for new cameras. Renaming it, or giving it a real liveness writer,
is a separate change.

## Consequences
* `cameraRegistryRealDb.test.ts` pins:
  * the tenant boundary on every camera route;
  * the cross-camera tour and preset checks;
  * all-or-nothing onboarding;
  * no invented diagnostic or preset.
* The detection-zone, preset and tour queries that are not lookups (list, create, update) stay in the routes.
