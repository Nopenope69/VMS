# VigilOne Commercial Edge Appliance — Resilience & Operational Failure Playbook

**Version:** 1.0 (Production Hardened)  
**Target Audience:** Field Operations, On-Premise System Engineers, CCTV Control Room SREs  
**Scope:** Edge hardware failures, power cuts, storage saturation, and network storms.

---

## 1. Scenario 1: Abrupt Power Cut & Unclean Engine Shutdown

### Failure Signature
- Appliance suffered hard AC power loss or kernel panic.
- MediaMTX daemon terminated abruptly mid-segment while recording continuous feeds.

### Resilience Invariants
1. **fMP4 Atom Continuity:** Recordings use fragmented MP4 (`fmp4`) with 1-second part durations. Power cuts truncate only the trailing incomplete sub-second fragment; all preceding fragments have self-contained `moof`/`mdat` headers and remain 100% playable.
2. **Boot Self-Healing (`StartupReconcilerService`):**
   - On appliance boot, the control plane queries PostgreSQL camera configurations and compares them against MediaMTX `/v3/paths/list`.
   - Any camera configured with `desiredRecorderState: RUNNING` that is missing from MediaMTX is automatically re-injected, and recording is commanded back on.
   - Any jobs left in `PROCESSING` status during the crash are reset to `PENDING` so the durable worker resumes hashing.

### Verification & Recovery Commands
```bash
# 1. Check container health status
docker compose ps

# 2. Inspect boot reconciliation log
docker compose logs backend | grep -i "StartupReconciler"

# 3. Probe the last recorded fMP4 segment for stream readability
ffprobe -v error -show_format -show_streams /recordings/cam_1/last_segment.mp4
```

---

## 2. Scenario 2: Storage Saturation & Evidence Pin Exhaustion

### Failure Signature
- Prometheus alert `StorageFreeSpaceWarning` (>85%) or `StorageFreeSpaceCritical` (>92%) fired.
- Or `PinnedStorageExhaustion`: Free space $< 50\text{ GB}$ while $>85\%$ of recordings are pinned by court evidence export leases.

### Automated System Behavior
1. **5-Tier Health State Machine:**
   - `AVAILABLE` ($\le 85\%$): Normal recording and indexing.
   - `WARNING` ($85\% - 92\%$): Warning logged to Prometheus metrics.
   - `EMERGENCY_PURGE` ($> 92\%$ or $< 30\text{ GB}$ free): StorageSentinel activates circular buffer purge, deleting oldest unpinned segments down to the hysteresis floor ($> 15\%$ free and $> 80\text{ GB}$ free).
   - `PINNED_STORAGE_EXHAUSTION`: StorageSentinel refuses to delete any segment with an unexpired `EvidencePin` lease.
2. **Admission Control:**
   - New evidence export requests are rejected with HTTP 507 (`STORAGE_PIN_EXHAUSTION`) to preserve the primary recording write path.

### Field Technician Remediation
```bash
# 1. Inspect storage metrics via curl
curl -s http://localhost:4000/metrics | grep vigilone_storage

# 2. Force manual expired lease sweep
# (EvidencePinManager automatically sweeps every 5m, but can be triggered manually)
docker compose exec backend node -e "
  const { EvidencePinManager } = require('./dist/services/storage/evidencePinManager.service');
  EvidencePinManager.reapExpiredLeases().then(console.log);
"

# 3. If pinned recordings are genuinely filling disk, mount an auxiliary storage volume:
# Edit docker-compose.yml to mount secondary disk at /recordings/archive
```

---

## 3. Scenario 3: PoE Switch Flap & 32-Camera Thundering Herd

### Failure Signature
- Core PoE switch rebooted or network link dropped.
- 32 cameras disconnected simultaneously and attempt reconnection at the exact same instant.

### Automated System Behavior
1. **Thundering-Herd Mitigation (`CameraConnectionManager`):**
   - Imposes a strict concurrency barrier: **Maximum 3 simultaneous ONVIF/RTSP handshakes**.
   - Applies exponential backoff with randomized jitter:
     $$T_{\text{wait}} = \min(60\text{s}, 2^{\text{retries}} \times 1\text{s}) + \text{random}(0, 3\text{s})$$
   - Disperses camera reconnect waves over a 30-to-90 second window, preventing Node.js event-loop or CPU thread saturation.
2. **Flapping Noise Suppression (`EventRateLimiter`):**
   - Dampens camera hardware motion triggers exceeding 1 trigger per 5 seconds, dropping sensor chatter.

### Field Technician Remediation
```bash
# 1. View live camera reconnect states
curl -s http://localhost:4000/metrics | grep vigilone_cameras_total

# 2. Inspect camera connection manager logs
docker compose logs backend | grep -i "CameraConnectionManager"
```

---

## 4. Scenario 4: CMOS Battery Failure & Clock Anti-Rollback

### Failure Signature
- Appliance RTC CMOS battery died during unpowered transit, resetting system time to `1970-01-01T00:00:00Z`.
- Or an operator deliberately attempted to roll back system clock to bypass commercial license expiry.

### Automated System Behavior
1. **Monotonic Floor Defense (`ClockGuard`):**
   - The appliance maintains a monotonic time floor:
     $$T_{\text{floor}} = \max(T_{\text{system}}, T_{\text{license\_issued}}, T_{\text{latest\_audit\_timestamp}}, T_{\text{build\_epoch}})$$
   - When $T_{\text{system}} < T_{\text{floor}} - 300\text{s}$, `ClockGuard` raises `CLOCK_SKEW_DETECTED`.
   - Licensing checks evaluate strictly against $T_{\text{floor}}$, preventing expired licenses from reactivating.
   - Audit hash chain rejects retroactive timestamps, preserving evidentiary validity.

### Field Technician Remediation
```bash
# 1. Check system clock vs hardware RTC
timedatectl status

# 2. Replace CR2032 CMOS battery on motherboard if time resets after power off.

# 3. Force NTP time synchronization
timedatectl set-ntp true
systemctl restart systemd-timesyncd
```
