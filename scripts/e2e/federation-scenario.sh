#!/usr/bin/env bash
# Phase 6 end-to-end multi-site scenario: headquarters and one site as two backend processes with two
# databases, joined by a relay the scenario cuts (scripts/e2e/federation-scenario.mjs). The backend must be
# built (backend/dist). DATABASE_URL is the site database; the headquarters database is created next to it.
#
#   DATABASE_URL=postgresql://user:pw@host:5432/db?schema=public scripts/e2e/federation-scenario.sh [report.json]
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"
: "${DATABASE_URL:?set DATABASE_URL to a migrated PostgreSQL database (the site)}"
export E2E_DIR="${E2E_DIR:-/tmp/vigilone-federation-e2e}"
REPORT="${1:-$E2E_DIR/report.json}"
export JWT_SECRET="${JWT_SECRET:-e2e_jwt_secret_$(openssl rand -hex 16)}"
export INTERNAL_API_SECRET="${INTERNAL_API_SECRET:-e2e_internal_secret_$(openssl rand -hex 12)}"
rm -rf "$E2E_DIR"; mkdir -p "$E2E_DIR"

BASE="${DATABASE_URL%%\?*}"          # postgresql://user:pw@host:port/db
QUERY="${DATABASE_URL#"$BASE"}"      # ?schema=public (or empty)
DB="${BASE##*/}"
HQ_DB="${DB}_fed_hq"
export SITE_DATABASE_URL="$DATABASE_URL"
export HQ_DATABASE_URL="${BASE%/*}/${HQ_DB}${QUERY}"

psql "$BASE" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS \"$HQ_DB\"" -c "CREATE DATABASE \"$HQ_DB\""
(cd backend && DATABASE_URL="$HQ_DATABASE_URL" npx prisma migrate deploy >/dev/null)
echo "[federation-e2e] site database: $DB, headquarters database: $HQ_DB"

node scripts/e2e/federation-scenario.mjs "$REPORT"
rc=$?
cat "$REPORT"
psql "$BASE" -q -c "DROP DATABASE IF EXISTS \"$HQ_DB\"" || true
exit $rc
