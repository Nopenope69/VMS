#!/usr/bin/env bash
# Drill: wall-clock jump (forward or backward) on the appliance host.
# Invariants: recording continues through the jump; backend health stays up.
# ClockGuard skew detection is not exposed over the API yet, so that invariant is NOT_VERIFIED
# here (see docs/BACKLOG.md); check backend logs for CLOCK_SKEW_DETECTED manually.
# Usage: clock-jump.sh --confirm-host-clock-change [+2hours|-2hours]   (needs root; disable NTP first)
DRILL_NAME=clock-jump; source "$(dirname "$0")/common.sh"
[ "${1:-}" = --confirm-host-clock-change ] || { echo "This changes the host clock. Re-run with --confirm-host-clock-change [offset]"; trap - EXIT; rm -f "$CHECKS_TSV"; exit 2; }
require_root; require_env CAMERA_PATH RECORDINGS_DIR; require_cmd date node
OFFSET="${2:-+2hours}"
trap finish EXIT
mono0="$(cut -d' ' -f1 /proc/uptime)"; wall0="$(date -u +%s)"
date -u -s "$OFFSET" >/dev/null; t_jump="$(epoch)"; log "clock jumped $OFFSET"
sleep "$(( SEGMENT_SECONDS + 10 ))"
if recording_active_since "$(( t_jump - 5 ))"; then check PASS recording-through-jump "segments still growing after the jump"; else check FAIL recording-through-jump "recording stalled after the jump"; fi
if [ -n "${BACKEND_URL:-}" ]; then
  if curl -sf "$BACKEND_URL/api/v1/health" >/dev/null; then check PASS backend-health "health OK after the jump"; else check FAIL backend-health "health failing after the jump"; fi
fi
check NOT_VERIFIED clockguard-detects-skew "ClockGuard state is not exposed via API; inspect backend logs"
# Restore wall clock using the monotonic clock elapsed since the jump started.
mono1="$(cut -d' ' -f1 /proc/uptime)"; restored=$(node -e "console.log(Math.round($wall0 + ($mono1 - $mono0)))")
date -u -s "@$restored" >/dev/null && log "clock restored"
