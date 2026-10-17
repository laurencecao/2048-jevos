#!/usr/bin/env bash
# Run the 9B and the 27B StartLux-Decision builds side by side.
#
#   9B  : llama-server 8018  -> startlux-decide 8081   (provider "startlux")
#   27B : llama-server 8019  -> startlux-decide 8082   (provider "startlux27b")
#   web : :3000, both engines selectable in the AI panel
#
#   bash deploy/startlux-both.sh start|stop|status
#
# Environment (defaults in brackets):
#   STARTLUX_DIR        folder holding both GGUF + config/tokenizer [<repo>/startlux]
#   STARTLUX9B_GGUF     9B GGUF   [StartLux-Decision-v1.1-9B-Instant-Q8_0.gguf]
#   STARTLUX27B_GGUF    27B GGUF  [StartLux-Decision-v1.1-27B-Instant-Q4_K_M.gguf]
#   STARTLUX9B_PORT     8018     STARTLUX27B_PORT   8019   (llama-server)
#   STARTLUX9B_API_PORT 8081     STARTLUX27B_API_PORT 8082 (decision API)
#   STARTLUX_CTX / STARTLUX_BATCH / STARTLUX_UBATCH   (4096 / 2048 / 2048)
#   STARTLUX_PYTHONPATH  where startlux_decide lives [<repo>/../startlux-py]
#
# Memory: 9.5 GB (9B Q8_0) + 16.5 GB (27B Q4_K_M) of weights, plus small KV
# caches. Small -b/-ub keep the logits buffers tiny, so both fit in 4x A2 16 GB.
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
DATA_DIR="${JEVOS_DATA_DIR:-}"
if [ -z "$DATA_DIR" ] && [ -f "$REPO_DIR/.jevos-path" ]; then
  DATA_DIR="$(cat "$REPO_DIR/.jevos-path")"
fi
DATA_DIR="${DATA_DIR:-$REPO_DIR/.jevos}"
LOGS="$DATA_DIR/logs"; mkdir -p "$LOGS"

if [ -z "${STARTLUX_DIR:-}" ]; then
  # The repo may either vendor startlux/ or sit next to it (deploy layout).
  if [ -d "$REPO_DIR/startlux" ]; then STARTLUX_DIR="$REPO_DIR/startlux"
  else STARTLUX_DIR="$(cd "$REPO_DIR/.." && pwd)/startlux"; fi
fi
SL_DIR="$STARTLUX_DIR"
GGUF9="${STARTLUX9B_GGUF:-$SL_DIR/StartLux-Decision-v1.1-9B-Instant-Q8_0.gguf}"
GGUF27="${STARTLUX27B_GGUF:-$SL_DIR/StartLux-Decision-v1.1-27B-Instant-Q4_K_M.gguf}"
LLAMA9="${STARTLUX9B_PORT:-8018}"
LLAMA27="${STARTLUX27B_PORT:-8019}"
API9="${STARTLUX9B_API_PORT:-8081}"
API27="${STARTLUX27B_API_PORT:-8082}"
CTX="${STARTLUX_CTX:-4096}"
BATCH="${STARTLUX_BATCH:-2048}"
UBATCH="${STARTLUX_UBATCH:-2048}"
PYTHONPATH="${STARTLUX_PYTHONPATH:-$REPO_DIR/../startlux-py}${PYTHONPATH:+:$PYTHONPATH}"
export PYTHONPATH

log() { printf '\033[1;36m[startlux-both]\033[0m %s\n' "$*"; }
healthy() { curl -fsS -m 3 "$1" >/dev/null 2>&1; }
wait_healthy() { # url timeout_s label
  local url="$1" timeout="$2" label="${3:-service}" i=0
  while [ "$i" -lt "$((timeout * 2))" ]; do
    healthy "$url" && { log "$label ready"; return 0; }
    sleep 0.5; i=$((i + 1))
  done
  log "$label did not become healthy in ${timeout}s (last log below)"
  return 1
}

pid_running() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

stop_one() { # pidfile label
  if pid_running "$1"; then
    local pid; pid="$(cat "$1")"
    log "stopping $2 (pid $pid)"
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$1"
}

