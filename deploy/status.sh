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

echo "repo:  $REPO_DIR"
echo "data:  $DATA_DIR"
probe() { # name port path
  local code pid
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:$2$3" || true)"
  pid="$(cat "$DATA_DIR/$1.pid" 2>/dev/null || echo -)"
  echo "$1: http $code  pid $pid  port $2"
}
if [ "$AI_PROVIDER" = "ollama" ]; then
  echo "jevos: not started (provider=ollama)"
else
  probe jevos "$JEVOS_PORT" /health
fi
probe web "$WEB_PORT" /
echo "engine: $AI_PROVIDER"
if [ "$AI_PROVIDER" = "ollama" ]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 3 "$OLLAMA_URL/api/version" || true)"
  echo "ollama: http $code  model $OLLAMA_MODEL  url $OLLAMA_URL"
else
  health="$(curl -fsS -m 3 "http://127.0.0.1:$JEVOS_PORT/health" 2>/dev/null || true)"
  if [ -n "$health" ]; then
    model="$(printf '%s' "$health" | sed -n 's/.*"model":"\([^"]*\)".*/\1/p')"
    echo "model: $model"
  fi
fi
echo "logs:  $DATA_DIR/logs"
