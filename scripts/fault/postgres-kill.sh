#!/usr/bin/env bash
# Drill: database killed (SIGKILL) and restarted. compose target only.
# Invariants: recording continues while the database is down; backend health recovers; segment
# rows committed before the kill are all still present; segments written during the outage are
# indexed by the reconciler afterwards (no lost committed events).
# Env: CAMERA_PATH, RECORDINGS_DIR, BACKEND_URL (e.g. http://localhost), [DOWN_SECONDS=30] [RECONCILE_WAIT=360]
DRILL_NAME=postgres-kill; source "$(dirname "$0")/common.sh"
trap finish EXIT
if [ "$FAULT_TARGET" != compose ]; then check NOT_VERIFIED postgres-kill "needs the compose stack (database + backend); not available on the local rig"; exit; fi
require_env CAMERA_PATH RECORDINGS_DIR BACKEND_URL; require_cmd docker curl
DOWN_SECONDS="${DOWN_SECONDS:-30}"; RECONCILE_WAIT="${RECONCILE_WAIT:-360}"
psqlq() { (cd "$COMPOSE_DIR" && docker compose exec -T postgres psql -U "${POSTGRES_USER:-vigilone}" -d "${POSTGRES_DB:-vigilone_db}" -tAc "$1"); }
cam_id="$(psqlq "SELECT id FROM \"Camera\" WHERE \"streamPath\"='${CAMERA_PATH}'" | tr -d '[:space:]')"
[ -n "$cam_id" ] || { check FAIL precondition "camera $CAMERA_PATH not in database"; exit; }
ids_before="$(psqlq "SELECT id FROM \"RecordingSegment\" WHERE \"cameraId\"='${cam_id}' ORDER BY id")"
n_before="$(echo "$ids_before" | grep -c . || true)"

t_kill="$(epoch)"; (cd "$COMPOSE_DIR" && docker compose kill -s SIGKILL postgres); sleep "$DOWN_SECONDS"
if recording_active_since "$t_kill"; then check PASS recording-during-db-outage "segments kept growing with the database down"; else check FAIL recording-during-db-outage "recording stalled while the database was down"; fi
(cd "$COMPOSE_DIR" && docker compose up -d postgres)
if waited="$(wait_for 180 bash -c "curl -sf '$BACKEND_URL/api/v1/health' | grep -q '\"database\":\"ok\"'")"; then check PASS backend-recovers "health reports database ok ${waited}s after restart"; else check FAIL backend-recovers "backend health did not recover within 180s"; fi
ids_after="$(psqlq "SELECT id FROM \"RecordingSegment\" WHERE \"cameraId\"='${cam_id}' ORDER BY id")"
missing="$(comm -23 <(echo "$ids_before") <(echo "$ids_after") | grep -c . || true)"
if [ "$missing" = 0 ]; then check PASS committed-rows-survive "$n_before pre-kill row(s) all present"; else check FAIL committed-rows-survive "$missing committed row(s) missing after restart"; fi
outage_files="$(find "$(cam_dir)" -name '*.mp4' -newermt "@$t_kill" ! -newermt "@$((t_kill + DOWN_SECONDS))" | wc -l)"
log "waiting up to ${RECONCILE_WAIT}s for the reconciler to index ${outage_files} outage segment(s)"
sleep "$RECONCILE_WAIT"
indexed="$(psqlq "SELECT count(*) FROM \"RecordingSegment\" WHERE \"cameraId\"='${cam_id}' AND \"startTime\" >= to_timestamp(${t_kill}) - interval '${SEGMENT_SECONDS} seconds'" | tr -d '[:space:]')"
if [ "${indexed:-0}" -ge "$outage_files" ]; then check PASS outage-segments-indexed "$indexed row(s) cover the outage window ($outage_files file(s))"; else check FAIL outage-segments-indexed "only ${indexed:-0} row(s) for $outage_files file(s) written during the outage"; fi
