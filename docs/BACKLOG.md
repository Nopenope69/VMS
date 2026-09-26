# Backlog

Items found while working on a phase that are outside that phase's scope. Each names where it was
found. Pick them up in the phase noted.

| Item | Found in | Target phase |
| --- | --- | --- |
| `MediaMTXProvider.getStreamStatus` returns `null` for both 404 and engine-unreachable; split into `NOT_FOUND` / `ENGINE_UNAVAILABLE` so media-provider.v1 can report which. | P0.7 | Phase 1 (fault injection needs it) |
| ai-worker posts `NormalizedDetectionEvent` (manifest id + inference id only); migrate to ai-adapter.v1 `InferenceResultV1` with the full provenance block and error channel. | P0.7 | Phase 2 (P2.1) |
| `VigilOneEvent` has no provenance field; AI-derived internal events cannot be mapped to events.v1 without the caller supplying it. Carry provenance through the orchestrator. | P0.7 | Phase 2 |
| `fromMotionEvent` defaults `source` to `VISION_AI` although today's motion producer is the classical scene detector; default should be a non-AI source. | P0.7 | Phase 2 |
| Contracts live in `backend/src/contracts`; extract to a small shared package once a second consumer (ai-worker, VMS-LITE) needs the zod schemas rather than the JSON examples. | P0.7 | Phase 2 |
| Digital inputs cannot be mapped to `access.door_opened` because the DI pin model does not record "door contact" semantics. | P0.7 | Phase 7 (unified physical security) |
| `soakHarness.ts` synthetic-payload mode writes non-video bytes; superseded by `scripts/soak` (real ffmpeg streams). Retire or relabel as SIMULATED. | P0.4 | Phase 1 |
| Frontend chunk is > 500 kB after minification (Vite warning); code-split by page. | P0.1 | Later UI work |
| `npm audit` reports 3 moderate vulnerabilities in backend dependencies (not triaged). | P0.1 | Phase 1 |
