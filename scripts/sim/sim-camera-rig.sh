#!/usr/bin/env bash
# SIMULATED-CAMERAS rehearsal rig: a MediaMTX binary recording fMP4 like the appliance, fed by N
# ffmpeg test-pattern publishers. It rehearses the software path only; it proves nothing about
# real cameras, PoE, network hardware or long-duration behaviour (see P1.6, HUMAN-REQUIRED).
#
#   MEDIAMTX_BIN=/path/to/mediamtx scripts/sim/sim-camera-rig.sh start 4
#   scripts/sim/sim-camera-rig.sh status | stop | restart-mediamtx | kill-camera 2 | start-camera 2
#
# Env: SIM_RIG_DIR (state, default /tmp/vigilone-sim-rig), RECORDINGS_DIR (default $SIM_RIG_DIR/recordings),
#      SIM_SEGMENT_SECONDS (10), SIM_SIZE (640x360), SIM_FPS (15), SIM_GOP_SECONDS (2)
set -euo pipefail
SIM_RIG_DIR="${SIM_RIG_DIR:-/tmp/vigilone-sim-rig}"
RECORDINGS_DIR="${RECORDINGS_DIR:-$SIM_RIG_DIR/recordings}"
SIM_SEGMENT_SECONDS="${SIM_SEGMENT_SECONDS:-10}"
SIM_SIZE="${SIM_SIZE:-640x360}"
SIM_FPS="${SIM_FPS:-15}"
SIM_GOP_SECONDS="${SIM_GOP_SECONDS:-2}"
mkdir -p "$SIM_RIG_DIR" "$RECORDINGS_DIR"

write_conf() {
  cat > "$SIM_RIG_DIR/mediamtx.yml" <<CONF
# SIMULATED-CAMERAS rehearsal config (mirrors the appliance recorder settings in mediamtx.yml)
logLevel: warn
api: yes
apiAddress: 127.0.0.1:9997
metrics: yes
metricsAddress: 127.0.0.1:9998
rtspAddress: 127.0.0.1:8554
protocols: [tcp]
rtmp: no
hls: no
webrtc: no
srt: no
pathDefaults:
  record: yes
  recordPath: $RECORDINGS_DIR/%path/%Y-%m-%d_%H-%M-%S-%f
  recordFormat: fmp4
  recordSegmentDuration: ${SIM_SEGMENT_SECONDS}s
  recordPartDuration: 1s
paths:
  all_others:
CONF
}

start_mediamtx() {
  : "${MEDIAMTX_BIN:?set MEDIAMTX_BIN to a MediaMTX binary (same version as docker-compose.yml)}"
  write_conf
  nohup "$MEDIAMTX_BIN" "$SIM_RIG_DIR/mediamtx.yml" > "$SIM_RIG_DIR/mediamtx.log" 2>&1 &
  echo $! > "$SIM_RIG_DIR/mediamtx.pid"
  echo "$MEDIAMTX_BIN" > "$SIM_RIG_DIR/mediamtx.bin"
  for _ in $(seq 1 20); do curl -sf 127.0.0.1:9997/v3/paths/list >/dev/null && return 0; sleep 0.5; done
  echo "mediamtx did not come up; see $SIM_RIG_DIR/mediamtx.log" >&2; return 1
}

start_camera() {
  local i="$1" gop=$(( SIM_FPS * SIM_GOP_SECONDS ))
  # -re paces at real time; the publisher reconnects are handled by restarting this process.
  nohup ffmpeg -hide_banner -loglevel error -re -f lavfi -i "testsrc2=size=${SIM_SIZE}:rate=${SIM_FPS}" \
    -c:v libx264 -preset ultrafast -tune zerolatency -g "$gop" -keyint_min "$gop" -pix_fmt yuv420p \
    -f rtsp -rtsp_transport tcp "rtsp://127.0.0.1:8554/sim_cam_${i}" > "$SIM_RIG_DIR/cam_${i}.log" 2>&1 &
  echo $! > "$SIM_RIG_DIR/cam_${i}.pid"
}

kill_pidfile() { [ -f "$1" ] && kill -9 "$(cat "$1")" 2>/dev/null || true; rm -f "$1"; }

case "${1:-}" in
  start)
    n="${2:-4}"; echo "$n" > "$SIM_RIG_DIR/count"
    start_mediamtx
    for i in $(seq 1 "$n"); do start_camera "$i"; done
    sleep 3; echo "SIMULATED-CAMERAS rig: $n publisher(s), recordings in $RECORDINGS_DIR" ;;
  stop)
    for f in "$SIM_RIG_DIR"/cam_*.pid; do kill_pidfile "$f"; done
    kill_pidfile "$SIM_RIG_DIR/mediamtx.pid" ;;
  restart-mediamtx)
    kill_pidfile "$SIM_RIG_DIR/mediamtx.pid"; MEDIAMTX_BIN="${MEDIAMTX_BIN:-$(cat "$SIM_RIG_DIR/mediamtx.bin")}" start_mediamtx
    # Publishers exit when the server goes away; bring them back like reconnecting cameras.
    for i in $(seq 1 "$(cat "$SIM_RIG_DIR/count")"); do
      pid_file="$SIM_RIG_DIR/cam_${i}.pid"
      if ! { [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; }; then start_camera "$i"; fi
    done ;;
  kill-camera) kill_pidfile "$SIM_RIG_DIR/cam_${2:?camera index}.pid" ;;
  start-camera) start_camera "${2:?camera index}" ;;
  status)
    curl -s 127.0.0.1:9997/v3/paths/list | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);for(const p of j.items)console.log(p.name, p.ready?"READY":"NOT_READY")})' ;;
  *) echo "usage: $0 start [n] | stop | status | restart-mediamtx | kill-camera <i> | start-camera <i>"; exit 2 ;;
esac
