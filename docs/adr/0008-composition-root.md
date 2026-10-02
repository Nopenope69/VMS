# 0008: A composition root builds the backend's long-lived modules once

## Status
Accepted (2026-10-01). Item 4 of the architecture review.

## Context
Long-lived modules were built wherever they were first needed:

* five route files built background workers at import time and exported them, and `server.ts` imported them
  from those route files to start and stop them;
* `RecordingCatalog` was built by `server.ts`, the playback routes, the alarm workflow and inside each
  `EvidenceArchive` (itself built by the alarm and evidence routes);
* `RelayAdapter` was built by the IncidentOrchestrator, the relay routes and the door routes.

To find out what runs in the process, you had to read every route file. The catalog had up to six copies.

## Decision
`backend/src/composition.ts` builds each long-lived module once and wires the shared ones in:

* one `RecordingCatalog`, shared by the evidence archive, playback and the alarm workflow;
* one `RelayAdapter` (the orchestrator's, exposed as `incidentOrchestrator.relay`), shared by the relay and
  door routes.

It also owns `startBackgroundServices()` and `stopBackgroundServices()`. Routes take their instances from it.
`server.ts` keeps only the HTTP server, the HA leader lease and shutdown.

## Done later (Bucket 7, 2026-10-02)
* The `IncidentOrchestrator` is built in `composition.ts`, with the shared `RecordingCatalog` (its bookmark
  adapter no longer makes a second one). Its module no longer exports an instance. Every event producer is
  handed its `ingestEvent` as an `EventSink`: the stream watchdog, scene-change detector and plate aggregator
  through `setEventSink`, the storage sentinel, camera event manager and door monitor through their constructors,
  and detection ingestion and the journey incident route as an argument. A producer with no sink logs
  "no event sink wired" instead of dropping the event silently. `compositionEventSinks.test.ts` pins the wiring
  and that no service imports an orchestrator instance.
* `EvidenceExportService` and `EvidenceManifestService` were deleted; their tests use `EvidenceArchive`.

## Consequences
* One file lists what runs in the backend process and in what order it starts and stops.
* The static checks that pin how crop and embedding workers start now read `composition.ts`.
