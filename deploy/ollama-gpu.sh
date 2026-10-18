#!/usr/bin/env bash
# Give ollama the whole GPU set, so clef:27b (27B Q4_K_M, ~18 GB of weights)
# can live next to clef-flash:9b instead of spilling to the CPU.
#
#   bash deploy/ollama-gpu.sh status
#   bash deploy/ollama-gpu.sh apply [--force]
#
# Why this is needed: on a 4x A2 box each card has ~15.3 GB. The 27B does not
# fit on one card, and stock ollama only spreads layers across GPUs when it has
# to (the running llama-server otherwise shows "--split-mode none --main-gpu
# 0"). OLLAMA_SCHED_SPREAD=1 makes the scheduler spread every model over all
# visible cards, which is what keeps both decision models resident.
#
# apply recreates the container (same image / volume / port), so it:
#   * refuses while an "ollama pull" is running (that would abort the pull),
#     unless --force is given, and
#   * keeps the data bind mount, otherwise the pulled models would be lost.
#
# Environment (defaults in brackets):
#   OLLAMA_CONTAINER       container name              [ollama]
#   OLLAMA_IMAGE           image                       [from docker inspect]
#   OLLAMA_DATA_DIR        host dir -> /root/.ollama   [from docker inspect]
#   OLLAMA_PORT            host port                   [11434]
#   OLLAMA_SCHED_SPREAD    1 = spread over all GPUs     [1]
#   OLLAMA_MAX_LOADED_MODELS  keep 9B + 27B resident   [2]
#   OLLAMA_NUM_PARALLEL    one request per model        [1]
#   OLLAMA_KV_CACHE_TYPE   q8_0 KV cache (less VRAM)    [q8_0]
#   OLLAMA_FLASH_ATTENTION 1                            [1]
#   OLLAMA_KEEP_ALIVE      residency                    [30m]
set -eo pipefail

CONTAINER="${OLLAMA_CONTAINER:-ollama}"
PORT="${OLLAMA_PORT:-11434}"
SPREAD="${OLLAMA_SCHED_SPREAD:-1}"
MAX_LOADED="${OLLAMA_MAX_LOADED_MODELS:-2}"
PARALLEL="${OLLAMA_NUM_PARALLEL:-1}"
KV_CACHE="${OLLAMA_KV_CACHE_TYPE:-q8_0}"
FLASH_ATTN="${OLLAMA_FLASH_ATTENTION:-1}"
KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:-30m}"

log() { printf '\033[1;36m[ollama-gpu]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[ollama-gpu]\033[0m %s\n' "$*" >&2; exit "${2:-1}"; }

command -v docker >/dev/null 2>&1 || die "docker is required"

exists() { docker inspect "$CONTAINER" >/dev/null 2>&1; }

field() { # go-template -> value, empty when the container is missing
  docker inspect "$CONTAINER" --format "$1" 2>/dev/null || true
}

status() {
  if ! exists; then
    echo "container: $CONTAINER (not found)"
    return 0
  fi
  echo "container: $CONTAINER"
  echo "image:     $(field '{{.Config.Image}}')"
  echo "state:     $(field '{{.State.Status}}')"
  echo "bind:      $(field '{{range .Mounts}}{{.Source}} -> {{.Destination}} {{end}}')"
  echo "ports:     $(field '{{json .NetworkSettings.Ports}}')"
  echo "env:"
  docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | grep -E '^OLLAMA_' | sed 's/^/  /' || echo "  (no OLLAMA_* env — that is why 27B falls back to one card)"
  echo "gpu:"
  if command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi --query-gpu=index,memory.used,memory.total --format=csv,noheader \
      | sed 's/^/  /'
  else
    echo "  nvidia-smi not found on the host"
  fi
  echo "models:"
  curl -fsS -m 3 "http://127.0.0.1:$PORT/api/tags" 2>/dev/null \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); [print("  " + m.get("name","?")) for m in d.get("models",[])]' 2>/dev/null \
    || echo "  (ollama not answering on :$PORT)"
}

pulling() {
  docker top "$CONTAINER" -eo args 2>/dev/null | grep -q 'ollama pull'
}

apply() {
  local force="${1:-}"
  exists || die "container '$CONTAINER' not found; start it once before applying GPU settings"

  if pulling && [ "$force" != "--force" ]; then
    die "an 'ollama pull' is running inside '$CONTAINER'; recreating the container would abort it.
  wait for the pull to finish, then re-run: bash deploy/ollama-gpu.sh apply
  (or pass --force if losing the download is acceptable)" 3
  fi

  local image data_dir restart
  image="$(field '{{.Config.Image}}')"
  data_dir="$(field '{{range .Mounts}}{{if eq .Destination "/root/.ollama"}}{{.Source}}{{end}}{{end}}')"
  restart="$(field '{{.HostConfig.RestartPolicy.Name}}')"
  [ -n "$image" ] || die "cannot read the image of '$CONTAINER'"
  [ -n "$data_dir" ] || die "cannot find the /root/.ollama bind mount of '$CONTAINER' (refusing to drop the model cache)"
  [ -n "$restart" ] || restart="always"

  log "recreating $CONTAINER from $image"
  log "bind $data_dir -> /root/.ollama, port $PORT, restart=$restart"
  docker rm -f "$CONTAINER" >/dev/null

  docker run -d --name "$CONTAINER" \
    --gpus all \
    --restart "$restart" \
    -p "$PORT:11434" \
    -v "$data_dir:/root/.ollama" \
    -e OLLAMA_HOST=0.0.0.0:11434 \
    -e "OLLAMA_SCHED_SPREAD=$SPREAD" \
    -e "OLLAMA_MAX_LOADED_MODELS=$MAX_LOADED" \
    -e "OLLAMA_NUM_PARALLEL=$PARALLEL" \
    -e "OLLAMA_KV_CACHE_TYPE=$KV_CACHE" \
    -e "OLLAMA_FLASH_ATTENTION=$FLASH_ATTN" \
    -e "OLLAMA_KEEP_ALIVE=$KEEP_ALIVE" \
    "$image" >/dev/null

  log "waiting for $CONTAINER to answer on :$PORT"
  for _ in $(seq 1 60); do
    if curl -fsS -m 2 "http://127.0.0.1:$PORT/api/version" >/dev/null 2>&1; then
      log "ready (OLLAMA_SCHED_SPREAD=$SPREAD, max loaded=$MAX_LOADED)"
      echo
      status
      return 0
    fi
    sleep 1
  done
  docker logs --tail 30 "$CONTAINER" >&2 || true
  die "ollama did not come back on :$PORT" 7
}

case "${1:-status}" in
  status)
    status
    ;;
  apply)
    apply "${2:-}"
    ;;
  -h|--help)
    sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *)
    echo "usage: bash deploy/ollama-gpu.sh [status|apply [--force]]" >&2
    exit 2
    ;;
esac
