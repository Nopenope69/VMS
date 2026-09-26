#!/usr/bin/env bash
# Drill: abrupt process kill in the middle of a segment (power-cut proxy for the recorder).
# Invariant: the open segment keeps everything up to the last completed 1 s fragment, i.e. loses at
# most the trailing sub-second fragment (fMP4 recordPartDuration 1s).
# Env: CAMERA_PATH, RECORDINGS_DIR, [KILL_AFTER_SECONDS=6] [TOLERANCE_SECONDS=1.5]
DRILL_NAME=abrupt-kill-mid-segment; source "$(dirname "$0")/common.sh"
require_env CAMERA_PATH RECORDINGS_DIR; require_cmd ffprobe node
KILL_AFTER_SECONDS="${KILL_AFTER_SECONDS:-6}"; TOLERANCE_SECONDS="${TOLERANCE_SECONDS:-1.5}"
trap finish EXIT

seg_start_epoch() { node -e 'import("'"$FAULT_ROOT"'/scripts/lib/segments.mjs").then(m=>console.log((m.parseSegmentStart(process.argv[1])/1000).toFixed(3)))' "$1"; }

# Wait for a fresh segment, then kill KILL_AFTER_SECONDS into it.
first="$(newest_segment)"
wait_for $(( SEGMENT_SECONDS + 30 )) bash -c "[ \"\$(ls -1 '$(cam_dir)' | grep -E '\\.mp4$' | sort | tail -n1)\" != '$first' ]" >/dev/null || { check FAIL precondition "no new segment started"; exit; }
seg="$(newest_segment)"; start="$(seg_start_epoch "$seg")"
sleep "$KILL_AFTER_SECONDS"
t_kill="$(date -u +%s.%N)"; mediamtx_kill; log "engine killed $(node -e "console.log(($t_kill-$start).toFixed(2))")s into $seg"
sleep 1
dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$(cam_dir)/$seg" 2>/dev/null || true)"
elapsed="$(node -e "console.log(($t_kill-$start).toFixed(3))")"
if [ -z "$dur" ]; then
  check FAIL truncated-segment-playable "$seg is not readable after the kill"
else
  lost="$(node -e "console.log(($elapsed-$dur).toFixed(3))")"
  if node -e "process.exit(($elapsed-$dur) <= $TOLERANCE_SECONDS ? 0 : 1)"; then
    check PASS truncated-segment-playable "$seg: ${dur}s readable of ${elapsed}s elapsed (lost ${lost}s, limit ${TOLERANCE_SECONDS}s)"
  else
    check FAIL truncated-segment-playable "$seg: only ${dur}s readable of ${elapsed}s elapsed (lost ${lost}s, limit ${TOLERANCE_SECONDS}s)"
  fi
fi
errs="$(ffmpeg -v error -i "$(cam_dir)/$seg" -f null - 2>&1 | grep -c . || true)"
if [ "$errs" = 0 ]; then check PASS truncated-segment-decodes "no decode errors"; else check FAIL truncated-segment-decodes "$errs decode error line(s)"; fi
mediamtx_start; t_up="$(epoch)"
if waited="$(wait_for 60 recording_active_since "$t_up")"; then check PASS recording-resumes "resumed ${waited}s after restart"; else check FAIL recording-resumes "not resumed within 60s"; fi
