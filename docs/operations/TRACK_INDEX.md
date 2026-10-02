# Track index (one record per tracked object)

Status: **built and tested on the real database with synthetic detections. Off by default.** It has not run on
a real camera, and its colour naming and plate linking are not measured on real footage. Design: ADR 0011.

## What it does

The AI worker reports a detection for every sampled frame in which a tracked person or vehicle appears. The track
index turns those frames into one record per object per camera:

| Field | Meaning |
| --- | --- |
| `objectClass` | person, car, motorcycle, bus, truck or bicycle: the class most of its detections had |
| `firstSeenAt`, `lastSeenAt`, `dwellSeconds` | When the tracker first saw it, when it was last seen, and the time in between |
| `path` | Where it touched the ground (bottom centre of its box, 0..1 of the picture), one point a second or per step, at most 120 points |
| `direction` | Overall movement in the picture: `UP`, `UP_RIGHT`, `RIGHT`, ... or `STATIONARY`. Up means towards the top of the picture, not north |
| `zones` | Visits to the camera's named zones (enabled INCLUSION zones), with entry and exit times. A gap of up to 5 s inside a zone is one visit |
| `colours` | People: `upper` (shirt) and `lower` (trousers). Vehicles: `body`. Shown only when at least two detections agree and one colour has at least half the votes. `monochromeDetections` counts IR pictures, which carry no colour |
| `plate` | The plate read tied to a vehicle (see below) |
| `bestDetectionId`, `bestCropId` | The detection with the highest confidence, and its crop if the crop store kept one |

### Colours

The worker names colours by counting the pixels of fixed parts of the box (a person's upper and lower body, a
vehicle's middle band) and taking the most common of eleven names: black, white, grey, red, orange, brown, yellow,
green, blue, purple, pink. It is a pixel count, not a trained model. Known limits:

* An IR picture (night mode) has no colour; it is reported as monochrome and no colour is named. A daytime scene
  with nothing coloured in it at all is also treated as monochrome.
* Shadows, backlight, reflections on cars and coloured street lighting change the colour a camera records.
* A person carrying a large bag or seen side-on may get the bag's colour.

Accuracy on real cameras is not measured. Measure it with pilot footage before relying on it.

`AI_COLOUR_ATTRIBUTES=false` on the worker stops it naming colours.

### Plates

When a plate read arrives (ANPR on, camera in LPR mode), it is tied to the vehicle track whose box contains the
centre of the plate in the closest frame, within one second. If no vehicle box contains it, nothing is tied: this
happens when the object detector does not run on the LPR camera, or misses the vehicle. The first plate tied to a
vehicle stays; a second, different plate in the same box is not tied. The plate text stays in the plate read and
is deleted with it by the plate retention purge.

Metrics: `vigilone_track_index_plate_links_total{outcome}` with `linked`, `already_linked`, `no_vehicle_track`,
`conflict` and `failed`.

## Turning it on

1. Backend: `VIGILONE_FEATURE_TRACK_INDEX=true`. The tenant licence needs `ADVANCED_SEARCH` for the API.
2. Worker: colours are on by default (`AI_COLOUR_ATTRIBUTES`).
3. Draw zones on each camera (Devices page, detection zones). Only enabled INCLUSION zones count as places.

Each confirmed detection then costs three more database statements. This has not been measured at a real site's
detection rate: watch `vigilone_track_index_observations_total{outcome="failed"}` and database load on the bench
before enabling it for many cameras. A failure never stops a detection from being stored.

## API

`GET /api/v1/tracks`, permission `SEARCH_VIEW`. Filters (query string):

* `cameraIds` (comma-separated), `from`, `to`: tracks seen in that window;
* `objectClasses` (comma-separated), `zoneId`, `direction`, `bodyColour`, `minDwellSeconds`, `hasPlate`;
* `upperColour`, `lowerColour`: people only, so they need `includePersons=true`;
* `limit` (up to 200, default 50), `offset`.

Newest first. `GET /api/v1/tracks/:id` returns one track.

**People.** Person tracks are left out unless `includePersons=true`. That needs the `CROP_PERSON_QUERY` permission
(administrators) and a declared purpose (`X-VigilOne-Purpose` header or `purpose` parameter), as person crop search
does. The query is audited as `TRACK_PERSON_QUERY` with the purpose.

**Plates.** Without `includePlates=true` a track only says `plate: { linked: true | false }`. The plate text needs
`PLATE_DATA_QUERY` and a purpose, and is audited as `TRACK_PLATE_QUERY`. A request cannot ask for person tracks and
plate text together: each has its own purpose.

Other queries are audited as `TRACK_QUERY` / `TRACK_VIEW`. If the audit entry cannot be written, nothing is
returned.

## Retention

Tracks follow `detectionSnapshotRetentionDays` (default 30): a track last seen before that is deleted by the
retention purge, unless it overlaps an incident evidence hold or legal hold on its camera. See
`DATA_PROTECTION.md`.

## Following across cameras

Tracks on different cameras can be linked into one journey, by plate or by appearance, with an operator
confirming each link: `CROSS_CAMERA_FOLLOW.md`.
