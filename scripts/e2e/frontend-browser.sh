#!/usr/bin/env bash
# Frontend browser tests (frontend/e2e/redaction-dpdp.spec.ts, plate-search.spec.ts, spatial-search.spec.ts) against the real backend and a seeded scratch
# database. The database named in TEST_DB_URL is dropped and recreated: never point it at real data.
#
#   TEST_DB_URL=postgresql://vigilone:pw@localhost:5432/vigilone_e2e scripts/e2e/frontend-browser.sh
#
# Needs: backend and frontend dependencies installed, Chromium for Playwright (PLAYWRIGHT_BROWSERS_PATH or
# `npx playwright install chromium`), psql.
set -euo pipefail
: "${TEST_DB_URL:?set TEST_DB_URL to a scratch database (it is dropped and recreated)}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
API_PORT="${E2E_API_PORT:-4100}"
WEB_PORT="${E2E_WEB_PORT:-4173}"
PIDS=()
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  if [ "${E2E_KEEP:-0}" = 1 ]; then echo "kept $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

ADMIN_URL="${TEST_DB_URL%/*}/postgres"
DB_NAME="${TEST_DB_URL##*/}"; DB_NAME="${DB_NAME%%\?*}"
psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE)" -c "CREATE DATABASE \"$DB_NAME\""

export DATABASE_URL="$TEST_DB_URL"
export EXPORTS_DIR="$WORK/exports" RECORDINGS_DIR="$WORK/recordings" SNAPSHOTS_DIR="$WORK/snapshots"
mkdir -p "$EXPORTS_DIR" "$RECORDINGS_DIR" "$SNAPSHOTS_DIR"

echo "== migrate and seed"
(cd "$ROOT/backend" && npx prisma migrate deploy >/dev/null && npx ts-node scripts/e2e/seed-frontend-e2e.ts > "$WORK/seed.json")

# The seed signs its licence with a key it makes; the backend trusts that key only under NODE_ENV=test.
export VIGILONE_LICENSE_TEST_PUBLIC_KEY="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).licensePublicKey)' "$WORK/seed.json")"

echo "== backend on :$API_PORT"
(cd "$ROOT/backend" && npm run -s build >"$WORK/backend-build.log" 2>&1) || { echo "backend build failed:"; tail -30 "$WORK/backend-build.log"; exit 1; }
(cd "$ROOT/backend" && NODE_ENV=test PORT="$API_PORT" VIGILONE_FEATURE_REDACTION=true VIGILONE_FEATURE_SMART_SEARCH=true VIGILONE_FEATURE_INVESTIGATION_TIMING=true VIGILONE_FEATURE_TRACK_INDEX=true VIGILONE_FEATURE_SEMANTIC_SEARCH=true VIGILONE_FEATURE_NL_SEARCH=true \
  JWT_SECRET="${JWT_SECRET:-vigilone_e2e_jwt_signing_key_32bytes_min!!}" \
  exec node dist/server.js > "$WORK/backend.log" 2>&1) &
PIDS+=($!)

echo "== frontend (vite preview) on :$WEB_PORT"
(cd "$ROOT/frontend" && npm run -s build >"$WORK/frontend-build.log" 2>&1) || { echo "frontend build failed:"; tail -30 "$WORK/frontend-build.log"; exit 1; }
(cd "$ROOT/frontend" && VIGILONE_API_TARGET="http://127.0.0.1:$API_PORT" exec node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port "$WEB_PORT" --strictPort > "$WORK/web.log" 2>&1) &
PIDS+=($!)

for url in "http://127.0.0.1:$API_PORT/api/v1/health" "http://127.0.0.1:$WEB_PORT/"; do
  for i in $(seq 1 60); do curl -fsS -o /dev/null "$url" && break; sleep 1; done
  curl -fsS -o /dev/null "$url" || { echo "not up: $url"; cat "$WORK/backend.log" "$WORK/web.log"; exit 1; }
done

echo "== browser tests"
status=0
(cd "$ROOT/frontend" && E2E_SEED_FILE="$WORK/seed.json" VIGILONE_BASE_URL="http://127.0.0.1:$WEB_PORT" npx playwright test) || status=$?
if [ "$status" -ne 0 ]; then echo "--- backend log (tail)"; tail -40 "$WORK/backend.log"; fi
for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
wait 2>/dev/null || true
psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE)"
exit "$status"
