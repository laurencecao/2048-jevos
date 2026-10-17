#!/usr/bin/env bash
# Switch the default decision engine in deploy.env and restart the web app.
#
#   bash deploy/switch-provider.sh jevos
#   bash deploy/switch-provider.sh ollama [model]
#
# The web UI can also switch engines per browser session without touching
# config; this script changes the server-side default (AI_PROVIDER).
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
DATA_DIR="${JEVOS_DATA_DIR:-}"
if [ -z "$DATA_DIR" ] && [ -f "$REPO_DIR/.jevos-path" ]; then
  DATA_DIR="$(cat "$REPO_DIR/.jevos-path")"
fi
DATA_DIR="${DATA_DIR:-$REPO_DIR/.jevos}"
ENV_FILE="$DATA_DIR/deploy.env"

PROVIDER="${1:-}"
MODEL="${2:-}"
if [ "$PROVIDER" != "jevos" ] && [ "$PROVIDER" != "ollama" ]; then
  echo "usage: bash deploy/switch-provider.sh jevos|ollama [model]" >&2
  exit 2
fi
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE; run deploy/install.sh first" >&2; exit 1; }

# Rewrite (or append) AI_PROVIDER, and OLLAMA_MODEL when one was given.
tmp="$(mktemp)"
grep -v -E '^(AI_PROVIDER|OLLAMA_MODEL)=' "$ENV_FILE" > "$tmp" || true
echo "AI_PROVIDER=\"$PROVIDER\"" >> "$tmp"
if [ -n "$MODEL" ]; then
  echo "OLLAMA_MODEL=\"$MODEL\"" >> "$tmp"
else
  grep -E '^OLLAMA_MODEL=' "$ENV_FILE" >> "$tmp" || echo "OLLAMA_MODEL=\"clef-flash:9b\"" >> "$tmp"
fi
mv "$tmp" "$ENV_FILE"

echo "[switch] provider=$PROVIDER (config: $ENV_FILE)"
bash "$SCRIPT_DIR/stop.sh" >/dev/null 2>&1 || true
bash "$SCRIPT_DIR/start.sh"
