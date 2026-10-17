#!/usr/bin/env bash
# =============================================================================
# 2048 x jevos - one-shot installer / 一键安装
#
#   bash deploy/install.sh [options]
#
# Options:
#   --data-dir DIR      jevos runtime dir (default: <repo>/.jevos)
#   --port PORT         web port (default: 3000)
#   --jevos-port PORT   jevos port (default: 8017)
#   --threads N         jevos CPU threads (default: 4)
#   --provider NAME       default engine: jevos | ollama | startlux (default: jevos)
#   --ollama-url URL      ollama base URL (default: http://127.0.0.1:11434)
#   --ollama-model ID     ollama decision model (default: clef-flash:9b)
#   --startlux-url URL    startlux-decide URL (default: http://127.0.0.1:8081)
#   --startlux-model NAME model name reported by startlux (default: StartLux-Decision-v1.1-9B-Instant; 27B Q4_K_M also supported)
#   --assets-dir DIR    use already-downloaded release files from DIR
#   --no-start          install only, do not start services
#   --skip-npm          skip npm install + build (deps already present)
#
# Idempotent: re-running skips verified downloads and reuses existing model.
# Exit codes: 0 ok · 2 bad args · 3 unsupported platform · 4 missing assets
#             5 checksum mismatch · 6 download failed · 7 service not healthy
# =============================================================================
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

DATA_DIR="${JEVOS_DATA_DIR:-$REPO_DIR/.jevos}"
WEB_PORT="${WEB_PORT:-3000}"
JEVOS_PORT="${JEVOS_PORT:-8017}"
THREADS="${JEVOS_THREADS:-4}"
AI_PROVIDER="${AI_PROVIDER:-jevos}"
OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"
OLLAMA_MODEL="${OLLAMA_MODEL:-clef-flash:9b}"
STARTLUX_URL="${STARTLUX_URL:-http://127.0.0.1:8081}"
STARTLUX_MODEL="${STARTLUX_MODEL:-StartLux-Decision-v1.1-9B-Instant}"
ASSETS_DIR=""
DO_START=1
SKIP_NPM=0
RELEASE_BASE="${JEVOS_ASSET_BASE:-https://github.com/feder-cr/jev/releases/download/jevos-v5}"

MODEL_ASSET="jevos-v5-openvino-int8.zip"
MODEL_SHA="0a1159c31b9c2abc484af9c866cdcfe5279fdf592b368636625c5a795f970acc"

usage() { sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --data-dir)   DATA_DIR="$2"; shift 2 ;;
    --port)       WEB_PORT="$2"; shift 2 ;;
    --jevos-port) JEVOS_PORT="$2"; shift 2 ;;
    --threads)    THREADS="$2"; shift 2 ;;
    --provider)   AI_PROVIDER="$2"; shift 2 ;;
    --ollama-url) OLLAMA_URL="$2"; shift 2 ;;
    --ollama-model) OLLAMA_MODEL="$2"; shift 2 ;;
    --startlux-url) STARTLUX_URL="$2"; shift 2 ;;
    --startlux-model) STARTLUX_MODEL="$2"; shift 2 ;;
    --assets-dir) ASSETS_DIR="$2"; shift 2 ;;
    --no-start)   DO_START=0; shift ;;
    --skip-npm)   SKIP_NPM=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

case "$AI_PROVIDER" in
  jevos|ollama|startlux) ;;
  *) echo "unknown provider: $AI_PROVIDER (use jevos, ollama or startlux)" >&2; exit 2 ;;
esac

# stdout is reserved for machine-readable paths; all progress goes to stderr
log() { printf '\033[1;36m[install]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[install]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[install]\033[0m %s\n' "$*" >&2; local code="${2:-1}"; exit "$code"; }

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# ---------- 1. platform -------------------------------------------------------
OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS/$ARCH" in
  Linux/x86_64)
    BIN_ASSET="jev-linux-x64.tar.gz"
    BIN_SHA="1ce77566405514ed2f20d64f8222cf9eba9b714d332f05f6296e0cad84dd7b04" ;;
  Darwin/arm64)
    BIN_ASSET="jev-macos-arm64.tar.gz"
    BIN_SHA="ba71df2da07d4bdf47c72771319b266347a0ae4732d0b74c8e9f227b646e7109" ;;
  *) die "unsupported platform: $OS/$ARCH (release ships linux-x64 and macos-arm64 only)" 3 ;;
esac
log "platform $OS/$ARCH -> $BIN_ASSET"

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar  >/dev/null 2>&1 || die "tar is required"
command -v unzip >/dev/null 2>&1 || warn "unzip not found; will try python3 -m zipfile"
command -v npm  >/dev/null 2>&1 || die "npm is required (Node 18.17+; tested on 20 and 22)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 18 ] || die "Node >= 18.17 required, found $(node -v 2>/dev/null || echo none)"

# ---------- 2. asset fetching (idempotent) -----------------------------------
ASSET_STORE="$DATA_DIR/assets"
mkdir -p "$ASSET_STORE"

find_asset() { # name -> path on stdout
  local name="$1"
  if [ -n "$ASSETS_DIR" ]; then
    for cand in "$ASSETS_DIR/$name" "$ASSETS_DIR/$(basename "$name")"; do
      [ -f "$cand" ] && { printf '%s\n' "$cand"; return 0; }
    done
    if [ "$name" = "$MODEL_ASSET" ] && [ -f "$ASSETS_DIR/model.zip" ]; then
      printf '%s\n' "$ASSETS_DIR/model.zip"; return 0
    fi
    return 1
  fi
  printf '%s\n' "$ASSET_STORE/$name"
}

