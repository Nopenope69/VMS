# VigilOne VMS — Next Steps: Cloud Pilot & Physical Hardware Roadmap

> **Current Milestone:** Pre-Pilot Lab Complete — Ready for Supervised Pilot  
> **Software Status:** CI Automated Suite Verified (GitHub Actions), Clean Builds, Real Container DR Verified  
> **Target Goal:** Validation on Live Compute (GCP VM) & Physical Camera Hardware Bench  

---

## 1. Executive Summary & Progression Path

All software-level engineering gates, container disaster recovery drills, core routes, and cryptographic evidence chains are fully implemented and verified in the automated lab environment. The next phase transitions VigilOne from code-level verification to **live compute validation and physical camera burn-in**:

```
┌───────────────────────────────────────┐
│ Track 1: Google Cloud VM Drill        │ ──► Verify turnkey installer, Caddy HTTPS,
│ (Live Remote Compute Deployment)      │     and first-run browser bootstrap in cloud.
└───────────────────────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│ Track 2: 1–4 Camera Physical Canary   │ ──► Wire real IP cameras (Hik/Dahua/CP Plus)
│ (Hardware & Network Burn-In Bench)    │     over PoE; test ONVIF, PTZ, and RTSP jitter.
└───────────────────────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│ Track 3: Supervised Customer Pilot    │ ──► Commission first production site using
│ (Stage 6 Commercial Acceptance)       │     Technician SOP & 30-day continuous run.
└───────────────────────────────────────┘
```

---

## 2. Track 1: Google Cloud VM Deployment Guide

Testing the turnkey single-command installer on a fresh Google Cloud VM validates unattended provisioning, Docker orchestration, and browser onboarding on a pristine Linux host.

### 2.1 Recommended VM Specifications
- **Operating System:** Ubuntu 22.04 LTS or Ubuntu 24.04 LTS (x86_64 / AMD64)
- **Machine Type:** `e2-standard-2` (2 vCPU, 8 GB RAM) or `e2-standard-4` (4 vCPU, 16 GB RAM)
- **Boot Disk:** 30 GB - 50 GB standard persistent disk or SSD
- **VPC Firewall Rules:** In GCP Console (**VPC network $\to$ Firewall**), ensure ingress is allowed for:
  - `TCP 80 & 443` — Web UI & API Gateway (Caddy HTTPS)
  - `UDP 8189` — WebRTC WHEP media egress (sub-500ms live stream)
  - `TCP 8889` — WebRTC WHEP signaling
  - `TCP 8554` — RTSP ingest port (if publishing streams from outside)

### 2.2 Installation Procedure
SSH into the GCP instance and run:

```bash
# 1. Update package manager and ensure git is installed
sudo apt-get update && sudo apt-get install -y git

# 2. Clone the repository
git clone https://github.com/Nopenope69/VMS.git
cd VMS

# 3. Execute the turnkey installer in unattended mode
# Automatically detects external IP for Caddy and CORS binding:
VM_EXTERNAL_IP=$(curl -s ifconfig.me)
sudo ./deploy/packaging/install.sh --unattended --lan-ip "$VM_EXTERNAL_IP"
```

### 2.3 Automated Installer Actions
During execution, `install.sh` will automatically:
1. Verify system requirements (provisions a 4 GB emergency swapfile if RAM < 8 GB).
2. Install official Docker Engine and Docker Compose v2.
3. Generate 256-bit CSPRNG secrets (AES-256-GCM vault key, JWT secret, DB password, Coturn secret).
4. Generate a one-time 24-hour **Technician Setup PIN** at `/etc/vigilone/setup-token.txt`.
5. Build and launch the containers (`caddy`, `backend`, `postgres`, `mediamtx`).
6. Deploy Prisma database migrations and verify a 45-second health probe.

### 2.4 First-Run Web Bootstrap
Once the installer completes, open your browser:
1. Navigate to `https://<YOUR_VM_EXTERNAL_IP>`.
2. Accept the self-signed TLS certificate prompt.
3. Enter the **Setup PIN** from `/etc/vigilone/setup-token.txt` (`sudo cat /etc/vigilone/setup-token.txt`).
4. Set the initial Administrator email and password.
5. The VigilOne Monitoring Dashboard will load.

