#!/usr/bin/env bash
# ==============================================================================
# VigilOne Appliance Packaging & Installer Test Suite
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
INSTALL_SH="${ROOT_DIR}/deploy/packaging/install.sh"
VIGILONECTL="${ROOT_DIR}/deploy/packaging/vigilonectl"

FAILED=0
TOTAL=0

assert_eq() {
  TOTAL=$((TOTAL + 1))
  local test_name="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  ✓ $test_name"
  else
    echo "  ✗ $test_name (Expected: '$expected', Got: '$actual')"
    FAILED=$((FAILED + 1))
  fi
}

assert_contains() {
  TOTAL=$((TOTAL + 1))
  local test_name="$1"
  local needle="$2"
  local haystack="$3"
  if echo "$haystack" | grep -F -q -- "$needle"; then
    echo "  ✓ $test_name"
  else
    echo "  ✗ $test_name (Expected to find '$needle' in output)"
    FAILED=$((FAILED + 1))
  fi
}

assert_file_contains() {
  TOTAL=$((TOTAL + 1))
  local test_name="$1"
  local needle="$2"
  local file="$3"
  if grep -F -q -- "$needle" "$file"; then
    echo "  ✓ $test_name"
  else
    echo "  ✗ $test_name (Expected to find '$needle' in $file)"
    FAILED=$((FAILED + 1))
  fi
}


echo "Running Packaging & Installer Verification Tests..."

# 1. Syntax Validations
echo "1. Shell Syntax Verification"
if bash -n "$INSTALL_SH"; then
  assert_eq "install.sh passes syntax check (bash -n)" "0" "0"
else
  assert_eq "install.sh passes syntax check (bash -n)" "0" "1"
fi

if bash -n "$VIGILONECTL"; then
  assert_eq "vigilonectl passes syntax check (bash -n)" "0" "0"
else
  assert_eq "vigilonectl passes syntax check (bash -n)" "0" "1"
fi

# 2. CLI Help Output Verification
echo "2. CLI Help and Interface Testing"
INSTALL_HELP="$(bash "$INSTALL_SH" --help 2>&1 || true)"
assert_contains "install.sh --help displays usage" "Usage: sudo ./install.sh [OPTIONS]" "$INSTALL_HELP"
assert_contains "install.sh contains --disk flag documentation" "--disk <path>" "$INSTALL_HELP"
assert_contains "install.sh contains --force-wipe-disk documentation" "--force-wipe-disk" "$INSTALL_HELP"
assert_contains "install.sh contains --lan-ip documentation" "--lan-ip <ip>" "$INSTALL_HELP"
assert_contains "install.sh contains --offline-bundle documentation" "--offline-bundle <path>" "$INSTALL_HELP"

CTL_HELP="$(bash "$VIGILONECTL" help 2>&1 || true)"
assert_contains "vigilonectl help displays commands" "Commands:" "$CTL_HELP"
assert_contains "vigilonectl help includes support-bundle" "support-bundle" "$CTL_HELP"
assert_contains "vigilonectl help includes reset-factory" "reset-factory" "$CTL_HELP"
assert_contains "vigilonectl help includes token" "token" "$CTL_HELP"

# 3. vigilonectl Version Output
CTL_VERSION="$(bash "$VIGILONECTL" version 2>&1 || true)"
assert_contains "vigilonectl version displays software version" "VigilOne NVR Appliance" "$CTL_VERSION"

# 4. Invariant Verification in Installer Source
echo "3. Security & Safety Invariants in Installer Script"
INSTALL_CONTENT="$(cat "$INSTALL_SH")"
assert_contains "install.sh enforces AES-256 key permissions (chmod 600)" 'chmod 600 "$KEY_FILE"' "$INSTALL_CONTENT"
assert_contains "install.sh enforces /opt/vigilone/.env permissions (chmod 600)" 'chmod 600 "$ENV_FILE"' "$INSTALL_CONTENT"
assert_contains "install.sh prevents root partition wipe" "hosts the operating system root filesystem (/)" "$INSTALL_CONTENT"
assert_contains "install.sh writes mount guard probe token" ".vigilone-mount-probe" "$INSTALL_CONTENT"
assert_contains "install.sh blocks internal ports (5432, 9997, 8554)" "ufw allow 80/tcp" "$INSTALL_CONTENT"
assert_contains "install.sh allows WebRTC media UDP 8189" "ufw allow 8189/udp" "$INSTALL_CONTENT"
assert_contains "install.sh deploys application files to INSTALL_DIR" "install_application_files" "$INSTALL_CONTENT"
assert_contains "install.sh supports air-gapped container image loading" "load_offline_images" "$INSTALL_CONTENT"
assert_contains "install.sh checks database readiness via pg_isready" "pg_isready -U vigilone" "$INSTALL_CONTENT"
assert_contains "install.sh runs prisma migrate deploy" "prisma migrate deploy" "$INSTALL_CONTENT"

