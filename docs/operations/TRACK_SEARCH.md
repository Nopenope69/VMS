# Track search (search by appearance, one result per person or vehicle)

Status: **built and tested on the real database with controlled embeddings. Off by default.** It has not run on
real footage, and how well its results match what operators mean is not measured (see "Measuring it"). Design:
ADR 0012. Builds on the track index (`TRACK_INDEX.md`) and semantic crop search (`SEMANTIC_SEARCH.md`).

## What it does

`POST /api/v1/tracks/search` finds tracked people and vehicles by how they look, and returns each once:

* **Query:** one of
  * `text`: "white SUV", "person carrying a backpack";
  * `cropId`: a stored crop, meaning "more like this";
  * `imageJpegBase64`: an uploaded JPEG photo, up to 4 MB.
* **AND terms** (`and`, up to 4): every match must also look like each term. A snapshot is scored by its weakest
  term.
* **NOT terms** (`not`, up to 4): a snapshot that looks more like a NOT term than like the query is set aside. A
  track is dropped when more than half of its matching snapshots are set aside, so one stray frame does not
  decide. Tracks that look like neither the query nor the NOT term can also be dropped; they would rank near the
  bottom anyway.
* **Filters** (`filters`): `cameraIds`, `from`, `to`, `objectClasses`, `zoneId`, `direction`, `upperColour`,
  `lowerColour`, `bodyColour`, `minDwellSeconds`, `hasPlate`. They are applied before ranking, inside the same
  database query, so a narrow filter (one camera, one zone) still finds its matches instead of losing them to
  better-looking matches elsewhere.
* **Results:** up to `limit` (default 20, at most 50) tracks, best first. Each result gives:
  * its `score` (cosine similarity of its best snapshot);
  * the snapshot that matched (`matchedCropId`, `matchedCropImageUrl`);
  * how many of the track's snapshots matched (`matchedCrops`) and how many a NOT term set aside
    (`excludedCrops`);
  * the full track record: path, zones, colours, dwell and plate link.

Scores are only comparable within one query. Raw similarity values differ between models, so there is no
"good match" threshold; read the order.

## Privacy

The same rules as the track list:

* **People:** person tracks are left out unless `includePersons: true`, which needs the `CROP_PERSON_QUERY`
  permission and a declared purpose (`X-VigilOne-Purpose`). A query by a person crop, or with `upperColour` /
  `lowerColour`, must set it.
* **Plates:** plate text needs `includePlates: true`, `PLATE_DATA_QUERY` and a purpose. A request cannot ask for
  both.
* **Audit:** every search is audited before the answer is sent, as `TRACK_SEARCH_QUERY`,
  `TRACK_PERSON_SEARCH_QUERY` (with the purpose) or `TRACK_PLATE_SEARCH_QUERY`. The entry records:
  * the query text or crop id;
  * the AND and NOT terms;
  * the filters, the model and the result count.
* **Uploaded photos:** a photo is embedded and discarded. Only its SHA-256 and size are recorded; the picture is
  never stored.

## Turning it on

Needs `VIGILONE_FEATURE_TRACK_INDEX=true` (the route) and `VIGILONE_FEATURE_SEMANTIC_SEARCH=true` (the
embeddings), the licence feature `ADVANCED_SEARCH`, and, for text and photo queries, the embedding adapter
(`EMBEDDING_ADAPTER_URL`). A query by stored crop works without the adapter.

Only snapshots that belong to a track can be found: crops are kept by the crop store (`OBJECT_CROPS`), embedded by
the crop embedder, and tied to a track through their detection. Crops from before the track index was switched on
are not searchable this way; use crop search (`/api/v1/search/crops`) for them.

## Measuring it

Recall@k on labelled site queries is the gate (`RETRIEVAL_LABELLING.md`, track mode):

1. Write labels as `vigilone.track-retrieval-labels.v1`. Each query is `text` or `queryCropId` (with its own
   `queryTrackId`), optional `filters`, and the ids of every relevant track.
2. Collect: `node tools/eval/retrieval-collect.mjs --labels labels.json --url <appliance> --token <JWT> --k 20`.
3. Score: `node tools/eval/retrieval-eval.mjs --labels labels.json --results results.json --real-site-data`.

A crop query's own track is removed from the ranking before scoring (finding it is trivial) and counted in
`ownTracksRemoved`.
