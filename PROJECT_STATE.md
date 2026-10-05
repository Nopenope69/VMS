# VigilOne Commercial Edge-First VMS — Project Memory & State

**Document Purpose:** Master memory snapshot preserving system state, architectural invariants, verified components, and exact specifications for continuing development.

**Remote Repository:** `https://github.com/Nopenope69/VMS.git` (Branches: `master`, `main`)  
- **Test, build and gate status:** generated from real CI runs, never hand-typed. See section 3 below and [`docs/generated/TEST_STATUS.md`](docs/generated/TEST_STATUS.md). Agent session logs with the exact commands run are in [`docs/STATUS.md`](docs/STATUS.md).

---

## 1. Complete System Architecture & Modules Built

### Bucket 1: Core Edge Appliance & Evidence Foundation
- **Caddy Single Gateway:** Reverse proxies `/api/*`, `/whep/*`, `/hls/*`, static SPA assets on port `80`/`443`.
- **Dedicated WebRTC ICE Transport:** UDP/TCP port `8189` for sub-500ms WHEP monitoring.
- **MediaMTX Engine Integration:** Programmatic RTSP path injection via internal API `:9997`; short-lived Bearer token webhook authentication (`/api/v1/media/auth`).
- **Crash-Resilient fMP4 Recording:** Fragmented MP4 with 1-second part durations so power loss truncates only the trailing sub-second fragment, leaving preceding fragments fully playable.
- **ONVIF Discovery & Control:** WS-Discovery multicast + manual IP probe + RFC1918 rate-limited subnet scan; PTZ ContinuousMove.
- **Hardware AES-256-GCM Encryption:** Appliance key management (`/etc/vigilone/appliance.key`, `chmod 600`) for camera credentials.
- **Section 63 BSA Evidence Package Generator:** Produces court-ready electronic evidence archives under Section 63 of Bharatiya Sakshya Adhiniyam, 2023 (BSA / formerly 65B IEA) with SHA-256 manifests, Ed25519 appliance digital signatures, and pre-populated Part A & Part B PDFs.
- **Operator UI Console:** 1x1, 2x2, 3x3, 1+5 live grid layouts, OSD monospace clock, REC indicator, 24-hour canvas timeline scrubber.

### Bucket 2: Multi-Tenant VMS Foundations & Event Operations
- **Offline Ed25519 Commercial Licensing:** Canonical JSON signing (`license.ts`), non-disruptive continuity invariant (licensing checks never block live view or recording).
- **Tamper-Evident Audit Event Hash Chain:** Cryptographically chained SHA-256 hashes (`eventHash = SHA256(prevHash + ...)`) with PostgreSQL two-key transactional advisory locks (`pg_advisory_xact_lock`) and unique constraint `@@unique([tenantId, sequenceNumber])`.
- **Fine-Grained RBAC & Staff Management:** `SUPER_ADMIN`, `TENANT_ADMIN`, `OPERATOR`, `VIEWER` roles with non-destructive account deactivation (`active: false`).
- **Multi-Site Tenancy Boundaries:** Facility timezones (`Asia/Kolkata`), UTC database timestamps, strict tenant isolation assertion.
- **Scene-Change Episode State Machine:** `IDLE` $\rightarrow$ `ACTIVE` $\rightarrow$ `COOLDOWN` (60s) episode tracking with substream-only decode (320x180 @ 1fps), motion spike counter, and real-time alarms console.

### Production Hardening Passes (The 16 Edge Appliance Invariants)
- **Pass 1 (Container Packaging & Secrets):** Dedicated unprivileged user `vigilone:vigilone` (`UID 10001`), BuildKit layer caching, `.dockerignore` files, image pinning (`bluenviron/mediamtx:1.9.3-ffmpeg`), CPU/memory limits, log rotation (`10m`, `3` files), `no-new-privileges:true`, static secrets scanner (`auditSecrets.ts`).
- **Pass 2 (Edge Observability & Telemetry):** Built-in zero-dependency Prometheus metrics engine (`/metrics`), VMS Golden Signals, correlation IDs (`x-request-id`), single-line structured JSON request logging, Grafana dashboard specification (`deploy/observability/dashboard.json`), Google SRE multi-window burn rate alerts (`deploy/observability/alerts.yml`).
- **Pass 3 (Chaos Engineering & Load Profiling):** fMP4 abrupt write truncation validation, 32-camera thundering-herd reconnect governor (max 3 concurrent handshakes + exponential jittered backoff), CMOS battery reset anti-rollback (`ClockGuard`), 32-camera load benchmark (0.00ms p99 event loop lag), field disaster recovery runbook (`deploy/chaos/resilience-runbook.md`).

### Bucket 3: Core VMS Surveillance Operations
1. **Weekly Recording Schedule Matrix & Site Timezone Engine:**
   - Database model: `RecordingSchedule` with 7-day x 24-hour JSON matrix (`MONDAY` through `SUNDAY`), `desiredMode` vs `lastAppliedMode` idempotent reconciliation.
   - Dynamic Facility Timezone: Evaluates site timezone (`site.timezone` e.g., `Asia/Kolkata` or `UTC`) with DST & midnight crossover safety.
   - Frontend UI: `ScheduleMatrixModal.tsx` interactive 7x24 grid painter with Continuous, Motion-Only, and Off brush tools, presets (24/7 Continuous, Office Hours, Weekend Security), and bulk fill.
2. **Motion Detection Inclusion Zones & Exclusion Masks:**
   - Database model: `DetectionZone` (`INCLUSION` vs `EXCLUSION`, priority integer, normalized polygon vertices `[{x, y}]`).
   - Geometric Pipeline: Pure mathematical Ray-Casting Point-in-Polygon (PIP) & Axis-Aligned Bounding Box (AABB) intersection in `DetectionZoneService`.
   - Exclusion Precedence: High-priority `EXCLUSION` zones override `INCLUSION` zones (e.g. masking busy highways or tree foliage).
   - Zone Configuration Snapshotting: Embedded in event metadata for forensic auditability.
   - Frontend UI: `DetectionZoneModal.tsx` with HTML5 Canvas polygon drawer, vertex dragging, real-time probe point tester, and active zone management.
3. **PTZ Presets & Guard Tour Patrol with Concurrency Arbiter:**
   - ONVIF Client: Realized `getPresets`, `setPreset`, `gotoPreset`, and `removePreset`.
   - Concurrency Arbiter: `PtzArbiterService` state machine (`IDLE`, `TOUR_RUNNING`, `MANUAL_OVERRIDE`, `TOUR_PAUSED`) enforcing 15-second mutual exclusion locks (`PtzLock`) and automatic 30-second operator inactivity patrol resumption.
   - Guard Tour Patrol: `GuardTourService` executing sequential preset tours with configurable dwell times.
   - Frontend UI: `PtzControlModal.tsx` featuring virtual joystick D-pad, live preset bookmarking, and tour builder.
4. **Custom Saved Layouts & Layout Tour Patrol:**
   - Database model: `Layout` with tenant isolation (`tenantId`, `userId`, `visibility: PRIVATE | TENANT_SHARED`, `slotsJson`).
   - Layout Tour Patrol: Automated control room tour rotating through saved views and grid types (1x1, 2x2, 3x3, 1+5, 4x4) with configurable intervals (10s, 15s, 30s, 60s) and countdown timer.
   - Frontend UI: `SaveLayoutModal.tsx` dialog and live selector in `LiveView.tsx`.
