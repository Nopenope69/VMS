#!/usr/bin/env bash
# Drill: media engine killed (SIGKILL) and restarted.
# Invariants: recording resumes within RESUME_LIMIT s of restart; live view readable again;
# segments finalized before the kill stay playable.
# Env: CAMERA_PATH, RECORDINGS_DIR, [DOWN_SECONDS=5] [RESUME_LIMIT=60]
DRILL_NAME=mediamtx-kill; source "$(dirname "$0")/common.sh"
require_env CAMERA_PATH RECORDINGS_DIR; require_cmd ffprobe node
DOWN_SECONDS="${DOWN_SECONDS:-5}"; RESUME_LIMIT="${RESUME_LIMIT:-60}"
trap finish EXIT

if recording_active_since $(( $(epoch) - 30 )); then check PASS precondition "camera is recording"; else check FAIL precondition "camera is not recording before the drill"; exit; fi
before=( $(ls -1 "$(cam_dir)" | grep -E '\.mp4$' | sort) )
unset 'before[${#before[@]}-1]'   # the open segment is excluded; the abrupt-kill drill covers it

t_kill="$(epoch)"; mediamtx_kill; log "engine killed"; sleep "$DOWN_SECONDS"
mediamtx_start; t_up="$(epoch)"; log "engine restarted"

if waited="$(wait_for "$RESUME_LIMIT" recording_active_since "$t_up")"; then
  check PASS recording-resumes "recording resumed ${waited}s after restart (limit ${RESUME_LIMIT}s)"
else
  check FAIL recording-resumes "no new growing segment within ${RESUME_LIMIT}s after restart"
fi
if waited="$(wait_for "$RESUME_LIMIT" live_view_readable)"; then
  check PASS live-view "readable ${waited}s after restart"
else
  check FAIL live-view "path not readable within ${RESUME_LIMIT}s after restart"
fi
bad=0; for f in "${before[@]}"; do ffprobe -v error -show_entries format=duration -of csv=p=0 "$(cam_dir)/$f" >/dev/null 2>&1 || bad=$((bad+1)); done
if [ "$bad" = 0 ]; then check PASS committed-segments-intact "${#before[@]} pre-kill segment(s) still playable"; else check FAIL committed-segments-intact "$bad of ${#before[@]} pre-kill segment(s) unreadable"; fi
gap="$(max_gap_seconds "$t_kill" "$(epoch)" 1)"
check INFO outage-gap-measured "largest gap across the outage: ${gap}s (engine down ${DOWN_SECONDS}s)"
