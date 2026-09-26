#!/usr/bin/env bash
# Drill: control-plane (backend) crash and restart while the media engine keeps recording.
# Invariants: recording never pauses; the segment open at crash time is not deleted, replaced or
# moved by boot-time crash recovery (same inode, still growing); no recorded bytes disappear
# from the camera directory (quarantine moves count as kept).
# compose: kills/starts the backend service. local: BACKEND_PID_FILE + BACKEND_START_CMD.
# Env: CAMERA_PATH, RECORDINGS_DIR, [BACKEND_URL] [SETTLE_SECONDS=20]
DRILL_NAME=backend-restart; source "$(dirname "$0")/common.sh"
require_env CAMERA_PATH RECORDINGS_DIR; require_cmd node
SETTLE_SECONDS="${SETTLE_SECONDS:-20}"
trap finish EXIT

backend_kill() {
  case "$FAULT_TARGET" in
    local) require_env BACKEND_PID_FILE; kill -9 "$(cat "$BACKEND_PID_FILE")" ;;
    compose) (cd "$COMPOSE_DIR" && docker compose kill -s SIGKILL backend) ;;
  esac
}
backend_start() {
  case "$FAULT_TARGET" in
    local) require_env BACKEND_START_CMD; bash -c "$BACKEND_START_CMD" ;;
    compose) (cd "$COMPOSE_DIR" && docker compose up -d backend) ;;
  esac
}
dir_bytes() { find "$(cam_dir)" -type f -name '*.mp4' -printf '%s\n' | awk '{s+=$1} END {print s+0}'; }

open_seg="$(newest_segment)"
[ -n "$open_seg" ] || { check FAIL precondition "no segment for $CAMERA_PATH"; exit; }
inode_before="$(stat -c %i "$(cam_dir)/$open_seg")"; size_before="$(stat -c %s "$(cam_dir)/$open_seg")"
bytes_before="$(dir_bytes)"

t_kill="$(epoch)"; backend_kill; log "backend killed while $open_seg was open"
sleep 3
if recording_active_since "$t_kill"; then check PASS recording-while-backend-down "segments kept growing"; else check FAIL recording-while-backend-down "recording paused with the backend down"; fi
backend_start
if [ -n "${BACKEND_URL:-}" ]; then
  if waited="$(wait_for 120 bash -c "curl -sf '$BACKEND_URL/api/v1/health' >/dev/null")"; then check PASS backend-recovers "healthy ${waited}s after restart"; else check FAIL backend-recovers "not healthy within 120s"; fi
else
  sleep 10
fi
sleep "$SETTLE_SECONDS"   # boot-time crash recovery runs during this window

if [ -f "$(cam_dir)/$open_seg" ] && [ "$(stat -c %i "$(cam_dir)/$open_seg")" = "$inode_before" ]; then
  size_after="$(stat -c %s "$(cam_dir)/$open_seg")"
  if [ "$size_after" -ge "$size_before" ]; then check PASS open-segment-preserved "$open_seg kept its inode (${size_before} -> ${size_after} bytes)"; else check FAIL open-segment-preserved "$open_seg shrank (${size_before} -> ${size_after} bytes)"; fi
else
  check FAIL open-segment-preserved "$open_seg was deleted, replaced or moved by recovery"
fi
bytes_after="$(dir_bytes)"
if [ "$bytes_after" -ge "$bytes_before" ]; then check PASS no-recorded-bytes-lost "camera dir ${bytes_before} -> ${bytes_after} bytes (incl. quarantine)"; else check FAIL no-recorded-bytes-lost "camera dir shrank ${bytes_before} -> ${bytes_after} bytes"; fi
if recording_active_since "$t_kill"; then check PASS recording-after-restart "still recording"; else check FAIL recording-after-restart "not recording after backend restart"; fi
