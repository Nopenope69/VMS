#!/usr/bin/env bash
# Drill: recordings volume fills up (loopback filesystem, never the real disk).
#   disk-full.sh setup <mountpoint> [size]   create + mount a loop ext4 fs (default 2G); point the
#                                            stack's recordings at it before starting it
#   disk-full.sh run                         fill it and check the invariants
#   disk-full.sh teardown <mountpoint>
# Invariants (compose): retention pruning frees space without stopping recording or live view;
# EvidencePin'd files (PINNED_FILES, space-separated) are never deleted.
# On the local rig there is no backend, so pruning is NOT_VERIFIED; the drill still checks that
# live view survives a full disk and recording resumes once space returns.
# Env (run): RECORDINGS_DIR (must be the loop mount), CAMERA_PATH, [LEAVE_MB=50] [PRUNE_WAIT=180] [PINNED_FILES]
DRILL_NAME=disk-full; source "$(dirname "$0")/common.sh"

case "${1:-}" in
  setup)
    require_root; mp="${2:?mountpoint}"; img="${mp%/}.img"
    fallocate -l "${3:-2G}" "$img" && mkfs.ext4 -q -F "$img" && mkdir -p "$mp" && mount -o loop "$img" "$mp" && echo "mounted $img at $mp"
    trap - EXIT; rm -f "$CHECKS_TSV"; exit 0 ;;
  teardown)
    require_root; mp="${2:?mountpoint}"; umount "$mp" && rm -f "${mp%/}.img"; trap - EXIT; rm -f "$CHECKS_TSV"; exit 0 ;;
  run) ;;
  *) echo "usage: $0 setup <mp> [size] | run | teardown <mp>"; exit 2 ;;
esac

trap finish EXIT
require_env RECORDINGS_DIR CAMERA_PATH; require_cmd findmnt node
LEAVE_MB="${LEAVE_MB:-50}"; PRUNE_WAIT="${PRUNE_WAIT:-180}"
src="$(findmnt -no SOURCE --target "$RECORDINGS_DIR" || true)"
case "$src" in /dev/loop*) check PASS safety "recordings are on loop device $src" ;; *) check FAIL safety "refusing to fill $RECORDINGS_DIR: it is on '$src', not a loop device"; exit ;; esac

free_mb() { df -Pm "$RECORDINGS_DIR" | awk 'NR==2{print $4}'; }
filler="$RECORDINGS_DIR/.drill-filler"
fill_mb=$(( $(free_mb) - LEAVE_MB )); [ "$fill_mb" -gt 0 ] && fallocate -l "${fill_mb}M" "$filler"
t_full="$(epoch)"; log "filled volume; ${LEAVE_MB} MB left"
sleep "$(( SEGMENT_SECONDS * 2 ))"

if waited="$(wait_for 30 live_view_readable)"; then check PASS live-view-while-full "readable while the volume is full"; else check FAIL live-view-while-full "live view lost while the volume is full"; fi
if [ "$FAULT_TARGET" = compose ]; then
  if waited="$(wait_for "$PRUNE_WAIT" bash -c "[ \$(df -Pm '$RECORDINGS_DIR' | awk 'NR==2{print \$4}') -gt $((LEAVE_MB * 2)) ]")"; then check PASS retention-prunes "free space recovered ${waited}s after filling"; else check FAIL retention-prunes "no pruning within ${PRUNE_WAIT}s"; fi
  if recording_active_since "$t_full"; then check PASS recording-while-full "recording continued"; else check FAIL recording-while-full "recording stopped"; fi
else
  check NOT_VERIFIED retention-prunes "no backend on the local rig; run against the compose stack"
fi
for f in ${PINNED_FILES:-}; do
  if [ -f "$f" ]; then check PASS pinned-evidence-kept "$f present"; else check FAIL pinned-evidence-kept "$f was deleted"; fi
done
[ -n "${PINNED_FILES:-}" ] || check NOT_VERIFIED pinned-evidence-kept "set PINNED_FILES to the paths of EvidencePin'd segments"
rm -f "$filler"; t_free="$(epoch)"
if waited="$(wait_for 60 recording_active_since "$t_free")"; then check PASS recording-after-space-returns "recording active ${waited}s after space returned"; else check FAIL recording-after-space-returns "not recording 60s after space returned"; fi
