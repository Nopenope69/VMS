#!/usr/bin/env bash
# P1.5 clean-VM install drill. Run as root on a FRESH Ubuntu 22.04 or 24.04 VM (nothing else
# installed, disposable). It installs the appliance unattended, waits for it to become healthy,
# runs status + acceptance, and writes a report. It does not modify anything outside what
# install.sh itself does.
#
#   sudo ./scripts/install-drill/clean-vm-install-drill.sh [--with-test-camera] [--out <dir>]
#
# Pass criteria (recorded, not assumed): install.sh exits 0; all core containers running/healthy
# within 10 min; /api/v1/health returns database ok and mediaEngine ok; a random SETUP_TOKEN was
# generated (not the retired default); vigilonectl acceptance runs (its FAIL items are listed).
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${OUT:-/var/tmp/vigilone-install-drill-$(date -u +%Y%m%dT%H%M%SZ)}"
WITH_TEST_CAMERA=0
while [ $# -gt 0 ]; do case "$1" in --with-test-camera) WITH_TEST_CAMERA=1 ;; --out) OUT="$2"; shift ;; esac; shift; done
mkdir -p "$OUT"
TSV="$OUT/checks.tsv"; : > "$TSV"
check() { printf '%s\t%s\t%s\n' "$1" "$2" "${3:-}" >> "$TSV"; echo "[install-drill] $1 $2 ${3:-}"; }

[ "$(id -u)" = 0 ] || { echo "run as root on a disposable VM"; exit 2; }
. /etc/os-release
case "${VERSION_ID:-}" in 22.04|24.04) check PASS os "Ubuntu $VERSION_ID" ;; *) check FAIL os "unsupported: ${PRETTY_NAME:-unknown}" ;; esac
if command -v docker >/dev/null 2>&1; then check INFO preexisting-docker "docker already installed: this is not a clean VM"; fi

start="$(date +%s)"
bash "$REPO/deploy/packaging/install.sh" --unattended > "$OUT/install.log" 2>&1; rc=$?
if [ "$rc" = 0 ]; then check PASS install-exit "install.sh --unattended exited 0 in $(( $(date +%s) - start ))s"; else check FAIL install-exit "exit $rc (see install.log)"; fi

INSTALL_DIR=/opt/vigilone
if [ "$WITH_TEST_CAMERA" = 1 ]; then (cd "$INSTALL_DIR" && docker compose --profile test up -d synthetic-camera) >> "$OUT/install.log" 2>&1; fi

healthy=0
for _ in $(seq 1 60); do
  states="$(cd "$INSTALL_DIR" && docker compose ps --format '{{.Service}}={{.State}}/{{.Health}}' 2>/dev/null | tr '\n' ' ')"
  if echo "$states" | grep -q 'backend=running/healthy' && echo "$states" | grep -q 'postgres=running/healthy' && echo "$states" | grep -q 'mediamtx=running'; then healthy=1; break; fi
  sleep 10
done
if [ "$healthy" = 1 ]; then check PASS containers-healthy "$states"; else check FAIL containers-healthy "not healthy within 10 min: ${states:-none}"; fi

health="$(curl -sk https://localhost/api/v1/health 2>/dev/null || curl -s http://localhost/api/v1/health 2>/dev/null)"
echo "$health" > "$OUT/health.json"
if echo "$health" | grep -q '"database":"ok"' && echo "$health" | grep -q '"mediaEngine":"ok"'; then check PASS health "$health"; else check FAIL health "${health:-no response}"; fi

token_file=/etc/vigilone/setup-token.txt
if [ -s "$token_file" ] && ! grep -q vigilone_dev_setup_token "$token_file"; then check PASS setup-token "random token generated ($(wc -c < "$token_file") bytes)"; else check FAIL setup-token "missing or default token in $token_file"; fi

vigilonectl status > "$OUT/status.txt" 2>&1 && check PASS vigilonectl-status "ok" || check FAIL vigilonectl-status "see status.txt"
if command -v node >/dev/null 2>&1; then
  RESULTS_DIR="$OUT" vigilonectl acceptance > "$OUT/acceptance.txt" 2>&1
  check INFO acceptance "vigilonectl acceptance exit $? (see acceptance.txt; FAIL items need action)"
else
  check NOT_VERIFIED acceptance "install Node >= 20 on the host to run vigilonectl acceptance"
fi
check MANUAL browser-bootstrap "open https://<vm-ip>/, complete the first-run wizard with the token from $token_file"

REPORT_KIND="clean-VM install drill" REPORT_SCHEMA="vigilone.install-drill.v1" \
  node "$REPO/scripts/lib/fault-report.mjs" "$TSV" "$OUT" clean-vm-install "$(hostname)" false "$(date -u -d "@$start" +%Y-%m-%dT%H:%M:%S.000Z)" 2>/dev/null \
  || { echo "(node not available: raw results in $TSV)"; grep -q '^FAIL' "$TSV" && exit 1; exit 0; }
