#!/usr/bin/env bash
# Start jevos + the 2048 web app. Idempotent: skips whatever is already healthy.
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
DATA_DIR="${JEVOS_DATA_DIR:-}"
if [ -z "$DATA_DIR" ] && [ -f "$REPO_DIR/.jevos-path" ]; then
  DATA_DIR="$(cat "$REPO_DIR/.jevos-path")"
fi
DATA_DIR="${DATA_DIR:-$REPO_DIR/.jevos}"
[ -f "$DATA_DIR/deploy.env" ] && . "$DATA_DIR/deploy.env"
WEB_PORT="${WEB_PORT:-3000}"
JEVOS_PORT="${JEVOS_PORT:-8017}"
THREADS="${JEVOS_THREADS:-4}"
AI_PROVIDER="${AI_PROVIDER:-jevos}"
OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"
OLLAMA_MODEL="${OLLAMA_MODEL:-clef-flash:9b}"
STARTLUX_URL="${STARTLUX_URL:-http://127.0.0.1:8081}"
STARTLUX_MODEL="${STARTLUX_MODEL:-StartLux-Decision-v1.1-9B-Instant}"
LOGS="$DATA_DIR/logs"; mkdir -p "$LOGS"

log() { printf '\033[1;36m[start]\033[0m %s\n' "$*"; }
healthy() { curl -fsS -m 2 "$1" >/dev/null 2>&1; }
wait_healthy() { # url timeout_s
  local url="$1" timeout="${2:-90}" i=0
  while [ "$i" -lt "$((timeout * 2))" ]; do
    healthy "$url" && return 0
    sleep 0.5; i=$((i + 1))
  done
  return 1
}

if [ "$AI_PROVIDER" = "ollama" ] || [ "$AI_PROVIDER" = "startlux" ]; then
  log "provider=$AI_PROVIDER: not starting jevos (set AI_PROVIDER=jevos to switch back)"
elif healthy "http://127.0.0.1:$JEVOS_PORT/health"; then
  log "jevos already healthy on $JEVOS_PORT"
else
  [ -x "$DATA_DIR/jev/jev" ] || { echo "jevos not installed; run deploy/install.sh first" >&2; exit 1; }
  log "starting jevos (threads=$THREADS port=$JEVOS_PORT)"
  # exec so $! is the jev process itself (not a wrapper shell)
  ( cd "$DATA_DIR/jev" && exec nohup ./jev serve --threads "$THREADS" --port "$JEVOS_PORT" \
      > "$LOGS/jevos.log" 2>&1 < /dev/null ) &
  echo $! > "$DATA_DIR/jevos.pid"
  wait_healthy "http://127.0.0.1:$JEVOS_PORT/health" 180 \
    || { echo "jevos failed to become healthy; last log:" >&2; tail -20 "$LOGS/jevos.log" >&2; exit 7; }
  log "jevos ready"
fi

if healthy "http://127.0.0.1:$WEB_PORT/"; then
  log "web already healthy on $WEB_PORT"
else
  [ -f "$REPO_DIR/.next/BUILD_ID" ] || { echo "web not built; run: npm run build" >&2; exit 1; }
  log "starting web (port=$WEB_PORT)"
  # call the next binary directly: keeps the PID stable for stop.sh
  ( cd "$REPO_DIR" && AI_PROVIDER="$AI_PROVIDER" \
      OLLAMA_URL="$OLLAMA_URL" OLLAMA_MODEL="$OLLAMA_MODEL" \
      STARTLUX_URL="$STARTLUX_URL" STARTLUX_MODEL="$STARTLUX_MODEL" \
      JEVOS_URL="http://127.0.0.1:$JEVOS_PORT" \
      exec nohup node node_modules/next/dist/bin/next start -p "$WEB_PORT" \
      > "$LOGS/web.log" 2>&1 < /dev/null ) &
  echo $! > "$DATA_DIR/web.pid"
  wait_healthy "http://127.0.0.1:$WEB_PORT/" 90 \
    || { echo "web failed to become healthy; last log:" >&2; tail -20 "$LOGS/web.log" >&2; exit 7; }
fi

if [ "$AI_PROVIDER" = "ollama" ]; then
  ollama_ok="$(curl -fsS -m 3 "$OLLAMA_URL/api/tags" >/dev/null 2>&1 && echo yes || echo no)"
  log "ready: http://127.0.0.1:$WEB_PORT/  (engine=ollama $OLLAMA_MODEL at $OLLAMA_URL, reachable=$ollama_ok)"
elif [ "$AI_PROVIDER" = "startlux" ]; then
  startlux_ok="$(curl -fsS -m 3 "$STARTLUX_URL/health" >/dev/null 2>&1 && echo yes || echo no)"
  log "ready: http://127.0.0.1:$WEB_PORT/  (engine=startlux $STARTLUX_MODEL at $STARTLUX_URL, reachable=$startlux_ok)"
else
  log "ready: http://127.0.0.1:$WEB_PORT/  (engine=jevos on :$JEVOS_PORT)"
fi
