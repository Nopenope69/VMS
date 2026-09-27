#!/usr/bin/env bash
# P4.4 end-to-end redaction scenario (SIMULATED recording of a SYNTHETIC scene with a public-domain
# face and a synthetic plate):
#
#   recorded segments + evidence manifest --> POST /privacy/jobs + /execute --> backend samples
#   frames --> ai-worker in redaction mode (YuNet + PP-OCRv4, real models over ai-adapter.v1) -->
#   masks --> ffmpeg --> derivative; then downloads it and checks the SHA-256 with sha256sum,
#   the masked pixels, the chain-of-custody link to the master hash, and that the masters are
#   byte-identical.
#
# The redaction models are candidate models; the scenario uses a TEMPORARY TEST-ONLY approvals
# file, which is not a licence decision.
#
#   DATABASE_URL=... scripts/e2e/redaction-scenario.sh [report.json]
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"
: "${DATABASE_URL:?set DATABASE_URL to a migrated PostgreSQL database}"
export E2E_DIR="${E2E_DIR:-/tmp/vigilone-redaction-e2e}"
export E2E_REPORT="${1:-$E2E_DIR/report.json}"
export INTERNAL_API_SECRET="${INTERNAL_API_SECRET:-e2e_internal_secret_$(openssl rand -hex 12)}"
export JWT_SECRET="${JWT_SECRET:-e2e_jwt_secret_$(openssl rand -hex 16)}"
export RECORDINGS_DIR="$E2E_DIR/recordings"
export EXPORTS_DIR="$E2E_DIR/exports"
export VIGILONE_FEATURE_REDACTION=true
export REDACTION_ADAPTER_URL=http://127.0.0.1:7013
export VIGILONE_MODEL_EXCEPTIONS="$E2E_DIR/TEST-ONLY-model-license-exceptions.json"
rm -rf "$E2E_DIR"; mkdir -p "$E2E_DIR" "$RECORDINGS_DIR" "$EXPORTS_DIR"
PIDS=()
cleanup() {
  for p in "${PIDS[@]}"; do kill -9 "$p" 2>/dev/null || true; done
  node scripts/e2e/redaction-scenario.mjs cleanup >/dev/null 2>&1 || true
}
trap cleanup EXIT
log() { echo "[redaction-e2e] $*"; }
wait_http() { for _ in $(seq 1 90); do curl -sf -o /dev/null "$1" && return 0; sleep 0.5; done; echo "timeout waiting for $1" >&2; return 1; }

node -e "
const d = require('./scripts/models/pipelines/redaction-v1.json');
require('fs').writeFileSync(process.env.VIGILONE_MODEL_EXCEPTIONS, JSON.stringify({ approvals: d.components.map((c) => ({
  key: c.key, sha256: c.sha256, approvedBy: 'TEST-ONLY e2e scenario (not a licence decision)', approvedAt: new Date().toISOString().slice(0, 10), reason: 'SIMULATED end-to-end test' })) }, null, 1));"

# Two 4-second "recorded" segments: the fixture scene panning slowly, as the recorder would store them.
SRC=services/ai-worker/src/__tests__/fixtures/redaction/SYNTHETIC_face_plate_scene.png
for i in 0 1; do
  ffmpeg -v error -y -loop 1 -i "$SRC" -vf "pad=1000:560:0:0,crop=960:540:'20*t/8+$((i*10))':'10*t/8+$((i*5))',format=yuv420p" \
    -r 15 -t 4 -c:v libx264 -preset veryfast -g 15 "$RECORDINGS_DIR/seg$i.mp4"
done

(cd backend && NODE_ENV=development PORT=4000 exec node dist/server.js > "$E2E_DIR/backend.log" 2>&1) & PIDS+=($!)
wait_http http://127.0.0.1:4000/api/v1/health || wait_http http://127.0.0.1:4000/api/v1/health/live

(AI_WORKER_MODE=redaction BACKEND_INTERNAL_URL=http://127.0.0.1:4000/api/v1/internal AI_ADAPTER_PORT=7013 \
  exec node services/ai-worker/dist/main.js > "$E2E_DIR/worker.log" 2>&1) & PIDS+=($!)
wait_http http://127.0.0.1:7013/v1/health
for _ in $(seq 1 60); do grep -q "redaction pipeline registered" "$E2E_DIR/worker.log" && break; sleep 0.5; done
grep -q "redaction pipeline registered" "$E2E_DIR/worker.log" || { cat "$E2E_DIR/worker.log"; exit 1; }

node scripts/e2e/redaction-scenario.mjs setup | tee "$E2E_DIR/setup.json"
node scripts/e2e/redaction-scenario.mjs run
EXPECTED="$(node -e "console.log(require('$E2E_DIR/state.json').outputSha256)")"
ACTUAL="$(sha256sum "$E2E_DIR/downloaded.mp4" | cut -d' ' -f1)"
log "recorded SHA-256 $EXPECTED; sha256sum of the download $ACTUAL"
[[ "$EXPECTED" == "$ACTUAL" ]] || { echo "SHA-256 MISMATCH" >&2; exit 1; }
export SHA256SUM_OF_DOWNLOAD="$ACTUAL"
node scripts/e2e/redaction-scenario.mjs verify
