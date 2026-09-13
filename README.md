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
> The following subsystems exist in the codebase as architectural stubs or future modules, but are **NOT operational in v1.0.0**. Do not deploy them in production or present them to clients as working features:
>
> 1. **ANPR / License Plate Recognition:** **OUT OF SCOPE FOR V1**. No frame-level computer vision or OCR inference engine is attached. The codebase contains only watchlist matching algorithms and a synthetic test endpoint.
> 2. **Multi-Site Federation:** **OUT OF SCOPE FOR V1**. While local Ed25519 pairing exists, no outbound HTTP/network client exists to sync data between appliances across WAN.
> 3. **S3 / Offsite Cloud Archive:** **OUT OF SCOPE FOR V1**. No AWS SDK or cloud storage client exists. All offsite archive attempts throw and fail closed. Evidence must be exported locally.
> 4. **Email Notifications:** **OUT OF SCOPE FOR V1**. SMTP dispatch is disabled (501). Supported alert channels for v1 are HTTP webhooks and Slack.
> 5. **Physical Relay / Access Control Integration:** **OUT OF SCOPE FOR V1**. No physical hardware driver (GPIO / serial / Modbus) is attached. Relay commands will fail closed with `NO_PHYSICAL_RELAY_DRIVER_ATTACHED`.
> 6. **Enterprise SSO (OIDC / SAML):** **OUT OF SCOPE FOR V1**. Hard-disabled (501). Authentication uses local cryptographic credentials.

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
3. Fill in your Facility Name, Administrator Email, Password, and the `SETUP_TOKEN` from your `.env` file (`vigilone_dev_setup_token_99182`).
4. Click **Bootstrap First-Run Tenant** to initialize the surveillance console with an automatic Enterprise evaluation license.

---

## 4. Third-Party Licenses & Commercial Boundaries

VigilOne enforces a strict Software Bill of Materials (SBOM) policy:
- The proprietary application codebase (`backend/`, `frontend/`) imports **strictly MIT, Apache-2.0, and BSD** dependencies.
- Copyleft **AGPL-3.0** (e.g. Ultralytics YOLO, OpenALPR) and **GPL** (e.g. ZoneMinder, Bluecherry core) are excluded from proprietary application modules.
- FFmpeg is executed strictly as a standalone operating system subprocess (`child_process.spawn()`). GPL obligations for the shipped binary (`libx264`) are fulfilled with source offers and license terms detailed in `THIRD_PARTY_LICENSES.md`.

---

## 5. Next Steps: Cloud Pilot & Physical Hardware Roadmap

All software engineering gates through Stage 5 are 100% complete and verified (77 test suites passing, clean builds, live container DR drill passed). The system is ready for real-world deployment validation:

- **Track 1: Google Cloud VM Deployment** — Test the single-command turnkey installer (`deploy/packaging/install.sh --unattended`) on a fresh Ubuntu 22.04/24.04 LTS VM, configure Caddy HTTPS, and complete the browser bootstrap wizard.
- **Track 2: 1–4 Physical Camera Bench Canary** — Connect real physical IP cameras (Hikvision, Dahua, CP Plus, ONVIF) over a local PoE switch to test ONVIF discovery, PTZ controls, real Ethernet RTSP transport, and network disconnect recovery.
- **Track 3: Supervised Customer Pilot** — Commission the first production site using the documented [Technician SOP](docs/operations/TECHNICIAN_SOP_AND_INSTALLATION_MANUAL.md) and [Acceptance Checklist](docs/operations/INSTALLATION_ACCEPTANCE_CHECKLIST.md).

For complete step-by-step procedures and commands, see:  
📘 **[`docs/operations/NEXT_STEPS_PILOT_AND_HARDWARE_ROADMAP.md`](docs/operations/NEXT_STEPS_PILOT_AND_HARDWARE_ROADMAP.md)**