5. **Stream Diagnostic Telemetry & Quality Watchdog:**
   - Quality Watchdog: `StreamWatchdogService` comparing active MediaMTX metrics against nominal `StreamProfileBaseline` (FPS, bitrate ranges, resolution, GOP interval) with composite deviation scoring.
   - Auto-Recovery: Restarts stalled FFmpeg/MediaMTX pipelines when degradation score $> 3.0$.
   - Frontend UI: `StreamDiagnosticModal.tsx` displaying telemetry gauges, deviation indicators, and live probe trigger.
6. **Unified Alarm Workflow Incident Console:**
   - Architectural Principle: **Event $\neq$ Alarm**. Events record raw sensor triggers; Alarms represent operational workflow incidents.
   - Lifecycle: `ACTIVE` $\rightarrow$ `ACKNOWLEDGED` $\rightarrow$ `RESOLVED`.
   - Frontend UI: `AlarmBanner.tsx` for real-time notification with 1-click ack, and `Events.tsx` dedicated **Alarms Incident Workflow** console with audit notes and resolution dialog.
7. **Recording & Retention Lifecycle Engine:**
   - Pipeline: `Camera -> MediaMTX -> Segmenter -> Storage -> Index -> Retention -> Playback`.
   - `RecordingWatchdogService`: Detects recording gaps ($>5$s) and write stalls ($>30$s), raising operational alarms.
   - `RetentionService`: Enforces site retention limits while **strictly respecting active `EvidencePin` legal leases**, preventing destruction of evidence during automated pruning.

### Bucket 4: Edge AI Runtime, Indian ANPR, Spatial Forensics, Outbound Notifications & DR
1. **Reusable Edge AI Runtime Execution Supervisor:** Connects strictly to MediaMTX loopback, bounded frame queue (max 100), telemetry calculation, standardized `DetectionEvent`, and permissive Apache-2.0 / MIT licensing.
2. **Indian ANPR Subsystem & Multi-Frame Track Aggregator:** Multi-frame track voting ($N \ge 3$), positional OCR character ambiguity correction, 36 States/UTs + Bharat (`BH`) syntax verification, 60-second observation deduplication, and hotlist matching.
3. **Spatial Forensics & Wildcard Plate Search:** Pure AABB intersection queries on forensic ROI, wildcard plate searches (`DL*`), and instant timeline seek points.
4. **Outbound Notification Dispatcher & Webhooks:** Bounded retry queue, HMAC-SHA256 signature verification, multi-channel support (Webhook, Slack, Email), and rate limiting.
5. **WebRTC TURN Ephemeral Auth:** Coturn REST API ephemeral token generation with dual-transport TURN configs for NAT traversal.
6. **Disaster Recovery & Encrypted Appliance Backup:** AES-256-GCM metadata backup ($< 5$ MB), excluding large video recordings, with checksum integrity and atomic transaction restore.
7. **Operator UI Console:** `AnprConsole.tsx`, `SmartSearchModal.tsx`, `NotificationSettingsModal.tsx`, and `BackupModal.tsx`.

### Bucket 5: Enterprise Edge Federation Platform (CMS Mesh), Event-Action Automation Matrix, Tripwire/Loitering Analytics, DI/DO Relays & Object Storage Archive (Completed)
1. **Cryptographic Node Identity & Reverse WSS Control Tunnel:**
   - Single-use pairing tokens (`vigilone_pair_*`) with configurable TTL and single-consumption enforcement.
   - Node identity anchored on Ed25519 cryptographic keypairs with SHA-256 public key fingerprint verification.
   - Zero open inbound ports on edge appliances: Edge initiates outbound reverse WebSocket control tunnels (`WSSControlTunnel`).
   - Mutual challenge-response signature verification and timestamp replay protection ($< 300$s).
   - Heartbeat & node degradation watchdog (`ONLINE`, `DEGRADED` on disk $>95\%$ or queue depth $>10$, `OFFLINE` on heartbeat timeout $>30$s).
2. **Monotonic Store-and-Forward Sync Engine:**
   - Dedicated sync streams: `EVENT`, `AUDIT`, and `ALARM`.
   - Monotonic 64-bit sequence counters (`syncCursorEvent`, `syncCursorAudit`, `syncCursorAlarm`) preventing gap insertion.
   - Deterministic gap detection (`GAP_DETECTED`) triggering edge recovery replay.
   - Duplicate batch suppression (`DUPLICATE_IGNORED`) ensuring strict idempotency.
   - Atomic transactional batch ingestion advances cursor only upon successful commit.
3. **Declarative Desired-State Configuration Federation:**
   - CMS bundles tenant desired state (`version`, `cameras`, `schedules`, `zones`, `watchlists`, `automationRules`).
   - Push-based distribution via `ConfigSyncRecord` tracking `desiredVersion` vs `appliedVersion`.
   - Edge transactional application with versioned `CONFIG_ACK` and schema compatibility verification.
