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
| ClockGuard state (skew detected, trusted floor) is not exposed via the API or metrics, so the clock-jump drill cannot verify detection automatically. Add it to `/health` or `/metrics`. | P1.2 | Phase 1 follow-up |
| `RecordingCatalog.registerSegment` may index a segment that is still being written (size/duration of a partial file). Index only after the active-write grace period or on the segment-complete hook. | P1.3 rehearsal | Phase 1 follow-up |
| Orphan (unregistered-camera) footage moved to `.quarantine/` can later be pruned by the 5 % quarantine cap. Decide whether footage of a camera removed from the database may ever be deleted automatically. | P1.3 rehearsal | Needs a product decision |
| Soak rehearsal did not register the simulated cameras in the database, so the backend was idle during it. A realistic software soak needs registered cameras with MediaMTX pulling from the simulated sources (the appliance's real topology). | P1.3 | Phase 1 follow-up |
| `tc netem` is unavailable in the agent sandbox; `network-fault.sh` has only been exercised to its NOT_VERIFIED path. | P1.2 | P1.6 (human run) |
| Docker image builds could not run in the agent sandbox (build containers cannot use the session proxy), so compose-target drills (`postgres-kill.sh`, compose variants of the others) have not been executed. | P1.2/P1.5 | P1.5/P1.6 (human run) |
| Run ONNX inference in a `worker_thread` (or a process pool): today it runs synchronously on the ai-worker event loop, so a slow model delays HTTP answers and late results are discarded as `DEADLINE_EXCEEDED`. | P2.1 | Phase 4 |
| The ai-worker reads MediaMTX with an operator-level credential; add a least-privilege read-only MediaMTX user for the worker. | P2.2 | Phase 4 hardening |
| Retire the legacy in-process `EdgeAiRuntime` (only started with the ANPR flag) once ANPR runs through the ai-adapter. | P2.2 | P4.1 |
| `supervision.ByteTrack` is deprecated upstream in favour of the `trackers` package; re-run tracker validation against the successor when it stabilises. | P2.7 | Phase 4 |
| Rule preview replays stored events only; a clip-based preview (run the model over recorded video for a window) would show what lower thresholds would catch. | P3.5 | Phase 4 |
| ONVIF Profile M: capture the RTSP metadata track live (the parser and JSONL archive exist; nothing feeds them yet). | P3.1 | Phase 4 |
| Camera clock check has 1 s resolution (ONVIF `GetSystemDateAndTime`), so a 100 ms bound cannot be confirmed; measure with RTCP sender reports (NTP timestamps) from the RTSP session. | P3.1 | Phase 4 |
| NVR channel mapping for camera events: a Hikvision/Dahua NVR stream carries events for many channels; map `channel` to the right VigilOne camera (today one source = one camera, channel kept in the payload). | P3.2 | Phase 4 |
| Camera events have been exercised only against test doubles and fixtures written from published formats; capture (redacted) real device streams for Hikvision, Dahua, Axis and Hanwha and add them as fixtures. | P3.1/P3.2 | P2.10 / field validation (HUMAN-REQUIRED) |
| Correlation (`PRECEDED_BY` / `NOT_PRECEDED_BY`) sees only events already stored; a preceding event that arrives late (slow camera, backlog) is missed. Consider a short evaluation delay for rules with correlation. | P3.6 | Phase 4 |
| `sax` (BlueOak-1.0.0, via `onvif` -> `xml2js`) and the other pending licence exceptions need a human decision; if BlueOak is rejected, replace the `onvif` package (camera events already use fast-xml-parser). | P3.1 | Human decision |
| `EvidenceArchive` writes `concatTool: 'ffmpeg-v6.1'` into manifests as a constant instead of the version of the ffmpeg binary that ran. | P3.4 | Phase 4 (fail-loud) |
| Webhook and Slack channels are blocked in air-gapped mode because the SSRF guard only allows public addresses; a LAN webhook target for air-gapped sites needs an explicit, audited allowlist. | P3.3 | Phase 4 |
| `disasterRecoveryDrill.test.ts` Scenario B failed once in a parallel full run (`orphansIndexed` 0, expected 2), then passed in a second full run and 10/10 isolated runs. All its dependencies are mocked or per-test; cause not found. Investigate before calling it a flake. | Session 2 verification | Phase 4 |
