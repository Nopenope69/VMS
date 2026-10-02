# Following a person or vehicle across cameras

Status: **built and tested on the real database with controlled embeddings and synthetic plate reads. Off by
default** (part of the track index feature). Not run on real footage; how often its suggestions are right is not
measured. Design: ADR 0013.

The system **suggests**; an operator **decides**. Nothing links two tracks on its own.

## Camera neighbours

Tell the system which cameras lead to which, and how long the walk or drive usually takes:

`PUT /api/v1/tracks/camera-neighbours` (permission `CAMERA_CONFIG`), with the full list:

```json
{ "neighbours": [
  { "cameraAId": "<gate>", "cameraBId": "<lobby>", "minTransitSeconds": 0, "maxTransitSeconds": 120 },
  { "cameraAId": "<lobby>", "cameraBId": "<warehouse>", "minTransitSeconds": 30, "maxTransitSeconds": 300 } ] }
```

* **Pairs:** a pair works both ways and is listed once. The list replaces the previous one, and each change is
  audited (`CAMERA_NEIGHBOURS_SET`).
* **Travel time:** `minTransitSeconds` of 0 also allows overlapping views (two cameras seeing the same moment).
* **Fallback:** a camera with no neighbours set uses every camera on its own site, within 10 minutes. The answer
  says `adjacency: "site-fallback"` so the operator knows the suggestions are broader.
* **Same camera:** coming back into the same view within 10 minutes is always a candidate.

## Suggestions

`GET /api/v1/tracks/:id/candidates?method=appearance|plate`:

* **appearance:** tracks of the same class on neighbouring cameras whose timing fits the travel time, ranked by how
  much they look like this track. The track's look is the average of its snapshot embeddings, so it needs the
  semantic search feature and embedded snapshots. The response also says:
  * `outsideTravelTime`: how many look-alikes were dropped because their timing did not fit;
  * `sourceCrops`: how many snapshots the comparison used.
* **plate:** other reads of the same plate within `windowSeconds` (default 24 hours), on any camera. Each read with
  a vehicle track is a candidate. Reads where the detector missed the vehicle are listed under `readsWithoutTrack`
  and cannot be linked.

Every candidate shows:
* its score;
* the time gap: seconds between the two sightings, negative when they overlap;
* any earlier decision.

A pair the operator **rejected** is not suggested again.

## Decisions

`POST /api/v1/tracks/:id/links` with `{ "toTrackId", "method": "APPEARANCE" | "PLATE", "decision": "CONFIRMED" | "REJECTED", "note"? }`.

* **The server records its own evidence:**
  * appearance similarity and the model used, or "no embedded crops";
  * for a plate, that the two reads have the same plate;
  * the time gap.

  A PLATE link between different plates is refused.
* **No plate text in links:** a link never stores the plate text; the plate read keeps its own retention.
* **Changing a decision:** a decision can be changed by posting again; the latest decision and decider are kept, and
  every decision is audited.
* **Who can decide:** a person track can only be linked to a person track.

## Journey

`GET /api/v1/tracks/:id/journey` follows CONFIRMED links in both directions. It returns every track of that person
or vehicle in time order, the cameras in the order visited, and the links with their evidence. It stops at 200
tracks (`truncated`).

## Privacy

* **People:** following a person (candidates, decisions, journey) is person data. It needs `CROP_PERSON_QUERY` and
  a declared purpose.
* **Plates:** following by plate, or asking for plate text, needs `PLATE_DATA_QUERY` and a purpose.
* **Audit:** every candidate query, decision and journey view is audited with the purpose: `TRACK_FOLLOW_QUERY`,
  `TRACK_LINK_CONFIRMED`, `TRACK_LINK_REJECTED`, `TRACK_JOURNEY_VIEW`.
* **Retention:** links are deleted with either of their tracks, so they follow the track retention
  (`DATA_PROTECTION.md`).

There is no face recognition. Appearance means the whole-body look (clothes, shape, colour) from the same embedding
model as semantic search.