### 2.5 Ingesting Camera Streams into the Cloud VM
To test video ingestion and playback on the cloud VM:

- **Approach A: Local Test Stream (Direct RTSP push via ffmpeg)**:
  Push an RTSP test video stream from your local workstation to the cloud VM:
  ```bash
  ffmpeg -re -f lavfi -i testsrc=size=1920x1080:rate=25 \
    -c:v libx264 -preset ultrafast -tune zerolatency \
    -f rtsp rtsp://<YOUR_VM_EXTERNAL_IP>:8554/cam1
  ```
  In the VigilOne Web UI, add the camera with RTSP URL: `rtsp://mediamtx:8554/cam1`.

- **Approach B: Private Mesh Network (Tailscale)**:
  Install Tailscale on both the GCP VM and your local network where physical cameras reside. VigilOne can then discover and stream directly from physical cameras using their private IP addresses (e.g., `rtsp://192.168.1.120:554/stream1`).

---

## 3. Track 2: 1–4 Physical Camera Bench Canary

Before building a 64-camera rack, a controlled bench test with **1 to 4 physical IP cameras** validates real-world hardware integration:

### 3.1 Hardware Configuration
- **Cameras:** 1 to 4 physical IP cameras from primary supported vendors:
  - Hikvision (e.g., DS-2CD series)
  - Dahua (e.g., IPC-HFW / IPC-HDW series)
  - CP Plus (e.g., CP-UNC series)
  - Generic ONVIF Profile S camera
- **Network:** Connected via a dedicated 4-port / 8-port PoE switch isolated on a camera VLAN.

### 3.2 Key Validation Objectives
1. **ONVIF Discovery & Authentication:** Test camera onboarding via ONVIF probe; verify stream URI resolution and credential embedding.
2. **Native MediaMTX Ingestion:** Confirm RTSP transport over TCP; verify continuous fMP4 chunk generation on disk.
3. **Low-Latency Live View:** Verify sub-500ms WebRTC (WHEP) grid playback in browser.
4. **Timeline Seeking & Scrubbing:** Let cameras record for 1 hour; test timeline scrubbing and seek accuracy across segment boundaries.
5. **PTZ Control:** If PTZ-capable, verify continuous move, stop, and preset management.
6. **Physical Disconnect Drill:** Unplug camera Ethernet cable for 30 seconds:
   - Confirm `CameraConnectionManager` detects disconnect and transitions to backoff.
   - Reconnect cable; confirm auto-reconnect completes in $\le 15$ seconds.
   - Confirm recording resumes with gap logged in catalog.

---

## 4. Track 3: Supervised Customer Pilot (Stage 6)

Once Tracks 1 and 2 are validated, the appliance enters **Stage 6: Controlled Pilot**:

1. **Pre-Deployment Checklist:** Complete [`docs/operations/INSTALLATION_ACCEPTANCE_CHECKLIST.md`](./INSTALLATION_ACCEPTANCE_CHECKLIST.md).
2. **Technician Commissioning:** Deploy on site using [`docs/operations/TECHNICIAN_SOP_AND_INSTALLATION_MANUAL.md`](./TECHNICIAN_SOP_AND_INSTALLATION_MANUAL.md).
3. **Customer Handover:** Execute credentials handover using [`docs/operations/CUSTOMER_HANDOVER_PROCEDURE.md`](./CUSTOMER_HANDOVER_PROCEDURE.md).
4. **30-Day Soak:** Monitor appliance under live site conditions for 30 consecutive days with zero unrecoverable footage loss.
5. **Support & Maintenance:** Utilize [`docs/operations/SUPPORT_ESCALATION_PROCEDURE.md`](./SUPPORT_ESCALATION_PROCEDURE.md) and `vigilonectl support-bundle` for privacy-sanitized diagnostics.
