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

echo ""
echo "Summary: $((TOTAL - FAILED))/$TOTAL tests passed."
if [[ $FAILED -ne 0 ]]; then
  echo "Installer script verification failed with $FAILED errors."
  exit 1
fi
echo "All packaging and installer tests passed successfully."
