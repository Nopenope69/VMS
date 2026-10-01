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

## Not done
* The `incidentOrchestrator` instance is still created in its own module. Four services
  (`detectionIngestion`, `sceneChangeDetector`, `streamWatchdog`, `storageSentinel`) import it
  directly, some through a dynamic `import()` to avoid an import cycle. Injecting it into them is the next
  step. Until then the orchestrator's bookmark adapter keeps its own `RecordingCatalog`. That is harmless
  (the catalog holds no state outside the database unless its timers are started), but it is a second copy.
* `EvidenceExportService` and `EvidenceManifestService` are used only by tests. They build their own
  `EvidenceArchive` and were left as they are.

## Consequences
* One file lists what runs in the backend process and in what order it starts and stops.
* The static checks that pin how crop and embedding workers start now read `composition.ts`.
