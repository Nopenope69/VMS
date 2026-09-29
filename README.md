# VigilOne VMS — Commercial Edge-First Video Management System

VigilOne is a vendor-neutral, commercial CCTV Video Management System (VMS) engineered as an **autonomous edge appliance**. Built for commodity IP cameras (Hikvision, Dahua, CP Plus, Generic ONVIF), it guarantees that **an internet outage never causes a CCTV or monitoring outage**.

---

## 1. Architectural Foundation & Separation of Concerns

```
                      OPERATOR BROWSER / CLIENT WORKSTATION
                           (Local LAN: Chrome / Firefox / Safari)
                                    │               │
                    Port 80 / 443   │               │ UDP/TCP Port 8189
                   (HTTP/S + WHEP)  │               │ (WebRTC ICE Media)
                                    ▼               ▼
                          ┌──────────────────┐  ┌──────────────────┐
                          │   CADDY GATEWAY  │  │     MEDIAMTX     │
                          │ (Reverse Proxy)  │  │  (WebRTC Engine) │
                          └────────┬─────────┘  └──────────────────┘
                                   │ (Docker Internal Bridge Network)
         ┌─────────────────────────┼─────────────────────────┐
         ▼                         ▼                         ▼
  ┌──────────────┐          ┌──────────────┐          ┌──────────────┐
  │ FRONTEND SPA │          │ BACKEND API  │          │   MEDIAMTX   │
  │   (Static)   │          │  (:4000)     │          │   (:8889)    │
  └──────────────┘          └──────┬───────┘          └──────┬───────┘
                                   │                         │
                                   │ :9997 (Docker Private)  │ RTSP Ingest
                                   └────────────────────────►│
                                                             ▼
                                                    CCTV / RTSP CAMERA
```

### Core Architectural Principles
1. **MediaMTX as the Media Engine:** Ingests camera streams strictly via RTSP. Demuxes and distributes on-the-fly to **WebRTC (WHEP)** for sub-500ms low-latency monitoring and **HLS** for mobile fallback. Segments streams into crash-resilient fragmented MP4 (`fmp4`) files on local storage.
2. **VigilOne Control Plane (Node.js/TS):** Handles ONVIF discovery (WS-Discovery + manual IP probe), encrypted credential storage (AES-256-GCM), vendor quirks, PTZ control, dynamic path orchestration, and recording metadata indexing.
3. **Caddy Single HTTP(S) Gateway:** Terminates port 80/443, proxying REST API (`/api/*`), WebRTC WHEP signaling (`/whep/*`), and HLS (`/hls/*`) under a single origin to eliminate CORS and runtime configuration bugs.
4. **Dedicated WebRTC ICE Port:** Dedicated media transport on UDP port `8189` (with TCP fallback) for robust LAN streaming.
5. **Unified Streaming Security:** MediaMTX delegates all read/playback requests to the backend via HTTP Webhook (`/api/v1/media/auth`) using short-lived Bearer tokens. Control API (port `9997`) is locked to the internal Docker network.
6. **Section 63 BSA Evidence Package Generator:** Produces tamper-evident electronic evidence archives with Section 63 BSA compliance reporting and statutory Part A & Part B certification workflows under Section 63 of the Bharatiya Sakshya Adhiniyam, 2023 (BSA / formerly 65B IEA) containing SHA-256 manifests, Ed25519 appliance digital signatures, and human signatory declarations.
7. **Offline Ed25519 Commercial Licensing:** Enforces camera limits, subscription expiry, and feature gating with an inviolable surveillance continuity invariant: licensing checks never disrupt live view or existing recordings.
8. **Tamper-Evident Audit Event Hash Chain:** Links all audit records cryptographically (`eventHash = SHA256(prevHash + eventData)`), proving mathematical immutability for compliance and legal scrutiny.

---

## 2. Commercial V1 Shipping Scope & Explicit Boundaries

VigilOne v1.0.0 is strictly scoped as a self-contained, rock-solid **Edge NVR Appliance**. To ensure absolute operational reliability and prevent misleading commercial claims, feature boundaries are frozen as follows:

### Supported V1 Commercial Scope (Production Ready):
- **Live Multi-Camera View:** Low-latency WebRTC (WHEP) sub-500ms streaming with HLS fallback via MediaMTX.
- **Continuous & Scheduled Recording:** Fragmented MP4 (`fmp4`) chunked recording with crash-resilient metadata.
- **Playback & Timeline Seeking:** Time-indexed playback, 24h timeline scrubbing, and gap detection (>15s).
- **Hashed Local Evidence Export (Section 63 BSA):** Cryptographically bound export archives with SHA-256 Merkle trees, detached Ed25519 appliance digital signatures, unbroken chain-of-custody ledger, and statutory Schedule Part A & B certificate templates.
- **Role-Based Access Control (RBAC):** Enforced roles (`SUPER_ADMIN`, `TENANT_ADMIN`, `OPERATOR`, `VIEWER`), tenant boundaries, and immutable audit logging.
- **Commercial Offline Licensing:** Ed25519 signed license certificates with camera quota limits and non-disruptive continuity invariant (live view never cut on expiration).
- **Turnkey Appliance Installer & Maintenance:** Single-command installer (`install.sh`), disk partitioning/Mount Guard, and CLI management (`vigilonectl`).

### Explicitly OUT-OF-SCOPE for V1 (Do Not Deploy / Market as Functional):
> [!WARNING]
> The subsystems below exist in the codebase but are **not field-proven**. Each sits behind a feature flag that is **OFF by default**: its API answers `501` with code `FEATURE_DISABLED`, its background workers do not start, and the operator console hides it. Do not enable them in production or present them to clients as working features.

