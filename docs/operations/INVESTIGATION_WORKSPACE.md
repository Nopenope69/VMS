# Investigation workspace (Find panel)

Status: **built and tested in a real browser against the real backend with seeded data. Off by default.** It has
not been used on real camera footage. Uses the track index (`TRACK_INDEX.md`), track search (`TRACK_SEARCH.md`) and
cross-camera following (`CROSS_CAMERA_FOLLOW.md`).

## What it does

On the Investigation page, the **Find** button opens a panel next to the camera grid:

1. **Find.** Pick cameras, a time window, object type, direction, colours, minimum time on scene and whether a
   plate was read. With a description ("white SUV") or a photo, results are ranked by appearance (needs semantic
   search and an embedding adapter); without one, they are the matching tracks, newest first. Each result shows its
   best picture, camera and time. "Must also look like" and "Must not look like" are the AND and NOT terms.
2. **Open a result.** The camera is added to the grid, focused and played from when the object was first seen. The
   panel shows the track: path sketch, dwell, zones, colours.
3. **Follow.** "Follow by plate" (vehicles with a plate read) or "Follow by appearance" lists suggested next
   sightings on neighbouring cameras, best first. **The operator decides**: View plays it, Confirm links it,
   Reject removes it and it is not suggested again. Notes say when neighbours are not set (whole-site fallback),
   how many sightings were too fast for the travel time, and plate reads without a vehicle track.
4. **Journey.** "Show journey" lists the confirmed sightings in time order. "Play journey" puts the journey's
   cameras in the grid from the first sighting. "Seal journey as evidence" makes one evidence package over those
   cameras from 30 s before the first sighting to 30 s after the last, on legal hold by default.
5. **On the floor plan.** "Show on floor plan" draws the numbered sightings, joined in order, on each floor plan
   the journey's cameras are placed on (the Floor plans page). Each sighting is drawn **at the camera that saw
   it**, not where the person or vehicle stood: that would need calibrated cameras, which is not built. A camera on
   no floor plan is listed under the drawing ("Not on a floor plan: step 2 (Yard)"), never placed by guess. The
   drawing uses the floor plan editor's layout, not an uploaded floor plan picture.
6. **Open incident.** Opens an incident (an alarm, so it is on the Alarms page with assignment, SLA and escalation
   as usual) with a title, severity and notes, and the sealed package attached if one was sealed. The server works
   out the journey from the confirmed links itself; it never takes a list of sightings from the screen. Footage on
   **every** camera of the journey is held, from `INCIDENT_HOLD_PRE_SECONDS` (60 s) before the first sighting to
   `INCIDENT_HOLD_POST_SECONDS` (120 s) after the last, for `INCIDENT_HOLD_DAYS` (90). The alarm sweeper pins the
   recordings and marks each hold complete, or failed with `NO_RECORDING_SEGMENTS_IN_WINDOW` when a camera
   recorded nothing (`GET /api/v1/alarms/:id/holds`). Needs `ALARM_MANAGE` (operators and administrators).

Every step is recorded by the investigation stopwatch (`PILOT_MEASUREMENT.md`) when it is running.

## Privacy

Person results, person following and plate following need a **purpose**, chosen in the panel (and a reference for
purposes that need one). Without it the backend refuses and the panel shows the refusal (`PURPOSE_REQUIRED`); it
is never filled in silently. Person data needs `CROP_PERSON_QUERY` (administrators); operators can find and follow
vehicles. Sealing evidence needs `EVIDENCE_EXPORT`. Every query and decision is audited by the backend with its
purpose.

## Turning it on

* Backend: `VIGILONE_FEATURE_TRACK_INDEX=true` (the Find button appears only then), tenant licence with
  `ADVANCED_SEARCH`.
* Optional: `VIGILONE_FEATURE_SEMANTIC_SEARCH=true` and an embedding adapter for description and photo search and
  for following by appearance. Without it, filter search and following by plate still work, and a description
  search says plainly that it is not available (`QUERY_EMBEDDING_NOT_AVAILABLE`).
* Set camera neighbours and travel times (`CROSS_CAMERA_FOLLOW.md`) so suggestions are limited to cameras a person
  or vehicle can actually reach.

## API

* `GET /api/v1/tracks/:id/journey/floorplan`: per floor plan, its placed cameras and the journey's sightings with
  their step numbers; `unplaced` lists sightings on cameras with no placement. Audited as `TRACK_JOURNEY_MAP_VIEW`.
* `POST /api/v1/tracks/:id/journey/incident` `{title, severity?, description?, evidenceManifestId?}` (201): the
  alarm, the number of cameras held and the hold window. The alarm's `metadataJson` has `source: "JOURNEY"`, the
  steps (track, camera, times), cameras, link ids, window and package id, and never plate text. Audited as
  `TRACK_JOURNEY_INCIDENT` and `ALARM_CREATE`. A package from another tenant is 404.

Both follow the journey's privacy rules: a person journey needs `CROP_PERSON_QUERY` and a purpose.

## Not built yet

* Where on the floor a person or vehicle was (needs calibrated cameras), and drawing on an uploaded floor plan
  picture.
* The sealed package is a standard evidence manifest; the journey's link evidence is not written into it.
* Accuracy on real footage is not measured (see the three linked documents).

## Tests

`frontend/e2e/investigation-workspace.spec.ts` (3 tests, including the floor plan and the incident) runs in CI (`frontend-browser-tests`) on a seeded tenant
(`backend/scripts/e2e/seed-workspace.ts`) with real crop pictures and controlled embeddings, and checks what the
backend stored after each step. `backend/src/__tests__/journeyIncidentRealDb.test.ts` covers the floor plan layout,
the incident, the holds being pinned by the alarm sweeper, and the privacy and permission refusals.
