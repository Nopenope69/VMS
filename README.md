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
6. **Section 63 BSA Evidence Package Generator:** Produces court-ready electronic evidence archives under Section 63 of the Bharatiya Sakshya Adhiniyam, 2023 (BSA / formerly 65B IEA) containing SHA-256 manifests, Ed25519 appliance digital signatures, and pre-populated statutory Part A & Part B PDFs.
7. **Offline Ed25519 Commercial Licensing:** Enforces camera limits, subscription expiry, and feature gating with an inviolable surveillance continuity invariant: licensing checks never disrupt live view or existing recordings.
8. **Tamper-Evident Audit Event Hash Chain:** Links all audit records cryptographically (`eventHash = SHA256(prevHash + eventData)`), proving mathematical immutability for compliance and legal scrutiny.

---

## 2. Module Implementation Status

| Subsystem / Module | Maturity Status | Technical Description |
| :--- | :--- | :--- |
| **Caddy Gateway & Single Origin** | **Verified in Repository** | Reverse proxies `/api/*`, `/whep/*`, `/hls/*`, and static SPA assets. |
| **MediaMTX Engine Integration** | **Verified in Repository** | REST path injection via internal API `:9997`; HTTP webhook media authentication. |
| **Streaming Security & Auth** | **Verified in Repository** | Short-lived Bearer tokens (60s validity) minted per camera; auto-refresh on reconnect. |
| **ONVIF Discovery & Control** | **Verified in Repository** | WS-Discovery multicast + manual IP probe + RFC1918 rate-limited subnet scan; PTZ ContinuousMove. |
| **Encrypted Credentials** | **Verified in Repository** | AES-256-GCM encryption at rest; appliance key management. |
| **Fragmented MP4 Recording** | **Verified in Repository** | 10-minute production segments (30s test segments), 1s part duration for crash-resilience. |
| **Recording Indexer & Sentinel** | **Verified in Repository** | Automated segment indexing, corrupted file quarantine heuristic, gap detection (>15s), and circular buffer purge. |
| **Section 63 BSA Evidence Engine** | **Verified in Repository** | `STREAM_COPY` (lossless) and `FRAME_ACCURATE` (libx264) export; SHA-256 manifest; Ed25519 signature; Part A & B PDFs. |
| **CCTV Operator UI Console** | **Verified in Repository** | 1x1, 2x2, 3x3, 1+5 grid layouts; OSD monospace clock; REC indicator; 24h canvas timeline scrubber. |
| **Offline Ed25519 Licensing Engine** | **Verified in Repository** | Signed artifact authority, camera quota meter, non-disruptive continuity invariant. |
| **Multi-Site Tenancy Boundaries** | **Verified in Repository** | Multi-facility isolation, per-site timezones, strict cross-tenant object access prevention. |
| **Permission-Based RBAC & Staff** | **Verified in Repository** | `SUPER_ADMIN`, `TENANT_ADMIN`, `OPERATOR`, `VIEWER` roles; in-app staff onboarding & account deactivation. |
| **Scene-Change Detection & Events** | **Verified in Repository** | FFmpeg scene-change probe, 60s debounce episode state machine, auto-recording, alarms console with acknowledge workflow. |
| **Tamper-Evident Audit Registry** | **Verified in Repository** | Cryptographic SHA-256 hash chaining on all operator actions with mathematical verification endpoint. |
| **Indian ANPR Microservice** | **Planned (Phase 4)** | MMDetection / LPRNet (Apache-2.0) + PaddleOCR + Indian state code parser. |
| **Remote WAN Tunneling & TURN** | **Planned (Phase 3)** | coturn STUN/TURN server + WireGuard/frp cloud connection. |

---

## 3. Quick Start (Local Deployment)

### Prerequisites
- Docker Engine 24+ & Docker Compose v2
- Port `80`, `443`, `8189` (UDP/TCP), and `8554` available

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
