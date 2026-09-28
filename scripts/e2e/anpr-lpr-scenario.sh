#!/usr/bin/env bash
# P4.1 end-to-end ANPR scenario (SIMULATED-CAMERA, SYNTHETIC plate):
#
#   synthetic plate clip --RTSP--> "camera" MediaMTX (:8654) --pull--> appliance MediaMTX
#   (:8554, records, auth via backend) --loopback--> ai-worker in anpr mode (PP-OCRv4 det +
#   fast-plate-ocr) --> backend /internal/anpr/observations --> VehicleObservation, ANPR_MATCH
#   event, known-plate alarm; then SIGKILLs the worker and checks recording keeps going.
#
# The ANPR models are candidate models (training-data licence pending human review). This
# scenario runs them with a TEMPORARY TEST-ONLY approvals file; it is not a licence decision.
#
#   MEDIAMTX_BIN=/path/to/mediamtx DATABASE_URL=... scripts/e2e/anpr-lpr-scenario.sh [report.json]
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"
: "${MEDIAMTX_BIN:?set MEDIAMTX_BIN to a MediaMTX binary}"
: "${DATABASE_URL:?set DATABASE_URL to a migrated PostgreSQL database}"
export E2E_DIR="${E2E_DIR:-/tmp/vigilone-anpr-e2e}"
export E2E_REPORT="${1:-$E2E_DIR/report.json}"
export INTERNAL_API_SECRET="${INTERNAL_API_SECRET:-e2e_internal_secret_$(openssl rand -hex 12)}"
export JWT_SECRET="${JWT_SECRET:-e2e_jwt_secret_$(openssl rand -hex 16)}"
export RECORDINGS_DIR="$E2E_DIR/recordings"
export CAMERA_RTSP_URL="rtsp://127.0.0.1:8654/lane1"
export VIGILONE_FEATURE_ANPR=true
export VIGILONE_MODEL_EXCEPTIONS="$E2E_DIR/TEST-ONLY-model-license-exceptions.json"
rm -rf "$E2E_DIR"; mkdir -p "$E2E_DIR" "$RECORDINGS_DIR"
PIDS=()
cleanup() {
  for p in "${PIDS[@]}"; do kill -9 "$p" 2>/dev/null || true; done
  node scripts/e2e/anpr-lpr-scenario.mjs cleanup >/dev/null 2>&1 || true
}
trap cleanup EXIT
log() { echo "[anpr-e2e] $*"; }
wait_http() { for _ in $(seq 1 60); do curl -sf -o /dev/null "$1" && return 0; sleep 0.5; done; echo "timeout waiting for $1" >&2; return 1; }
count_segments() { find "$RECORDINGS_DIR" -name '*.mp4' 2>/dev/null | wc -l; }
wait_tcp() { for _ in $(seq 1 60); do (echo > "/dev/tcp/127.0.0.1/$1") 2>/dev/null && return 0; sleep 0.5; done; echo "timeout waiting for port $1" >&2; return 1; }

node -e "
const d = require('./scripts/models/pipelines/anpr-india-v1.json');
require('fs').writeFileSync(process.env.VIGILONE_MODEL_EXCEPTIONS, JSON.stringify({ approvals: d.components.map((c) => ({
  key: c.key, sha256: c.sha256, approvedBy: 'TEST-ONLY e2e scenario (not a licence decision)', approvedAt: new Date().toISOString().slice(0, 10), reason: 'SIMULATED end-to-end test' })) }, null, 1));"

# 1. The clip: a SYNTHETIC scene with plate MH 12 AB 1234 (tools/anpr/synth_plates.py), slowly
#    zooming in like an approaching vehicle, 12 s, looped.
SRC=services/ai-worker/src/__tests__/fixtures/anpr/SYNTHETIC_private_hsrp.png
ffmpeg -v error -y -loop 1 -i "$SRC" -vf "scale=1920:1080,zoompan=z='1+0.002*on':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=1280x720:fps=15,format=yuv420p" \
  -c:v libx264 -preset veryfast -g 15 -t 12 "$E2E_DIR/plate_lane.mp4"

cat > "$E2E_DIR/camera.yml" <<EOC
logLevel: warn
api: no
rtspAddress: 127.0.0.1:8654
protocols: [tcp]
rtmp: no
hls: no
webrtc: no
srt: no
paths:
  all_others:
EOC
"$MEDIAMTX_BIN" "$E2E_DIR/camera.yml" > "$E2E_DIR/camera-mtx.log" 2>&1 & PIDS+=($!)
wait_tcp 8654
ffmpeg -hide_banner -loglevel error -re -stream_loop -1 -i "$E2E_DIR/plate_lane.mp4" -c copy \
  -f rtsp -rtsp_transport tcp "$CAMERA_RTSP_URL" > "$E2E_DIR/publisher.log" 2>&1 & PIDS+=($!)

cat > "$E2E_DIR/appliance.yml" <<EOC
logLevel: warn
api: yes
apiAddress: 127.0.0.1:9997
authMethod: http
authHTTPAddress: http://127.0.0.1:4000/api/v1/media/auth
authHTTPExclude:
  - action: api
rtspAddress: 127.0.0.1:8554
protocols: [tcp]
rtmp: no
hls: no
webrtc: no
srt: no
pathDefaults:
  record: no
  recordPath: $RECORDINGS_DIR/%path/%Y-%m-%d_%H-%M-%S-%f
  recordFormat: fmp4
  recordSegmentDuration: 5s
  recordPartDuration: 1s
paths:
  all_others:
EOC
"$MEDIAMTX_BIN" "$E2E_DIR/appliance.yml" > "$E2E_DIR/appliance-mtx.log" 2>&1 & PIDS+=($!)
wait_http http://127.0.0.1:9997/v3/paths/list

(cd backend && NODE_ENV=development PORT=4000 MEDIAMTX_API_URL=http://127.0.0.1:9997 \
  exec node dist/server.js > "$E2E_DIR/backend.log" 2>&1) & PIDS+=($!)
wait_http http://127.0.0.1:4000/api/v1/health || wait_http http://127.0.0.1:4000/api/v1/health/live

node scripts/e2e/anpr-lpr-scenario.mjs setup | tee "$E2E_DIR/setup.json"

(AI_WORKER_MODE=anpr BACKEND_INTERNAL_URL=http://127.0.0.1:4000/api/v1/internal \
  MEDIAMTX_READ_USER=internal MEDIAMTX_READ_PASSWORD="$INTERNAL_API_SECRET" AI_ADAPTER_PORT=7012 \
  exec node services/ai-worker/dist/main.js > "$E2E_DIR/worker.log" 2>&1) & WORKER_PID=$!; PIDS+=($WORKER_PID)

log "waiting for the known-plate alarm..."
node scripts/e2e/anpr-lpr-scenario.mjs wait

export SEGMENTS_BEFORE_KILL="$(count_segments)"
pkill -9 -P "$WORKER_PID" 2>/dev/null || true; kill -9 "$WORKER_PID" 2>/dev/null || true
log "worker killed; segments so far: $SEGMENTS_BEFORE_KILL"
sleep 12
export SEGMENTS_AFTER_KILL="$(count_segments)"
log "segments 12 s after the kill: $SEGMENTS_AFTER_KILL"

node scripts/e2e/anpr-lpr-scenario.mjs verify
