# 0013: Cross-camera following: suggested by the system, decided by an operator

## Status
Accepted (2026-10-02). Bucket 3 of the North Star build plan (section 5, P0 item 4). Builds on ADR 0011 (tracks)
and ADR 0012 (track search).

## Context
A track ends where a camera's view ends. To answer "where did this person go?", tracks on different cameras must
be tied together. Two signals exist:
* a plate read, which is an exact key for vehicles;
* appearance (crop embeddings), which is a similarity for anything.

Either can be wrong: plates are misread or cloned, and two people in the same uniform look alike. A wrong link in
an investigation sends an operator after the wrong person.

## Decision
* **No automatic links.** The system lists candidates; an operator confirms or rejects each pair (`TrackLink`), and
  the decision is audited with its purpose. A confirmed chain of links is the journey. This is the precursor of the
  investigation entity (V1.0): an entity will be built from confirmed links only.
* **Camera neighbours with travel times** (`CameraNeighbour`, undirected) limit appearance candidates to places and
  times a person could actually reach.
  * Learning adjacency from data was rejected for now: it needs real traffic, which the pilot will provide.
  * Without configuration, the camera's site is used with a 10-minute window, and the answer says so.
* **Appearance** compares the average of the source track's crop embeddings (pgvector `AVG`, then normalised)
  with crops of candidate tracks, through `searchTracks`, so filters run before ranking as in ADR 0012.
* **Plate following** ignores neighbours (a vehicle can leave and come back hours later) and uses a time window
  instead (default 24 h).
* **Evidence is recomputed by the server** when a decision is recorded, not taken from the client. A PLATE link
  between different plates is refused. Plate text is never copied into a link, so links cannot outlive the
  plate retention period with the plate in them.
* A **rejected** pair is never suggested again.

## Consequences
* Travel times are set by hand. A wrong setting hides true matches (too tight) or adds noise (too loose). Measure
  both on the pilot and revisit learnt adjacency then.
* A track average blurs a person who changes appearance mid-track (a jacket taken off). Not measured.
* The journey follows links transitively, so one wrong confirmation joins two people's journeys. The links carry
  who decided and when, so a wrong one can be found and set to REJECTED.
* Accuracy of appearance candidates (how often the true next sighting is in the top 5) is not measured. It needs
  labelled cross-camera journeys from the pilot.
