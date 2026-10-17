#!/usr/bin/env bash
# Stop both services. Safe to run when they are not running.
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
DATA_DIR="${JEVOS_DATA_DIR:-}"
if [ -z "$DATA_DIR" ] && [ -f "$REPO_DIR/.jevos-path" ]; then
  DATA_DIR="$(cat "$REPO_DIR/.jevos-path")"
fi
DATA_DIR="${DATA_DIR:-$REPO_DIR/.jevos}"
[ -f "$DATA_DIR/deploy.env" ] && . "$DATA_DIR/deploy.env"
WEB_PORT="${WEB_PORT:-3000}"; JEVOS_PORT="${JEVOS_PORT:-8017}"

for name in web jevos; do
  pidfile="$DATA_DIR/$name.pid"
  [ -f "$pidfile" ] || continue
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "[stop] $name pid=$pid"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$pidfile"
done

# fallback: kill leftovers that belong to this data dir / port, same user only
pkill -u "$(id -u)" -f "jev serve --threads $THREADS --port $JEVOS_PORT" 2>/dev/null || true
pkill -u "$(id -u)" -f "next start -p $WEB_PORT" 2>/dev/null || true

command -v ss >/dev/null 2>&1 || { echo "[stop] done (port reclaim via pkill only)"; exit 0; }
for port in "$WEB_PORT" "$JEVOS_PORT"; do
  pids="$(ss -ltnp 2>/dev/null | awk -v p=":$port" '$4 ~ p {print $NF}' | grep -o 'pid=[0-9]*' | cut -d= -f2 || true)"
  for pid in $pids; do
    cmd="$(ps -o cmd= -p "$pid" 2>/dev/null || true)"
    case "$cmd" in
      *next*|*jev*) echo "[stop] reclaiming $pid ($cmd)"; kill "$pid" 2>/dev/null || true ;;
    esac
  done
done
echo "[stop] done"
