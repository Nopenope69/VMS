#!/usr/bin/env bash
# P1.4 installation acceptance (docs/operations/INSTALLATION_ACCEPTANCE_CHECKLIST.md).
# Runs every checklist item that can be checked from the appliance host and lists the rest as
# MANUAL for the field engineer. Invoked by `vigilonectl acceptance`; can also run standalone.
#
# Env: INSTALL_DIR (/opt/vigilone), CONFIG_DIR (/etc/vigilone), RECORDINGS_DIR
#      (/var/lib/vigilone/recordings), EVIDENCE_ZIP (optional: an exported package to verify, F27-F29),
#      RESULTS_DIR (default $INSTALL_DIR/acceptance-results), SEGMENT_SECONDS (600)
set -uo pipefail
INSTALL_DIR="${INSTALL_DIR:-/opt/vigilone}"
CONFIG_DIR="${CONFIG_DIR:-/etc/vigilone}"
RECORDINGS_DIR="${RECORDINGS_DIR:-/var/lib/vigilone/recordings}"
RESULTS_DIR="${RESULTS_DIR:-$INSTALL_DIR/acceptance-results}"
SEGMENT_SECONDS="${SEGMENT_SECONDS:-600}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
TSV="$(mktemp)"
check() { printf '%s\t%s\t%s\n' "$1" "$2" "${3:-}" >> "$TSV"; printf '  %-12s %-40s %s\n' "$1" "$2" "${3:-}"; }
have() { command -v "$1" >/dev/null 2>&1; }
dc() { (cd "$INSTALL_DIR" && docker compose "$@"); }

echo "VigilOne installation acceptance: automated checks"
echo

# --- Section A: physical (all manual) ---------------------------------------------------------
for item in "A1 chassis mounting" "A2 airflow and clearance" "A3 grounding integrity" "A4 power supply redundancy" "A5 UPS backing" "A6 cable strain relief"; do
  check MANUAL "$item" "inspect on site"
done

# --- Section B: network -----------------------------------------------------------------------
check MANUAL "B7 dual interface separation" "confirm eth0 = viewing LAN, eth1 = camera switch"
if have ip; then
  gw_ifaces="$(ip route show default 2>/dev/null | awk '{print $5}' | sort -u | tr '\n' ' ')"
  check MANUAL "B8 camera subnet has no gateway" "default route via: ${gw_ifaces:-none}; confirm it is not the camera interface"
else
  check MANUAL "B8 camera subnet has no gateway" "ip(8) not available"
fi
if have docker && dc ps >/dev/null 2>&1; then
  published="$(dc ps --format '{{.Publishers}}' 2>/dev/null | tr ',' '\n' | grep -oE '(0\.0\.0\.0|\[::\]|::):[0-9]+' | awk -F: '{print $NF}' | sort -un | tr '\n' ' ')"
  unexpected="$(for p in $published; do case "$p" in 80|443|8189) ;; *) printf '%s ' "$p" ;; esac; done)"
  if [ -z "$unexpected" ]; then check PASS "B9 only 80/443/8189 published" "published: ${published:-none}"; else check FAIL "B9 only 80/443/8189 published" "unexpected: $unexpected"; fi
  echo " $published " | grep -q " 5432 " && check FAIL "B10 PostgreSQL not published" "5432 is published" || check PASS "B10 PostgreSQL not published" "5432 not published by any container"
  echo " $published " | grep -q " 9997 " && check FAIL "B11 MediaMTX API not published" "9997 is published" || check PASS "B11 MediaMTX API not published" "9997 not published by any container"
  check MANUAL "B9-B11 external scan" "run nmap from another host against eth0 and eth1 to confirm"
else
  check NOT_VERIFIED "B9-B11 port exposure" "docker compose not reachable from $INSTALL_DIR"
fi

# --- Section C: storage -----------------------------------------------------------------------
if have findmnt; then
  rec_src="$(findmnt -no SOURCE --target "$RECORDINGS_DIR" 2>/dev/null)"; root_src="$(findmnt -no SOURCE /)"
  if [ -n "$rec_src" ] && [ "$rec_src" != "$root_src" ]; then check PASS "C12 recordings pool separate from /" "$RECORDINGS_DIR on $rec_src, / on $root_src"; else check FAIL "C12 recordings pool separate from /" "$RECORDINGS_DIR is on the root filesystem ($root_src)"; fi
  rec_target="$(findmnt -no TARGET --target "$RECORDINGS_DIR" 2>/dev/null)"
  fstab_line="$(awk -v t="$rec_target" '$2==t' /etc/fstab 2>/dev/null)"
  if echo "$fstab_line" | grep -q '^UUID=' && echo "$fstab_line" | grep -q 'noatime'; then check PASS "C13 fstab by UUID with noatime" "$fstab_line"; else check FAIL "C13 fstab by UUID with noatime" "fstab entry for $rec_target: ${fstab_line:-none}"; fi
else
  check NOT_VERIFIED "C12-C13 mounts" "findmnt not available"
fi
probe="$RECORDINGS_DIR/.vigilone-mount-probe"
if [ -f "$probe" ]; then check PASS "C14 mount guard probe token" "$probe present"; else check FAIL "C14 mount guard probe token" "$probe missing"; fi
check MANUAL "C15 mount guard trip test" "remove/unmount the probe and confirm the alarm within 5 s"
check MANUAL "C16 storage accounting" "compare 'df -h $RECORDINGS_DIR' with the Storage page"

