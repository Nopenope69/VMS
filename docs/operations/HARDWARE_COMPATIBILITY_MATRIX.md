# VigilOne Edge NVR — Commercial Hardware Compatibility Matrix
**Document Reference:** `VIGILONE-HCM-2026-V1`  
**Standard of Governance:** Strict Evidentiary Discipline — Components are marked *Validated Benchmark Baseline* only with explicit test evidence identifying the exact model, firmware baseline, and verified test results. All other hardware is categorized as *Reference Configuration (Requires On-Site Qualification)*, *Untested*, or *Not Supported*.  
**Release Target:** v1.0.0 Commercial Appliance Release  

---

## 1. Governance & Classification Definitions

To maintain absolute commercial integrity and prevent unsubstantiated vendor claims, all hardware evaluated for use with VigilOne Edge NVR is classified into four strict categories:

1. **Validated Benchmark Baseline:** The exact manufacturer, model, hardware revision, and firmware version physically or simulation-verified in Stage 2/3 and Stage 5 integration test envelopes.
2. **Reference Configuration (Requires On-Site Qualification):** Known enterprise/surveillance hardware matching architectural specifications, but requiring on-site acceptance testing prior to commercial commissioning.
3. **Untested:** Hardware matching generic interface standards (e.g. generic SATA drives or generic PoE switches) that has not undergone laboratory verification.
4. **Not Supported:** Hardware known to fail timing, reliability, or protocol compliance requirements.

---

## 2. Camera Compatibility Matrix

VigilOne utilizes native RTSP streaming over TCP/UDP and ONVIF Profile S/T discovery.

| Vendor | Model | Hardware Rev / Firmware | Classification | Stream Envelopes Verified | Test Reference |
|---|---|---|---|---|---|
| **Hikvision** | `DS-2CD2043G2-I` | V5.5.800 build 210628 | **Validated Benchmark Baseline** | 4MP H.264/H.265 @ 25fps, G.711u audio, ONVIF Profile S/T | Stage 2 Canary & Stage 3 Bench |
| **Dahua** | `IPC-HFW2431S-S-S2` | V2.820.0000000.12.R build 2021-07-23 | **Validated Benchmark Baseline** | 4MP H.264/H.265 @ 25fps, RTSP interleaving over TCP | Stage 3 Bench Cohort 2 |
| **CP Plus** | `CP-UNC-TA41L3` | V2.680.0000000.3.R build 2022-01-14 | **Validated Benchmark Baseline** | 4MP H.264 @ 20fps, ONVIF Profile S | Stage 3 Bench Cohort 3 |
| **Uniview** | `IPC2124SR3-DPF40` | V1.2.0 build 211115 | **Validated Benchmark Baseline** | 4MP H.265 @ 25fps, ONVIF Profile S/T | Stage 3 Bench Cohort 4 |
| **Axis** | M30 / P32 Series | Firmware 10.x+ | **Reference Configuration** | ONVIF Profile S/T compliant; requires site acceptance check | Architectural Baseline |
| **Hanwha** | Q Series / X Series | Firmware 2.x+ | **Reference Configuration** | ONVIF Profile S/T compliant; requires site acceptance check | Architectural Baseline |
| **Generic IP Cameras** | Unbranded / OEM | Variable | **Untested** | Untested; must pass `scripts/physical-camera-canary.sh` | On-Site Check Required |
| **Consumer Wi-Fi Cams** | Tuya, Ring, Blink | Cloud-tethered | **Not Supported** | Proprietary cloud protocols, no continuous RTSP | Protocol Incompatible |

---

## 3. Network Switches & Transmission Infrastructure

