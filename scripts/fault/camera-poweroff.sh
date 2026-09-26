#!/usr/bin/env bash
# Drill: camera power-off (stream loss) and restore.
# Invariants: other cameras keep recording while one is dark; the camera's recording resumes
# within RESUME_LIMIT s of power returning (plan acceptance: reconnect within 60 s).
# local target: kills/restarts the rig publisher. compose target: runs POWER_OFF_CMD/POWER_ON_CMD
# (e.g. a PoE switch port command) or, if unset, asks the operator to cut and restore power.
# Env: CAMERA_PATH, RECORDINGS_DIR, [CAMERA_INDEX] [OTHER_CAMERA_PATH] [OFF_SECONDS=20] [RESUME_LIMIT=60]
DRILL_NAME=camera-poweroff; source "$(dirname "$0")/common.sh"
require_env CAMERA_PATH RECORDINGS_DIR; require_cmd node
OFF_SECONDS="${OFF_SECONDS:-20}"; RESUME_LIMIT="${RESUME_LIMIT:-60}"
trap finish EXIT

power_off() {
  if [ "$FAULT_TARGET" = local ]; then "$FAULT_ROOT/scripts/sim/sim-camera-rig.sh" kill-camera "${CAMERA_INDEX:?CAMERA_INDEX}";
  elif [ -n "${POWER_OFF_CMD:-}" ]; then bash -c "$POWER_OFF_CMD";
  else read -r -p "Cut power to the camera for $CAMERA_PATH, then press Enter " _; fi
}
power_on() {
  if [ "$FAULT_TARGET" = local ]; then "$FAULT_ROOT/scripts/sim/sim-camera-rig.sh" start-camera "$CAMERA_INDEX";
  elif [ -n "${POWER_ON_CMD:-}" ]; then bash -c "$POWER_ON_CMD";
  else read -r -p "Restore power to the camera, then press Enter " _; fi
}

t_off="$(epoch)"; power_off; sleep "$OFF_SECONDS"
if [ -n "${OTHER_CAMERA_PATH:-}" ]; then
  if CAMERA_PATH="$OTHER_CAMERA_PATH" recording_active_since "$t_off"; then check PASS other-cameras-unaffected "$OTHER_CAMERA_PATH kept recording"; else check FAIL other-cameras-unaffected "$OTHER_CAMERA_PATH stopped recording"; fi
else
  check NOT_VERIFIED other-cameras-unaffected "set OTHER_CAMERA_PATH to check isolation"
fi
power_on; t_on="$(epoch)"
if waited="$(wait_for "$RESUME_LIMIT" recording_active_since "$t_on")"; then
  check PASS recording-resumes "camera recording resumed ${waited}s after power restore (limit ${RESUME_LIMIT}s)"
else
  check FAIL recording-resumes "not resumed within ${RESUME_LIMIT}s of power restore"
fi
