#!/usr/bin/env bash
# Print a one-screen health report for both services.
set -o pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
DATA_DIR="${JEVOS_DATA_DIR:-}"
if [ -z "$DATA_DIR" ] && [ -f "$REPO_DIR/.jevos-path" ]; then
  DATA_DIR="$(cat "$REPO_DIR/.jevos-path")"
fi
DATA_DIR="${DATA_DIR:-$REPO_DIR/.jevos}"
[ -f "$DATA_DIR/deploy.env" ] && . "$DATA_DIR/deploy.env"
WEB_PORT="${WEB_PORT:-3000}"; JEVOS_PORT="${JEVOS_PORT:-8017}"
AI_PROVIDER="${AI_PROVIDER:-jevos}"
OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"
OLLAMA_MODEL="${OLLAMA_MODEL:-clef-flash:9b}"
OLLAMA27_URL="${OLLAMA27_URL:-http://127.0.0.1:11434}"
OLLAMA27_MODEL="${OLLAMA27_MODEL:-clef:27b}"
STARTLUX_URL="${STARTLUX_URL:-http://127.0.0.1:8081}"
STARTLUX_MODEL="${STARTLUX_MODEL:-StartLux-Decision-v1.1-9B-Instant}"
STARTLUX27_URL="${STARTLUX27_URL:-http://127.0.0.1:8082}"
STARTLUX27_MODEL="${STARTLUX27_MODEL:-StartLux-Decision-v1.1-27B-Instant}"
JEV_API_URL="${JEV_API_URL:-}"
JEV_API_KEY="${JEV_API_KEY:-}"
JEV_API_MODEL="${JEV_API_MODEL:-jev-latest}"

echo "repo:  $REPO_DIR"
echo "data:  $DATA_DIR"
probe() { # name port path
  local code pid
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:$2$3" || true)"
  pid="$(cat "$DATA_DIR/$1.pid" 2>/dev/null || echo -)"
  echo "$1: http $code  pid $pid  port $2"
}
if [ "$AI_PROVIDER" = "ollama" ] || [ "$AI_PROVIDER" = "ollama27b" ] || [ "$AI_PROVIDER" = "startlux" ] || [ "$AI_PROVIDER" = "startlux27b" ] || [ "$AI_PROVIDER" = "jevapi" ]; then
  echo "jevos: not started (provider=$AI_PROVIDER)"
else
  probe jevos "$JEVOS_PORT" /health
fi
probe web "$WEB_PORT" /
echo "engine: $AI_PROVIDER"
if [ "$AI_PROVIDER" = "ollama" ] || [ "$AI_PROVIDER" = "ollama27b" ]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 3 "$OLLAMA_URL/api/version" || true)"
  code27="$(curl -s -o /dev/null -w '%{http_code}' -m 3 "$OLLAMA27_URL/api/version" || true)"
  echo "ollama:      http $code    model $OLLAMA_MODEL   url $OLLAMA_URL"
  echo "ollama27b:   http $code27  model $OLLAMA27_MODEL  url $OLLAMA27_URL"
elif [ "$AI_PROVIDER" = "startlux" ] || [ "$AI_PROVIDER" = "startlux27b" ]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 3 "$STARTLUX_URL/health" || true)"
  code27="$(curl -s -o /dev/null -w '%{http_code}' -m 3 "$STARTLUX27_URL/health" || true)"
  echo "startlux:     http $code    model $STARTLUX_MODEL    url $STARTLUX_URL"
  echo "startlux27b:  http $code27  model $STARTLUX27_MODEL  url $STARTLUX27_URL"
elif [ "$AI_PROVIDER" = "jevapi" ]; then
  if [ -n "$JEV_API_URL" ] && [ -n "$JEV_API_KEY" ]; then
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 -H "Authorization: Bearer $JEV_API_KEY" "$JEV_API_URL/health" || true)"
    echo "jevapi:       http $code    model $JEV_API_MODEL    url $JEV_API_URL  key set"
  else
    echo "jevapi:       not configured (set JEV_API_URL and JEV_API_KEY in $DATA_DIR/deploy.env)"
  fi
else
  health="$(curl -fsS -m 3 "http://127.0.0.1:$JEVOS_PORT/health" 2>/dev/null || true)"
  if [ -n "$health" ]; then
    model="$(printf '%s' "$health" | sed -n 's/.*"model":"\([^"]*\)".*/\1/p')"
    echo "model: $model"
  fi
fi
echo "logs:  $DATA_DIR/logs"