<!-- FEATURE_FLAGS:START (generated by backend/scripts/ci/generate-feature-flag-docs.ts; do not edit by hand) -->
| Subsystem | Default | Enable with | What is real today |
| --- | --- | --- | --- |
| Multi-site federation | OFF (501 `FEATURE_DISABLED`) | `VIGILONE_FEATURE_FEDERATION=true` | Pairing, control-tunnel protocol and sync engine exist; no outbound WAN client runs, so appliances do not sync across sites. |
| S3 / object-storage archive | OFF (501 `FEATURE_DISABLED`) | `VIGILONE_FEATURE_OBJECT_STORAGE_ARCHIVE=true` | Scheduling and checksum logic exist; no S3 client is attached and uploads fail closed. |
| Enterprise SSO (OIDC) | OFF (501 `FEATURE_DISABLED`) | `VIGILONE_FEATURE_OIDC_SSO=true` | OIDC/PKCE service exists but has not been validated against a real identity provider. |
| DI/DO relays and access-control I/O | OFF (501 `FEATURE_DISABLED`) | `VIGILONE_FEATURE_DIO_RELAY=true` | Handshake state machine exists; no GPIO/serial/Modbus driver is attached (NO_PHYSICAL_RELAY_DRIVER_ATTACHED). |
| ANPR / licence-plate recognition | OFF (501 `FEATURE_DISABLED`) | `VIGILONE_FEATURE_ANPR=true` | Plate reads come from the anpr-worker (PP-OCRv4 detection + fast-plate-ocr, candidate models needing a human licence approval) on cameras in LPR mode; accuracy on Indian site data is not measured yet. |
| Video redaction | OFF (501 `FEATURE_DISABLED`) | `VIGILONE_FEATURE_REDACTION=true` | Jobs verify the source hashes, detect faces/plates through the redaction adapter (candidate models needing a human licence approval), burn opaque masks with ffmpeg, verify and hash the derivative and record it in chain of custody. Recall on site footage is not measured. |
| Smart search | OFF (501 `FEATURE_DISABLED`) | `VIGILONE_FEATURE_SMART_SEARCH=true` | Plain SQL over DetectionEvent rows; there is no embedding or semantic search yet. |
| Floorplans | OFF (501 `FEATURE_DISABLED`) | `VIGILONE_FEATURE_FLOORPLANS=true` | Floorplan CRUD and FOV projection exist; not validated on a real site. |
| Camera-native events (ONVIF, Hikvision, Dahua) | OFF (501 `FEATURE_DISABLED`) | `VIGILONE_FEATURE_CAMERA_EVENTS=true` | ONVIF PullPoint, Hikvision ISAPI and Dahua event clients are tested against local protocol stubs and published formats, not yet against physical cameras. |
| Alarm explanations | OFF (501 `FEATURE_DISABLED`) | `VIGILONE_FEATURE_EXPLANATIONS=true` | Each new alarm gets a template-generated "why was this flagged" record (explain-template.v1, no model), stored and written into evidence packages as explanations.json, where vigilone-verify re-renders and checks it. A failure is audited and logged and never blocks the alarm. Tested on the real database; not yet exercised on a live site. |
| Object crop capture | OFF (501 `FEATURE_DISABLED`) | `VIGILONE_FEATURE_OBJECT_CROPS=true` | Crops (a JPEG the ai-worker attaches when AI_ATTACH_CROPS is on, or a cut from a detection's snapshot image) are stored in CROPS_DIR with a hash, a free-space floor and a hold-aware retention purge. Person crops need a per-site switch with a recorded purpose and are off by default. Not exercised on a live camera site. |
| Semantic crop search | OFF (501 `FEATURE_DISABLED`) | `VIGILONE_FEATURE_SEMANTIC_SEARCH=true` | Crop embeddings are stored in pgvector and searched by example (a stored crop or a vector); results are audited and person crops are purpose-limited. There is no embedding model yet (the SigLIP 2 adapter and text queries are not built), so nothing is embedded until an adapter is configured, and retrieval quality on site data is not measured. |
<!-- FEATURE_FLAGS:END -->

Also out of scope for v1 and not behind a flag: **email notifications** (SMTP dispatch answers 501; supported alert channels are HTTP webhooks and Slack).

---

## 3. Quick Start (Local Deployment)

### Prerequisites
- Docker Engine 24+ & Docker Compose v2
- Port `80`, `443`, and `8189` (UDP/TCP) available (RTSP `8554` is internal only)

### Launch Edge Appliance
```bash
# 1. Clone repository
git clone https://github.com/your-org/vigilone-vms.git
cd vigilone-vms

# 2. Configure environment
cp .env.example .env

# 3. Start the edge appliance stack (including test synthetic camera)
docker compose --profile test up -d
```

### Initial Bootstrap & Access
1. Open your browser to `http://localhost` (or the host's LAN IP).
2. Click **Initial Appliance Setup / First-Run Bootstrap**.
3. Fill in your Facility Name, Administrator Email, a strong Password of your choosing, and the appliance `SETUP_TOKEN`. The installer generates it (`openssl rand -hex 16`) and stores it in `/etc/vigilone/setup-token.txt` (mode 0600); for a local development stack, set `SETUP_TOKEN` in `.env` or read the ephemeral token the backend logs at startup. There is no default token or password.
4. Click **Bootstrap First-Run Tenant** to initialize the surveillance console with an automatic Enterprise evaluation license.

---

## 4. Third-Party Licenses & Commercial Boundaries

VigilOne enforces a strict Software Bill of Materials (SBOM) policy:
- The proprietary application codebase (`backend/`, `frontend/`) imports **strictly MIT, Apache-2.0, and BSD** dependencies.
- Copyleft **AGPL-3.0** (e.g. Ultralytics YOLO, OpenALPR) and **GPL** (e.g. ZoneMinder, Bluecherry core) are excluded from proprietary application modules.
- FFmpeg is executed strictly as a standalone operating system subprocess (`child_process.spawn()`). GPL obligations for the shipped binary (`libx264`) are fulfilled with source offers and license terms detailed in `THIRD_PARTY_LICENSES.md`.

---

## 5. Next Steps: Cloud Pilot & Physical Hardware Roadmap

Current test and build status is generated by CI (see [`docs/generated/TEST_STATUS.md`](docs/generated/TEST_STATUS.md) once the first master run has committed it) and the agent's verified session log is in [`docs/STATUS.md`](docs/STATUS.md). The system has **not** yet run on real cameras; the next step is real-world validation:

- **Track 1: Google Cloud VM Deployment** — Test the single-command turnkey installer (`deploy/packaging/install.sh --unattended`) on a fresh Ubuntu 22.04/24.04 LTS VM, configure Caddy HTTPS, and complete the browser bootstrap wizard.
- **Track 2: 1–4 Physical Camera Bench Canary** — Connect real physical IP cameras (Hikvision, Dahua, CP Plus, ONVIF) over a local PoE switch to test ONVIF discovery, PTZ controls, real Ethernet RTSP transport, and network disconnect recovery.
- **Track 3: Supervised Customer Pilot** — Commission the first production site using the documented [Technician SOP](docs/operations/TECHNICIAN_SOP_AND_INSTALLATION_MANUAL.md) and [Acceptance Checklist](docs/operations/INSTALLATION_ACCEPTANCE_CHECKLIST.md).

For complete step-by-step procedures and commands, see:  
📘 **[`docs/operations/NEXT_STEPS_PILOT_AND_HARDWARE_ROADMAP.md`](docs/operations/NEXT_STEPS_PILOT_AND_HARDWARE_ROADMAP.md)**

