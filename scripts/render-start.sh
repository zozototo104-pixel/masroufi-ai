#!/usr/bin/env bash
set -euo pipefail

APP_DIR="masrofi_ai_v6_2"
ARCHIVE_FILE="masrofi_ai_v6_2.tar.gz"
FULL_ARCHIVE_B64="archive/masrofi_ai_v6_2.tar.gz.b64"

if [ ! -f "$APP_DIR/package.json" ]; then
  echo "[render-start] unpacking Masrofi AI archive..."
  if [ -f archive/midi-part11.b64 ]; then
    cat archive/midi-part*.b64 | base64 -d > "$ARCHIVE_FILE"
  elif [ -f archive/tiny-part41.b64 ]; then
    cat archive/tiny-part*.b64 | base64 -d > "$ARCHIVE_FILE"
  elif [ -f archive/safe-part17.b64 ]; then
    cat archive/safe-part01.b64 archive/core-part02.b64 archive/safe-part0[3-9].b64 archive/safe-part1[0-7].b64 | base64 -d > "$ARCHIVE_FILE"
  elif [ -f "$FULL_ARCHIVE_B64" ]; then
    base64 -d "$FULL_ARCHIVE_B64" > "$ARCHIVE_FILE"
  else
    echo "[render-start] archive parts are incomplete" >&2
    exit 1
  fi
  tar -xzf "$ARCHIVE_FILE"
fi

cd "$APP_DIR"
exec npm start