# --- Section D: services ----------------------------------------------------------------------
if have docker && dc ps >/dev/null 2>&1; then
  for svc in caddy backend mediamtx postgres; do
    st="$(dc ps --format '{{.Service}} {{.State}} {{.Health}}' 2>/dev/null | awk -v s="$svc" '$1==s{print $2" "$3}')"
    case "$st" in "running healthy"|"running ") check PASS "D17 $svc running" "$st" ;; *) check FAIL "D17 $svc running" "${st:-not found}" ;; esac
  done
  fatal="$(dc logs --since 24h backend 2>/dev/null | grep -ciE 'FATAL|Unhandled|panic|uncaughtException' || true)"
  if [ "${fatal:-0}" = 0 ]; then check PASS "D18 no fatal errors in backend logs (24 h)" "0 matches"; else check FAIL "D18 no fatal errors in backend logs (24 h)" "$fatal matching line(s); run vigilonectl logs"; fi
else
  check NOT_VERIFIED "D17-D18 services" "docker compose not reachable"
fi
if [ -f "$CONFIG_DIR/clock_guard.state" ]; then check PASS "D19 ClockGuard state present" "$(cat "$CONFIG_DIR/clock_guard.state" 2>/dev/null)"; else check FAIL "D19 ClockGuard state present" "$CONFIG_DIR/clock_guard.state missing"; fi
if have timedatectl; then
  ntp="$(timedatectl show -p NTPSynchronized --value 2>/dev/null)"
  if [ "$ntp" = yes ]; then check PASS "D20 clock synchronized" "NTPSynchronized=yes"; else check FAIL "D20 clock synchronized" "NTPSynchronized=${ntp:-unknown}"; fi
else
  check NOT_VERIFIED "D20 clock synchronized" "timedatectl not available"
fi

# --- Section E: video -------------------------------------------------------------------------
if [ -d "$RECORDINGS_DIR" ]; then
  cams=0; stale=""; badnames=0
  for d in "$RECORDINGS_DIR"/*/; do
    [ -d "$d" ] || continue; name="$(basename "$d")"; [ "$name" = exports ] && continue
    newest="$(ls -1 "$d" 2>/dev/null | grep -E '\.mp4$' | sort | tail -n1)"; [ -n "$newest" ] || continue
    cams=$((cams+1))
    age=$(( $(date +%s) - $(stat -c %Y "$d/$newest") ))
    [ "$age" -gt 120 ] && stale="$stale $name(${age}s)"
    badnames=$((badnames + $(ls -1 "$d" | grep -E '\.mp4$' | grep -cvE '^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{6}\.mp4$' || true)))
  done
  if [ "$cams" -gt 0 ]; then check PASS "E21 cameras recording" "$cams camera director(y/ies) with segments"; else check FAIL "E21 cameras recording" "no camera segments under $RECORDINGS_DIR"; fi
  if [ "$cams" -gt 0 ] && [ -z "$stale" ]; then check PASS "E23 segments being written" "every camera's newest segment modified within 120 s"; else check FAIL "E23 segments being written" "stale:${stale:- none recording}"; fi
  if [ "$badnames" = 0 ]; then check PASS "E24 UTC segment naming" "all names match YYYY-MM-DD_HH-mm-ss-ffffff.mp4"; else check FAIL "E24 UTC segment naming" "$badnames file(s) with unexpected names"; fi
else
  check FAIL "E21-E24 recordings" "$RECORDINGS_DIR does not exist"
fi
check MANUAL "E22 live view latency < 500 ms" "measure glass-to-glass with a stopwatch in view"
check MANUAL "E25 timeline scrubbing" "seek to several points in Playback"
check MANUAL "E26 network disconnect resilience" "or run scripts/fault/camera-poweroff.sh / network-fault.sh drop"

# --- Section F: evidence ----------------------------------------------------------------------
if [ -n "${EVIDENCE_ZIP:-}" ]; then
  if have node; then
    out="$(node "$REPO_ROOT/scripts/acceptance/verify-evidence-package.mjs" "$EVIDENCE_ZIP" 2>&1)"; rc=$?
    if [ "$rc" = 0 ]; then check PASS "F27-F29 evidence package verifies offline" "$(basename "$EVIDENCE_ZIP")"; else check FAIL "F27-F29 evidence package verifies offline" "$(echo "$out" | grep -E '^FAIL' | head -3 | tr '\n' ';')"; fi
  else
    check NOT_VERIFIED "F27-F29 evidence package" "node not installed on the host"
  fi
else
  check NOT_VERIFIED "F27-F29 evidence package" "export a clip and re-run with EVIDENCE_ZIP=<path>"
fi
check MANUAL "F30 statutory disclaimer wording" "open certificate_sec63.pdf and read it"

echo
REPORT_KIND="installation acceptance" REPORT_SCHEMA="vigilone.acceptance.v1" \
  node "$REPO_ROOT/scripts/lib/fault-report.mjs" "$TSV" "$RESULTS_DIR" installation-acceptance "$(hostname)" false "$STARTED"
rc=$?; rm -f "$TSV"; exit "$rc"
