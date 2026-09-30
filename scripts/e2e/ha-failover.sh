#!/usr/bin/env bash
# Phase 8 high-availability failover with two real backend processes on one database (see ha-failover.mjs).
#
#   DATABASE_URL=... scripts/e2e/ha-failover.sh [report.json]     (needs backend/dist: cd backend && npm run build)
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"
: "${DATABASE_URL:?set DATABASE_URL to a migrated PostgreSQL database}"
export E2E_DIR="${E2E_DIR:-/tmp/vigilone-ha-e2e}"
export INTERNAL_API_SECRET="${INTERNAL_API_SECRET:-e2e_internal_secret_$(openssl rand -hex 12)}"
export JWT_SECRET="${JWT_SECRET:-e2e_jwt_secret_$(openssl rand -hex 16)}"
export RECORDINGS_DIR="${RECORDINGS_DIR:-$E2E_DIR/recordings}"
export EXPORTS_DIR="${EXPORTS_DIR:-$E2E_DIR/exports}"
rm -rf "$E2E_DIR"; mkdir -p "$E2E_DIR" "$RECORDINGS_DIR" "$EXPORTS_DIR"
exec node scripts/e2e/ha-failover.mjs "${1:-$E2E_DIR/report.json}"
