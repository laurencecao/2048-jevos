#!/usr/bin/env bash
# Start llama-server for a StartLux-Decision GGUF (9B or 27B).
#
#   bash deploy/startlux-llama.sh                        # 9B Q8_0, port 8018
#   STARTLUX_GGUF=startlux/StartLux-Decision-v1.1-27B-Instant-Q4_K_M.gguf \
#   LLAMACPP_PORT=8081 bash deploy/startlux-llama.sh     # 27B Q4_K_M, port 8081
#
# Environment:
#   STARTLUX_GGUF     GGUF file (default: ./startlux/StartLux-Decision-v1.1-9B-Instant-Q8_0.gguf)
#   STARTLUX_MMPROJ   optional mmproj-*.gguf for image prompts (text decisions do not need it)
#   LLAMACPP_BIN      llama-server binary (default: llama-server on PATH)
#   LLAMACPP_PORT     listen port (default: 8018)
#   STARTLUX_CTX      context length (default: 20480)
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
GGUF="${STARTLUX_GGUF:-$REPO_DIR/startlux/StartLux-Decision-v1.1-9B-Instant-Q8_0.gguf}"
PORT="${LLAMACPP_PORT:-8018}"
CTX="${STARTLUX_CTX:-20480}"
BIN="${LLAMACPP_BIN:-llama-server}"

[ -f "$GGUF" ] || { echo "missing GGUF: $GGUF (set STARTLUX_GGUF)" >&2; exit 2; }
if ! command -v "$BIN" >/dev/null 2>&1 && [ ! -x "$BIN" ]; then
  echo "llama-server not found: $BIN (set LLAMACPP_BIN)" >&2
  exit 2
fi

args=(-m "$GGUF" -ngl 99 -c "$CTX" --parallel 1 --ctx-checkpoints 0 -b 16384 -ub 16384 --port "$PORT")
if [ -n "${STARTLUX_MMPROJ:-}" ]; then
  [ -f "$STARTLUX_MMPROJ" ] || { echo "missing mmproj: $STARTLUX_MMPROJ" >&2; exit 2; }
  args+=(--mmproj "$STARTLUX_MMPROJ")
fi

exec "$BIN" "${args[@]}"
