# 0011: One record per tracked object (the track index)

## Status
Accepted (2026-10-01). Bucket 1 of the North Star build plan (`docs/strategy/00-north-star-v0.1-and-v1.0-plan-2026-09-29.md`,
section 5, P0 item 2).

## Context
The ai-worker sends one `DetectionEvent` for every sampled frame in which a confirmed track appears. A person who
crosses a camera's view for 40 seconds becomes about 40 rows: each has a box and a class, but none of them says
where the person went, how long they stayed, which zone they entered, what they wore, or which plate was on the
vehicle. Search (Bucket 2), cross-camera following (Bucket 3) and the investigation workspace (Bucket 4) all need
that summary, and rebuilding it from raw rows on every query does not scale and cannot be filtered with an index.

Plate reads (`VehicleObservation`) and vehicle detections arrive from two separate pipelines, and nothing tied
them together: `VehicleObservation.trackId` existed but was never set.

## Decision
`ObjectTrack` holds one row per (camera, worker track id), updated by every stored confirmed-track detection
(`services/tracks/trackIndex.service.ts`, pure rules in `trackMath.ts`):

* **Class:** a vote over the detections, so a car read once as a truck stays a car.
* **Time:** first seen (the tracker's first sighting, before confirmation), last seen, and dwell as a column.
* **Path:** the ground point (bottom centre of the box) over time, thinned to waypoints at least a second or a
  step apart, at most 120 points; the newest observation is always the end. The ground point is used because
  zones are drawn on the ground and a floorplan projection needs the feet, not the box centre.
* **Direction:** in the image, from first to last point, in eight sectors or STATIONARY. Not a compass bearing:
  the image does not know north.
* **Zones:** visits to the camera's enabled INCLUSION `DetectionZone`s, with entry and exit times. EXCLUSION zones
  mask detection and are not places.
* **Colours:** votes over the worker's colour attributes. A region gets a colour only with two or more votes and
  a clear majority. The worker names colours by counting pixels in HSV space (`colourAttributes.ts`), not with a
  trained model: no licence, no weights. On an IR picture it reports `monochrome` and names nothing.
* **Plate:** a plate read is tied to the vehicle track whose box contains the plate's centre in the nearest frame
  within one second; the smallest such box wins. No containing box, no link. The first plate stays; a different
  plate in the same vehicle box is counted as a conflict and not linked.

Each update runs in one transaction that inserts the row if needed and locks it (`SELECT ... FOR UPDATE`), so two
detections of one track arriving together are both applied.

**Privacy.** A person's track says where they walked and what they wore. The API (`/api/v1/tracks`) leaves person
tracks out unless the request asks for them with the `CROP_PERSON_QUERY` permission and a declared purpose, as person
crop search does; plate text needs `PLATE_DATA_QUERY` and a purpose, as plate search does. Every query is audited
before the answer is sent. The track stores no picture and no plate text: the plate stays in `VehicleObservation`
and is deleted with it by the plate retention purge. Tracks are purged with detection snapshots, honouring holds.

The feature is behind `VIGILONE_FEATURE_TRACK_INDEX` (default off), like every subsystem not yet field-proven.

## Consequences
* Three extra statements per confirmed detection (insert-if-absent, locked read, update). Not measured at the
  detection rate of a real site; measure it on the bench before switching the feature on for 16 or more cameras.
* Tracks are per camera. Linking a track on one camera to a track on another is Bucket 3 and will reference these
  rows; it is not inferred here.
* A worker restart starts new track ids, so one person crossing during a restart becomes two tracks.
* The colour heuristic is unvalidated. Its accuracy on real cameras, and the share of daytime scenes it wrongly
  treats as monochrome, are to be measured with the pilot data (Bucket 5).
