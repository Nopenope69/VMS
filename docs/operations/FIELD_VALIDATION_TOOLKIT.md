# Field validation toolkit (Phase 1)

Tools to prove the recorder on real hardware and under failure. Everything here writes JSON plus
markdown reports. Anything run against a non-camera source is labelled **SIMULATED** (file names,
headings, report fields) and never counts as field evidence.

Requirements on the machine running the tools: Node >= 20, ffmpeg/ffprobe, bash; root for the
network, disk and clock drills; Docker Compose access for `compose`-target drills.

| Tool | Plan item | What it does |
| --- | --- | --- |
| `scripts/bench/bench-camera.mjs` | P1.1 | Per-camera run: ONVIF probe, RTSP validation, N-second fMP4 record, ffprobe/decode integrity, SHA-256, seek test |
| `scripts/bench/update-matrix.mjs` | P1.1 | Regenerates the results table in `HARDWARE_COMPATIBILITY_MATRIX.md` from real-camera reports |
| `scripts/fault/*.sh` | P1.2 | Fault drills that assert invariants (see below) |
| `scripts/soak/soak-runner.mjs` | P1.3 | N-camera soak sampler and report (gaps, restarts, memory/CPU growth, disk growth, event-loop lag) |
| `vigilonectl acceptance` (`scripts/acceptance/acceptance.sh`) | P1.4 | Automated items of the installation checklist; manual items listed |
| `scripts/acceptance/verify-evidence-package.mjs` | P1.4 | Offline verification of an exported evidence package (digest, Ed25519 signature, every artifact hash) |
| `scripts/install-drill/clean-vm-install-drill.sh` | P1.5 | `install.sh --unattended` on a fresh Ubuntu 22.04/24.04 VM, then health, status and acceptance |
| `scripts/sim/sim-camera-rig.sh` | rehearsal | MediaMTX binary + ffmpeg test-pattern publishers (SIMULATED-CAMERAS) |

## Bench (P1.1)

```bash
node scripts/bench/bench-camera.mjs --source-kind camera --label "Gate cam (Hikvision)" \
  --onvif-host 192.168.10.21 --user admin --pass '<password>' --duration 600
node scripts/bench/update-matrix.mjs
git add docs/operations/bench-results docs/operations/HARDWARE_COMPATIBILITY_MATRIX.md
```

Pass rules: ONVIF probe answers (mandatory for `camera`), RTSP stream probes, the recording is at
least `duration - max(2 %, one keyframe interval + 1 s)` long (stream copy must start on a
keyframe), is fragmented MP4, decodes with zero errors, and every seek lands within
`max(2 s, 1.5 x longest keyframe interval)` of its target. Credentials are redacted from reports.

## Fault drills (P1.2)

Set `FAULT_TARGET=compose` (appliance stack) or `local` (rehearsal rig), plus `CAMERA_PATH`,
`RECORDINGS_DIR`, `SEGMENT_SECONDS`, `RESULTS_DIR`. Each check is PASS, FAIL, NOT_VERIFIED (could
not be checked on this target) or INFO/MANUAL. Exit code: 0 PASS, 1 FAIL, 3 INCONCLUSIVE.

| Drill | Invariants checked |
| --- | --- |
| `mediamtx-kill.sh` | recording resumes within 60 s of restart; live view readable; pre-kill segments still playable; outage gap measured |
| `abrupt-kill-mid-segment.sh` | the open segment loses at most the trailing sub-second fragment (limit 1.5 s) and decodes cleanly; recording resumes |
| `camera-poweroff.sh` | other cameras keep recording; the camera resumes within 60 s of power returning (`POWER_OFF_CMD`/`POWER_ON_CMD` for a PoE switch, or operator prompts) |
| `network-fault.sh drop` / `latency` | tc netem on `IFACE`: resume within 60 s after a drop; no gap > 5 s under 300 ms / 1 % loss |
| `postgres-kill.sh` (compose) | recording continues without the database; backend health recovers; pre-kill segment rows survive; outage segments are indexed by the reconciler |
| `backend-restart.sh` | recording never pauses; the segment open at crash time keeps its inode and keeps growing; no recorded bytes disappear |
| `disk-full.sh setup/run/teardown` | loop filesystem only (refuses real disks); live view survives; retention prunes (compose); EvidencePin'd files kept; recording resumes when space returns |
| `clock-jump.sh --confirm-host-clock-change` | recording continues through a wall-clock jump; health stays up; ClockGuard detection is NOT_VERIFIED until exposed via API |

## Soak (P1.3)

```bash
node scripts/soak/soak-runner.mjs --source-kind camera --duration 72h --interval 60s \
  --recordings-dir /var/lib/vigilone/recordings --metrics-url http://127.0.0.1:4000/metrics \
  --metrics-token "$METRICS_AUTH_TOKEN" --docker --warmup 1h --out docs/operations/soak-results/<date>-16cam
```

The report judges only what a soak can measure: no gap > 5 s per camera (PASS only if the run
covers >= 24 h, otherwise PASS_SHORT_RUN), and backend memory growth < 5 %/24 h after warm-up
(judged only on >= 6 h of post-warm-up samples; shorter windows are NOT_VERIFIED, never a guess).

## P1.6: what the human must do (HUMAN-REQUIRED)

1. Hardware: 4 cameras (one each Hikvision, CP Plus, Dahua, generic ONVIF) on a managed PoE switch;
   the reference mini-PC with a separate recordings disk; a clean Ubuntu 22.04/24.04 install.
2. Run `scripts/install-drill/clean-vm-install-drill.sh` on the appliance (P1.5) and commit the report.
3. Register the cameras in the UI. For each camera run the bench (600 s) and commit the reports
   and the regenerated matrix.
4. Run every fault drill with `FAULT_TARGET=compose` against a live camera; use real PoE port
   power commands for `camera-poweroff.sh`; run `disk-full.sh` on a spare loop-mounted recordings
   volume. Commit the reports from `RESULTS_DIR`.
5. Export one evidence clip per camera and run `vigilonectl acceptance <Evidence_x.zip>`.
6. Scale to 16 cameras and run the soak for 72 h. Commit `report.json`, `report.md` and
   `samples.jsonl`.
7. Record the measured values against the Phase 1 acceptance criteria in `docs/STATUS.md`.