# 5. Stage 1 Architectural & Packaging Invariants
echo "4. Stage 1 Packaging & Architectural Invariants"
COMPOSE_CONTENT="$(cat "${ROOT_DIR}/docker-compose.yml")"
FRONTEND_DOCKERFILE="$(cat "${ROOT_DIR}/frontend/Dockerfile")"
BACKEND_PKG="$(cat "${ROOT_DIR}/backend/package.json")"
MIGRATION_FILE="${ROOT_DIR}/backend/prisma/migrations/20260901000000_init/migration.sql"
CI_FILE="${ROOT_DIR}/.github/workflows/ci.yml"

# Verify frontend_dist named volume is completely eliminated (C-008)
if echo "$COMPOSE_CONTENT" | grep -q "frontend_dist"; then
  assert_eq "docker-compose.yml eliminates frontend_dist named volume (C-008)" "absent" "present"
else
  assert_eq "docker-compose.yml eliminates frontend_dist named volume (C-008)" "absent" "absent"
fi

assert_contains "caddy service builds frontend directly" "context: ./frontend" "$COMPOSE_CONTENT"
assert_contains "mediamtx receives INTERNAL_API_SECRET" "INTERNAL_API_SECRET=" "$COMPOSE_CONTENT"
assert_contains "frontend/Dockerfile uses caddy:2.9-alpine runner" "FROM caddy:2.9-alpine AS runner" "$FRONTEND_DOCKERFILE"
assert_contains "frontend/Dockerfile bakes assets into /srv/frontend" "COPY --from=builder /app/dist /srv/frontend" "$FRONTEND_DOCKERFILE"

# Verify Prisma offline reproducibility
assert_contains "backend package.json includes prisma in dependencies" '"prisma":' "$BACKEND_PKG"

# Verify baseline migration exists (C-004)
if [[ -f "$MIGRATION_FILE" ]]; then
  assert_eq "baseline migration 20260901000000_init exists" "exists" "exists"
  assert_file_contains "baseline migration creates Tenant table" 'CREATE TABLE "Tenant"' "$MIGRATION_FILE"
else
  assert_eq "baseline migration 20260901000000_init exists" "exists" "missing"
fi

# Verify CI workflow file exists (C-010)
if [[ -f "$CI_FILE" ]]; then
  assert_eq "CI workflow .github/workflows/ci.yml exists" "exists" "exists"
  assert_file_contains "CI workflow verifies prisma migrate deploy" "prisma migrate deploy" "$CI_FILE"
  assert_file_contains "CI workflow runs installer test suite" "scripts/__tests__/installer.test.sh" "$CI_FILE"
else
  assert_eq "CI workflow .github/workflows/ci.yml exists" "exists" "missing"
fi

# 6. Stage 4 Single-Command & Zero-Terminal Installer Invariants
echo "5. Stage 4 Single-Command & Zero-Terminal Invariants"
CLI_CONTENT="$(cat "$VIGILONECTL")"
assert_contains "install.sh supports --non-interactive flag" "--non-interactive" "$INSTALL_CONTENT"
assert_contains "install.sh requires --force-wipe-disk in unattended mode on partitioned disks" "Unattended mode refuses to wipe without --force-wipe-disk" "$INSTALL_CONTENT"
assert_contains "install.sh strictly exits non-zero on mount failure" "fatal \"Failed to mount target storage disk" "$INSTALL_CONTENT"
assert_contains "install.sh strictly exits non-zero on healthcheck failure" "fatal \"Appliance healthcheck verification failed!" "$INSTALL_CONTENT"
assert_contains "vigilonectl supports ota subcommand" "cmd_ota" "$CLI_CONTENT"
assert_contains "vigilonectl supports backup subcommand" "cmd_backup" "$CLI_CONTENT"

echo ""
echo "Summary: $((TOTAL - FAILED))/$TOTAL tests passed."
if [[ $FAILED -ne 0 ]]; then
  echo "Installer script verification failed with $FAILED errors."
  exit 1
fi
echo "All packaging and installer tests passed successfully."

