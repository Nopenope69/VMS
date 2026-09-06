# VigilOne Commercial Edge-First VMS — Project Memory & State

**Document Purpose:** Master memory snapshot preserving system state, architectural invariants, verified components, and exact specifications for continuing with **Bucket 3 (Core VMS Surveillance Operations)** in the next session.

**Remote Repository:** `https://github.com/Nopenope69/VMS.git` (Branches: `master`, `main`)  
**Latest Verified Commit:** `8e51149`  
**Automated Test Status:** **57/57 tests passing across all 18 test suites** (`npm test` in `backend/`, execution time: ~2.28s).  
**Build Status:** Backend `tsc && prisma generate` (exit code `0`), Frontend `vite build` (exit code `0`).

---

## 1. What Has Been Built & Verified (Buckets 1, 2, and Hardening)

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

---

## 2. Inviolable Architectural Principles
1. **The Law of Surveillance Path Sovereignty:** The primary media plane (RTSP ingest, disk write, live view) has absolute priority. Background jobs (hashing, indexing, audit, export) must never starve the media engine.
2. **Single Physical RTSP Stream Invariant:** Only one RTSP connection is ever established to each physical camera. Internal consumers (scene change, thumbnailers) pull strictly from MediaMTX's localhost relay (`rtsp://127.0.0.1:8554/...`).
3. **Durable Bounded Queue:** Segment completion uses PostgreSQL `SegmentJob` with `UNIQUE(tenantId, segmentPath)` and bounded concurrency = 2.
4. **Time-Leased Evidence Pins:** Segments are protected by `EvidencePin` leases with auto-expiry and admission control; boolean flags are forbidden.
5. **Monotonic Clock Floor:** Appliance clock evaluates $\max(T_{\text{system}}, T_{\text{license}}, T_{\text{latest\_audit}})$ to defeat CMOS battery resets or clock rollback.

---

## 3. The Next Target: Bucket 3 (Core VMS Surveillance Operations)

In the new chat session, we will implement **Bucket 3**, which adds the core operational features that transform VigilOne into a complete commercial VMS product (inspired by Milestone XProtect, Nx Witness, and Frigate):

### Specification for Bucket 3 Modules:
1. **Weekly Recording Schedule Matrix (7-day x 24-hour Grid):**
   - Database model: `RecordingSchedule` (weekly matrix storing mode per hour for Monday through Sunday).
   - Modes: `CONTINUOUS`, `MOTION_ONLY`, `OFF`.
   - Scheduler service: Evaluates active mode every minute and commands MediaMTX recording on/off dynamically.
   - Frontend UI: Interactive 7x24 grid painter in Camera Settings allowing operators to click/drag hours.
2. **Motion Detection Inclusion Zones & Exclusion Masks:**
   - Database model: `DetectionZone` (`polygonCoordinates: Array<{x: number, y: number}>`, `type: INCLUSION | EXCLUSION`, `name: string`).
   - Frontend UI: Interactive canvas overlay on the camera player allowing operators to draw polygon masks (e.g. ignore swaying trees or public streets).
   - Motion filter: Evaluates motion bounding boxes against polygons before triggering episodes.
3. **PTZ Presets & Automated Guard Tour Patrol:**
   - ONVIF PTZ Integration: `GetPresets`, `SetPreset`, `GotoPreset`, `RemovePreset`.
   - Database model: `PtzPreset` and `PtzTour` (sequence of presets with dwell time in seconds).
   - Guard Tour Service: Background tour loop cycling camera between presets, pausing for dwell time, and returning to home on operator intervention.
   - Frontend UI: PTZ preset buttons, tour creator modal, and joystick control overlay.
4. **Custom Layouts & Multi-View Tour Manager:**
   - Database model: `Layout` (grid type `1x1`, `2x2`, `3x3`, `1+5`, `4x4`, cell-to-camera mappings, role sharing).
   - Layout Tour: Auto-cycling through saved views every 15–60 seconds in the control room.
   - Frontend UI: Layout dropdown selector, "Save Current View", and "Start Layout Tour" fullscreen toggle.
5. **Stream Diagnostic Inspector & Quality Watchdog:**
   - Real-time stream telemetry: Probe active FPS, incoming bitrate (kbps), video codec, audio codec, and keyframe (GOP) interval.
   - Frontend UI: Technical diagnostic drawer on each camera cell in the live view grid.
