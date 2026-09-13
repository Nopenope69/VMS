# On-Site Installation Acceptance Checklist & Sign-Off Protocol
**Document Reference:** `VIGILONE-CHK-ACCEPT-2026-V1`  
**Site Name / Project:** __________________________________________________  
**Customer Entity:** ____________________________________________________  
**Appliance Serial Number:** ____________________________________________  
**Deployment Date:** ____________________________________________________  
**Field Engineer Name:** ________________________________________________  

---

## 1. Objective Acceptance Gate Overview

An on-site installation of the VigilOne Edge NVR appliance is deemed **Accepted** only when all 30 objective verification items below have been validated, witnessed, and checked. Any single failure item constitutes a non-acceptance event requiring immediate technical remediation prior to customer sign-off.

---

## 2. 30-Point Verification Matrix

### Section A: Physical, Environmental & Electrical Rigor
- [ ] **A1. Chassis Mounting:** Appliance is securely mounted in 19-inch rack with 4x M6 screws; rails locked.
- [ ] **A2. Airflow & Clearance:** Minimum 1RU clear ventilation space maintained above and below chassis.
- [ ] **A3. Grounding Integrity:** Chassis earth ground lug is bonded to facility master ground bus (< 1 ohm resistance).
- [ ] **A4. Power Supply Redundancy:** Dual PSUs connected to separate power distribution circuits (PDU A + PDU B).
- [ ] **A5. UPS Battery Backing:** Both power inputs are backed by an on-line double-conversion UPS system.
- [ ] **A6. Cable Strain Relief:** Power and network patch cables are secured with hook-and-loop strain relief ties.

### Section B: Network Segregation & Firewall Hardening
- [ ] **B7. Dual Interface Physical Separation:** `eth0` is connected to Corporate/Viewing LAN; `eth1` is connected to Isolated CCTV Switch.
- [ ] **B8. Camera Subnet Isolation:** Subnet `192.168.10.0/24` has no default gateway and zero routing to public Internet.
- [ ] **B9. Port Exposure Verification:** `nmap` port scan against `eth0` shows only ports 80, 443, and 8189/udp accessible.
- [ ] **B10. Database Port Blocked:** Port 5432 (PostgreSQL) is strictly inaccessible from both `eth0` and `eth1`.
- [ ] **B11. Media Engine Internal Port Blocked:** Port 9997 (MediaMTX API) is strictly inaccessible externally.

### Section C: Storage Pool, Filesystem & Mount Guard
- [ ] **C12. Dedicated Pool Separation:** OS root partition (`/`) is isolated from CCTV recording pool (`/var/lib/vigilone/recordings`).
- [ ] **C13. Persistent Mount (`/etc/fstab`):** Storage drive is mounted via UUID with `noatime,nodiratime` options.
- [ ] **C14. Mount Guard Probe Token:** `/var/lib/vigilone/recordings/.vigilone-mount-probe` exists with valid timestamp.
- [ ] **C15. Active Probe Trip Test:** Simulating probe unavailability causes Mount Guard to trip in $\le 5$ seconds and raises an audible/visual alarm.
- [ ] **C16. Storage Accounting:** Storage utilization accurately reported in `vigilonectl status` and Web UI dashboard.

### Section D: Core Service Health & Container Orchestration
- [ ] **D17. Docker Stack Health:** `docker compose ps` shows all 4 core services (`caddy`, `backend`, `mediamtx`, `postgres`) healthy.
- [ ] **D18. Clean System Logs:** `vigilonectl logs` displays zero fatal exceptions, stack traces, or panics.
- [ ] **D19. Host Hardware Binding:** System machine-id and DMI board UUID correctly bound in `/etc/vigilone/clock_guard.state`.
- [ ] **D20. Monotonic Clock Enforcement:** Time synchronizes via local PTP/NTP server; ClockGuard floor active.

### Section E: Video Ingestion, Live Streaming & Archiving
- [ ] **E21. Multi-Camera Discovery:** All scheduled cameras are discovered and provisioned in the system.
- [ ] **E22. Live Stream Fluidity:** Web UI displays live RTSP/WebRTC streams with $< 500\text{ms}$ glass-to-glass latency.
- [ ] **E23. Continuous Segment Creation:** Recording segments are generated at exact 1-minute intervals.
- [ ] **E24. Filename UTC Timestamp Authority:** Segment timestamps match UTC file naming scheme (`YYYY-MM-DD_HH-mm-ss-ffffff`).
- [ ] **E25. Playback Timeline Scrubbing:** Timeline scrubber allows instant seek to arbitrary timestamps with smooth playback.
- [ ] **E26. Network Disconnect Resilience:** Disconnecting camera Ethernet drops feed; reconnecting resumes recording within 15 seconds.

### Section F: Forensic Export, Custody & Section 63 BSA Compliance
- [ ] **F27. Evidentiary Package Generation:** Exporting an evidence clip produces a valid `Evidence_<ID>.zip` archive.
- [ ] **F28. Cryptographic Chain Verification:** ZIP contains `manifest.json`, `manifest.sig`, `appliance_public_key.pem`, `chain_of_custody.json`, and `certificate_sec63.pdf`.
- [ ] **F29. Offline Signature Check:** `manifest.sig` successfully verifies against `manifest.json` using the bundled public key.
- [ ] **F30. Statutory Disclaimer Verification:** Generated PDF certificate contains non-certifying technical attestation wording under Section 63 BSA.

---

## 3. Handover & Sign-Off Certification

| Role | Name | Organization | Signature | Date |
|---|---|---|---|---|
| **Lead Field Engineer** | ____________________ | VigilOne / Certified Partner | ____________________ | ____________ |
| **Customer IT / Security Lead** | ____________________ | Client Enterprise | ____________________ | ____________ |

**Final Status:** [ ] ACCEPTED & COMMISSIONED &nbsp;&nbsp;&nbsp;&nbsp; [ ] CONDITIONAL ACCEPTANCE &nbsp;&nbsp;&nbsp;&nbsp; [ ] REJECTED (RE-INSPECTION REQUIRED)
