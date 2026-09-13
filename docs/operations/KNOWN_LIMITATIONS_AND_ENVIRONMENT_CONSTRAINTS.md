# Known Limitations, System Envelopes & Environment Constraints
**Document Reference:** `VIGILONE-DOC-LIMITS-2026-V1`  
**Applicability:** VigilOne Edge NVR Commercial Release v1.0.0  
**Status:** Approved Technical Disclosure  

---

## 1. Concrete System Envelopes & Validated Capacity Limits

The following boundaries define the tested and supported technical envelope for a single VigilOne Edge NVR appliance:

| Dimension | Architectural Limit | Laboratory Validated Baseline | Operational Recommendation |
|---|---|---|---|
| **Max Concurrent Camera Channels** | 64 Streams | 64 Streams @ 1080p25 H.264 | Up to 48 channels recommended for headroom on 8-core CPUs |
| **Max 4K Ingestion Channels** | 32 Streams | 32 Streams @ 4K15 H.265 | Dedicated NVMe write cache recommended for > 20 4K streams |
| **Max Bitrate per Channel** | 16 Mbps | 8 Mbps (1080p) / 12 Mbps (4K) | Configure cameras to VBR (Variable Bitrate) with medium quality |
| **Max Storage Capacity per Node** | 128 TB | 32 TB physical pool | JBOD or hardware RAID-5/6 pool across surveillance-grade HDDs |
| **Max Retention Window** | Unlimited (Disk bounded) | 90 days continuous @ 64ch | Configure retention quota in camera settings |
| **Simultaneous WebRTC Viewers** | 16 Concurrent Sessions | 8 Concurrent Sessions | Utilize Sub-Stream (D1/720p) for multi-camera grid viewing |

---

## 2. Strictly Non-Supported Environments & Topologies

Deploying the appliance in any of the following configurations is strictly **not supported** and voids the SLA warranty:

1. **Direct Public Internet Camera Exposure:** Connecting surveillance cameras to public routable IP addresses or directly through unshielded NAT without VPN or dedicated VLAN separation.
2. **Consumer Wi-Fi Cameras:** Battery-powered, proprietary cloud-tethered Wi-Fi cameras (e.g., Nest, Ring, Tuya) that do not provide continuous, deterministic RTSP streams.
3. **Dynamic Host Configuration Protocol (DHCP) on Appliance Host:** Using dynamic DHCP IP addressing on `eth0` or `eth1`. Network interfaces must have static IP assignments to ensure constant database and stream listener bindings.
4. **Shingled Magnetic Recording (SMR) Drives:** Using desktop SMR hard drives for video recording. Continuous multi-channel streaming requires CMR (Conventional Magnetic Recording) surveillance drives (WD Purple Pro, Seagate SkyHawk AI).
5. **Shared Host Workloads:** Running third-party software, virtualization hypervisors, cryptominers, or external web applications directly on the bare-metal appliance host.
6. **Unmanaged Network Switches:** Using switches without 802.1Q VLAN support, IGMP snooping, or adequate PoE power budgets.

---

## 3. Explicit v1 Scope Cuts (Deferred to v2)

In accordance with the [Master Commercialization Execution Contract](../audits/MASTER_COMMERCIALIZATION_EXECUTION_CONTRACT.md) and commercial review, VigilOne v1.0.0 is deliberately scoped to **core NVR functionality**: live view, continuous/scheduled recording, playback, hashed local evidence export, RBAC, licensing, and turnkey installer/upgrades.

The following capabilities are **explicitly OUT-OF-SCOPE for v1** and must not be marketed or deployed as functional:
- **ANPR / License Plate Recognition:** No frame-level OCR/inference engine exists. Watchlist algorithms exist for testing only.
- **Multi-Site Federation:** Local Ed25519 pairing exists, but no outbound HTTP/network sync client is implemented.
- **S3 / Offsite Cloud Archive:** No AWS/cloud SDK exists. Production calls fail closed. Evidence must be exported locally.
- **Email (SMTP) Notifications:** Disabled (501). Supported alert channels for v1 are webhooks and Slack.
- **Physical Relay / Access Control Hardware:** No physical hardware driver (GPIO/serial/Modbus) is attached. Commands fail closed with `NO_PHYSICAL_RELAY_DRIVER_ATTACHED`.
- **Enterprise Single Sign-On (SSO / OIDC / SAML):** Hard-disabled (501). v1 uses secure local cryptographic credentials.