start_llama() { # label gguf port log pidfile
  local label="$1" gguf="$2" port="$3" logfile="$4" pidfile="$5"
  if healthy "http://127.0.0.1:$port/health"; then
    log "$label already healthy on $port"; return 0
  fi
  [ -f "$gguf" ] || { echo "missing GGUF: $gguf" >&2; return 2; }
  log "starting $label llama-server on $port ($(basename "$gguf"))"
  ( cd "$REPO_DIR" && exec nohup env \
      STARTLUX_GGUF="$gguf" LLAMACPP_PORT="$port" \
      STARTLUX_CTX="$CTX" STARTLUX_BATCH="$BATCH" STARTLUX_UBATCH="$UBATCH" \
      bash "$SCRIPT_DIR/startlux-llama.sh" ) \
    > "$logfile" 2>&1 < /dev/null &
  echo $! > "$pidfile"
  wait_healthy "http://127.0.0.1:$port/health" 300 "$label" \
    || { tail -20 "$logfile" >&2; return 7; }
}

start_api() { # label model port backend_url log pidfile
  local label="$1" model="$2" port="$3" backend="$4" logfile="$5" pidfile="$6"
  if healthy "http://127.0.0.1:$port/health"; then
    log "$label decision API already healthy on $port"; return 0
  fi
  log "starting $label decision API on $port -> $backend"
  ( cd "$REPO_DIR" && exec nohup env \
      STARTLUX_MODEL_DIR="$SL_DIR" STARTLUX_MODEL="$model" \
      STARTLUX_LLAMACPP_URL="$backend" STARTLUX_PORT="$port" \
      bash "$SCRIPT_DIR/startlux-serve.sh" ) \
    > "$logfile" 2>&1 < /dev/null &
  echo $! > "$pidfile"
  wait_healthy "http://127.0.0.1:$port/health" 120 "$label decision API" \
    || { tail -20 "$logfile" >&2; return 7; }
}

status() {
  local url code
  for spec in "9B llama-server:$LLAMA9:/health:startlux9b-llama" \
              "9B decision API:$API9:/health:startlux9b-api" \
              "27B llama-server:$LLAMA27:/health:startlux27b-llama" \
              "27B decision API:$API27:/health:startlux27b-api"; do
    local label="${spec%%:*}" rest="${spec#*:}"
    local port="${rest%%:*}" rest2="${rest#*:}" path="${rest2%%:*}" pidfile="${rest2##*:}"
    url="http://127.0.0.1:$port$path"
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 3 "$url" || true)"
    printf '  %-18s port %-5s http %-3s pid %s\n' "$label" "$port" "$code" \
      "$(cat "$LOGS/$pidfile.pid" 2>/dev/null || echo -)"
  done
}

case "${1:-start}" in
  start)
    start_llama "9B" "$GGUF9" "$LLAMA9" "$LOGS/startlux9b-llama.log" "$LOGS/startlux9b-llama.pid"
    start_llama "27B" "$GGUF27" "$LLAMA27" "$LOGS/startlux27b-llama.log" "$LOGS/startlux27b-llama.pid"
    start_api "9B" "StartLux-Decision-v1.1-9B-Instant" "$API9" "http://127.0.0.1:$LLAMA9" \
      "$LOGS/startlux9b-api.log" "$LOGS/startlux9b-api.pid"
    start_api "27B" "StartLux-Decision-v1.1-27B-Instant" "$API27" "http://127.0.0.1:$LLAMA27" \
      "$LOGS/startlux27b-api.log" "$LOGS/startlux27b-api.pid"
    log "both engines are up:"
    status
    log "app: AI_PROVIDER=startlux (9B) or startlux27b (27B); STARTLUX_URL=http://127.0.0.1:$API9 STARTLUX27_URL=http://127.0.0.1:$API27"
    ;;
  stop)
    stop_one "$LOGS/startlux9b-api.pid" "9B decision API"
    stop_one "$LOGS/startlux27b-api.pid" "27B decision API"
    stop_one "$LOGS/startlux9b-llama.pid" "9B llama-server"
    stop_one "$LOGS/startlux27b-llama.pid" "27B llama-server"
    log "stopped"
    ;;
  status)
    status
    ;;
  *)
    echo "usage: bash deploy/startlux-both.sh [start|stop|status]" >&2
    exit 2
    ;;
esac
