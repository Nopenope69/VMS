#!/usr/bin/env bash
# P2.9 end-to-end scenario (SIMULATED-CAMERA):
#
#   person clip --RTSP--> "camera" MediaMTX (:8654) --pull--> appliance MediaMTX (:8554, records,
#   auth via backend) --loopback--> ai-worker (real YOLOX) --> backend /internal/detections -->
#   tracker CONFIRMED --> tripwire incident --> IncidentOrchestrator --> alarm (API)
#
# then kills the worker with SIGKILL and checks that recording keeps going.
#
# Needs: built backend (backend/dist) and ai-worker (services/ai-worker/dist), a migrated Postgres
# at DATABASE_URL, ffmpeg, a MediaMTX binary (MEDIAMTX_BIN, same version as docker-compose.yml),
# and the model (scripts/models/fetch-model.sh yolox-tiny).
#
#   MEDIAMTX_BIN=/path/to/mediamtx DATABASE_URL=... scripts/e2e/ai-tripwire-scenario.sh [report.json]
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"
: "${MEDIAMTX_BIN:?set MEDIAMTX_BIN to a MediaMTX binary}"
: "${DATABASE_URL:?set DATABASE_URL to a migrated PostgreSQL database}"
export E2E_DIR="${E2E_DIR:-/tmp/vigilone-e2e}"
export E2E_REPORT="${1:-$E2E_DIR/report.json}"
export INTERNAL_API_SECRET="${INTERNAL_API_SECRET:-e2e_internal_secret_$(openssl rand -hex 12)}"
export JWT_SECRET="${JWT_SECRET:-e2e_jwt_secret_$(openssl rand -hex 16)}"
export RECORDINGS_DIR="$E2E_DIR/recordings"
export CAMERA_RTSP_URL="rtsp://127.0.0.1:8654/gate"
export AI_MODEL_KEY="${AI_MODEL_KEY:-yolox-tiny}"
rm -rf "$E2E_DIR"; mkdir -p "$E2E_DIR" "$RECORDINGS_DIR"
PIDS=()
cleanup() {
  for p in "${PIDS[@]}"; do kill -9 "$p" 2>/dev/null || true; done
  node scripts/e2e/ai-tripwire-scenario.mjs cleanup >/dev/null 2>&1 || true
}
trap cleanup EXIT
log() { echo "[e2e] $*"; }
wait_http() { for _ in $(seq 1 60); do curl -sf -o /dev/null "$1" && return 0; sleep 0.5; done; echo "timeout waiting for $1" >&2; return 1; }
count_segments() { find "$RECORDINGS_DIR" -name '*.mp4' 2>/dev/null | wc -l; }

# 1. The clip: a public-domain photo of a person (scikit-image 'astronaut', NASA) moving upward
#    across a plain background, 12 s, looped. No real footage.
SRC=services/ai-worker/src/__tests__/fixtures/golden/source/astronaut.png
ffmpeg -v error -y -f lavfi -i "color=c=0x4a5a6a:s=1280x720:r=15:d=12" -loop 1 -i "$SRC" \
  -filter_complex "[1:v]scale=260:260[p];[0:v][p]overlay=x=510:y='700-t*80':shortest=1,format=yuv420p" \
  -c:v libx264 -preset veryfast -g 15 -t 12 "$E2E_DIR/person_crossing.mp4"

# 2. The "IP camera": its own MediaMTX with an RTSP server on :8654.
cat > "$E2E_DIR/camera.yml" <<EOF
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
EOF
"$MEDIAMTX_BIN" "$E2E_DIR/camera.yml" > "$E2E_DIR/camera-mtx.log" 2>&1 & PIDS+=($!)
sleep 1
ffmpeg -hide_banner -loglevel error -re -stream_loop -1 -i "$E2E_DIR/person_crossing.mp4" -c copy \
  -f rtsp -rtsp_transport tcp "$CAMERA_RTSP_URL" > "$E2E_DIR/publisher.log" 2>&1 & PIDS+=($!)

# 3. The appliance MediaMTX: records fMP4, authorises reads through the backend (as mediamtx.yml).
cat > "$E2E_DIR/appliance.yml" <<EOF
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
EOF
"$MEDIAMTX_BIN" "$E2E_DIR/appliance.yml" > "$E2E_DIR/appliance-mtx.log" 2>&1 & PIDS+=($!)
wait_http http://127.0.0.1:9997/v3/paths/list

# 4. The backend (development mode, real Postgres).
(cd backend && NODE_ENV=development PORT=4000 MEDIAMTX_API_URL=http://127.0.0.1:9997 \
  EXPORTS_DIR="$E2E_DIR/exports" node dist/server.js > "$E2E_DIR/backend.log" 2>&1) & PIDS+=($!)
wait_http http://127.0.0.1:4000/api/v1/health || wait_http http://127.0.0.1:4000/api/v1/health/live

# 5. Tenant, camera, rules; MediaMTX starts pulling from the camera and recording.
node scripts/e2e/ai-tripwire-scenario.mjs setup | tee "$E2E_DIR/setup.json"

# 6. The AI worker (real YOLOX via onnxruntime-node), reading the appliance loopback stream.
(AI_WORKER_MODE=pipeline BACKEND_INTERNAL_URL=http://127.0.0.1:4000/api/v1/internal \
  MEDIAMTX_READ_USER=internal MEDIAMTX_READ_PASSWORD="$INTERNAL_API_SECRET" \
  AI_ADAPTER_PORT=7011 AI_DETECT_FPS=5 AI_GATE_MODE=motion \
  node services/ai-worker/dist/main.js > "$E2E_DIR/worker.log" 2>&1) & WORKER_PID=$!; PIDS+=($WORKER_PID)

# 7. Wait for the alarm through the operator API.
log "waiting for the tripwire alarm..."
node scripts/e2e/ai-tripwire-scenario.mjs wait

# 8. Evidence isolation: SIGKILL the worker, recording must keep going.
export SEGMENTS_BEFORE_KILL="$(count_segments)"
pkill -9 -P "$WORKER_PID" 2>/dev/null || true; kill -9 "$WORKER_PID" 2>/dev/null || true
log "worker killed; segments so far: $SEGMENTS_BEFORE_KILL"
sleep 12
export SEGMENTS_AFTER_KILL="$(count_segments)"
log "segments 12 s after the kill: $SEGMENTS_AFTER_KILL"

node scripts/e2e/ai-tripwire-scenario.mjs verify
