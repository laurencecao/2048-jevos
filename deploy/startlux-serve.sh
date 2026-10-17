#!/usr/bin/env bash
# Serve a StartLux-Decision GGUF folder through startlux-decide (llama.cpp).
#
#   llama-server ... --port 8018        # the GGUF itself
#   bash deploy/startlux-serve.sh       # decision API on 8081
#
# Everything can be overridden from the environment:
#   STARTLUX_MODEL_DIR      folder with the GGUF + config/tokenizer files
#   STARTLUX_MODEL          model name reported by /health and /v1/models
#   STARTLUX_LLAMACPP_URL   llama-server base URL (default http://127.0.0.1:8018)
#   STARTLUX_PORT           decision API port (default 8081)
#   STARTLUX_LLAMACPP_BIDIR server (stock llama-server) | request | auto | off
set -eo pipefail

MODEL_DIR="${STARTLUX_MODEL_DIR:-$PWD/startlux}"
LLAMACPP_URL="${STARTLUX_LLAMACPP_URL:-http://127.0.0.1:8018}"
PORT="${STARTLUX_PORT:-8081}"
NAME="${STARTLUX_MODEL:-StartLux-Decision-v1.1-9B-Instant}"

export STARTLUX_LLAMACPP_BIDIR="${STARTLUX_LLAMACPP_BIDIR:-server}"

if command -v startlux-decide >/dev/null 2>&1; then
  exec startlux-decide serve --model "$MODEL_DIR" --backend llamacpp \
    --llamacpp-url "$LLAMACPP_URL" --port "$PORT" --name "$NAME"
fi
exec python3 -m startlux_decide.cli serve --model "$MODEL_DIR" --backend llamacpp \
  --llamacpp-url "$LLAMACPP_URL" --port "$PORT" --name "$NAME"
