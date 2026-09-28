#!/usr/bin/env bash
# Shared helpers for P1.2 fault-injection drills. Source this file; do not run it.
#
# Targets (FAULT_TARGET):
#   compose  the appliance stack (docker compose; default). Needs root for tc/mount/date drills.
#   local    a rehearsal rig: a MediaMTX binary + ffmpeg publishers started by
#            scripts/sim/sim-camera-rig.sh. Results are labelled SIMULATED.
#
# Common environment:
#   RECORDINGS_DIR   host path of the recordings root (compose: /var/lib/vigilone/recordings)
#   CAMERA_PATH      stream path to observe (directory under RECORDINGS_DIR)
#   RESULTS_DIR      where reports go (default: ./fault-results)
#   SEGMENT_SECONDS  recorder segment length (compose 600; rehearsal rig 10)
#   COMPOSE_DIR      repo/stack directory for docker compose (default: repo root)
#   SIM_RIG_DIR      local target: rig state directory (pid files, mediamtx.yml)
set -euo pipefail

FAULT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FAULT_TARGET="${FAULT_TARGET:-compose}"
RESULTS_DIR="${RESULTS_DIR:-./fault-results}"
SEGMENT_SECONDS="${SEGMENT_SECONDS:-600}"
COMPOSE_DIR="${COMPOSE_DIR:-$FAULT_ROOT}"
SIM_RIG_DIR="${SIM_RIG_DIR:-/tmp/vigilone-sim-rig}"
DRILL_NAME="${DRILL_NAME:-unnamed}"
DRILL_STARTED="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
CHECKS_TSV="$(mktemp)"

log() { echo "[fault:${DRILL_NAME}] $*" >&2; }
check() { # check <PASS|FAIL|NOT_VERIFIED|INFO> <name> <detail>
  printf '%s\t%s\t%s\n' "$1" "$2" "${3:-}" >> "$CHECKS_TSV"
  log "$1 $2 ${3:-}"
}
require_cmd() { for c in "$@"; do command -v "$c" >/dev/null || { log "missing required command: $c"; exit 2; }; done; }
require_env() { for v in "$@"; do [ -n "${!v:-}" ] || { log "missing required env: $v"; exit 2; }; done; }
require_root() { [ "$(id -u)" = 0 ] || { log "this drill needs root"; exit 2; }; }
is_simulated() { [ "$FAULT_TARGET" = local ] && echo true || echo "${FAULT_SIMULATED:-false}"; }
epoch() { date -u +%s; }
iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }

# EXIT trap: write the report; exit 0 = PASS, 1 = FAIL, 3 = INCONCLUSIVE (a check was NOT_VERIFIED).
finish() {
  local rc=0
  node "$FAULT_ROOT/scripts/lib/fault-report.mjs" "$CHECKS_TSV" "$RESULTS_DIR" "$DRILL_NAME" "$FAULT_TARGET" "$(is_simulated)" "$DRILL_STARTED" || rc=$?
  rm -f "$CHECKS_TSV"
  exit "$rc"
}

cam_dir() { echo "$RECORDINGS_DIR/$CAMERA_PATH"; }

newest_segment() { ls -1 "$(cam_dir)" 2>/dev/null | grep -E '\.mp4$' | sort | tail -n 1; }

# Succeeds when a segment written after <since_epoch> exists and is still growing.
recording_active_since() {
  local since="$1" f s1 s2 mt
  f="$(newest_segment)"; [ -n "$f" ] || return 1
  mt="$(stat -c %Y "$(cam_dir)/$f")"; [ "$mt" -ge "$since" ] || return 1
  s1="$(stat -c %s "$(cam_dir)/$f")"; sleep 2
  f="$(newest_segment)"; s2="$(stat -c %s "$(cam_dir)/$f")"
  [ "$s2" -gt "$s1" ] || [ "$(stat -c %Y "$(cam_dir)/$f")" -gt "$mt" ]
}

# wait_for <timeout_s> <command...>: echoes seconds waited; non-zero if the timeout expires.
wait_for() {
  local timeout="$1"; shift
  local start; start="$(epoch)"
  while true; do
    if "$@" 2>/dev/null; then echo $(( $(epoch) - start )); return 0; fi
    [ $(( $(epoch) - start )) -ge "$timeout" ] && { echo "$timeout"; return 1; }
    sleep 1
  done
}

# Largest coverage gap (seconds) for the camera in [since, until].
max_gap_seconds() {
  node "$FAULT_ROOT/scripts/lib/segments.mjs" gaps "$(cam_dir)" --since "$(iso "$1")" --until "$(iso "$2")" --threshold "${3:-1}" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).maxGapSec))'
}

# Live view is readable when the media engine serves the path to a new reader.
live_view_readable() {
  case "$FAULT_TARGET" in
    local) ffprobe -v error -rtsp_transport tcp -rw_timeout 8000000 -show_entries stream=codec_name -of csv=p=0 "rtsp://127.0.0.1:8554/$CAMERA_PATH" >/dev/null ;;
    compose) (cd "$COMPOSE_DIR" && docker compose exec -T mediamtx ffprobe -v error -rtsp_transport tcp -rw_timeout 8000000 -show_entries stream=codec_name -of csv=p=0 "rtsp://127.0.0.1:8554/$CAMERA_PATH") >/dev/null ;;
  esac
}

# --- media engine control --------------------------------------------------------------------
mediamtx_kill() {
  case "$FAULT_TARGET" in
    local) kill -9 "$(cat "$SIM_RIG_DIR/mediamtx.pid")" ;;
    compose) (cd "$COMPOSE_DIR" && docker compose kill -s SIGKILL mediamtx) ;;
  esac
}
mediamtx_start() {
  case "$FAULT_TARGET" in
    local) "$FAULT_ROOT/scripts/sim/sim-camera-rig.sh" restart-mediamtx ;;
    compose) (cd "$COMPOSE_DIR" && docker compose up -d mediamtx) ;;
  esac
}