| Manufacturer | Model | Specification | Classification | Verification Notes |
|---|---|---|---|---|
| **Cisco** | Catalyst 2960X / 1000 Series | 24/48-Port PoE+ (370W), IGMP Snooping | **Validated Benchmark Baseline** | Stage 3 Soak Rig transmission switch baseline |
| **Aruba** | CX 6100 Series | 24-Port GbE PoE+ Class 4 (370W) | **Reference Configuration** | Fully compliant with IEEE 802.3at / 802.3af standards |
| **Ubiquiti** | UniFi Pro PoE 24 | 24-Port GbE PoE+ (400W) | **Reference Configuration** | Compliant; requires manual IGMP querier enablement |
| **Netgear** | ProSAFE GS728TP | 24-Port PoE+ Smart Switch | **Reference Configuration** | Compliant; standard GbE switching |
| **Unmanaged Switches** | Generic 10/100/1000 | No VLAN or IGMP support | **Not Supported** | Unmanaged switches cause broadcast storms under heavy multicast traffic |

---

## 4. Server Appliances & Host Processing Platforms

| Vendor | Model / Configuration | Processors & Memory | Classification | Validated Envelope |
|---|---|---|---|---|
| **Supermicro** | SuperServer 5019D-FN8TP | Intel Xeon D-2146NT (8C/16T), 32GB DDR4 ECC | **Validated Benchmark Baseline** | 64-channel 1080p25 H.264 benchmark workload |
| **Dell** | PowerEdge R250 / R350 | Intel Xeon E-2336 (6C/12T), 32GB DDR4 ECC | **Reference Configuration** | Sized for up to 64-channel concurrent ingestion |
| **Advantech** | MIC-770 V2 Modular Edge | Intel Core i7-10700E (8C/16T), 16GB DDR4 | **Reference Configuration** | Industrial fanless edge appliance specification |
| **Generic x86_64 PC** | Core i5+, 16GB RAM | Intel 8th Gen+, Non-ECC RAM | **Untested** | Functional for pilot benches; lacks IPMI / ECC |
| **ARM SBCs** | Raspberry Pi 4/5 | Broadcom BCM2711 | **Not Supported** | Insufficient I/O bandwidth and memory bandwidth for 64 cameras |

---

## 5. Storage Media (HDD & NVMe SSD)

| Manufacturer | Model Family | Technology | Classification | Verification Notes |
|---|---|---|---|---|
| **Western Digital** | WD Purple Pro (8TB - 18TB) | 7200 RPM, AllFrame AI, CMR | **Validated Benchmark Baseline** | Continuous 24/7 multi-stream write benchmark baseline |
| **Seagate** | SkyHawk AI (8TB - 16TB) | 7200 RPM, ImagePerfect AI, CMR | **Validated Benchmark Baseline** | Continuous 24/7 multi-stream write benchmark baseline |
| **Samsung** | PM9A3 (960GB - 3.84TB) | PCIe Gen4 x4 NVMe, Enterprise TLC | **Validated Benchmark Baseline** | OS, PostgreSQL database, and high-speed cache baseline |
| **Micron** | 7450 PRO (960GB - 3.84TB) | PCIe Gen4 NVMe, Enterprise TLC | **Reference Configuration** | Enterprise endurance rated for transactional database use |
| **Desktop HDDs** | WD Blue, Seagate Barracuda | SMR (Shingled Magnetic Recording) | **Not Supported** | SMR drives experience catastrophic write latency spikes during continuous CCTV streams, causing segment loss |

---

## 6. Sizing & Capacity Discipline

The following figures represent the **Laboratory Verified Capacity Envelopes** validated through automated test harnesses and the hardware soak simulator:

- **Verified Ingestion Workload:** 64 concurrent streams at 1080p @ 25fps (or 32 streams at 4K @ 15fps) using H.264/H.265.
- **Verified Storage Capacity Pool:** Up to 32TB tested in bench testing; 128TB is the documented architectural ceiling per storage volume.
- **Physical Calendar-Bound Field Soak:** Stage 3 software harness validation is complete; the physical multi-vendor 168-hour continuous camera soak remains **Field Validation Pending (0/168h evidenced)** until pilot completion.
