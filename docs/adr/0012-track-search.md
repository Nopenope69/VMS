# 0012: Search returns tracks, filtered before ranking

## Status
Accepted (2026-10-02). Bucket 2 of the North Star build plan (section 5, P0 item 3). Builds on ADR 0011.

## Context
Semantic crop search (ADR 0005) returns snapshots. A person walking past one camera for 40 seconds is many
snapshots, so a page of results is mostly the same person. Its filters are on the snapshot only (camera, time,
class); the track index (ADR 0011) adds zone, direction, colour, dwell and plate. The North Star asks for search as
a product: one result per person or vehicle, filters combined with "white SUV"-style descriptions, AND and NOT
terms, and search by an uploaded photo.

## Decision
`POST /api/v1/tracks/search` (`services/search/trackSearch.ts`):

* **One SQL statement** joins each crop embedding to its crop, detection and track, applies the track filters in
  the WHERE clause, and orders by cosine distance to the main query vector, taking up to `candidates` crops
  (default 400). Filtering after ranking was rejected: a narrow filter (one camera) would come back empty whenever
  the best-looking crops were elsewhere. The approximate index is tried first; a short answer is confirmed with an
  exact scan, as crop search already does.
* **Grouping by track:** a crop's score is the lowest similarity over the main query and the AND terms; a track's
  score is its best crop's.
* **NOT is relative, not a threshold:** a crop is set aside when its similarity to a NOT term is at least its score;
  a track is dropped when more than half of its candidate crops are set aside. Fixed similarity thresholds were
  rejected because raw similarities differ between models and would need tuning per model.
* **Query vectors** all come from one verified embedding model: text terms and a photo go through the same adapter,
  and a query whose terms come back from different models is refused. A stored crop query uses that crop's stored
  vector for the model in use.
* **Uploaded photos** are JPEG only, at most 4 MB, embedded and discarded. The audit keeps the SHA-256 and size.
* **Privacy and audit** follow the track list (ADR 0011): person tracks and plate text each need their permission
  and a purpose, and every search is audited before the answer is sent.

## Consequences
* Candidates are retrieved in the order of the main query only. With AND terms, a track that matches the AND term
  strongly but the main term weakly can fall outside the candidate budget; raising `candidates` trades speed for
  completeness. Not measured on site data.
* Only crops tied to a track are searchable here. Crop search stays for crops without a track.
* The ranking rules are heuristics. Recall@k on labelled site queries (track mode of the retrieval tools) decides
  whether they are good enough.
* Speed at site scale (hundreds of thousands of embedded crops, with joins) is not measured. Measure it on the
  reference hardware before relying on it in the investigation workspace.
