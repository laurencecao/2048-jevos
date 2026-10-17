#!/usr/bin/env bash
# Print a one-screen health report for both services.
set -o pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
DATA_DIR="${JEVOS_DATA_DIR:-$REPO_DIR/.jevos}"
[ -f "$DATA_DIR/deploy.env" ] && . "$DATA_DIR/deploy.env"
WEB_PORT="${WEB_PORT:-3000}"; JEVOS_PORT="${JEVOS_PORT:-8017}"

echo "repo:  $REPO_DIR"
echo "data:  $DATA_DIR"
for row in "jevos $JEVOS_PORT /health" "web $WEB_PORT /"; do
  set -- $row
  name="$1"; port="$2"; path="$3"
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:$port$path" || true)"
  pid="$(cat "$DATA_DIR/$name.pid" 2>/dev/null || echo -)"
  echo "$name: http $code  pid $pid  port $port"
done
health="$(curl -fsS -m 3 "http://127.0.0.1:$JEVOS_PORT/health" 2>/dev/null || true)"
if [ -n "$health" ]; then
  model="$(printf '%s' "$health" | sed -n 's/.*"model":"\([^"]*\)".*/\1/p')"
  echo "model: $model"
fi
echo "logs:  $DATA_DIR/logs"
