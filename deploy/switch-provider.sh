#!/usr/bin/env bash
# Switch the default decision engine in deploy.env and restart the web app.
#
#   bash deploy/switch-provider.sh jevos
#   bash deploy/switch-provider.sh ollama [model]      # 9B  clef-flash:9b
#   bash deploy/switch-provider.sh ollama27b [model]   # 27B clef:27b
#   bash deploy/switch-provider.sh startlux      # 9B  on :8081
#   bash deploy/switch-provider.sh startlux27b   # 27B on :8082
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
case "$PROVIDER" in
  jevos|ollama|ollama27b|startlux|startlux27b) ;;
  *)
    echo "usage: bash deploy/switch-provider.sh jevos|ollama|ollama27b|startlux|startlux27b [model]" >&2
    exit 2
    ;;
esac
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE; run deploy/install.sh first" >&2; exit 1; }

# Rewrite AI_PROVIDER; keep both model keys, and override the one that was given.
tmp="$(mktemp)"
grep -v -E '^(AI_PROVIDER|OLLAMA_MODEL|OLLAMA27_MODEL|STARTLUX_MODEL|STARTLUX27_MODEL)=' "$ENV_FILE" > "$tmp" || true
echo "AI_PROVIDER=\"$PROVIDER\"" >> "$tmp"
grep -E '^OLLAMA_MODEL=' "$ENV_FILE" >> "$tmp" || echo "OLLAMA_MODEL=\"clef-flash:9b\"" >> "$tmp"
grep -E '^OLLAMA27_MODEL=' "$ENV_FILE" >> "$tmp" || echo "OLLAMA27_MODEL=\"clef:27b\"" >> "$tmp"
grep -E '^STARTLUX_MODEL=' "$ENV_FILE" >> "$tmp" || echo "STARTLUX_MODEL=\"StartLux-Decision-v1.1-9B-Instant\"" >> "$tmp"
grep -E '^STARTLUX27_MODEL=' "$ENV_FILE" >> "$tmp" || echo "STARTLUX27_MODEL=\"StartLux-Decision-v1.1-27B-Instant\"" >> "$tmp"
if [ -n "$MODEL" ]; then
  case "$PROVIDER" in
    ollama)
      sed -i.bak -E "s|^OLLAMA_MODEL=.*|OLLAMA_MODEL=\"$MODEL\"|" "$tmp" && rm -f "$tmp.bak"
      ;;
    ollama27b)
      sed -i.bak -E "s|^OLLAMA27_MODEL=.*|OLLAMA27_MODEL=\"$MODEL\"|" "$tmp" && rm -f "$tmp.bak"
      ;;
    startlux)
      sed -i.bak -E "s|^STARTLUX_MODEL=.*|STARTLUX_MODEL=\"$MODEL\"|" "$tmp" && rm -f "$tmp.bak"
      ;;
    startlux27b)
      sed -i.bak -E "s|^STARTLUX27_MODEL=.*|STARTLUX27_MODEL=\"$MODEL\"|" "$tmp" && rm -f "$tmp.bak"
      ;;
  esac
fi
mv "$tmp" "$ENV_FILE"

echo "[switch] provider=$PROVIDER (config: $ENV_FILE)"
bash "$SCRIPT_DIR/stop.sh" >/dev/null 2>&1 || true
bash "$SCRIPT_DIR/start.sh"