4. **Typed Event-Action Automation Matrix:** (Since 2026-10-01 the rules are evaluated only by the IncidentOrchestrator's `RuleEngine`; the legacy `EventActionMatrixService`, `AlarmService` and `GpioRelayService` are deleted. See section 7.)
   - Strongly typed rule DSL matching triggers (`TRIPWIRE_CROSS`, `LOITERING_DWELL`, `ANPR_WATCHLIST`, `MOTION_ZONE`, `DIGITAL_INPUT_STATE`, `CAMERA_OFFLINE`, `SCENE_CHANGE`).
   - Multi-action execution pipeline: `FIRE_DO_RELAY`, `TRIGGER_ALARM`, `PTZ_PRESET_GOTO`, `DISPATCH_NOTIFICATION`, `START_HIGH_RES_RECORDING`, `BOOKMARK_SEGMENT`.
   - Cooldown timers suppressing cascading feedback loops.
   - Unique `ruleExecutionId` auditing individual action durations, timeouts, and `continueOnFailure` policies (`SUCCESS`, `PARTIAL`, `FAILED`).
5. **Spatial Analytics: Directional Tripwire & Continuous Loitering:**
   - 2D Vector cross-product: $(B_x - A_x)(P_y - A_y) - (B_y - A_y)(P_x - A_x)$ distinguishing `SIDE_A` from `SIDE_B`.
   - Track-state hysteresis eliminating boundary jitter false alarms.
   - Direction enforcement: `A_TO_B`, `B_TO_A`, or `BIDIRECTIONAL`.
   - Continuous Loitering Dwell: Invariant requires unbroken dwell inside the polygon; exiting the polygon immediately resets the dwell counter.
6. **Physical Digital I/O (DI/DO) Multi-Stage Confirmation Handshake:**
   - Sensor input pins (`INPUT`): Door contacts, PIRs, optical beams monitored with real-time HIGH/LOW telemetry.
   - Actuator relay pins (`OUTPUT`): Siren, gate barriers, electric maglocks protected against accidental input invocation.
   - 4-Stage confirmation lifecycle: `COMMAND_SENT` $\rightarrow$ `COMMAND_ACK` $\rightarrow$ `STATE_CONFIRMED` or `COMMAND_FAILED` on timeout ($>3000$ms).
   - Momentary `PULSE` scheduling for barrier gates and access control strikes.
7. **Provider-Neutral Object Storage Archival (S3 / MinIO / Ceph):**
   - Content-addressed pre-flight `HEAD` check on `SHA256(segment)` preventing duplicate uploads over bandwidth-constrained links.
   - Off-peak schedule window evaluator with midnight crossover support (e.g. 23:00 - 05:00 UTC).
   - Bandwidth rate limiter (Bps throttling).
   - **Legal Evidence Pin Priority Bypass:** Segments pinned under Section 63 BSA evidence holds immediately bypass off-peak window restrictions.
   - Segment SHA-256 pre-upload checksum verification to prevent cold vault corruption.
8. **Operator UI Console & Modals:**
   - `FederationConsole.tsx`: Mesh status dashboard, pairing token generator, version skew tracker, sync cursor monitors, and embedded relay controller.
   - `RelayControlWidget.tsx`: Multi-stage state confirmation relay pad, sensor monitors, and hardware confirmation logs.
   - `EventActionRuleModal.tsx`: Visual IFTTT automation matrix builder with action timeouts and execution history.
   - `TripwireModal.tsx`: Canvas vector tripwire line drawer with directional arrows and continuous loitering polygon painter.
   - `ObjectStorageArchiveModal.tsx`: S3/MinIO archival configuration, off-peak scheduler, bandwidth throttle gauge, and job queue.

### Bucket 6: Enterprise Investigation, Synchronized Playback, Indoor Spatial Intelligence, Evidence Integrity & Privacy (Completed)
1. **Enterprise Identity, SSO & Session Governance:**
   - OpenID Connect (OIDC) federation with cryptographically secure PKCE challenge/verifier exchange (`OidcService`).
   - Standard discovery document validation & ID token claims verification (`iss`, `aud`, `exp`, `nonce`).
   - Fine-grained enterprise claims-to-role mapping (`SUPER_ADMIN`, `TENANT_ADMIN`, `OPERATOR`, `VIEWER`).
   - Inactivity auto-lock threshold (default 30 mins) with session unlock and global session revocation kill-switch.
2. **Multi-Camera Synchronized Playback & Reverse Shuttle Engine:**
   - Centralized `RecordingSegmentIndex` mapping authoritative UTC wall-clock time to media PTS and timebase (`timebaseNumerator`, `timebaseDenominator`, `fps`).
   - Multi-camera synchronized seek across arbitrarily complex layouts.
   - Monotonic local player delta advancement: $\Delta \text{masterUtc} = \Delta t_{\text{monotonic}} \times \text{rate}$.
   - Variable speed shuttle (-16x, -8x, -4x, -2x, -1x, 0.5x, 1x, 2x, 4x, 8x, 16x).
   - Variable FPS Frame Stepping: Exact decoded frame PTS delta ($\Delta \text{PTS} = \text{timebaseDenominator} / (\text{fps} \times \text{timebaseNumerator})$); strictly avoids fixed 33ms assumptions.
   - Gap Hold: Cameras in recording gaps report `NO_RECORDING` and hold last decoded frame without stalling the master timeline.
   - Reverse shuttle scrubber: Extracts descending keyframe sequences across multiple cameras.
3. **Evidence Integrity & Section 63 BSA Provenance:**
   - Master evidence immutability: Original recordings are NEVER modified, overwritten, or re-encoded.
   - Multi-camera cryptographic evidence manifest generation (`EvidenceManifest`) with deterministic SHA-256 root hash over sorted segment hashes (`masterEvidenceHash`).
   - Section 63 BSA (Bharatiya Sakshya Adhiniyam, 2023) metadata record generation with explicit legal admissibility disclaimer.
   - Derivative clip exports link back cryptographically to parent manifest hash.
   - Immutable chain of custody logging (`ChainOfCustodyLog`) with unbroken lineage ancestry verification.
4. **Privacy Policy Enforcement & Video Redactor Engine:**
   - Configurable tenant privacy policies (`PrivacyPolicy`): Face redaction, license plate masking, bystander blurring, restricted static zones.
   - Dual-custody supervisory approval enforcement for unredacted raw footage exports.
   - FFmpeg filter complex generator for temporal bounding box masks (`delogo` for faces/plates, `drawbox` for static zones).
   - Asynchronous redaction job execution producing cryptographically attributable derivative exports.
   - Physical derivative path enforcement under `EXPORTS_DIR/derivatives/<tenantId>/<jobId>.mp4`.
   - Mandatory fail-closed verification: `status: FAILED` if output derivative is missing or empty.
   - Authentic SHA-256 computation via streaming disk read into `crypto.createHash('sha256')`.
   - Purged fabricated model version strings (`1.2.0-yolo-cctv`).
   - Added CI corruption hygiene gate `scripts/ci/check-repo-hygiene.ts` (`npm run check:hygiene`).

### Bucket 7: Governed AI Foundation & Decoupled Worker Plane (Completed)
1. **Model Governance & Schema Registry:**
   - Database model `ModelManifest` (`name, version, sha256` unique/index, runtime config, licenses, training data provenance, obligations).
   - Commercial license policy enforcement (`MIT, Apache-2.0, BSD-2/3, ISC` approved; `MPL-2.0` reviewed file-level copyleft exception; `GPL, AGPL, CC-BY-NC, proprietary` rejected).
   - Immutable model version pinning and SHA-256 artifact verification.
   - Pre-deployment CI model license gate (`scripts/ci/check-model-licenses.ts`).
2. **Authenticated Detection Ingestion & Database-Native Idempotency:**
   - Internal API endpoints (`POST /internal/model-manifests`, `POST /internal/detections`) secured with `X-Internal-Secret`.
   - `DetectionEvent` unique `inferenceId` with atomic database-native upsert idempotency handling concurrent retry races (`P2002`).
   - Strict architectural decoupling: AI failures never impact evidence, recording, manifests, or camera playback.
3. **Decoupled AI Worker Skeleton (`services/ai-worker/`):**
   - Independent service process with `ModelLoader` verifying authentic SHA-256 and runtime config before execution.
   - Standardized `DetectionNormalizer` producing UUID `inferenceId` and normalized bounding boxes.
   - Resilient `AuthenticatedInternalApiClient` with exponential retry backoff.
   - `WorkerHealthMonitor` reporting operational status, loaded model state, and inference count.
4. **MediaMTX Localhost Loopback & Frame Acquisition Pipeline (Completed):**
   - **Absolute Loopback Invariant**: `buildLoopbackRtspUrl` strictly restricts connection targets to `rtsp://127.0.0.1:8554/<streamPath>`; external/private network camera addresses are strictly rejected.
   - **Safe Process Spawning**: FFmpeg spawned via argument arrays (`child_process.spawn`) with sanitized `streamPath` regex (`/^[a-zA-Z0-9_\-\/]+$/`); no shell interpolation.
   - **Filter-Level Frame Decimation and Output Bounding**: FFmpeg downsamples to 1 fps and applies aspect-ratio preserving scaling with letterboxing (`force_original_aspect_ratio=decrease,pad=...`) directly inside the filter pipeline before emitting raw RGB24 bytes to stdout (`-an`, `-pix_fmt rgb24`, `-f rawvideo`).
   - **Memory-Bounded Extractor & Accumulator Reset**: `FrameExtractor` bounds stdout accumulator to $\le 2 \times \text{frameByteSize}$; on disconnect/reconnect, accumulator is explicitly purged (`resetAccumulator()`) preventing misaligned RGB frame boundaries. Emits structured `VideoFrame` with monotonic `sequenceNumber`, `streamSessionId`, `sampledAt`, and `receivedAt`.
   - **Per-Camera Bounded Queues**: `BoundedFrameQueue` (default capacity 10) per camera drops oldest frames on saturation; Camera A spikes never starve Camera B.
   - **Appliance Resource Limits**: `ResourceGovernor` limits concurrency (`MAX_CONCURRENT_STREAMS = 16`, `MAX_FPS = 5`, `MAX_WIDTH = 1280`, `MAX_HEIGHT = 720`).
   - **8-State Stream Lifecycle**: `StreamManager` (`DISCOVERED` $\rightarrow$ `CONNECTING` $\rightarrow$ `CONNECTED` $\rightarrow$ `RUNNING` $\rightarrow$ `DISCONNECTED` $\rightarrow$ `BACKOFF` $\rightarrow$ `STOPPING` $\rightarrow$ `STOPPED`) with exponential backoff ($1\text{s} \times 2^N$ up to 30s) and randomized jitter.
   - **Camera Discovery**: `GET /internal/cameras` returns strictly safe metadata (`id, tenantId, name, streamPath, monitored`), never leaking credentials, hardware IPs, or external RTSP URIs.
   - **Evidence Plane Isolation Invariant**: AI crashes, FFmpeg non-zero exits, and loopback reconnects have zero impact on MediaMTX recording, fMP4 segmenting, or Section 63 BSA evidence manifests.

5. **Interactive Indoor Spatial Maps & Camera Geometry:**
   - Multi-level architectural floorplan management (`Floorplan`) with scale (pixels/meter) and rotation.
   - Camera spatial placement (`CameraSpatialPlacement`) with 3D coordinates, mount height, heading (0-360° navigational), pitch, horizontal/vertical FOV, and optical zoom.
   - Dynamic 2D FOV vision cone polygon calculation with smooth SVG arc interpolation.
   - Pure mathematical point-in-cone angular and spatial containment testing (`SpatialProjectionService`).
   - Live surveillance alarm spatial projection with severity-coded pulsating halos (CRITICAL red vs WARNING amber).
6. **Operator UI Console & Modals:**
   - `Investigation.tsx`: Multi-camera synchronized grid (1x1, 2x2, 1+5, 3x3), UTC wall-clock timeline, coverage bars & gaps, variable rate shuttle, and single-frame stepping.
   - `FloorplanView.tsx`: Interactive SVG floorplan stage, camera placement tools, dynamic FOV vision cones, live alarm halos, and camera inspection drawer.
   - `IdentitySettings.tsx`: OIDC provider manager, PKCE authorization initiator, and workstation session auto-lock console.
   - `EvidenceReviewModal.tsx`: Cryptographic manifest verification, Section 63 BSA certificate details, chain of custody timeline, and dual-custody approval.

---

## 2. Inviolable Architectural Principles
1. **The Law of Surveillance Path Sovereignty:** The primary media plane (RTSP ingest, disk write, live view) has absolute priority. Background jobs (hashing, indexing, audit, export, AI inference, CMS sync, cold archive) must never starve the media engine.
2. **Single Physical RTSP Stream Invariant:** Only one RTSP connection is ever established to each physical camera. Internal consumers (scene change, thumbnailers, watchdog, AI inference) pull strictly from MediaMTX's localhost relay (`rtsp://127.0.0.1:8554/...`). Direct camera RTSP connections for AI sampling are strictly forbidden.
3. **Durable Bounded Queue:** Segment completion uses PostgreSQL `SegmentJob` with `UNIQUE(tenantId, segmentPath)` and bounded concurrency = 2.
4. **Time-Leased Evidence Pins:** Segments are protected by `EvidencePin` leases with auto-expiry and admission control; boolean flags are forbidden.
5. **Monotonic Clock Floor:** Appliance clock evaluates $\max(T_{\text{system}}, T_{\text{license}}, T_{\text{latest\_audit}})$ to defeat CMOS battery resets or clock rollback.
6. **PTZ Mutual Exclusion & Graceful Override:** PTZ operations are governed by `PtzArbiterService` with time-bounded locks; manual overrides always take precedence over automated patrol tours with automatic timeout resumption.
7. **Evidence Preservation during Pruning:** Automated storage retention pruning must check and preserve any segment overlapping with an unexpired `EvidencePin`.
8. **Disaster Recovery Configuration Scope Boundary:** Configuration backup `.vigilone-backup` strictly archives database configuration and metadata ($< 5$ MB); multi-terabyte video recordings are strictly excluded from the configuration archive.
9. **Permissive AI Licensing:** All AI inference runtimes and weights must be Apache-2.0 or MIT licensed; AGPL/GPL copyleft dependencies are strictly excluded from the appliance runtime.
10. **Defensible Local Durability Boundary:** In edge federation, claims of absolute zero data loss are replaced with defensible local transactional durability: *"No loss of events committed to the edge's durable local event store, subject to local storage availability."*
11. **Control Plane vs. Media Plane Separation:** The CMS manages control, signaling, configuration desired-state, and event aggregation. Real-time media streams travel directly from edge node to client via WebRTC WHEP / LAN wherever network topology allows.
12. **Track Hysteresis & Continuous Dwell Invariant:** Directional line-crossing requires vector cross-product sign transitions debounced by track-state hysteresis. Continuous dwell loitering requires unbroken presence inside the polygon; any boundary exit immediately resets the dwell timer.
13. **Multi-Stage Physical Relay Handshake:** Actuator relays must progress through explicit stages (`COMMAND_SENT` $\rightarrow$ `COMMAND_ACK` $\rightarrow$ `STATE_CONFIRMED`), failing cleanly on hardware timeout ($>3000$ms) with full audit logging.
14. **Playback Clock Invariant:** UTC wall-clock time is the authoritative investigation timeline; monotonic time is used for local player progression/rate control; per-camera media PTS/timebase mappings translate recording timestamps onto the master UTC timeline. Never treat UTC and monotonic time as the same clock. No fixed 33ms assumption for frame stepping.
15. **Recording Catalog Invariant:** `RecordingCatalog` is the single authoritative owner of all recording existence, presentation timestamps, wall-clock coverage, recording gap detection, evidence pin registration, and retention enforcement. `RecordingSegment` is the unified database model (decommissioning `RecordingSegmentIndex`). Pinned segments have absolute veto power over automated retention pruning; `STORAGE_QUOTA_PINNED_EXHAUSTION` fires only when quota deficit cannot be satisfied because remaining footage is pinned.
16. **Evidence Archive & Provenance Invariant:** `EvidenceArchive` (`src/services/evidence/archive/`) is the single authoritative deep module for evidence manifests, Merkle tree provenance, Section 63 BSA certificate generation, custody hash chains, derivative clip lineage, and pin lifecycle management.
    - **Dual-Pin Separation:** `TemporaryExportPin` protects source segments for export duration; `LegalHoldPin` imposes an absolute retention veto that survives export completion, failure, or cancellation, releasing only via explicit authorized `setLegalHold(false)`.
    - **Canonical Length-Prefixed Merkle Leaves:** Domain `"VIGILONE-EVIDENCE-SEGMENT-V1"` length-prefixed binary buffer encoding with deterministic odd-leaf node duplication and $O(\log N)$ inclusion proofs.
    - **Canonical Manifest Signing:** Appliance Ed25519 private key signs the canonical manifest JSON digest (binding time range, cameras, version, and Merkle root).
    - **Section 63 BSA Boundary:** Appliance signature certifies machine system provenance only; Schedule Part A (party in-charge) and Part B (technical expert) statutory declarations strictly require explicit human completion.
    - **Tamper-Evident Custody Hash Chain:** Sequential cryptographic chain: $E_n = \text{SHA-256}(E_{n-1}.\text{eventHash} \parallel \text{eventId} \parallel \text{action} \parallel \text{actorUserId} \parallel \text{timestampUtcIso} \parallel \text{payloadHash})$.
17. **Privacy Control Invariant:** Configurable privacy policy enforcement and redaction controls aligned with applicable requirements (e.g. DPDP Act 2023 / GDPR). The software states that it supports evidentiary integrity and Section 63 BSA requirements without claiming that the platform guarantees statutory or judicial admissibility. Packages are designated as "structured evidence export packages".
18. **Tenant & Privilege Isolation:** Identity/SSO, playback sessions, floorplans, evidence manifests, privacy policies, exports, and redaction jobs remain tenant-scoped and RBAC-enforced at the backend API layer.
19. **Spatial Engine & Geometric Invariants (ADR 0003):** `SpatialEngine` (`src/services/spatial/engine/`) is the single authoritative deep module for all 2D vector geometry, detection zone masking, tripwires, continuous dwell loitering, camera FOV vision cones, floorplan projection, and spatial motion searches.
    - **Strict Facade Isolation:** Shims (`DetectionZoneService`, `SpatialAnalyticsService`, `SpatialProjectionService`, `FloorplanService`) call public `SpatialEngine` facade methods only; internal submodules remain private.
    - **Topological Polygon vs BBox Intersection:** `intersectsPolygonBBox` implements complete topological intersection (bbox corners in poly, poly vertices in bbox, and segment-segment edge intersections).
    - **Three-State Tripwire Hysteresis:** Line sides use `SIDE_A` ($>+\epsilon$), `ON_LINE` ($[-\epsilon, +\epsilon]$), and `SIDE_B` ($<-\epsilon$). A valid crossing requires traversing across the `ON_LINE` buffer, suppressing line-edge noise.
    - **Loitering Observation-Loss Rule:** Explicit exit (`OBSERVED_OUTSIDE` or centroid outside) immediately resets dwell timer. Detector dropouts $\le \text{observationTimeoutMs}$ (2000ms) preserve dwell timer; dropouts $> 2000$ms reset dwell upon return.
    - **Calibrated PTZ FOV with Fallback:** Uses calibrated profile lookup when present, with optical fallback $\text{FOV}_{\text{eff}} = \max(10^\circ, \min(180^\circ, \text{FOV}_{\text{h}} / \text{zoom}))$.
    - **Bounded Track State Ledger:** LRU and TTL eviction bounds memory with per-camera caps (500), global caps (5000), and observable telemetry metrics.
    - **Exclusion Precedence:** High-priority exclusion zones have absolute veto over detections.
20. **Unified Incident Orchestrator & Action Outbox Invariant (ADR 0004):** `IncidentOrchestrator` (`src/services/incident/orchestrator/`) is the single authoritative deep module for sensor/vision event ingestion, automation rule evaluation, persistent action outbox dispatch, hardware relay execution, alarm state machines, and outbound notification delivery.
    - **Strongly Typed Canonical Event Contract:** Standardized discriminated union `VigilOneEvent` with strict typing across 12 event kinds (`MOTION`, `TRIPWIRE_CROSS`, `LOITERING_DWELL`, `ANPR_MATCH`, `CAMERA_OFFLINE`, `STREAM_DEGRADED`, `DI_TRIGGER`, `SCENE_CHANGE`, `SYSTEM_ALERT`, `AI_OBJECT_DETECTED`, `CAMERA_ANALYTIC`, `DOOR_EVENT`), explicit spatial refs, and evidence refs.
    - **One Entry per Event Kind (ADR 0006):** `eventKinds.ts` is the only place a kind is described: its rule trigger types, trigger config schemas, trigger match and events.v1 mapping. The rule engine, rule schema, rule preview, dry run and events.v1 mapping derive from it. The compiler refuses a kind without an entry; a load-time check refuses a `RuleTriggerType` that no kind feeds.
    - **Cascade Loop & Depth Protection:** Hard recursion limits `MAX_EVENT_ACTION_DEPTH = 5` and `MAX_ACTIONS_PER_CORRELATION = 25`. Breaching cascades are terminated safely with `CASCADE_TERMINATED` and security alert logging.
    - **Multi-Level Database-Enforced Idempotency:** Canonical event deduplication key `event.id`, unique `(ruleId, triggerEventId)` on `RuleExecutionRecord`, and unique `(ruleExecutionId, actionId)` on `ActionExecutionRecord`.
    - **Persistent Action Outbox:** Ingestion durably commits events and pending execution records before background outbox claiming. Process crashes resume cleanly without lost or duplicated actions.
    - **Adapter-Specific Relay Confirmation Semantics:** Digital I/O execution enforces explicit `RelayConfirmationMode`: `ACK_ONLY` (confirms command transmission only, never claims `STATE_CONFIRMED`), `STATE_FEEDBACK` (requires physical feedback contact), and `PULSE_COMPLETION` (timed pulse cycle completion) with device-level configurable timeouts.
    - **Atomic Alarm & Audit Serialization:** Mutations consume `CommandContext` (`tenantId`, `actorUserId`, `correlationId`, `permissions`), enforcing tenant boundaries and committing atomic `AuditChainService` records.
    - **Event $\neq$ Alarm Mental Model:** Sensor events never spontaneously become alarms. Alarms are created strictly via explicit rule actions (including built-in system critical policies).
21. **One ai-adapter.v1 Seam per Side (ADR 0007):** On the backend, `AiAdapterClient` (`src/services/ai/aiAdapterClient.ts`) is the only code that speaks ai-adapter.v1. The embedding, redaction and VLM clients add task-specific checks only. In the ai-worker, `PipelineAdapterCore` holds the contract rules for the ANPR, redaction, embedding and VLM adapters. The object-detection core keeps its own queue, shared with the camera stream pipeline. The SDK `createAdapter` server is not yet used by the worker (see ADR 0007, "Not done").
22. **Composition Root (ADR 0008):** `backend/src/composition.ts` builds each long-lived backend module once and owns starting and stopping background services. It provides one `RecordingCatalog` and one `RelayAdapter` (the orchestrator's). Routes take instances from it and never construct long-lived modules or background workers. `server.ts` runs only HTTP, the HA lease and shutdown.

---

## 3. Test & Verification Summary

<!-- TEST_STATUS:START (generated by backend/scripts/ci/generate-status.ts from a real Jest run; do not edit by hand) -->
Generated 2026-10-05T15:58:19.531Z from commit `18a2cbd2520a` (https://github.com/Nopenope69/VMS/actions/runs/37335992651).

| Project | Suites passed | Tests passed | Failed | Skipped | Result |
| --- | --- | --- | --- | --- | --- |
| backend | 160/160 | 1190/1226 | 0 | 36 | PASS |
| ai-worker | 31/33 | 315/325 | 5 | 5 | FAIL |
| **Total** | | **1505/1551** | **5** | **41** | **FAIL** |

Per-suite detail: [`docs/generated/TEST_STATUS.md`](docs/generated/TEST_STATUS.md).
<!-- TEST_STATUS:END -->

---

## 4. Operator-Grade Surveillance UI/UX Overhaul (Master Memory Snapshot)

### Architectural Invariants & Design Token System
- **Industrial Avionics & Warm Control-Room Palette:** Built with bespoke tactical tokens adhering to WCAG AAA contrast ratios:
  - `vms-bg` / `vms-panel` / `vms-surface`: `#38240D` (Scorched Umber foundation)
  - `vms-accent` / `vms-accent-hover`: `#C05800` (High-Vis Burnt Amber)
  - `vms-text` / `vms-text-bright`: `#FDFBD4` (Crisp Warm Cream, 17.5:1 contrast against `#38240D`)
  - `vms-border` / `vms-elevated`: `#713600` (Warm Bronze / Deep Earth)
  - Standardized Status Accents: Live/Recording Emerald (`#10B981`), Warning Amber (`#F59E0B`), Alarm Rose (`#EF4444`), Telemetry Sky (`#38BDF8`), Legal Hold Purple (`#A855F7`).
- **Token Purity & Zero Dead Classes:**
  - 0 occurrences of undefined legacy classes (`graphite-*`, `cctv-*`).
  - 0 occurrences of invalid Tailwind class `py-0.2`.
  - Reusable UI primitive component library established in `frontend/src/components/ui/` (`Button`, `Card`, `Badge`, `Modal`, `ConfirmModal`, `Input`, `EmptyState`, `KpiStat`).

### Ergonomics, Hotkeys & Operator Control
- **Zero Blocking Browser Dialogs (43 / 43 Replaced):** All native `alert()` and `confirm()` calls replaced with accessible ARIA modals (`role="dialog"`, `aria-modal="true"`, `Escape` key dismissal) and inline notification banners.
- **Conflict-Free Global Navigation:** Tab switching migrated to `Alt+1` through `Alt+0` (displaying `⌥1`..`⌥0` badge hints) with input/textarea typing guard.
- **Rapid Grid Presets:** Bare keys `1`–`5` switch surveillance grid layouts directly in `LiveView.tsx` (`1x1`, `2x2`, `3x3`, `4x4`, `1+5`).
- **Double-Click Tile Maximization:** Active video feeds in `CameraTile.tsx` maximize to full viewport on double-click; double-clicking again restores the grid layout.
- **Forensic Transport Controls:** `Investigation.tsx` supports `Space` (Play/Pause), `Arrow Left/Right` (1s step), and `J`/`K`/`L` (Rewind / Pause / Fast-Forward shuttle).
- **Bulk Alarm Triage & Canned Presets (`Events.tsx`):** Multi-select header and row checkboxes, `Acknowledge Selected`, `Acknowledge All Critical`, and attestation preset chips (`False Alarm`, `Security Guard Dispatched`, `Sensor Test`, `Sector All Clear`).
- **High-Density Telemetry Bars:** Replaced bulky 4-5 card KPI blocks with single-line horizontal telemetry vitals across all 6 administrative consoles (`Devices`, `Evidence`, `AuditLogs`, `StorageManagement`, `ApplianceConsole`, `Events`).
- **Legal Compliance Invariant:** Preserved mandatory Section 63 BSA legal disclaimers in high-legibility `font-sans` with $\ge 14\text{px}$ font size.

### Zero-Friction Evaluation & Demo Bypass Architecture
- **1-Click Evaluation Bypass:** Dedicated `Bypass Setup & Test UI` and `Bypass & Test UI` actions on `FirstRunWizard.tsx` and `Login.tsx` instantly authenticate as `Alex Vance (Chief Security Officer)` with `SUPER_ADMIN` privileges.
- **1-Click Demo Pre-Fill:** `Fill Demo Data` and `Fill Credentials` actions pre-fill valid appliance commissioning forms (`Metro Transit Command Facility`, `admin@vigilone.local`, `Password123!`, `vigilone_dev_setup_token_99182`).
- **Offline Simulated CCTV Feeds & Telemetry:** When physical cameras or backend are offline, `LiveView.tsx` renders 4 simulated streams with real-time canvas telemetry, running UTC timecode, optical reticle, and PTZ indicators; `Events.tsx` falls back to simulated alarms with optimistic local state updates.

---

## 5. Tier-1 Control-Room Operator-Grade Upgrades (Post-Audit Implementation)

1. **Synchronized Multi-Track Timeline Swimlanes (`TimelineScrubber.tsx`, `Investigation.tsx`):**
   - True multi-camera synchronized canvas scrubber with individual camera swimlanes (`TimelineTrack[]`).
   - Dynamic canvas height calculation (`22 + activeTracks.length * 24`).
   - Real-time track selection (`onSelectTrack`), emerald footage blocks, amber motion pips, master burnt amber UTC playhead.
   - Synchronized across all 4 investigation matrix feeds with simultaneous segment fetching and simulated demo fallback.
2. **Universal Command Palette (<kbd>Cmd+K</kbd> / <kbd>Ctrl+K</kbd>) & Hotkey Cheatsheet (<kbd>?</kbd>):**
   - `CommandPalette.tsx`: Omnibar fuzzy-search across Consoles (`Alt+1..0`), Cameras, and Actions with keyboard navigation (<kbd>↑</kbd>/<kbd>↓</kbd>/<kbd>Enter</kbd>/<kbd>Esc</kbd>).
   - `HotkeyHelpModal.tsx`: Categorized operator cheat-sheet with Global Navigation, Live Grid, Transport, and Command & Control shortcuts.
   - Accessible ARIA semantics: `role="dialog"`, `aria-modal="true"`, `e.key === 'Escape'` dismissal.
3. **Interactive Camera Directory Drawer in Live Grid (`CameraDrawer.tsx`, `LiveView.tsx`):**
   - Collapsible slide-over drawer with instant search filtering, online/offline status filter chips, and facility sector grouping.
   - Interactive click-to-slot assignment: clicking any slot in the grid targets it; clicking a camera in the drawer binds it immediately.
   - Direct slot unassign button on tile hover, keyboard shortcut <kbd>C</kbd> to toggle drawer.
4. **Tactical Alarm Acoustics & 5-Second Undo Toast (`AlarmBanner.tsx`):**
   - Native Web Audio API (`AudioContext`) synthesized 880Hz/659Hz dual-tone acoustic chime on new critical alarms (zero network assets, zero latency).
   - Operator mute toggle and 5-minute audio snooze button.
   - 5-second inline "Undo" countdown chip upon clicking "Acknowledge", preventing accidental alarm dismissals under high stress.
5. **Pre-Flight Camera Connection Probe & Hardware Micro-Interactions (`Devices.tsx`, `CameraTile.tsx`, `index.css`):**
   - `Devices.tsx`: "Test Connection" button validating RTSP/ONVIF reachability before form submission via `/cameras/discover` with immediate visual status banner.
   - `CameraTile.tsx`: Frosted glass controls (`backdrop-blur-sm bg-vms-elevated/90`) and dedicated "Retry Stream" overlay on interrupted streams.
   - `index.css`: Cross-browser custom scrollbars styled with Scorched Umber `#713600` / `#38240D`.

---

## 6. Bucket 6: Clean Governed AI Pipeline & Evidence Decoupling (Steps 0, 1, 2 & 3)

### Step 0: Redaction/Evidence Integrity (`ab05273`)
- Eliminated fake fallback models (`1.2.0-yolo-cctv`).
- Configured output resolution strictly under `EXPORTS_DIR/derivatives/<tenantId>/<jobId>.mp4`.
- Enforced fail-closed behavior on missing derivative files.
- Computed authentic SHA-256 via streaming hash calculation.
- Established repository corruption hygiene gate (`npm run check:hygiene`).

### Step 1: Governed AI Foundation (`e9480d3`)
- Database model `ModelManifest` with immutable versioning, license classification, and runtime configuration.
- Commercial license governance policy rejecting copyleft/viral licenses.
- Pre-deployment CI license gate (`npm run check:model-licenses`).
- Decoupled AI Worker skeleton (`services/ai-worker/`) with `ModelLoader`, `DetectionNormalizer`, and `WorkerHealthMonitor`.
- Database-native idempotency on `inferenceId` in `DetectionEvent` (`P2002` race handling).

### Step 2: MediaMTX RTSP Loopback & Frame Acquisition (`9a84ab4`)
- Absolute loopback invariant: AI worker connects strictly to `rtsp://127.0.0.1:8554/<streamPath>`, with zero camera/ONVIF access.
- Safe `child_process.spawn()` argument arrays with shell escape injection prevention.
- Filter-level decimation (`fps=1`, letterbox padding) inside FFmpeg.
- Memory-bounded stdout chunk accumulator (max 2x frame size) with automatic purge on reconnect.
- `BoundedFrameQueue` with drop-oldest policy and `ResourceGovernor`.
- 8-state stream lifecycle with exponential backoff and randomized jitter.
- Privacy-preserving internal camera discovery (`GET /internal/cameras`).

### Step 3: Governed ONNX Runtime & Object Detection Model (`ba79517`)
- **Hard Production Guard**: `OnnxInferenceEngine` throws `FATAL CONFIGURATION ERROR` if `AI_INFERENCE_MODE=test-stub` in production. Native mode fails fast if `onnxruntime-node` is missing, setting worker health to `ERROR`.
- **Authoritative `FrameGeometry` & Coordinate Reversal**: `CoordinateTransformer` unpads and unscales model-space boxes back to normalized source camera coordinates $[0..1]$. Frames missing geometry are rejected without guessing.
- **Class-Scoped NMS**: `classScopedNms` groups candidates by class before IoU suppression; person and vehicle boxes never suppress each other.
- **Governed Signature Decoding**: `SignatureDecoder` dynamically decodes ONNX outputs according to `modelSignatureJson`, mapping classes from `classesJson` and filtering by thresholds from `thresholdsJson`.
- **Global `InferenceScheduler`**: Concurrency bounded to 2, hard deadline timeout `INFERENCE_TIMEOUT_MS = 1000`, newest-frame preference dropping stale frames to prevent latency lag.
- **Planar Tensor Buffer Pool**: `TensorBufferPool` pre-allocates Float32Array buffers, eliminating memory leaks and GC overhead.
- **Database-Native Idempotent Ingestion**: `POST /internal/detections` handles duplicate inference IDs via unique upsert and `P2002` race recovery.
- **Architectural Evidence Isolation Under Load**: `evidenceIsolationLoad.test.ts` proves that severe AI frame load, timeouts, and drops have zero effect on MediaMTX recording, fMP4 segment ingestion, or Section 63 BSA evidence manifests.

### Step 4: Multi-Object Tracking & Spatial Analytics Integration (`b5f3844`)
- **Class-Scoped Association Invariant**: IoU association is strictly partitioned by object class (`person` $\leftrightarrow$ `person`, `vehicle` $\leftrightarrow$ `vehicle`). Cross-class candidate pairs receive $\text{cost} = \infty$ and are discarded before IoU calculation, preventing cross-class track corruption.
- **Deterministic 4-State Lifecycle**: Tracks advance through `TENTATIVE` $\rightarrow$ `CONFIRMED` $\rightarrow$ `LOST` $\rightarrow$ `TERMINATED`. Persistent UUIDv4 `trackId` is assigned at creation and maintained until termination. Only `CONFIRMED` tracks are emitted downstream to backend spatial analytics.
- **Bounded Memory & Eviction Precedence**: Strict per-camera capacity limit of 50 active tracks. Eviction order on capacity pressure: `TERMINATED` $\rightarrow$ `LOST` $\rightarrow$ `TENTATIVE`. `CONFIRMED` tracks are never evicted for capacity; incoming candidate tracks are rejected when all 50 slots are occupied by active confirmed tracks.
- **Constant-Velocity Projection & Bounded Trajectory**: Predicts search bounding box locations during tracking gaps using calculated velocity ($dx = v_x \cdot \Delta t, dy = v_y \cdot \Delta t$). Trajectory history is chronological and bounded to the last 30 points.
- **Per-Camera Isolation**: `AiWorker` manages independent `MultiObjectTracker` instances isolated by `cameraId`. Tracker states and capacity are strictly separated across feeds.
- **Directional Tripwires & Continuous Loitering**: Ingestion route `POST /internal/detections` evaluates confirmed tracks against active `SpatialAnalyticsRule`s via `SpatialEngine`. Supports `A_TO_B`, `B_TO_A`, and `BIDIRECTIONAL` tripwire crossings with track-state hysteresis. Continuous loitering requires unbroken presence inside the polygon; exiting the polygon resets the dwell timer immediately.
- **Database-Level Incident Uniqueness & Cooldown Deduplication**: `Incident` model enforces `@@unique([cameraId, ruleId, trackId, cooldownBucket])` with `cooldownBucket = BigInt(Math.floor(currentTimeMs / (cooldownSeconds * 1000)))`, providing atomic database-level concurrency protection against duplicate alerts during race conditions.
- **Strict Evidence Plane Isolation**: Spatial analytics evaluation and incident creation operate strictly asynchronously or decoupled from recording, retaining zero coupling to MediaMTX streaming, fMP4 segmenting, or Section 63 BSA evidence manifests.

---

## 7. Architecture Review Follow-Through (2026-10-01)

The `improve-codebase-architecture` review found six deepening candidates. Status:

| # | Item | State | Where |
| --- | --- | --- | --- |
| 1 | Retire the legacy rule engine | Merged (PR #19) | ADR 0004 follow-up. Fixed a real bug: `POST /automation/dry-run` crashed with HTTP 500 after writing a stray `RuleExecutionRecord`. It now evaluates with the live `RuleEngine` and writes nothing. |
| 2 | One entry per event kind | Merged (PR #20) | ADR 0006, `eventKinds.ts` |
| 3 | One ai-adapter.v1 seam per side | Merged (PR #21) | ADR 0007. Worker on the SDK server: not done. |
| 4 | Composition root | Merged (PR #22) | ADR 0008. The orchestrator instance is still created in its own module; four services import it directly. |
| 5 | Camera registry module | Merged (PR #25) | ADR 0009. Fixes cross-tenant writes: another tenant could edit and delete zones, stop and delete guard tours, and run the diagnostic probe. Also makes onboarding all or nothing and stops inventing diagnostics and presets. Finding fixed in Bucket 7: `Camera.isOnline` became `monitored`, and online is now real liveness from the stream watchdog. |
| 6 | One declaration of settings | Merged (PR #26) | ADR 0010, `config/settings.ts`. A bad setting stops start-up, naming the variable; before, `DOOR_POLL_INTERVAL_MS=5s` became a 1 ms timer. `RECORDINGS_DIR`, `EXPORTS_DIR` and `COTURN_*` still have two readers. |

**Known gap, fixed in PR #23:** the generated status showed the ai-worker red (28 failures in `goldenSiglip2`, `goldenVlm` and `embeddingAdapter`). The cause was not the code. `status.yml` required the model tests but never fetched the SigLIP 2 and SmolVLM2 models or built `llama-server`. The PR checks in `ci.yml` do, and are green. Verified after merge: status run 36855674301 passed, the first green run of that workflow since Phase 5.

**Working rules carried between sessions:**
- Skills and `.claude` setup files are never committed to this repository.
- Merge only when the owner asks.
- Fail loud, and use honest STATUS labels.
- Run the full suites and gates before every push.
- Use one PR per item and drive its CI to green.
- All work starts from `master`. `main` is a stale branch, 91 or more commits behind; do not build on it.
- Check work from other agents (e.g. Antigravity) against the real backend before trusting it (see section 8).

---

## 8. Redaction Console and DPDP Settings (2026-10-01, PR #27, merged)

Antigravity built a redaction console, DPDP settings, a pgvector doc and a compliance audit, and pushed them to
`main` as commit `4482397`. The code compiled, but against the real backend it failed in six ways. PR #27 brought
it onto `master` with fixes (Session 19 in `docs/STATUS.md`):

- **Redaction job:** it sent the wrong mode (`BLUR`/`SOLID_BLACK`) and the wrong id (the export, not the
  manifest). It now sends `FACE`/`LICENSE_PLATE`. Masking is solid black only; there is no blur.
- **DPDP save:** it sent the wrong field names, so every save failed with a 400. The purge message always said
  0. Both are fixed.
- **Downloads:** plain links got 401. They now go through `frontend/src/services/download.ts`.
- **Evidence page:** it read fields that do not exist and blanked the whole app when any real export existed.
  It now uses the real fields.
- **Docs:** the compliance audit was rewritten so every claim matches the code; it is marked INTERNAL
  SELF-ASSESSMENT. The pgvector doc now describes the real `CropEmbedding` schema.

**Browser tests (new):**
- `scripts/e2e/frontend-browser.sh` runs `frontend/e2e/redaction-dpdp.spec.ts`, six tests, using Playwright
  1.56.1, which matches the Chromium in `/opt/pw-browsers`.
- It needs `TEST_DB_URL` pointing at a scratch database, which it drops and recreates.
- It seeds the database (`backend/scripts/e2e/seed-frontend-e2e.ts`), then starts the real backend and
  `vite preview`.
- CI job: `frontend-browser-tests`.
- `frontend/e2e/operations.spec.ts` was rewritten in Bucket 7 against the seeded tenant (sign-in and role menus,
  camera directory liveness, alarm triage, storage) and runs with the others.

## 9. Where to Pick Up Next

**State:**
- The North Star was rewritten around the AI investigation product (#29). Its build plan has buckets 1 to 8
  (section 5 of `docs/strategy/00-north-star-v0.1-and-v1.0-plan-2026-09-29.md`), one PR per bucket.
- Merged: Bucket 1, the track index (#30, ADR 0011); Bucket 5, measurement tools (#32); Bucket 2, track search
  (#33, ADR 0012); Bucket 3, cross-camera following (#36, ADR 0013); Bucket 4, the investigation workspace (#37,
  #38); Bucket 7, housekeeping (#39); the plate and spatial search fixes (#31, #34); the status-push race fix
  (#35).
- Buckets 1 to 5 and 7 are done. Left: **Bucket 6** (privacy tools: data-principal access/erasure requests,
  exportable record of processing, breach register), **Bucket 8** (V1.0 understand-and-act; several items need a
  local language model and a licence decision first). The **ai-worker on the SDK server** is done (Session 27,
  ADR 0007). Bucket H (bench, clean-install drill, footage, licences, DPDP choices, pilot site) is
  the owner's field track.
- **AI features (owner, 2026-10-04):** threat detections first, then the five software features of
  `docs/strategy/vigilone-ai-features-landscape-2026-10-03.md` (natural-language search, describe-what-to-watch
  rules, cited incident summary, alarm triage, footage integrity). Threat detections without a new model
  (unattended bag, wrong way) are on `claude/amazing-hypatia-hkgolw` (Session 28); person down and fence climbing
  need a pose model and a licence decision (merged, #43). Bucket 6 (privacy tools) is parked.
- **Plain-language search** (first of the five, Session 29, feature `NL_SEARCH`): rules with an English, Hinglish
  and Devanagari word list fill the Find form; Qwen3-4B (candidate, needs the owner's approval to run in the
  product) only rewrites requests the word list cannot read, and what the rules read in the original wins.
  Measured in `docs/ai/nl-search-evaluation.md`.
- **Next:** the other four software features (describe-what-to-watch rules, cited incident summary, alarm triage,
  footage integrity), one PR each, from `master`.
- **Built from the reference study (2026-10-05, branch `claude/elegant-albattani-4krihk`):** incident window (ADR 0014:
  one incident, one alarm, per rule via `incidentWindowSeconds`) and alarm triage (ADR 0015, flag `ALARM_TRIAGE`:
  ordered queue with reasons and proposed rule changes, nothing applied; API only, no queue page yet). Left of the
  four features: cited incident summary, describe-what-to-watch rules, footage integrity.
- **Reference study (2026-10-05):** `docs/strategy/vigilone-oss-reference-study-2026-10-05.md` adds four small items
  from open-source projects (alert-cutoff semantics, RecordingCatalog crash-safety and time audit, per-camera health
  endpoint, adapter result fields) and sets the order: alert-cutoff first, then the four pending features.

**Open follow-ups, all known and documented:**

| Follow-up | Detail | Recorded in |
| --- | --- | --- |
| Out-of-order track path (bug) | **Fixed** on `claude/amazing-hypatia-hkgolw`: in `appendPath` (`backend/src/services/tracks/trackMath.ts`) a point earlier than the path's start now becomes the new start, so a burst applied latest-first keeps its beginning and its direction. Other late points (inside the path) are still ignored. Unit tests cover start-replacement, a late inner point and a latest-first burst; `trackIndexRealDb` passed 10 runs in a row. | PR #39 comment |
| ai-worker on the SDK server | **Done** on `claude/amazing-hypatia-hkgolw` (Session 27): SDK 0.2.0 adds `createAdapterCore` and the VLM answer, component provenance, liveness and multi-task hooks; the worker ships a checked copy of it (`services/ai-worker/src/sdk/`, `npm run check-sdk` in CI) and its ANPR, redaction, embedding and VLM pipelines run on it. The object-detection core keeps its own queue. | ADR 0007 |
| Data-principal requests | There is no workflow for an individual's access or erasure request (DPDP s.11–13). Bucket 6. | `docs/BACKLOG.md`; the compliance audit, section 4 |
| No record of processing or breach register | There is no exportable Art. 30 record and no breach register or notification workflow. Bucket 6. | Compliance audit, sections 1 and 6 |
| `main` branch | Still on GitHub (holds the unfixed Antigravity commit; everything on it is on `master`). The owner decided to delete it; agent sessions cannot delete branches, so the owner does it on GitHub (Branches page). `chore/repo-skills` is already gone. | Section 8 |

**Working agreements with the owner:**
- One PR per bucket or fix, started from `master`; the owner merges. Run the full suites and the six gates before
  pushing; drive CI to green; explain results in plain, non-technical words.
- Fail loud and label status honestly (`docs/STATUS.md` states). Never commit skills or `.claude` files.
- Agent sessions push only to their own branch; branch deletion and merges are the owner's.

**Local environment notes (cloud sandbox):**
- PostgreSQL can stop when the container restarts. Run `service postgresql start`.
- Test database URL: `postgresql://vigilone:vigilone_ci_secret_password_2026!@localhost:5432/vigilone_db?schema=public`.
- Model files are fetched with `scripts/models/fetch-model.sh <name>`. SigLIP 2 and SmolVLM2 are large; after
  using them, free the disk space, because `storageVolumeManager` needs more than 5% free.