ensure_asset() { # name sha -> echoes verified path
  local name="$1" sha="$2" path
  path="$(find_asset "$name")" || die "asset not found in --assets-dir $ASSETS_DIR: $name" 4
  if [ -f "$path" ] && [ "$(sha256 "$path")" = "$sha" ]; then
    log "asset ok: $name ($(du -h "$path" | cut -f1))"
    printf '%s\n' "$path"; return 0
  fi
  [ -n "$ASSETS_DIR" ] && die "checksum mismatch: $path" 5
  log "downloading $name"
  rm -f "$path.part"
  curl -fL --retry 5 --retry-delay 2 --retry-all-errors --connect-timeout 20 --max-time 1800 \
       -o "$path.part" "$RELEASE_BASE/$name" \
    || die "download failed: $RELEASE_BASE/$name (retry, or re-run with --assets-dir DIR)" 6
  mv "$path.part" "$path"
  [ "$(sha256 "$path")" = "$sha" ] || die "checksum mismatch after download: $path" 5
  printf '%s\n' "$path"
}

# ---------- 3. binary + model -------------------------------------------------
JEVDIR="$DATA_DIR/jev"
mkdir -p "$DATA_DIR"
if [ "$AI_PROVIDER" = "ollama" ] || [ "$AI_PROVIDER" = "startlux" ]; then
  log "provider=$AI_PROVIDER: skipping jevos assets (re-run with --provider jevos to install them)"
elif [ -x "$JEVDIR/jev" ] && [ -f "$JEVDIR/model/model.json" ] && [ -f "$JEVDIR/model/openvino_model.bin" ]; then
  log "jevos binary and model already installed, skipping"
else
  BIN_TGZ="$(ensure_asset "$BIN_ASSET" "$BIN_SHA")"
  MODEL_ZIP="$(ensure_asset "$MODEL_ASSET" "$MODEL_SHA")"

  log "extracting $BIN_ASSET"
  tar -xzf "$BIN_TGZ" -C "$DATA_DIR"
  [ -x "$JEVDIR/jev" ] || die "unexpected archive layout: $JEVDIR/jev missing"

  log "extracting model (679 MB, ~10-30 s)"
  rm -rf "$JEVDIR/model" "$JEVDIR/.model.tmp"
  mkdir -p "$JEVDIR/.model.tmp"
  if command -v unzip >/dev/null 2>&1; then
    unzip -qo "$MODEL_ZIP" -d "$JEVDIR/.model.tmp"
  else
    python3 -m zipfile -e "$MODEL_ZIP" "$JEVDIR/.model.tmp"
  fi
  if [ -d "$JEVDIR/.model.tmp/model" ]; then SRC="$JEVDIR/.model.tmp/model"; else SRC="$JEVDIR/.model.tmp"; fi
  [ -f "$SRC/model.json" ] || die "model archive missing model.json (layout: $SRC)"
  mv "$SRC" "$JEVDIR/model"
  rm -rf "$JEVDIR/.model.tmp"
fi

# ---------- 4. node deps + build ---------------------------------------------
if [ "$SKIP_NPM" = 0 ]; then
  log "installing npm dependencies"
  cd "$REPO_DIR"
  if [ -f package-lock.json ]; then npm ci --no-audit --no-fund
  else npm install --no-audit --no-fund; fi
  log "building Next.js"
  npm run build
fi

# ---------- 5. persist config ------------------------------------------------
cat > "$DATA_DIR/deploy.env" <<EOF
# generated by deploy/install.sh $(date -u +%Y-%m-%dT%H:%M:%SZ)
REPO_DIR="$REPO_DIR"
WEB_PORT="$WEB_PORT"
JEVOS_PORT="$JEVOS_PORT"
JEVOS_THREADS="$THREADS"
AI_PROVIDER="$AI_PROVIDER"
OLLAMA_URL="$OLLAMA_URL"
OLLAMA_MODEL="$OLLAMA_MODEL"
STARTLUX_URL="$STARTLUX_URL"
STARTLUX_MODEL="$STARTLUX_MODEL"
EOF
chmod 644 "$DATA_DIR/deploy.env"
# remember the data dir so start/stop/status work without env vars
printf '%s\n' "$DATA_DIR" > "$REPO_DIR/.jevos-path"

log "config: $DATA_DIR/deploy.env (provider=$AI_PROVIDER)"
if [ -d "$JEVDIR/model" ]; then
  log "jevos:  $JEVDIR ($(du -sh "$JEVDIR/model" | cut -f1) model)"
fi
if [ "$AI_PROVIDER" = "ollama" ]; then
  log "ollama: $OLLAMA_URL model=$OLLAMA_MODEL"
fi
if [ "$AI_PROVIDER" = "startlux" ]; then
  log "startlux: $STARTLUX_URL model=$STARTLUX_MODEL (run startlux-decide separately)"
fi

if [ "$DO_START" = 1 ]; then
  bash "$SCRIPT_DIR/start.sh"
else
  log "installed. start with: bash deploy/start.sh"
fi
