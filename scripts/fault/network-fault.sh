#!/usr/bin/env bash
# Drill: network drop or degradation on the camera-facing interface (tc netem).
#   network-fault.sh drop      100% loss for DROP_SECONDS, then restore
#   network-fault.sh latency   NETEM_DELAY (300ms) +/- NETEM_JITTER (50ms), NETEM_LOSS (1%) for DEGRADE_SECONDS
# Invariants: drop: recording resumes within RESUME_LIMIT s of restore and live view returns;
#             latency: no recording gap > GAP_LIMIT s during the degraded window.
# Env: IFACE (camera-facing NIC; lo for the local rig), CAMERA_PATH, RECORDINGS_DIR. Needs root.
DRILL_NAME="network-${1:-drop}"; source "$(dirname "$0")/common.sh"
require_env IFACE CAMERA_PATH RECORDINGS_DIR; require_cmd tc node; require_root
RESUME_LIMIT="${RESUME_LIMIT:-60}"; GAP_LIMIT="${GAP_LIMIT:-5}"
restore() { tc qdisc del dev "$IFACE" root 2>/dev/null || true; }
trap 'restore; finish' EXIT

case "${1:-drop}" in
  drop)
    DROP_SECONDS="${DROP_SECONDS:-30}"
    tc qdisc add dev "$IFACE" root netem loss 100% || { check NOT_VERIFIED netem "tc netem unavailable on $IFACE"; exit; }
    log "dropping all traffic on $IFACE for ${DROP_SECONDS}s"; sleep "$DROP_SECONDS"; restore; t_on="$(epoch)"
    if waited="$(wait_for "$RESUME_LIMIT" recording_active_since "$t_on")"; then check PASS recording-resumes "resumed ${waited}s after network restore (limit ${RESUME_LIMIT}s)"; else check FAIL recording-resumes "not resumed within ${RESUME_LIMIT}s"; fi
    if waited="$(wait_for "$RESUME_LIMIT" live_view_readable)"; then check PASS live-view "readable ${waited}s after restore"; else check FAIL live-view "not readable within ${RESUME_LIMIT}s"; fi ;;
  latency)
    DEGRADE_SECONDS="${DEGRADE_SECONDS:-60}"
    tc qdisc add dev "$IFACE" root netem delay "${NETEM_DELAY:-300ms}" "${NETEM_JITTER:-50ms}" loss "${NETEM_LOSS:-1%}" || { check NOT_VERIFIED netem "tc netem unavailable on $IFACE"; exit; }
    t0="$(epoch)"; sleep "$DEGRADE_SECONDS"; t1="$(epoch)"; restore; sleep "$((SEGMENT_SECONDS + 5))"
    gap="$(max_gap_seconds "$t0" "$t1" 1)"
    if node -e "process.exit($gap <= $GAP_LIMIT ? 0 : 1)"; then check PASS no-gap-under-degradation "max gap ${gap}s (limit ${GAP_LIMIT}s)"; else check FAIL no-gap-under-degradation "max gap ${gap}s (limit ${GAP_LIMIT}s)"; fi ;;
  *) log "usage: $0 drop|latency"; exit 2 ;;
esac
